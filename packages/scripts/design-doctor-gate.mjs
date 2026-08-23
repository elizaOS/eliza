/**
 * Design gate over react-doctor's focused UI diagnostics. Runs
 * `react-doctor design` on the repository, compares the per-rule warning
 * counts against the committed baseline, and fails when any rule GROWS.
 * Shrinking is rewarded: pass `--update-baseline` in the same PR that cleans
 * surfaces to ratchet the allowance down. Errors from the underlying tool's
 * TypeScript parse (rule id "1354") are ignored — they are parser noise on
 * non-React scripts, not design findings.
 *
 * The npx invocation runs from a temp cwd because the repository's root
 * package.json `overrides` conflict with react-doctor's own dependency tree
 * when npm resolves from inside the workspace.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../..", "..");
const BASELINE_PATH = join(REPO_ROOT, "packages/scripts/design-doctor-baseline.json");
const PARSER_NOISE_RULES = new Set(["1354"]);

const updateBaseline = process.argv.includes("--update-baseline");

const runDir = mkdtempSync(join(tmpdir(), "design-doctor-"));
const reportPath = join(runDir, "report.json");

console.log("[design-doctor-gate] running react-doctor design (this takes a few minutes)…");
try {
  execFileSync(
    "npx",
    [
      "-y",
      "react-doctor@latest",
      "--json",
      "--json-out",
      reportPath,
      "--no-telemetry",
      "--no-color",
      "-y",
      "design",
      REPO_ROOT,
    ],
    { cwd: runDir, stdio: ["ignore", "inherit", "inherit"], timeout: 30 * 60 * 1000 },
  );
} catch (error) {
  // react-doctor exits 1 when error-severity diagnostics exist; the report is
  // still written. Only a missing report is a real failure.
  // error-policy:J1 boundary translation: a missing report becomes a failed gate below.
  void error;
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch {
  // error-policy:J1 boundary translation: the gate is the process boundary.
  console.error("[design-doctor-gate] react-doctor produced no report — treat as failure");
  process.exit(1);
}

const counts = {};
for (const diagnostic of report.diagnostics ?? []) {
  if (PARSER_NOISE_RULES.has(diagnostic.rule)) continue;
  counts[diagnostic.rule] = (counts[diagnostic.rule] ?? 0) + 1;
}

if (updateBaseline) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`[design-doctor-gate] baseline updated: ${Object.keys(sorted).length} rules, ${Object.values(sorted).reduce((a, b) => a + b, 0)} findings`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
} catch {
  // error-policy:J1 boundary translation: missing baseline is an explicit setup failure.
  console.error(`[design-doctor-gate] no baseline at ${BASELINE_PATH} — run with --update-baseline first`);
  process.exit(1);
}

const regressions = [];
const improvements = [];
for (const [rule, count] of Object.entries(counts)) {
  const allowed = baseline[rule] ?? 0;
  if (count > allowed) regressions.push(`${rule}: ${count} > baseline ${allowed}`);
  else if (count < allowed) improvements.push(`${rule}: ${count} (baseline ${allowed})`);
}
for (const rule of Object.keys(baseline)) {
  if (!(rule in counts) && baseline[rule] > 0) improvements.push(`${rule}: 0 (baseline ${baseline[rule]})`);
}

if (improvements.length > 0) {
  console.log(`[design-doctor-gate] ${improvements.length} rules improved — ratchet down with --update-baseline in this PR:`);
  for (const line of improvements) console.log(`  ↓ ${line}`);
}
if (regressions.length > 0) {
  console.error(`[design-doctor-gate] FAIL — ${regressions.length} rules regressed past the baseline:`);
  for (const line of regressions) console.error(`  ↑ ${line}`);
  process.exit(1);
}
console.log("[design-doctor-gate] PASS — no design rule regressed");
