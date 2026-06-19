/**
 * Run-all orchestrator.
 *
 * Spawns each KPI script as a child process, then reads each KPI's latest.json
 * and writes a consolidated dashboard (markdown + JSON) under results/summary/.
 *
 * KPI selection:
 *   bundle     always run (no server / browser needed)
 *   boot       run unless --no-boot
 *   frontend   run unless --no-frontend
 *   statesync  run only when --statesync is passed (needs a live server)
 *
 *   node packages/benchmarks/loadperf/run-all.mjs
 *   node packages/benchmarks/loadperf/run-all.mjs --no-boot --no-frontend
 *   LOADPERF_BASE_URL=http://127.0.0.1:31337 node ... run-all.mjs --statesync
 *
 * Exit: non-zero if any KPI that actually ran (not skipped) reported a budget
 * failure. Skipped KPIs (exit 2 / { skipped: true }) do not fail the suite.
 */

import { spawnSync } from "node:child_process";
import {
  HERE,
  RESULTS_ROOT,
  readLatest,
  mkdirSync,
  writeFileSync,
  ms,
  kb,
  mb,
  join,
} from "./lib.mjs";

const NOW = new Date().toISOString();

const argv = process.argv.slice(2);
const RUN_BOOT = !argv.includes("--no-boot");
const RUN_FRONTEND = !argv.includes("--no-frontend");
const RUN_STATESYNC = argv.includes("--statesync");

/** kpi -> { script, run } */
const PLAN = [
  { kpi: "bundle", script: "bundle-kpi.mjs", run: true },
  { kpi: "boot", script: "boot-kpi.mjs", run: RUN_BOOT },
  { kpi: "frontend", script: "frontend-kpi.mjs", run: RUN_FRONTEND },
  { kpi: "statesync", script: "statesync-kpi.mjs", run: RUN_STATESYNC },
];

function runKpi(script) {
  const res = spawnSync(process.execPath, [join(HERE, script)], {
    stdio: "inherit",
    env: process.env,
  });
  // exit codes: 0 pass, 1 budget fail, 2 skipped
  return res.status ?? 1;
}

function main() {
  const ran = [];
  for (const { kpi, script, run } of PLAN) {
    if (!run) {
      ran.push({ kpi, status: "off" });
      continue;
    }
    console.log(`\n>>> ${kpi}`);
    const code = runKpi(script);
    const status = code === 0 ? "pass" : code === 2 ? "skipped" : "fail";
    ran.push({ kpi, status, exitCode: code });
  }

  const results = {};
  for (const { kpi } of PLAN) results[kpi] = readLatest(kpi);

  const summary = {
    recordedAt: NOW,
    selection: Object.fromEntries(ran.map((r) => [r.kpi, r.status])),
    kpis: results,
  };

  const summaryDir = join(RESULTS_ROOT, "summary");
  mkdirSync(summaryDir, { recursive: true });
  const stamp = NOW.replace(/[:.]/g, "-");
  writeFileSync(join(summaryDir, `${stamp}.json`), JSON.stringify(summary, null, 2));
  writeFileSync(join(summaryDir, "latest.json"), JSON.stringify(summary, null, 2));

  const md = renderMarkdown(ran, results);
  writeFileSync(join(summaryDir, `${stamp}.md`), md);
  writeFileSync(join(summaryDir, "latest.md"), md);

  console.log(md);
  console.log(`dashboard -> ${join(summaryDir, "latest.md")}`);

  // Fail the suite only when a KPI that actually ran reported a budget failure.
  const anyFail = ran.some((r) => r.status === "fail");
  process.exit(anyFail ? 1 : 0);
}

function checkRow(c) {
  if (c.unit === "ms") return `${c.name}: ${ms(c.value)} / ${ms(c.budget)}`;
  if (c.unit === "MB") return `${c.name}: ${c.value == null ? "—" : `${c.value.toFixed(1)} MB`} / ${c.budget} MB`;
  if (c.unit === "bytes") return `${c.name}: ${c.value == null ? "—" : kb(c.value)} / ${kb(c.budget)}`;
  return `${c.name}: ${c.value ?? "—"} / ${c.budget}`;
}

function renderMarkdown(ran, results) {
  const lines = [];
  lines.push("# Load / Perf KPI Dashboard");
  lines.push("");
  lines.push(`Generated: ${NOW}`);
  lines.push("");

  lines.push("## Status");
  lines.push("");
  lines.push("| KPI | Status |");
  lines.push("| --- | --- |");
  for (const r of ran) {
    const badge = { pass: "PASS", fail: "FAIL", skipped: "skipped", off: "off" }[r.status];
    lines.push(`| ${r.kpi} | ${badge} |`);
  }
  lines.push("");

  for (const r of ran) {
    const rec = results[r.kpi];
    lines.push(`## ${r.kpi}`);
    lines.push("");
    if (r.status === "off") {
      lines.push("_not selected this run._");
      lines.push("");
      continue;
    }
    if (!rec) {
      lines.push("_no result recorded._");
      lines.push("");
      continue;
    }
    if (rec.skipped) {
      lines.push(`_skipped: ${rec.error ?? "unavailable"}_`);
      lines.push("");
      continue;
    }
    const s = rec.summary ?? {};
    if (r.kpi === "bundle") {
      lines.push(`- total brotli: ${mb(s.totalBrotli ?? 0)} across ${s.assetCount ?? "?"} assets`);
      lines.push(`- initial entry: ${kb(s.initialEntryBrotli ?? 0)} (${(s.initialEntryFiles ?? []).join(", ") || "?"})`);
      if (s.largestChunk) lines.push(`- largest chunk: ${s.largestChunk.name} ${kb(s.largestChunk.brotli)}`);
      lines.push(`- duplicate waste: ${mb(s.duplicateWastedBrotli ?? 0)}`);
    } else if (r.kpi === "boot") {
      lines.push(`- mode: ${s.mode ?? "?"}`);
      lines.push(`- ready: ${ms(s.readyMs)}`);
      lines.push(`- peak RSS: ${s.peakRssMb == null ? "—" : `${s.peakRssMb} MB`}`);
    } else if (r.kpi === "frontend") {
      lines.push(`- FCP: ${ms(s.fcpMs)}  LCP: ${ms(s.lcpMs)}  CLS: ${(s.cls ?? 0).toFixed?.(3) ?? s.cls}`);
      lines.push(`- JS transferred: ${kb(s.jsTransferredBytes ?? 0)} over ${s.requestCount ?? "?"} requests`);
      lines.push(`- long tasks: ${ms(s.longTasksMs)}`);
    } else if (r.kpi === "statesync") {
      lines.push(`- clients: ${s.clients ?? "?"}  broadcasts: ${s.broadcastsObserved ?? "?"}`);
      lines.push(`- skew p50/p95: ${ms(s.skewP50Ms)} / ${ms(s.skewP95Ms)}`);
      lines.push(`- desync events: ${s.desyncEvents ?? "?"}  reconnect: ${ms(s.reconnectMs)}`);
    }
    lines.push("");
    if (Array.isArray(rec.checks) && rec.checks.length) {
      lines.push("Budget checks:");
      lines.push("");
      for (const c of rec.checks) {
        lines.push(`- ${c.pass ? "PASS" : "FAIL"} ${checkRow(c)}`);
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push("Budgets are defined in `budgets.json`. Ratchet them down as optimizations land.");
  lines.push("");
  return lines.join("\n");
}

main();
