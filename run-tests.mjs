// 测试跑法：node run-tests.mjs [--quick]
// --quick 只跑不需要网络的单元组；默认全部（含真机端到端）。

const { spawnSync } = await import("node:child_process")
const { join, dirname } = await import("node:path")
const { fileURLToPath } = await import("node:url")

const HERE = dirname(fileURLToPath(import.meta.url))
const quick = process.argv.includes("--quick")

const suites = quick
  ? ["test/unit.mjs"]
  : ["test/unit.mjs", "test/e2e.mjs"]

let pass = 0, fail = 0, suitesOk = 0
for (const s of suites) {
  const r = spawnSync(process.execPath, [join(HERE, s)], { encoding: "utf8", timeout: 300_000 })
  const out = (r.stdout || "") + (r.stderr || "")
  const name = s.replace("test/", "").replace(".mjs", "")
  const pm = out.match(/# pass (\d+)/)
  const fm = out.match(/# fail (\d+)/)
  const p = pm ? Number(pm[1]) : 0
  const f = fm ? Number(fm[1]) : 1
  pass += p
  fail += f
  if (f === 0 && r.status === 0) suitesOk++
  const flag = f === 0 && r.status === 0 ? "✓" : "✗"
  console.log(`${flag} ${name.padEnd(12)} ${p} pass ${f} fail`)
  if (f > 0 || r.status !== 0) {
    // 失败时把 TAP 输出的失败段打出来
    for (const line of out.split("\n")) {
      if (/^not ok|error:|actual|expected/.test(line)) console.log("   " + line.trim().slice(0, 200))
    }
  }
}
console.log("─".repeat(40))
console.log(`合计: ${pass} pass, ${fail} fail, ${suitesOk}/${suites.length} 套件`)

// 发布前的脱敏闸门：拿本机真实凭据/身份比对全部受控文件。
// 单独跑、不占 pass/fail 计数，但不干净就让整轮失败——省得改完代码
// 顺手把调试用的真实路径带进提交。
const sec = spawnSync(process.execPath, [join(HERE, "tools/check-secrets.mjs"), "--all"], {
  encoding: "utf8", timeout: 60_000,
})
const secOut = ((sec.stdout || "") + (sec.stderr || "")).trim()
if (sec.status === 0) {
  console.log("✓ secrets      脱敏检查通过")
} else {
  fail++
  console.log("✗ secrets      脱敏检查不通过")
  for (const line of secOut.split("\n")) {
    if (line.includes("✗") || line.includes("发现")) console.log("   " + line.trim())
  }
}

process.exit(fail > 0 ? 1 : 0)
