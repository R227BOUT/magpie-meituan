// OpenCode & Magpie provider plugin for 妙手 (Meituan CatPaw).
// 核心（三段式对话 / 模型清单 / 积分）在 core.mjs；这里只做 magpie 插件 SDK 的
// 装配：config / auth / provider.loader 的 fetch 拦截。

import {
  PROVIDER_ID, PROVIDER_NAME, STREAM, GATEWAY, NOCODE,
  readDesktopLogin, listModels, quota, currentUser, checkAccount,
  chat, cancelUpstream, FALLBACK_MODELS, meituanAuthPath, fileTokenGuide,
} from "./core.mjs"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const cardText = (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 160)
const isAbortError = (e) => !!e && (e.name === "AbortError" || e.name === "TimeoutError" || /abort/i.test(String(e?.message || "")))

const modelIconData = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return `data:image/png;base64,${readFileSync(join(here, "icon.png")).toString("base64")}`
  } catch {
    return ""
  }
})()

export const MeituanPlugin = async () => {
  const tokenOf = async (auth) => {
    // 三种来源：桌面登录复用（desktop）、直接粘贴 token（manual）、OAuth（auth.access 即 token）
    if (auth?.source === "desktop") {
      const d = readDesktopLogin()
      if (!d) {
        const e = new Error("妙手桌面端登录态已失效，请打开妙手重新登录后在此重新登录")
        e.signIn = "expired"
        throw e
      }
      return d.token
    }
    const t = String(auth?.access || auth?.token || "").trim()
    if (!t) {
      const e = new Error("妙手登录态缺失，请重新登录")
      e.signIn = "expired"
      throw e
    }
    return t
  }

  return {
    config: async (config) => {
      config.provider ??= {}
      const was = config.provider[PROVIDER_ID] ?? {}
      const models = Object.fromEntries(
        FALLBACK_MODELS.map((m) => [
          m.id,
          {
            name: m.name,
            limit: { context: 192_000, output: 128_000 },
            tool_call: true,
            reasoning: false,
            attachment: m.id !== "glm-5.3" && m.id !== "deepseek-v4-pro",
            modalities: { input: ["text"], output: ["text"] },
            ...(m.rate ? { remark: `官方 ×${m.rate}` } : {}),
          },
        ]),
      )
      config.provider[PROVIDER_ID] = {
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: STREAM,
        ...(modelIconData ? { icon: modelIconData } : {}),
        ...was,
        models: { ...models, ...(was.models ?? {}) },
      }
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        return provider.models
      },
    },

    auth: {
      provider: PROVIDER_ID,
      icon: modelIconData,

      async refresh(auth) {
        // 桌面来源的座位跟随桌面应用：它重新登录后 transparent 拿新 token。
        if (auth?.source !== "desktop") return undefined
        const d = readDesktopLogin()
        if (!d) return undefined
        if (d.token === auth?.access) return undefined
        return {
          access: d.token,
          refresh: "",
          expires: 0,
          source: "desktop",
          accountId: d.uid || auth.accountId,
          name: d.name || auth.name || "",
        }
      },

      async loader(getAuth) {
        let auth
        let token = ""
        try {
          auth = await getAuth()
          token = await tokenOf(auth)
        } catch (e) {
          return {
            baseURL: STREAM,
            apiKey: "meituan",
            async fetch() {
              return new Response(
                JSON.stringify({ error: { message: e?.message ?? String(e), type: "authentication_error" } }),
                { status: e?.signIn === "expired" ? 401 : 502, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": e?.signIn === "expired" ? "expired" : "kept" } },
              )
            },
          }
        }

        return {
          baseURL: STREAM,
          apiKey: "meituan",
          async fetch(input, init = {}) {
            const req = input instanceof Request ? input : null
            const url = req ? req.url : String(input)
            let bodyText = init?.body
            if (bodyText === undefined && req) bodyText = await req.clone().text()

            // ---- OpenAI /chat/completions → 三段式 ----
            if (/\/chat\/completions$/.test(url)) {
              let body = {}
              try { body = JSON.parse(bodyText || "{}") } catch {}
              const model = String(body?.model || "auto")
              const stream = body?.stream !== false
              let resp
              try {
                resp = await chat(token, body, init?.signal)
              } catch (e) {
                const expired = e?.loginRequired === true || /ssoid|auth failed|重新登录/i.test(String(e?.message))
                return new Response(
                  JSON.stringify({ error: { message: e?.message ?? String(e), type: expired ? "authentication_error" : "api_error" } }),
                  { status: expired ? 401 : 502, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": expired ? "expired" : "kept" } },
                )
              }
              if (!resp.ok && resp.status !== 200) {
                // 非 SSE 的错误响应原样透传（chat() 里已是 JSON 错误体）
                const txt = await resp.text().catch(() => "")
                return new Response(txt || JSON.stringify({ error: { message: `妙手 HTTP ${resp.status}`, type: "api_error" } }), {
                  status: resp.status,
                  headers: { "Content-Type": "application/json" },
                })
              }
              if (!stream) {
                // 非流式：攒完整文本再拼一个标准 chat.completion 响应。
                // agent 中途取消（signal abort）会在这里以 AbortError 冒出 ——
                // 转成 499 语义的 JSON 返回而不是抛未处理拒绝；同时取消上游。
                const reader = resp.body.getReader()
                const dec = new TextDecoder()
                let buf = "", text = "", usage = null, err = null
                try {
                  for (;;) {
                    const { done, value } = await reader.read()
                    if (done) break
                    buf += dec.decode(value, { stream: true })
                    let i
                    while ((i = buf.indexOf("\n\n")) >= 0) {
                      const block = buf.slice(0, i); buf = buf.slice(i + 2)
                      for (const line of block.split("\n")) {
                        const raw = line.startsWith("data:") ? line.slice(5).trim() : ""
                        if (!raw || raw === "[DONE]") continue
                        try {
                          const j = JSON.parse(raw)
                          if (j.error) { err = j.error.message; continue }
                          const d0 = j.choices?.[0]?.delta || {}
                          if (d0.content) text += d0.content
                          if (j.usage) usage = j.usage
                        } catch { /* 跳过坏帧 */ }
                      }
                    }
                  }
                } catch (e) {
                  if (isAbortError(e)) {
                    return new Response(JSON.stringify({ error: { message: "请求已取消", type: "cancelled" } }), { status: 499, headers: { "Content-Type": "application/json" } })
                  }
                  throw e
                }
                if (err) return new Response(JSON.stringify({ error: { message: err, type: "upstream_error" } }), { status: 502, headers: { "Content-Type": "application/json" } })
                return new Response(JSON.stringify({
                  id: `chatcmpl-mt-${Date.now().toString(36)}`,
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
                  usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, estimated: true },
                }), { status: 200, headers: { "Content-Type": "application/json" } })
              }
              // 流式：透传 SSE；宿主断开时取消上游（通过 X-Magpie-Stream-Id 标记）
              const out = new Response(resp.body, resp)
              out.headers.set("X-Magpie-Stream-Id", resp.__session?.streamMessageId || "")
              return out
            }

            // ---- 其它路径（SDK 对 models 的探测等）：透传并补鉴权 ----
            const headers = new Headers(init?.headers ?? req?.headers)
            headers.set("access-token", token)
            headers.set("X-Auth-Token", token)
            headers.delete("authorization")
            headers.delete("x-api-key")
            const res = await fetch(url, { ...init, method: init?.method ?? req?.method ?? "GET", headers, body: bodyText })
            if (res.status === 401) {
              return new Response(
                JSON.stringify({ error: { message: "妙手登录态已失效，请重新登录", type: "authentication_error" } }),
                { status: 401, headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "expired" } },
              )
            }
            return res
          },
        }
      },

      async usage(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch (e) {
          return { error: cardText(e?.message) || "登录态读取失败", signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
        let token = ""
        try {
          token = await tokenOf(auth)
        } catch (e) {
          return { error: cardText(e?.message), signIn: e?.signIn === "expired" ? "expired" : "kept" }
        }
        try {
          const [q, u] = await Promise.all([quota(token).catch((e) => { throw e }), currentUser(token).catch(() => null)])
          const plan = q.plan || {}
          const next = Number(plan.nextRefreshTime) || 0
          return {
            plan: plan.name || "Free",
            balance: `${q.remaining.toFixed(2)} 积分`,
            windows: [
              {
                name: "Credits",
                // 上游只给余额不给累计 —— 卡片展示余额与重置时间，不伪造 used
                display: `${q.remaining.toFixed(2)} 分剩余`,
                used: 0,
                amount: q.remaining,
                limit: null,
                unit: "credits",
                ...(next ? { runsOutAt: new Date(next).toISOString() } : {}),
              },
            ],
            user: (u && u.ok && u.data.userName) || auth?.name || auth?.accountId || "妙手",
            signIn: "kept",
          }
        } catch (e) {
          const expired = e?.loginRequired === true || /ssoid|auth failed|重新登录|过期/i.test(String(e?.message))
          return { error: cardText(e?.message) || "用量查询失败", signIn: expired ? "expired" : "kept" }
        }
      },

      // 妙手积分按套餐周期重置（体验版 plan_free），没有签到端点
      async checkin() {
        return { outcome: "inactive", message: "妙手积分按套餐周期自动重置，无需签到" }
      },

      methods: [
        {
          type: "oauth",
          label: "妙手桌面端登录态（本机 auth.json，只读复用，推荐）",
          authorize: async () => ({
            url: "",
            instructions: "直接复用本机妙手客户端（CatPaw 桌面版）的登录态，读取 .meituan-catpaw/auth.json 的 accessToken（只读，不写任何文件）。",
            method: "auto",
            async callback() {
              const d = readDesktopLogin()
              if (!d) {
                return {
                  type: "failed",
                  error: `未检测到本机妙手登录态（${meituanAuthPath()}）。请先安装并登录妙手，或改用粘贴 Token 方式。`,
                }
              }
              const probe = await checkAccount(d.token)
              if (!probe.ok) {
                return { type: "failed", error: `本机登录态验证失败：${probe.detail}。请在妙手里重新登录后再试，或改用粘贴 Token 方式。` }
              }
              return {
                type: "success",
                access: d.token,
                refresh: "",
                expires: 0,
                source: "desktop",
                accountId: d.uid || PROVIDER_NAME,
                name: d.name || "",
              }
            },
          }),
        },
        {
          type: "oauth",
          label: "手动粘贴 Token（桌面端没装、或想用另一个账号时用这个）",
          authorize: async () => {
            const g = fileTokenGuide()
            return {
              url: "",
              instructions: g.steps.join("\n"),
              method: "code",
              async callback(input) {
                // 用户从记事本复制时常带上引号、空格、换行，先清干净
                const token = String(input ?? "")
                  .replace(/[\s"']/g, "")
                  .replace(/^accessToken:/i, "")
                  .trim()
                if (!token) {
                  return { type: "failed", error: "没有读到内容。请把 accessToken 引号中间那整串复制过来。" }
                }
                if (token.length < 40) {
                  return {
                    type: "failed",
                    error: `只收到 ${token.length} 个字符，看起来复制不全。完整的 accessToken 大约 150 个字符，`
                      + `请回到记事本，从 Ag 开头一直选到结尾，再复制一次。`,
                  }
                }
                const probe = await checkAccount(token)
                if (!probe.ok) {
                  return {
                    type: "failed",
                    error: `这串 token 妙手不认（${probe.detail}）。两个常见原因：\n`
                      + "① 复制时漏了开头或结尾几个字符，重新完整复制一次；\n"
                      + "② 妙手里已经重新登录过，旧 token 失效了——按上面第 1 步重新打开那个文件，抄新的那串。",
                  }
                }
                return {
                  type: "success",
                  access: token,
                  refresh: "",
                  expires: 0,
                  source: "manual",
                  accountId: probe.uid || PROVIDER_ID,
                  name: probe.name || "",
                }
              },
            }
          },
        },
      ],
    },
  }
}

export default MeituanPlugin
