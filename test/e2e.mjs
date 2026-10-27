// 真机端到端：读本机妙手登录态，逐个端点真打（只读端点为主；chat 只发一条
// 极短消息并取消，烧掉的积分可以忽略）。没有登录态时整组跳过（不是失败）。
import { pathToFileURL, fileURLToPath } from "node:url"
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"

// 从本文件位置推插件目录，clone 到哪都能跑
const PLUGIN = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "")

const core = await import(pathToFileURL(PLUGIN + "/core.mjs").href)
const index = await import(pathToFileURL(PLUGIN + "/index.mjs").href)
const authPath = core.meituanAuthPath()
const hasAuth = existsSync(authPath) && !!core.readDesktopLogin()

function freshToken() {
  const d = core.readDesktopLogin()
  return d ? d.token : ""
}

test("桌面登录读取：文件在时给出 token 与账号", () => {
  if (!hasAuth) return
  const d = core.readDesktopLogin()
  assert.ok(d, "readDesktopLogin 应返回登录态")
  assert.ok(d.token.length >= 100, "accessToken 应是长串")
  assert.ok(d.uid, "uid 应非空")
})

test("三套请求头的形状", () => {
  const g = core.gatewayHeaders("T")
  assert.equal(g["X-Auth-Token"], "T")
  assert.equal(g["access-token"], "T")
  const n = core.nocodeHeaders("T")
  assert.equal(n["access-token"], "T")
  assert.equal(n["client-id"], "2f73f89b68")
  const s = core.streamHeaders("T", true)
  assert.equal(s["X-Passport-Token"], "T")
  assert.equal(s.Cookie, "X-Passport-Token=T")
  assert.equal(s.Accept, "text/event-stream")
})

test("estimateTokens：中文按 1.6 字/tok，英文按 4 字/tok", () => {
  const cjk = core.estimateTokens("一二三四五六七八九十") // 10 个 CJK → ~6
  assert.ok(cjk >= 5 && cjk <= 7, "10 CJK → 5~7, got " + cjk)
  const en = core.estimateTokens("abcdefgh") // 8 个非 CJK → 2
  assert.equal(en, 2)
  assert.equal(core.estimateTokens(""), 0)
})

test("promptFromMessages：单条 user 原样，多轮拼接", () => {
  assert.equal(core.promptFromMessages([{ role: "user", content: "你好" }]), "你好")
  const multi = core.promptFromMessages([
    { role: "system", content: "S" },
    { role: "user", content: "U1" },
    { role: "assistant", content: "A" },
    { role: "user", content: "U2" },
  ])
  assert.match(multi, /System:\nS/)
  assert.match(multi, /User:\nU1/)
  assert.match(multi, /Assistant:\nA/)
  assert.match(multi, /User:\nU2/)
  assert.equal(core.promptFromMessages([]), "")
})

test("newChatId：desk- 前缀且不重复", () => {
  const a = core.newChatId(), b = core.newChatId()
  assert.match(a, /^desk-[0-9a-f]{16}$/)
  assert.notEqual(a, b)
})

// ---- 真机（需要登录态）----

test("真机：模型清单 model-types", { skip: !hasAuth && "本机没有妙手登录态" }, async () => {
  const tok = freshToken()
  const ms = await core.listModels(tok)
  assert.ok(ms.length >= 8, "至少 8 个模型，got " + ms.length)
  const auto = ms.find((m) => m.id === "auto")
  assert.ok(auto, "应有 auto 兜底")
  const flash = ms.find((m) => m.id === "glm-5.3-flash")
  assert.ok(flash, "应有 glm-5.3-flash")
})

test("真机：积分余额 credit/balance", { skip: !hasAuth && "本机没有妙手登录态" }, async () => {
  const tok = freshToken()
  let q = null, lastErr = null
  for (let i = 0; i < 3 && !q; i++) {
    try { q = await core.quota(tok) } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 800)) }
  }
  assert.ok(q, "quota 三次都失败：" + (lastErr && lastErr.message))
  assert.equal(typeof q.remaining, "number")
  assert.ok(q.remaining >= 0)
})

test("真机：当前用户 current-user", { skip: !hasAuth && "本机没有妙手登录态" }, async () => {
  const tok = freshToken()
  const u = await core.currentUser(tok)
  assert.equal(u.ok, true)
})

test("真机：checkAccount 综合体检", { skip: !hasAuth && "本机没有妙手登录态" }, async () => {
  const tok = freshToken()
  const c = await core.checkAccount(tok)
  assert.equal(c.ok, true, c.detail)
  assert.match(c.detail, /凭据有效/)
})

test("真机：过期 token 被识别为 loginRequired（用假 token）", async () => {
  await assert.rejects(
    () => core.listModels("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    (e) => e.loginRequired === true,
  )
})

test("真机：插件 usage 卡片（auth.loader + usage 钩子）", { skip: !hasAuth && "本机没有妙手登录态" }, async () => {
  const p = await index.MeituanPlugin()
  const loader = await p.auth.loader(async () => ({ source: "desktop", access: "old" }))
  assert.equal(typeof loader.fetch, "function")
  // usage 走的是 tokenOf(desktop) → readDesktopLogin 的现值
  const card = await p.auth.usage(async () => ({ source: "desktop" }))
  assert.ok(card.balance && /积分/.test(card.balance), "卡片应有积分余额，got " + JSON.stringify(card).slice(0, 200))
  assert.equal(card.signIn, "kept")
})

test("真机：config 钩子注入 provider 与模型", async () => {
  const p = await index.MeituanPlugin()
  const config = {}
  await p.config(config)
  const prov = config.provider.meituan
  assert.equal(prov.name, "妙手 CatPaw")
  assert.ok(Object.keys(prov.models).length >= 10)
})

test("真机：三段式对话端到端（发一条极短消息，读完即取消）", { skip: !hasAuth && "本机没有妙手登录态", timeout: 120_000 }, async () => {
  const tok = freshToken()
  const resp = await core.chat(tok, {
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "回复一个字：好" }],
  })
  assert.equal(resp.status, 200, "chat 应返回 200")
  assert.match(resp.headers.get("content-type") || "", /text\/event-stream/)
  // 读完流（流内会在终态后自己收尾）
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let text = "", sawUsage = false, sawDone = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const s = dec.decode(value, { stream: true })
    for (const line of s.split("\n")) {
      const raw = line.startsWith("data:") ? line.slice(5).trim() : ""
      if (!raw || raw === "[DONE]") { if (raw === "[DONE]") sawDone = true; continue }
      try {
        const j = JSON.parse(raw)
        if (j.choices?.[0]?.delta?.content) text += j.choices[0].delta.content
        if (j.usage) sawUsage = true
      } catch { /* 跳过 */ }
    }
  }
  assert.ok(text.length > 0, "应有正文，got: " + JSON.stringify({ text, sawUsage, sawDone }).slice(0, 200))
  assert.ok(sawUsage, "应有估算 usage")
  assert.ok(sawDone, "应有 [DONE]")
  // 会话取消（尽力，失败不断言）
  const sid = resp.__session?.streamMessageId
  if (sid) await core.cancelUpstream(tok, sid)
})

test("真机：非流式模式（stream:false）攒全文本", { skip: !hasAuth && "本机没有妙手登录态", timeout: 120_000 }, async () => {
  const p = await index.MeituanPlugin()
  const loader = await p.auth.loader(async () => ({ source: "desktop" }))
  const resp = await loader.fetch("https://ai.catpaw.meituan.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "glm-5.3-flash",
      stream: false,
      messages: [{ role: "user", content: "回复一个字：行" }],
    }),
  })
  assert.equal(resp.status, 200)
  const j = await resp.json()
  assert.equal(j.object, "chat.completion")
  assert.ok(j.choices?.[0]?.message?.content?.length > 0, "应有正文")
  assert.ok(j.usage, "应有 usage")
})
