#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "benchmark-five-example-sampler");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function rel(target, from = REPORT_DIR) {
  return path.relative(from, path.join(REPO_ROOT, target)).replaceAll(path.sep, "/");
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pct(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
}

function playbackPathFromTrajectoryHref(href) {
  return path.join("reports/benchmarks/code-agent-trajectory-catalog", href || "").replaceAll(path.sep, "/");
}

function buildRecordLookup(trajectory) {
  const byBenchmark = new Map();
  for (const entry of trajectory.entries || []) {
    if (entry.side !== "target") continue;
    const playbackPath = playbackPathFromTrajectoryHref(entry.playbackHref);
    const bucket = byBenchmark.get(entry.benchmark) || [];
    for (const record of entry.records || []) {
      bucket.push({
        taskId: record.taskId || "",
        recordIndex: record.index,
        step: record.step,
        kind: record.kind,
        model: record.model || "",
        provider: record.provider || "",
        totalTokens: number(record.totalTokens),
        cacheReadTokens: number(record.cacheReadTokens),
        cachePercent: record.cachePercent ?? null,
        inputSource: record.inputSource || "",
        outputSource: record.outputSource || "",
        responseChars: number(record.responseChars),
        toolCallCount: number(record.toolCallCount),
        actions: record.actions || [],
        inputPreview: record.inputPreview || "",
        outputPreview: record.outputPreview || "",
        playbackHref: rel(playbackPath),
        playbackExists: existsSync(path.join(REPO_ROOT, playbackPath)),
        sourceHref: rel(path.join("reports/benchmarks/code-agent-trajectory-catalog", entry.fileHref || "")),
      });
    }
    byBenchmark.set(entry.benchmark, bucket);
  }
  return byBenchmark;
}

function selectExamples(exampleRow, records) {
  const selected = [];
  const used = new Set();
  for (const example of exampleRow.examples || []) {
    const match = records.find((record) => record.taskId && record.taskId === example.id && !used.has(record));
    if (match) {
      selected.push({ ...match, evidenceId: example.id, evidenceMode: "explicit-task-id" });
      used.add(match);
    } else {
      selected.push({
        taskId: example.id || "",
        evidenceId: example.id || "",
        evidenceMode: "manifest-only",
        recordIndex: null,
        step: null,
        kind: "",
        model: "",
        provider: "",
        totalTokens: 0,
        cacheReadTokens: 0,
        cachePercent: null,
        inputSource: "",
        outputSource: "",
        responseChars: 0,
        toolCallCount: 0,
        actions: [],
        inputPreview: "",
        outputPreview: "",
        playbackHref: example.playbackHref ? rel(path.join("reports/benchmark-analysis/benchmark-examples", example.playbackHref)) : "",
        playbackExists: example.playbackHref
          ? existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-examples", example.playbackHref))
          : false,
        sourceHref: example.fileHref ? rel(path.join("reports/benchmark-analysis/benchmark-examples", example.fileHref)) : "",
      });
    }
    if (selected.length >= 5) return selected;
  }
  for (const record of records) {
    if (selected.length >= 5) break;
    if (used.has(record)) continue;
    selected.push({
      ...record,
      evidenceId: record.taskId || `sample-${selected.length + 1}`,
      evidenceMode: record.taskId ? "trajectory-task-id" : "trajectory-sample",
    });
    used.add(record);
  }
  return selected.slice(0, 5);
}

function buildPayload() {
  const examples = readJson("reports/benchmark-analysis/benchmark-examples/examples.json");
  const trajectory = readJson("reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json");
  const recordsByBenchmark = buildRecordLookup(trajectory);
  const rows = (examples.rows || []).map((row) => {
    const records = recordsByBenchmark.get(row.benchmark) || [];
    const selected = selectExamples(row, records);
    return {
      benchmark: row.benchmark,
      runId: row.runId,
      runMode: row.runMode,
      disposition: row.disposition,
      status: row.status,
      caveat: row.caveat || "",
      sampleCount: row.sampleCount,
      explicitExampleCount: row.explicitExampleCount,
      selectedCount: selected.length,
      selectedWithPlayback: selected.filter((entry) => entry.playbackExists).length,
      selectedWithTaskId: selected.filter((entry) => entry.taskId).length,
      selectedTokenTotal: selected.reduce((sum, entry) => sum + number(entry.totalTokens), 0),
      selectedCacheReadTokens: selected.reduce((sum, entry) => sum + number(entry.cacheReadTokens), 0),
      reviewHref: rel(path.join("reports/benchmark-analysis/benchmark-examples", row.reviewHref || "")),
      examples: selected,
    };
  });
  return {
    schema: "eliza_benchmark_five_example_sampler_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      benchmarkCount: rows.length,
      withFiveSelected: rows.filter((row) => row.selectedCount >= 5).length,
      selectedRows: rows.reduce((sum, row) => sum + row.selectedCount, 0),
      selectedWithPlayback: rows.reduce((sum, row) => sum + row.selectedWithPlayback, 0),
      selectedWithTaskId: rows.reduce((sum, row) => sum + row.selectedWithTaskId, 0),
      sampleCountOnlyBenchmarks: rows.filter((row) => row.caveat).length,
      selectedTokenTotal: rows.reduce((sum, row) => sum + row.selectedTokenTotal, 0),
      selectedCacheReadTokens: rows.reduce((sum, row) => sum + row.selectedCacheReadTokens, 0),
    },
    rows,
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Five Example Sampler</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:11px; }
    .card b { display:block; margin-top:4px; font-size:21px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Five Example Sampler</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">Benchmarks</span><b>${escapeHtml(payload.summary.withFiveSelected)}/${escapeHtml(payload.summary.benchmarkCount)}</b><span>with five selected</span></div>
      <div class="card"><span class="muted">Examples</span><b>${escapeHtml(payload.summary.selectedWithPlayback)}/${escapeHtml(payload.summary.selectedRows)}</b><span>with playback</span></div>
      <div class="card"><span class="muted">Task IDs</span><b>${escapeHtml(payload.summary.selectedWithTaskId)}</b><span>selected examples</span></div>
      <div class="card"><span class="muted">Cache</span><b>${escapeHtml(pct(payload.summary.selectedTokenTotal ? (payload.summary.selectedCacheReadTokens / payload.summary.selectedTokenTotal) * 100 : null))}</b><span>selected token subset</span></div>
    </div>
    <section class="panel"><div class="body"><table><thead><tr><th>benchmark</th><th>selected</th><th>tokens/cache</th><th>examples</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td><code>${escapeHtml(row.benchmark)}</code><br><span class="muted">${escapeHtml(row.disposition)} · ${escapeHtml(row.runMode)}${row.caveat ? ` · ${escapeHtml(row.caveat)}` : ""}</span></td><td>${escapeHtml(row.selectedWithPlayback)}/${escapeHtml(row.selectedCount)} playback<br>${escapeHtml(row.selectedWithTaskId)} task IDs</td><td>${escapeHtml(row.selectedTokenTotal)} tokens<br>${escapeHtml(row.selectedCacheReadTokens)} cached</td><td>${row.examples
        .map((example) => `<div><code>${escapeHtml(example.evidenceId)}</code> <span class="muted">${escapeHtml(example.evidenceMode)}</span> <a href="${escapeHtml(example.playbackHref)}">playback</a></div>`)
        .join("")}</td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Five Example Sampler",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Benchmarks with five selected examples: ${payload.summary.withFiveSelected}/${payload.summary.benchmarkCount}`,
    `- Selected rows with playback: ${payload.summary.selectedWithPlayback}/${payload.summary.selectedRows}`,
    `- Selected examples with task IDs: ${payload.summary.selectedWithTaskId}`,
    `- Sample-count-only benchmarks: ${payload.summary.sampleCountOnlyBenchmarks}`,
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(path.join(REPORT_DIR, "five-example-sampler.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`benchmark five-example sampler ${payload.summary.selectedWithPlayback}/${payload.summary.selectedRows} playback examples at ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
