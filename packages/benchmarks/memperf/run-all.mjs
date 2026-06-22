/**
 * Memperf orchestrator (#8809).
 *
 * Spawns the measuring harness (`memperf-kpi.ts`) under
 * `bun --conditions=eliza-source` (it imports the real
 * `@elizaos/plugin-local-inference` services), then reads the recorded
 * `results/memperf/latest.json` and writes a consolidated dashboard under
 * `results/summary/`.
 *
 *   node packages/benchmarks/memperf/run-all.mjs
 *   node packages/benchmarks/memperf/run-all.mjs --json
 *
 * Exit codes mirror the harness:
 *   0  measured rows present, all budgets pass
 *   1  a budget (or the eviction-telemetry self-check floor) FAILED — regression
 *   2  nothing measurable on this host (no model bundle); self-check passed
 *
 * The `1` path is the CI regression gate: a real measured peak-RSS over budget,
 * a real co-residency eviction count over the ceiling, or a broken arbiter
 * telemetry path all exit non-zero. A model-absent host exits 2 (skip), so the
 * harness is runnable in CI without GBs of models.
 */

import { spawnSync } from "node:child_process";
import {
  HERE,
  join,
  mkdirSync,
  ms,
  RESULTS_ROOT,
  readLatest,
  writeFileSync,
} from "./lib.mjs";

const NOW = new Date().toISOString();
const JSON_ONLY = process.argv.includes("--json");
const BUN_BIN = process.env.BUN_PATH || "bun";

function runHarness() {
  const res = spawnSync(
    BUN_BIN,
    ["--conditions=eliza-source", join(HERE, "memperf-kpi.ts")],
    {
      stdio: JSON_ONLY ? ["ignore", "ignore", "inherit"] : "inherit",
      env: process.env,
    },
  );
  if (res.error) {
    console.error(`[memperf] failed to spawn bun: ${res.error.message}`);
    return 1;
  }
  // 0 pass, 1 budget/telemetry fail, 2 skipped (nothing measurable)
  return res.status ?? 1;
}

function renderMarkdown(rec, status) {
  const lines = [];
  lines.push("# Memory-Benchmark KPI Dashboard");
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
  const host = s.host ?? {};
  lines.push("## Host");
  lines.push("");
  lines.push(
    `- tier: ${host.tier ?? "?"} (${host.totalRamGb ?? "?"} GB RAM` +
      `${host.vramGb ? `, ${host.vramGb} GB VRAM` : ""}, FFI ${host.ffiAvailable ? "available" : "unavailable"})`,
  );
  lines.push(
    `- measured: ${s.measuredModalities ?? 0} rows, skipped: ${s.skippedModalities ?? 0} rows`,
  );
  lines.push("");

  lines.push("## Per (tier × modality)");
  lines.push("");
  lines.push(
    "| tier | modality | measured | load | Δrss | peak rss | throughput |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rec.modalities ?? []) {
    if (row.measured) {
      lines.push(
        `| ${row.tier} | ${row.modality} | yes | ${ms(row.loadMs)} | ` +
          `${row.rssDeltaMb} MB | ${row.peakRssMb} MB | ` +
          `${row.throughput ?? "—"} ${row.throughputUnit ?? ""} |`,
      );
    } else {
      lines.push(
        `| ${row.tier} | ${row.modality} | skip | — | — | — | _${row.skipReason}_ |`,
      );
    }
  }
  lines.push("");

  const co = rec.coResidency ?? {};
  lines.push("## Co-residency (text → vision → voice → pressure)");
  lines.push("");
  lines.push(`- mode: **${co.mode ?? "?"}**`);
  lines.push(`- sequence: ${(co.sequence ?? []).join(" → ")}`);
  lines.push(`- budget: ${co.budgetMb ?? "?"} MB`);
  lines.push(
    `- loads: ${co.loadCount ?? "?"}, evictions: ${co.evictionCount ?? "?"}, pressure events: ${co.pressureEvents ?? "?"}`,
  );
  for (const e of co.evictions ?? []) {
    lines.push(
      `  - evicted ${e.capability}/${e.modelKey} reason=${e.reason} (~${e.estimatedMb} MB)`,
    );
  }
  lines.push("");

  lines.push("## Budget checks");
  lines.push("");
  if (!(rec.checks ?? []).length) {
    lines.push(
      "_no gated metric produced (all rows skipped); see co-residency self-check._",
    );
  }
  for (const c of rec.checks ?? []) {
    const cmp = c.name.includes("Min") ? "≥" : "≤";
    lines.push(
      `- ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.value ?? "—"} / ${cmp} ${c.budget} ${c.unit}`,
    );
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push(
    "Budgets live in `budgets.json`. Ratchet per-tier `peakRssMb` down as the LRU fit-path and dynamic context selection land.",
  );
  lines.push("");
  return lines.join("\n");
}

function main() {
  if (!JSON_ONLY) console.log(">>> memperf");
  const code = runHarness();
  const status = code === 0 ? "pass" : code === 2 ? "skipped" : "fail";

  const rec = readLatest("memperf");
  const summaryDir = join(RESULTS_ROOT, "summary");
  mkdirSync(summaryDir, { recursive: true });
  const stamp = NOW.replace(/[:.]/g, "-");
  const summary = { recordedAt: NOW, status, exitCode: code, memperf: rec };
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
