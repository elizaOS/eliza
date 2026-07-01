/**
 * Consolidated report generator for the Mobile Resource Workbench.
 *
 * Reads every `results/<workload>/latest.json` and writes a markdown + HTML
 * report under `results/report/`. Run after `run-workbench.mjs` (or in CI, to
 * publish the artifact). Pure read/format — no device needed.
 *
 *   node packages/benchmarks/mobile-resource/report.mjs
 */

import { existsSync, readdirSync } from "node:fs";
import {
  join,
  mb,
  mkdirSync,
  ms,
  RESULTS_ROOT,
  readLatest,
  tps,
  writeFileSync,
} from "./lib.mjs";

const NOW = new Date().toISOString();

function listWorkloadResults() {
  if (!existsSync(RESULTS_ROOT)) return [];
  const out = [];
  for (const name of readdirSync(RESULTS_ROOT)) {
    if (name === "report") continue;
    const rec = readLatest(name);
    if (rec) out.push({ workload: name, rec });
  }
  return out;
}

function fmtPct(n) {
  return n == null ? "—" : `${n}%`;
}

function renderMarkdown(entries) {
  const lines = [];
  lines.push("# Mobile Resource Workbench — Report");
  lines.push("");
  lines.push(`Generated: ${NOW}`);
  lines.push("");
  if (entries.length === 0) {
    lines.push("_No results recorded yet. Run `run-workbench.mjs` first._");
    lines.push("");
    return lines.join("\n");
  }

  lines.push("## Status");
  lines.push("");
  lines.push("| Workload | Tier | Device | Status |");
  lines.push("| --- | --- | --- | --- |");
  for (const { workload, rec } of entries) {
    if (workload === "summary") continue;
    const status = rec.skipped ? "skipped" : rec.pass ? "PASS" : "FAIL";
    lines.push(
      `| ${workload} | ${rec.tier ?? "—"} | ${rec.deviceClass ?? rec.platform ?? "—"} | ${status} |`,
    );
  }
  lines.push("");

  for (const { workload, rec } of entries) {
    if (workload === "summary") continue;
    lines.push(`## ${workload}`);
    lines.push("");
    if (rec.skipped) {
      lines.push(`_skipped: ${rec.reason ?? "unavailable"}_`);
      lines.push("");
      continue;
    }
    const s = rec.summary ?? {};
    lines.push(
      `- generations: ${s.generations ?? 0}  samples: ${s.resourceSamples ?? 0}`,
    );
    lines.push(
      `- decode tok/s (p50/p90): ${tps(s.decodeTokensPerSecond?.p50)} / ${tps(s.decodeTokensPerSecond?.p90)}`,
    );
    lines.push(
      `- prefill tok/s (p50): ${tps(s.prefillTokensPerSecond?.p50)}  TTFT (p90): ${ms(s.ttftMs?.p90)}`,
    );
    lines.push(
      `- RSS peak/steady: ${mb(s.rss?.peakMb)} / ${mb(s.rss?.steadyMb)}  leak: ${s.rss?.leakSuspected ?? "—"}`,
    );
    lines.push(
      `- battery drain: ${fmtPct(s.battery?.drainPct)}  energy Δ: ${s.battery?.energyMicroAmpHoursDelta == null ? "—" : `${s.battery.energyMicroAmpHoursDelta} µAh`}`,
    );
    lines.push(
      `- thermal: initial ${s.thermal?.initialState ?? "—"} → max ${s.thermal?.maxState ?? "—"} (${s.thermal?.transitionCount ?? 0} transitions, throttled ${s.thermal?.fractionThrottled == null ? "—" : `${Math.round(s.thermal.fractionThrottled * 100)}%`})`,
    );
    lines.push(
      `- low-power transitions: ${s.lowPowerMode?.transitionCount ?? 0}`,
    );
    lines.push("");
    if (Array.isArray(rec.checks) && rec.checks.length) {
      lines.push("Budget checks:");
      lines.push("");
      for (const c of rec.checks) {
        const v = c.value == null ? "—" : `${c.value}`;
        const b = c.budget == null ? "no-baseline" : `${c.budget}`;
        lines.push(
          `- ${c.pass ? "PASS" : "FAIL"} ${c.name}: ${v} / ${b} ${c.unit}`,
        );
      }
      lines.push("");
    }
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "Budgets live in `budgets.json` (per device class × tier). `null` budgets are unmeasured baselines — ratchet them in as on-device numbers stabilise (see `BASELINE.md`).",
  );
  lines.push("");
  return lines.join("\n");
}

function renderHtml(markdownText) {
  // Minimal self-contained HTML wrapper (no external deps).
  const escaped = markdownText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>Mobile Resource Workbench</title><body style="font:14px/1.5 ui-monospace,monospace;max-width:980px;margin:2rem auto;padding:0 1rem"><pre>${escaped}</pre></body>`;
}

function main() {
  const entries = listWorkloadResults();
  const md = renderMarkdown(entries);
  const dir = join(RESULTS_ROOT, "report");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "latest.md"), md);
  writeFileSync(join(dir, "latest.html"), renderHtml(md));
  console.log(md);
  console.log(`\nreport -> ${join(dir, "latest.md")}`);
}

main();
