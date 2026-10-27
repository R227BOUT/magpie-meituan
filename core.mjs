// OpenCode & Magpie provider plugin for 妙手 (Meituan CatPaw / catpaw-moon).
//
// 妙手 (Meituan CatPaw) signs in through the desktop client; the app persists
// the passport accessToken in plaintext in
//   <妙手 data>/.meituan-catpaw/auth.json   { auth:{accessToken,...}, account:{uid,name} }
// This plugin reuses that login (read-only) or accepts a pasted access token.
//
// ── 三个 host 各有分工，鉴权头各不相同（LMR 逆向 + 真机实测的结论）──
//   GATEWAY  https://catx.nocode.cn          头 X-Auth-Token(+access-token)  积分余额 / 当前用户
//   NOCODE   https://nocode.cn               头 access-token(+client-id)     建会话 / 触发 agent
//   STREAM   https://ai.catpaw.meituan.com   头 X-Passport-Token(+同名 Cookie) 模型清单 / SSE 流
//   client-id（product.json 的 auth.provider.clientId）= 2f73f89b68
//
// ── 对话是「三段式」，不是 OpenAI 协议 ──
//   ① POST {NOCODE}/api/chat/create                body { chatId, source:'catdesk', prompt, ... }
//   ①b GET  {NOCODE}/api/chat/detail?chatId=       轮询 data.id 出现（create 是异步落库，不等到就触发必炸 NPE）
//   ② POST {NOCODE}/api/chat/agent-stream          body { chatId, messages:[…], model, … } → conversationId
//   ③ POST {STREAM}/api/agent/stream/connect       body { timestamp, conversationId, messageIndex:0, incrementalOnly:true }
//      → SSE，帧形如 {"headlessRemoteAgentResp":{"message":{"content":[{"type":"text","text":"…"}]}}}
//      终态只认 {"statusUpdate":"completed"} 等（finished:true 是中间步骤，不能当终态）
//   取消：POST {NOCODE}/api/chat/resumable-stream/cancel?messageId=<streamMessageId>
//
// ── 频控（真机实测）──
//   create 连打约 6 次即 429，冷却实测 41 秒。撞到 429 唯一正确动作是立即放弃
//   并本地记住解禁时间（原地退避只会续期窗口）。
//
// ── 模型 ──
//   POST {STREAM}/api/agent/maas/model-types  body {tenant:'CatDesk',scene:'CATX_APP',env:'EXTERNAL'}
//   每个模型带 extendedInfo.rateMultiplier（官方积分倍率，如 "0.06"）。

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { randomUUID, randomBytes } from "node:crypto"

export const PROVIDER_ID = "meituan"
export const PROVIDER_NAME = "妙手 CatPaw"

export const GATEWAY = process.env.MEITUAN_GATEWAY || "https://catx.nocode.cn"
export const NOCODE = process.env.MEITUAN_NOCODE || "https://nocode.cn"
export const STREAM = process.env.MEITUAN_STREAM_BASE || "https://ai.catpaw.meituan.com"
export const CLIENT_ID = process.env.MEITUAN_CLIENT_ID || "2f73f89b68"
const TENANT = "CatDesk"
const SCENE = "CATX_APP"
const ENV_NAME = "EXTERNAL"
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) CatPaw/1.0.82 Chrome/130.0.0.0 Electron/33.0.0 Safari/537.36"

const DEFAULT_MODEL = "auto"
const TURN_TIMEOUT_MS = 300_000
const ATTEMPTS = 2
const PERSIST_WAIT_MS = 4000
const PERSIST_STEP_MS = 200
const RETRY_GAP_MS = 1200
const RATE_LIMIT_MS = 45_000

const P = {
  creditBalance: "/api/gateway/credit/balance",
  currentUser: "/api/gateway/passport/current-user",
  chatCreate: "/api/chat/create",
  chatAgentStream: "/api/chat/agent-stream",
  chatDetail: "/api/chat/detail",
  chatCancelStream: "/api/chat/resumable-stream/cancel",
  modelTypes: "/api/agent/maas/model-types",
  streamConnect: "/api/agent/stream/connect",
  conversationHistory: "/api/agent/conversation/history",
}

// 网关没有公开模型清单时的兜底（来自 2026-10-26 真机 model-types 实测）。
// rateMultiplier 是官方积分倍率，看板上会显示为「官方 ×0.06」。
export const FALLBACK_MODELS = [
  { id: "auto", name: "Auto（智能路由）", rate: "" },
  { id: "LongCat-2.0", name: "LongCat-2.0", rate: "0.00" },
  { id: "glm-5.3-flashx", name: "GLM-5.3-FlashX", rate: "0.16" },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", rate: "0.06" },
  { id: "glm-5.3", name: "GLM-5.3", rate: "0.59" },
  { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", rate: "0.06" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", rate: "0.48" },
  { id: "MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash", rate: "0.05" },
  { id: "MiniMax-M3", name: "MiniMax-M3", rate: "0.22" },
  { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", rate: "0.61" },
  { id: "kimi-k3", name: "Kimi-K3", rate: "0.94" },
]

// ---- 桌面登录读取（只读） ----------------------------------------------------

// 妙手的数据目录是 <安装位置>/data/.meituan-catpaw。安装位置由用户决定
// （默认安装器会让选），所以这里按「确定能算出来的」→「碰运气扫」两级找：
//   1. MEITUAN_AUTH_PATH / MEITUAN_DATA_DIR 环境变量，装了哪都能指
//   2. %APPDATA%、%LOCALAPPDATA%、用户主目录下的 妙手/data
//   3. 每个盘符的根下一层目录（Program Files、自定义的 D:\xxx 之类）
// 只做 stat，不递归，扫完还没找到就返回候选里的第一个让上层报错。
function authCandidate(root) {
  return join(root, "妙手", "data", ".meituan-catpaw", "auth.json")
}

function dataDirCandidates() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  for (const env of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME"]) {
    if (process.env[env]) push(authCandidate(process.env[env]))
  }
  // 每个盘符：根下面一层的每个目录都可能是一个自定义安装根
  const roots = []
  for (let c = 67; c <= 90; c++) { // C..Z
    const d = String.fromCharCode(c) + ":\\"
    try { if (existsSync(d)) roots.push(d) } catch {}
  }
  for (const d of roots) {
    push(authCandidate(d))
    if (existsSync(d)) {
      for (const sub of ["Program Files", "Program Files (x86)", "Programs"]) {
        push(authCandidate(join(d, sub)))
      }
      // 一层浅扫：装在 D:\<自定义目录>\妙手 这种也算
      try {
        for (const name of readdirSync(d)) {
          if (name === "妙手" || name === "$Recycle.Bin" || name === "Windows") continue
          push(authCandidate(join(d, name)))
        }
      } catch {}
    }
  }
  return out
}

export function meituanAuthPath() {
  if (process.env.MEITUAN_AUTH_PATH) return process.env.MEITUAN_AUTH_PATH
  if (process.env.MEITUAN_DATA_DIR) {
    return join(process.env.MEITUAN_DATA_DIR, ".meituan-catpaw", "auth.json")
  }
  const candidates = dataDirCandidates()
  for (const p of candidates) {
    try { if (existsSync(p)) return p } catch {}
  }
  return candidates[0]
}

// ---- 给不懂技术的人的取 token 指引 -------------------------------------------
//
// 粘贴 token 这种方式，难的不是粘贴，是「token 在哪」。所以这里按顺序给三条
// 路，第一条就是他自己电脑上那个文件的确切路径——打开就能抄，不用找。

export function fileTokenGuide() {
  const path = meituanAuthPath()
  const found = (() => { try { return existsSync(path) } catch { return false } })()
  if (!found) {
    return {
      path,
      found: false,
      steps: [
        "没有在你电脑上找到妙手的登录文件。",
        "这通常说明妙手还没安装，或者装好后没登录过。",
        "最简单的办法：装好妙手、登录一次，然后重新选「复用桌面端登录态」，就不用走这条了。",
        "",
        "如果你确定装过、也登录过，只是插件没找到，可以手动告诉它位置：",
        "  在「系统属性 → 环境变量」里新建一个用户变量",
        "  名称：MEITUAN_AUTH_PATH",
        "  值　：那个 auth.json 的完整路径",
        "不知道文件在哪的话：打开文件资源管理器，在「此电脑」的搜索框里搜 .meituan-catpaw，",
        "搜出来那个文件夹里就有 auth.json。",
      ],
    }
  }
  return {
    path,
    found: true,
    steps: [
      `第 1 步：按 Win + R，输入 notepad "${path}"，回车。`,
      "（这会用记事本打开妙手存登录信息的小文件，不会改到任何东西。）",
      "第 2 步：在打开的记事本里按 Ctrl + F，搜索 accessToken",
      '会看到这样一行：  "accessToken": "很长的一串字母数字"',
      "第 3 步：把两个引号中间的那一整串复制下来（引号本身不要复制）。",
      "第 4 步：回到这里，粘贴到下面的输入框。",
      "",
      "注意：整串大概 150 个字符，中间不能有空格或换行。如果粘贴进去提示「太短」，",
      "多半是只复制了一半——重新全选那串再复制一次。",
    ],
  }
}

export function readDesktopLogin() {
  const path = meituanAuthPath()
  let j
  try {
    j = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  const token = String(j?.auth?.accessToken || "").trim()
  if (!token) return null
  const uid = String(j?.account?.uid || "").trim()
  return {
    token,
    uid,
    name: String(j?.account?.name || j?.account?.loginName || uid || "").trim(),
    updatedAt: Number(j?.updatedAt) || 0,
    path,
  }
}

// ---- 三套请求头 -------------------------------------------------------------

export function gatewayHeaders(token) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Auth-Token": token,
    "access-token": token,
  }
}
export function nocodeHeaders(token) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "access-token": token,
    "client-id": CLIENT_ID,
    "User-Agent": UA,
  }
}
export function streamHeaders(token, sse) {
  return {
    "X-Passport-Token": token,
    Cookie: `X-Passport-Token=${token}`,
    "client-id": CLIENT_ID,
    Accept: sse ? "text/event-stream" : "application/json",
    "Content-Type": "application/json",
    "User-Agent": UA,
  }
}

// ---- 小工具 -----------------------------------------------------------------

const gap = (ms) => new Promise((r) => setTimeout(r, ms))
const isAbort = (e) => !!e && (e.name === "AbortError" || e.name === "TimeoutError" || /abort/i.test(String(e?.message || "")))
const cardText = (v) => String(v ?? "").replace(/\s+/g, " ").slice(0, 160)

export function newChatId() {
  const t = () => randomBytes(6).toString("hex").slice(0, 8)
  return `desk-${t()}${t()}`
}

// 官方客户端的终态集合（main-Bwpu7z8v.js 的 iB()）
const TERMINAL_STATUS = new Set(["completed", "canceled", "cancel", "user_stopped", "error", "failed", "terminated"])
const ERROR_STATUS = new Set(["error", "failed", "terminated"])

// 账号级频控记忆：token 后 12 位 → 解禁时间戳。41 秒冷却窗口内原地重试只会续期。
const RATE_LIMIT_UNTIL = new Map()

function textOfContent(c) {
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === "object" ? String(x.text || "") : String(x || ""))).join("")
  if (c && typeof c === "object") return String(c.text || "")
  return ""
}

export function promptFromMessages(messages) {
  const msgs = Array.isArray(messages) ? messages.filter((m) => m && typeof m === "object") : []
  if (!msgs.length) return ""
  let lastUser = -1
  for (let i = msgs.length - 1; i >= 0; i -= 1) if (msgs[i].role === "user") { lastUser = i; break }
  const usable = lastUser >= 0 ? msgs.slice(0, lastUser + 1) : msgs
  if (usable.length === 1 && usable[0].role === "user") return textOfContent(usable[0].content)
  const parts = []
  for (const m of usable) {
    const t = textOfContent(m.content)
    if (!t.trim()) continue
    if (m.role === "system") parts.push(`System:\n${t}`)
    else if (m.role === "assistant") parts.push(`Assistant:\n${t}`)
    else parts.push(`User:\n${t}`)
  }
  return parts.join("\n\n")
}

// 上游不给 usage → 按 CJK/非 CJK 估算 token（LMR 同款口径）
export function estimateTokens(text) {
  if (!text) return 0
  const s = String(text)
  let cjk = 0
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef)
      || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) cjk++
  }
  const nonCjk = s.length - cjk
  return Math.max(1, Math.round(cjk / 1.6 + nonCjk / 4))
}

// ---- 模型清单 ----------------------------------------------------------------

export async function listModels(token, signal) {
  const r = await fetch(`${STREAM}${P.modelTypes}`, {
    method: "POST",
    headers: streamHeaders(token, false),
    body: JSON.stringify({ tenant: TENANT, scene: SCENE, env: ENV_NAME }),
    signal: signal || AbortSignal.timeout(20_000),
  })
  if (!r.ok) {
    const e = new Error(`妙手模型清单 HTTP ${r.status}`)
    if (r.status === 401 || r.status === 403) e.loginRequired = true
    throw e
  }
  const j = await r.json().catch(() => null)
  if (!j) throw new Error("妙手模型清单返回不是 JSON")
  const code = j.code != null ? j.code : j.unifyCode
  if (code !== 0 && code != null) {
    const msg = String(j.msg || j.message || "")
    const e = new Error(`妙手模型清单被拒 code=${code}：${msg}`)
    if (/login|登录|token|auth|sso|过期|expire|ssoid/i.test(msg) || code === 30002 || code === 401) e.loginRequired = true
    throw e
  }
  const rows = Array.isArray(j.data) ? j.data : []
  const seen = new Set()
  const out = []
  for (const m of rows) {
    const id = String((m && m.modelTypeName) || "").trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const ex = (m.extendedInfo && typeof m.extendedInfo === "object") ? m.extendedInfo : {}
    const params = Array.isArray(m.parameterDefinitions) ? m.parameterDefinitions : []
    out.push({
      id,
      name: id,
      context: 192_000,
      output: 128_000,
      reasoning: params.some((d) => d && (d.id === "thinking" || d.id === "effort")),
      attachment: !!m.supportImage,
      tool_call: true,
      rate: String(ex.rateMultiplier ?? ""),
      remark: String(ex.marketingCopy || ""),
    })
  }
  if (!seen.has(DEFAULT_MODEL)) {
    out.unshift({ id: DEFAULT_MODEL, name: "Auto（智能路由）", context: 192_000, output: 128_000, reasoning: false, attachment: false, tool_call: true, rate: "", remark: "" })
  }
  return out
}

// ---- 积分 / 体检 -------------------------------------------------------------

// 上游只给「还剩多少」（availableCredits），不给累计 → usage 卡片只展示余额与
// 套餐重置时间。故意不算 used：余额差值当「今日消耗」会把套餐周期重置误判成消耗。
export async function quota(token, signal) {
  const r = await fetch(`${GATEWAY}${P.creditBalance}`, {
    headers: gatewayHeaders(token),
    signal: signal || AbortSignal.timeout(20_000),
  })
  const j = await r.json().catch(() => null)
  const innerStatus = j?.data?.status ?? j?.status
  const innerMsg = String(j?.data?.message || j?.message || j?.msg || "")
  if (!r.ok || innerStatus === 401 || /auth failed|ssoid/i.test(innerMsg)) {
    const e = new Error(`妙手积分被拒 HTTP ${r.status}${innerMsg ? "：" + innerMsg : ""}`)
    if (r.status === 401 || r.status === 403 || innerStatus === 401 || /auth failed|ssoid|重新登录/i.test(innerMsg)) e.loginRequired = true
    throw e
  }
  const d = j.data || {}
  const plan = d.userPlan || {}
  return {
    remaining: Math.round((Number(d.availableCredits) || 0) * 100) / 100,
    // plan.name 是归一化字段（上游叫 planName），调用方统一用 name
    plan: { ...plan, name: String(plan.planName || "") },
  }
}

export async function currentUser(token, signal) {
  const r = await fetch(`${GATEWAY}${P.currentUser}`, {
    headers: gatewayHeaders(token),
    signal: signal || AbortSignal.timeout(20_000),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j || j.code !== 0) {
    const msg = String((j && (j.message || j.msg)) || `HTTP ${r.status}`)
    return { ok: false, message: msg }
  }
  return { ok: true, data: j.data || {} }
}

export async function checkAccount(token) {
  if (!token) return { ok: false, detail: "没有可用 token" }
  try {
    const u = await currentUser(token)
    if (!u.ok) return { ok: false, detail: `网关鉴权失败：${u.message}` }
    let extra = ""
    try {
      const ms = await listModels(token)
      extra = `，${ms.length} 个模型`
    } catch { /* 模型清单读不到不影响可用性判断 */ }
    try {
      const q = await quota(token)
      extra += `，余额 ${q.remaining} 分${q.plan?.name ? "（" + q.plan.name + "）" : ""}`
    } catch { /* 余额读不到不影响可用性判断 */ }
    const nm = String(u.data?.userName || "")
    return {
      ok: true,
      detail: `凭据有效${nm ? "（" + nm + "）" : ""}${extra}`,
      // 上层存账号时要用：GUI 上显示成名字比显示成一串 id 好认
      name: nm,
      uid: String(u.data?.userId || u.data?.uid || ""),
    }
  } catch (e) {
    return { ok: false, detail: e.message }
  }
}

// ---- 三段式对话 ----------------------------------------------------------------

async function waitChatPersisted(token, chatId, maxMs, stepMs, signal) {
  const t0 = Date.now()
  let polls = 0
  let last = { status: 0, raw: "" }
  for (;;) {
    polls += 1
    try {
      const r = await fetch(`${NOCODE}${P.chatDetail}?chatId=${encodeURIComponent(chatId)}`, {
        headers: nocodeHeaders(token),
        signal: AbortSignal.timeout(Math.min(8000, maxMs)),
      })
      const txt = await r.text().catch(() => "")
      let jj = null
      try { jj = JSON.parse(txt) } catch {}
      last = { status: r.status, raw: txt.slice(0, 200) }
      if (r.ok && jj && jj.code === 0 && jj.data && jj.data.id != null && jj.data.id !== "") {
        return { id: jj.data.id, waitedMs: Date.now() - t0, polls, last }
      }
    } catch (e) {
      if (isAbort(e)) throw e
      last = { status: -1, raw: e.message }
    }
    if (Date.now() - t0 >= maxMs) return { id: null, waitedMs: Date.now() - t0, polls, last }
    await gap(stepMs)
  }
}

async function cancelStream(token, streamMessageId) {
  const s = String(streamMessageId || "").trim()
  if (!s) return
  try {
    await fetch(`${NOCODE}${P.chatCancelStream}?messageId=${encodeURIComponent(s)}`, {
      method: "POST",
      headers: nocodeHeaders(token),
      body: "{}",
      signal: AbortSignal.timeout(8000),
    })
  } catch { /* 尽力取消 */ }
}

// 事件流 → OpenAI chat.completion.chunk SSE
function openAiStream(events, model, { prompt = "", onUsage } = {}) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`
  const created = Math.floor(Date.now() / 1000)
  const enc = new TextEncoder()
  let sentRole = false
  let respChars = 0

  const sseChunk = (payload) => `data: ${JSON.stringify(payload)}\n\n`
  const head = (role) => sseChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: role, finish_reason: null }] })
  const delta = (d) => sseChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: d, finish_reason: null }] })

  async function pump(controller) {
    const reader = events.body && events.body.getReader ? events.body.getReader() : null
    if (!reader) {
      controller.enqueue(enc.encode(sseChunk({ error: { message: "妙手事件流为空", type: "upstream_error" } })))
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
      return
    }
    const dec = new TextDecoder()
    let buf = ""
    let closed = false
    const finish = (why) => {
      if (closed) return
      closed = true
      if (!sentRole) { controller.enqueue(enc.encode(head({ role: "assistant" }))); sentRole = true }
      controller.enqueue(enc.encode(delta({})))
      const estPrompt = estimateTokens(prompt)
      // estimateTokens 接收文本：respChars 是累计字符数，用等长 ASCII 串代入
      //（字符数 ÷ 4 = 估算 token，与 CJK 混排的实际值误差可接受，且不虚高）
      const estCompletion = respChars > 0 ? estimateTokens("x".repeat(Math.min(respChars, 1_000_000))) : 0
      const usage = {
        prompt_tokens: estPrompt,
        completion_tokens: Math.max(1, estCompletion),
        total_tokens: estPrompt + Math.max(1, estCompletion),
        estimated: true,
      }
      controller.enqueue(enc.encode(sseChunk({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: why || "stop" }], usage })))
      controller.enqueue(enc.encode("data: [DONE]\n\n"))
      controller.close()
      if (onUsage) onUsage(usage)
      // cancel 返回 Promise：abort 打断底层流时它会以 AbortError reject ——
      // try/catch 只接同步异常，必须 .catch() 吃掉异步拒绝（否则 unhandledRejection）
      reader.cancel().catch(() => { /* 已结束 */ })
    }
    const emit = (d) => {
      if (!sentRole) { controller.enqueue(enc.encode(head({ role: "assistant" }))); sentRole = true }
      controller.enqueue(enc.encode(delta(d)))
    }

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) { finish("stop"); return }
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          for (const line of block.split("\n")) {
            const raw = line.startsWith("data:") ? line.slice(5).trim() : ""
            if (!raw) continue
            let j = null
            try { j = JSON.parse(raw) } catch { continue }
            if (!j || typeof j !== "object") continue

            if (typeof j.statusUpdate === "string" && TERMINAL_STATUS.has(j.statusUpdate)) {
              if (ERROR_STATUS.has(j.statusUpdate) && !sentRole) {
                controller.enqueue(enc.encode(sseChunk({ error: { message: `妙手上游以 ${j.statusUpdate} 结束`, type: "upstream_error" } })))
              }
              finish("stop")
              return
            }

            const resp = j.headlessRemoteAgentResp
            if (!resp || typeof resp !== "object") continue
            if (resp.currentStatus && ERROR_STATUS.has(String(resp.currentStatus))) {
              controller.enqueue(enc.encode(sseChunk({ error: { message: `妙手上游状态：${resp.currentStatus}`, type: "upstream_error" } })))
              finish("stop")
              return
            }
            const msg = resp.message
            if (!msg || typeof msg !== "object") continue
            if (resp.isHistoryMessage === true) continue
            if (msg.type && msg.type !== "assistant") continue

            const parts = Array.isArray(msg.content) ? msg.content : []
            for (const c of parts) {
              if (!c || typeof c !== "object") continue
              const t = String(c.type || "")
              if (t === "text") {
                const txt = c.text ? String(c.text) : ""
                if (txt) { respChars += txt.length; emit({ content: txt }) }
              } else if (t === "reasoning" || t === "thinking" || t === "reasoning_content" || t === "reasoningContent") {
                const txt = String(c.text || c.reasoning || c.thinking || "")
                if (txt) { respChars += txt.length; emit({ reasoning_content: txt }) }
              }
            }
          }
        }
      }
    } catch (e) {
      if (!closed) {
        controller.enqueue(enc.encode(sseChunk({ error: { message: `妙手事件流中断：${e.message}`, type: "upstream_error" } })))
        finish("stop")
      }
    }
  }

  const stream = new ReadableStream({ start: pump })
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

/**
 * 三段式 chat：OpenAI /chat/completions 请求 → 妙手会话 → OpenAI SSE 响应。
 * 返回的 Response 挂了 __session（{ streamMessageId }），宿主在客户端断开时
 * 调 cancelUpstream 取消，避免「没人看还在烧积分」。
 */
export async function chat(token, body, signal) {
  // 有些 agent 会把渠道前缀一起传（"meituan/glm-5.3-flash"）——剥掉再交给上游
  const model = String((body && body.model) || "").trim().replace(/^meituan\//i, "") || DEFAULT_MODEL
  const prompt = promptFromMessages(body && body.messages)
  if (!prompt) {
    return new Response(JSON.stringify({ error: { message: "messages must include a user turn", type: "invalid_request_error" } }),
      { status: 400, headers: { "Content-Type": "application/json" } })
  }
  const timeout = signal || AbortSignal.timeout(TURN_TIMEOUT_MS)
  const rlKey = String(token).slice(-12)
  const rlUntil = RATE_LIMIT_UNTIL.get(rlKey) || 0
  if (rlUntil > Date.now()) {
    const left = Math.ceil((rlUntil - Date.now()) / 1000)
    return new Response(JSON.stringify({
      error: {
        message: `妙手刚才对本账号限流了，还需等约 ${left} 秒（上游建会话频率限制，实测冷却约 40 秒），不是渠道配置问题。`,
        type: "rate_limit_error",
        retry_after_sec: left,
      },
    }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(left) } })
  }

  const failures = []
  let picked = null

  for (let round = 1; round <= ATTEMPTS; round += 1) {
    const chatId = newChatId()

    // ① 建会话
    let created
    try {
      created = await fetch(`${NOCODE}${P.chatCreate}`, {
        method: "POST",
        headers: nocodeHeaders(token),
        body: JSON.stringify({ chatId, source: "catdesk", prompt, images: [], files: [], type: "COMMON", techStackTemplateId: "default", isAgent: true }),
        signal: timeout,
      })
    } catch (e) {
      if (isAbort(e)) throw e
      failures.push(`第${round}轮建会话网络错误：${e.message}`)
      await gap(RETRY_GAP_MS * round)
      continue
    }
    const cj = await created.json().catch(() => null)
    const createMsg = String((cj && (cj.msg || cj.message)) || "")

    if (created.status === 429 || /refus|rate.?limit|too many/i.test(createMsg)) {
      RATE_LIMIT_UNTIL.set(rlKey, Date.now() + RATE_LIMIT_MS)
      return new Response(JSON.stringify({
        error: {
          message: `妙手限制建会话频率（HTTP 429${createMsg ? " " + createMsg : ""}），实测需要等约 40 秒。刚发过几次请求的话等半分钟再发即可。`,
          type: "rate_limit_error",
          retry_after_sec: 45,
        },
      }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": "45" } })
    }
    if (!created.ok || !cj || cj.code !== 0) {
      // 凭据类失败（401/403/SSO 过期）不该重试第二轮 —— 直接以 loginRequired 抛出，
      // 宿主会转成 401 + sign-in expired，让 magpie 提示重新登录而不是干等
      const innerStatus = cj?.data?.status ?? cj?.status
      const authFail = created.status === 401 || created.status === 403 || innerStatus === 401
        || /auth failed|ssoid|重新登录|过期|expire/i.test(createMsg)
      if (authFail) {
        const e = new Error(`妙手登录态已失效：${createMsg || `HTTP ${created.status}`}`)
        e.loginRequired = true
        throw e
      }
      failures.push(`第${round}轮建会话失败：${createMsg || `HTTP ${created.status}`}`)
      await gap(RETRY_GAP_MS * round)
      continue
    }

    // ①b 等落库（create 异步落库，不等到 data.id 就触发必炸上游 NPE）
    const persisted = await waitChatPersisted(token, chatId, PERSIST_WAIT_MS, PERSIST_STEP_MS, timeout)
    if (!persisted.id) {
      failures.push(`第${round}轮建会话后记录未落库（轮询 ${persisted.polls} 次 / ${persisted.waitedMs}ms）`)
      await gap(RETRY_GAP_MS * round)
      continue
    }
    // 落库成功后 agent 才 abort 的话，这条 chat 已占「同账号单会话」名额但未触发
    // agent（不烧积分）；不额外取消——下次 create 会换新 id。

    // ② 触发 agent
    const now = Date.now()
    let triggered
    try {
      triggered = await fetch(`${NOCODE}${P.chatAgentStream}`, {
        method: "POST",
        headers: nocodeHeaders(token),
        body: JSON.stringify({
          chatId,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }], createTime: new Date(now).toISOString() }],
          files: [], urls: [], model, manualToolName: "", toolMessageId: "",
          isAgent: true, currentPath: "/", techStackTemplateId: "default",
          sourcePlatform: "web", isImportProject: false, frontCreateTime: now,
        }),
        signal: timeout,
      })
    } catch (e) {
      if (isAbort(e)) {
        // abort 时可能刚拿到 streamMessageId 却没来得及走到 picked 赋值——
        // 上游此刻可能已经在跑，尽力取消一次（幂等）
        try {
          const tj = await triggered.json().catch(() => null)
          const smid = String(tj?.data?.streamMessageId || "")
          if (smid) await cancelStream(token, smid)
        } catch { /* 尽力 */ }
        throw e
      }
      failures.push(`第${round}轮触发 agent 网络错误：${e.message}`)
      await gap(RETRY_GAP_MS * round)
      continue
    }
    const tj = await triggered.json().catch(() => null)
    if (!triggered.ok || !tj || tj.code !== 0) {
      const msg = String((tj && (tj.msg || tj.message)) || `HTTP ${triggered.status}`)
      failures.push(`第${round}轮触发 agent 失败：${msg}`)
      await gap(RETRY_GAP_MS * round)
      continue
    }
    const d = tj.data || {}
    const conv = String(d.conversationId || "")
    const smid = String(d.streamMessageId || "")
    if (conv) { picked = { chatId, conversationId: conv, streamMessageId: smid }; break }

    const errMsg = String(d.errorMessage || "")
    failures.push(`第${round}轮触发无 conversationId${d.errorCode ? `（errorCode=${d.errorCode}）` : ""}${errMsg ? `：${cardText(errMsg)}` : ""}`)
    if (smid) await cancelStream(token, smid)
    await gap(RETRY_GAP_MS * round)
  }

  if (!picked) {
    const detail = failures.join("；")
    const hint = /无 conversationId/.test(detail)
      ? "多半是同一账号已有一路 agent 会话在跑（妙手同一时刻只跑一个），等上一路结束后重试即可。"
      : "稍后重试通常可恢复。"
    return new Response(JSON.stringify({
      error: { message: `妙手连续 ${ATTEMPTS} 轮未取到会话：${detail}。${hint}`, type: "upstream_error" },
    }), { status: 502, headers: { "Content-Type": "application/json" } })
  }

  const { conversationId, streamMessageId, chatId } = picked
  const events = await fetch(`${STREAM}${P.streamConnect}`, {
    method: "POST",
    headers: streamHeaders(token, true),
    body: JSON.stringify({ timestamp: Date.now(), conversationId, messageIndex: 0, incrementalOnly: true }),
    signal: timeout,
  })
  if (!events.ok) return events

  const resp = openAiStream(events, model, { prompt })
  resp.__session = { streamMessageId, chatId, conversationId }
  return resp
}

export async function cancelUpstream(token, streamMessageId) {
  await cancelStream(token, streamMessageId)
}

// ---- Test hooks ---------------------------------------------------------------

export const _internal = {
  estimateTokens,
  promptFromMessages,
  newChatId,
  gatewayHeaders,
  nocodeHeaders,
  streamHeaders,
  meituanAuthPath,
  confOfDefaults: FALLBACK_MODELS,
}
