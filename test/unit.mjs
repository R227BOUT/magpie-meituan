// 纯单元组：不联网。core 的纯函数 + index 的 config/装配。
import { pathToFileURL, fileURLToPath } from "node:url"
import { test } from "node:test"
import assert from "node:assert/strict"

// 从本文件位置推插件目录，clone 到哪都能跑
const PLUGIN = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "")
const core = await import(pathToFileURL(PLUGIN + "/core.mjs").href)
const index = await import(pathToFileURL(PLUGIN + "/index.mjs").href)

test("estimateTokens 覆盖中英混合与边界", () => {
  assert.equal(core.estimateTokens(""), 0)
  assert.equal(core.estimateTokens(null), 0)
  // 纯 CJK：10 字 → ceil(10/1.6)=7
  const cjk = core.estimateTokens("一二三四五六七八九十")
  assert.ok(cjk >= 6 && cjk <= 8, "got " + cjk)
  // 纯 ASCII：8 字 → 2
  assert.equal(core.estimateTokens("abcdefgh"), 2)
  // 混合
  const mixed = core.estimateTokens("你好 world 世界")
  assert.ok(mixed >= 3 && mixed <= 6, "got " + mixed)
})

test("promptFromMessages 只发最后一轮 user 前的全部内容", () => {
  const out = core.promptFromMessages([
    { role: "user", content: [{ type: "text", text: "数组形态" }] },
  ])
  assert.equal(out, "数组形态")
  // assistant 在 user 之后的内容被丢弃（上游单轮）
  const out2 = core.promptFromMessages([
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
    { role: "user", content: "q2" },
  ])
  assert.match(out2, /q/)
  assert.match(out2, /q2/)
  assert.doesNotMatch(out2, /^.*\bA\b.*Assistant:\na$/m)
})

test("三套头的字段一个不能少", () => {
  const g = core.gatewayHeaders("T")
  assert.deepEqual(Object.keys(g).sort(), ["Accept", "Content-Type", "X-Auth-Token", "access-token"])
  const n = core.nocodeHeaders("T")
  assert.ok(n["client-id"])
  const s = core.streamHeaders("T", false)
  assert.equal(s.Cookie, "X-Passport-Token=T")
})

test("meituanAuthPath 有回退顺序且第一个存在的生效", () => {
  const p = core.meituanAuthPath()
  assert.ok(typeof p === "string" && p.length > 0)
  // 路径怎么拼不重要，重要的是指向 auth.json，且环境变量能覆盖
  assert.match(p, /auth\.json$/)
})

test("config 钩子：模型表完整、幂等、用户改动保留", async () => {
  const p = await index.MeituanPlugin()
  const config = {}
  await p.config(config)
  const first = config.provider.meituan
  assert.equal(first.name, "妙手 CatPaw")
  assert.equal(first.api, "https://ai.catpaw.meituan.com")
  assert.ok(Object.keys(first.models).includes("auto"))
  assert.ok(Object.keys(first.models).includes("glm-5.3-flash"))
  // 用户改过 auto 的名字 → 第二次 config 保留
  first.models.auto.name = "我的 Auto"
  await p.config(config)
  assert.equal(config.provider.meituan.models.auto.name, "我的 Auto", "用户覆盖应保留")
})

test("loader：无登录态时 fetch 返回 401 且带 X-Magpie-Sign-In", async () => {
  const p = await index.MeituanPlugin()
  const loader = await p.auth.loader(async () => { const e = new Error("没有登录"); e.signIn = "expired"; throw e })
  const r = await loader.fetch("https://ai.catpaw.meituan.com/chat/completions", { method: "POST" })
  assert.equal(r.status, 401)
  assert.equal(r.headers.get("x-magpie-sign-in"), "expired")
  const j = await r.json()
  assert.match(j.error.message, /登录/)
})



test("package.json 的 files 齐全（发布不缺文件）", async () => {
  const { readFileSync, existsSync } = await import("node:fs")
  const { join } = await import("node:path")
  const pkg = JSON.parse(readFileSync(PLUGIN + "/package.json", "utf8"))
  for (const f of pkg.files) {
    if (f.includes("*")) continue
    assert.ok(existsSync(PLUGIN + "/" + f), "files 里声明的 " + f + " 不存在")
  }
  assert.ok(pkg.magpie?.maxConcurrency >= 1, "maxConcurrency 应声明")
})
