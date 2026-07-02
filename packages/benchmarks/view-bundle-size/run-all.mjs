/**
 * View-bundle-size orchestrator (#10724).
 *
 * Spawns the measuring harness (`bundle-size-kpi.mjs`), then reads the recorded
 * `results/view-bundle-size/latest.json` and writes a consolidated dashboard
 * under `results/summary/`. Mirrors the memperf/loadperf orchestrators.
 *
 *   node packages/benchmarks/view-bundle-size/run-all.mjs
 *   node packages/benchmarks/view-bundle-size/run-all.mjs --json
 *   node packages/benchmarks/view-bundle-size/run-all.mjs --no-build   # measure an existing build
 *
 * Exit codes mirror the harness:
 *   0  all budgets pass
 *   1  a bundle (or the total) exceeded budget — regression → fails CI (the gate)
 *   2  nothing measurable (no view bundle built on this host) → skip
 */

import { spawnSync } from "node:child_process";
import {
  HERE,
  join,
  kb,
  mkdirSync,
  RESULTS_ROOT,
  readLatest,
  writeFileSync,
} from "./lib.mjs";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");
// Pass through the harness flags (everything except our own --json handling).
const PASSTHROUGH = process.argv.slice(2).filter((a) => a !== "--json");

function runHarness() {
  const res = spawnSync(
    process.execPath,
    [join(HERE, "bundle-size-kpi.mjs"), ...PASSTHROUGH],
    {
      stdio: JSON_ONLY ? ["ignore", "ignore", "inherit"] : "inherit",
      env: process.env,
    },
  );
  if (res.error) {
    console.error(
      `[view-bundle-size] failed to spawn harness: ${res.error.message}`,
    );
    return 1;
  }
  return res.status ?? 1;
}

function renderMarkdown(rec, status) {
  const lines = [];
  lines.push("# View-Bundle-Size Dashboard (#10724)");
  lines.push("");
  lines.push(`Generated: ${NOW}`);
  lines.push("");
  lines.push(`Status: **${status.toUpperCase()}**`);
  lines.push("");

  if (!rec) {
    lines.push("_no result recorded._");
    lines.push("");
    return lines.join("\n");
  }

  const s = rec.summary ?? {};
  lines.push("## Summary");
  lines.push("");
  lines.push(`- target: ${rec.target ?? "?"}`);
  lines.push(
    `- measured: ${s.measuredBundles ?? 0} / ${s.expectedBundles ?? "?"} bundles` +
      (s.skippedBundles ? ` (${s.skippedBundles} did not build)` : ""),
  );
  if ((s.measuredBundles ?? 0) > 0) {
    lines.push(
      `- total: ${kb(s.totalGzipBytes)} gzip / ${kb(s.totalRawBytes)} raw` +
        (s.totalGzipBudgetBytes != null
          ? ` (budget ${kb(s.totalGzipBudgetBytes)} gzip)`
          : ""),
    );
  }
  lines.push("");

  const byName = new Map((rec.checks ?? []).map((c) => [c.name, c]));
  lines.push("## Per bundle (gzip)");
  lines.push("");
  lines.push("| bundle | gzip | budget | raw | result |");
  lines.push("| --- | --- | --- | --- | --- |");
  const sorted = [...(rec.bundles ?? [])].sort(
    (a, z) => (z.gzipBytes ?? -1) - (a.gzipBytes ?? -1),
  );
  for (const b of sorted) {
    const c = byName.get(b.name);
    const result = !b.measured
      ? c
        ? "FAIL (no build)"
        : "skip (no build)"
      : c
        ? c.pass
          ? "PASS"
          : "FAIL"
        : "— (no budget)";
    lines.push(
      `| ${b.name} | ${kb(b.gzipBytes)} | ${c?.budget != null ? kb(c.budget) : "—"} | ${kb(b.rawBytes)} | ${result} |`,
    );
  }
  const totalCheck = byName.get("total.gzipBytes");
  if (totalCheck) {
    lines.push(
      `| **total** | ${kb(totalCheck.gzipBytes)} | ${kb(totalCheck.budget)} | — | ${totalCheck.pass ? "PASS" : "FAIL"} |`,
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Budgets live in `budgets.json` (gzipped bytes, level 9). Ratchet `gzipBudgetBytes` down as views shrink.",
  );
  lines.push("");
  return lines.join("\n");
}

function main() {
  if (!JSON_ONLY) console.log(">>> view-bundle-size");
  const code = runHarness();
  const status = code === 0 ? "pass" : code === 2 ? "skipped" : "fail";

  const rec = readLatest("view-bundle-size");
  const summaryDir = join(RESULTS_ROOT, "summary");
  mkdirSync(summaryDir, { recursive: true });
  const stamp = NOW.replace(/[:.]/g, "-");
  const summary = {
    recordedAt: NOW,
    status,
    exitCode: code,
    viewBundleSize: rec,
  };
  writeFileSync(
    join(summaryDir, `${stamp}.json`),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(summaryDir, "latest.json"),
    JSON.stringify(summary, null, 2),
  );
  const md = renderMarkdown(rec, status);
  writeFileSync(join(summaryDir, `${stamp}.md`), md);
  writeFileSync(join(summaryDir, "latest.md"), md);

  if (JSON_ONLY) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(md);
    console.log(`dashboard -> ${join(summaryDir, "latest.md")}`);
  }
  // Propagate the harness exit code so CI gates on it directly.
  process.exit(code);
}

main();
