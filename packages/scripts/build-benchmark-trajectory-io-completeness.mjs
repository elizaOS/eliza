#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmark-analysis",
  "trajectory-io-completeness",
);
const TRAJECTORY_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmarks",
  "code-agent-trajectory-catalog",
);

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

function relTrajectory(href) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(TRAJECTORY_DIR, text);
  return path.relative(REPORT_DIR, absolute).replaceAll(path.sep, "/");
}

function hasInput(record) {
  const source = String(record.inputSource || "");
  return source && source !== "none";
}

function hasOutput(record) {
  const source = String(record.outputSource || "");
  return source && source !== "none";
}

function outputGapClass(record) {
  if (hasOutput(record)) return "output-present";
  if (!Number.isFinite(record.totalTokens) || Number(record.totalTokens) === 0) {
    return "environment-or-dry-run-no-token-output";
  }
  if ((record.actions || []).length > 0) return "tool-call-or-action-only-output";
  return "empty-response-with-token-usage";
}

function buildPayload() {
  const trajectory = readJson(
    "reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json",
  );
  const rowsByBenchmark = new Map();
  const allRecords = [];

  for (const entry of trajectory.entries || []) {
    const row =
      rowsByBenchmark.get(entry.benchmark) ||
      {
        benchmark: entry.benchmark,
        files: 0,
        playbackFiles: 0,
        records: 0,
        llmLikeRecords: 0,
        withInput: 0,
        withOutput: 0,
        missingInput: 0,
        missingOutput: 0,
        missingOutputWithTokens: 0,
        missingOutputWithoutTokens: 0,
        outputGapClasses: {},
        tokens: 0,
        cacheReadTokens: 0,
        sampleGaps: [],
        sampleMissingInputs: [],
      };
    row.files += 1;
    if (entry.playbackHref) row.playbackFiles += 1;
    row.llmLikeRecords += Number(entry.totals?.llmLikeRecords || 0);
    row.tokens += Number(entry.totals?.totalTokens || 0);
    row.cacheReadTokens += Number(entry.totals?.cacheReadTokens || 0);

    for (const record of entry.records || []) {
      const recordRow = {
        benchmark: entry.benchmark,
        runId: entry.runId,
        side: entry.side,
        adapter: entry.adapter,
        taskId: record.taskId || "",
        step: record.step,
        model: record.model || "",
        provider: record.provider || "",
        totalTokens: Number(record.totalTokens || 0),
        cacheReadTokens: Number(record.cacheReadTokens || 0),
        inputSource: record.inputSource || "",
        outputSource: record.outputSource || "",
        actions: record.actions || [],
        outputGapClass: outputGapClass(record),
        inputPreview: record.inputPreview || "",
        outputPreview: record.outputPreview || "",
        playbackHref: relTrajectory(entry.playbackHref),
      };
      allRecords.push(recordRow);
      row.records += 1;
      if (hasInput(record)) row.withInput += 1;
      else {
        row.missingInput += 1;
        if (row.sampleMissingInputs.length < 5) row.sampleMissingInputs.push(recordRow);
      }
      if (hasOutput(record)) row.withOutput += 1;
      else {
        row.missingOutput += 1;
        if (Number(record.totalTokens || 0) > 0) row.missingOutputWithTokens += 1;
        else row.missingOutputWithoutTokens += 1;
        row.outputGapClasses[recordRow.outputGapClass] =
          (row.outputGapClasses[recordRow.outputGapClass] || 0) + 1;
        if (row.sampleGaps.length < 5) row.sampleGaps.push(recordRow);
      }
    }
    rowsByBenchmark.set(entry.benchmark, row);
  }

  const rows = [...rowsByBenchmark.values()].sort((a, b) =>
    a.benchmark.localeCompare(b.benchmark),
  );
  const summary = {
    benchmarkCount: rows.length,
    files: rows.reduce((sum, row) => sum + row.files, 0),
    playbackFiles: rows.reduce((sum, row) => sum + row.playbackFiles, 0),
    records: rows.reduce((sum, row) => sum + row.records, 0),
    llmLikeRecords: rows.reduce((sum, row) => sum + row.llmLikeRecords, 0),
    withInput: rows.reduce((sum, row) => sum + row.withInput, 0),
    withOutput: rows.reduce((sum, row) => sum + row.withOutput, 0),
    missingInput: rows.reduce((sum, row) => sum + row.missingInput, 0),
    missingOutput: rows.reduce((sum, row) => sum + row.missingOutput, 0),
    missingOutputWithTokens: rows.reduce((sum, row) => sum + row.missingOutputWithTokens, 0),
    missingOutputWithoutTokens: rows.reduce(
      (sum, row) => sum + row.missingOutputWithoutTokens,
      0,
    ),
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    cacheReadTokens: rows.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    outputGapClasses: allRecords.reduce((counts, record) => {
      if (record.outputGapClass !== "output-present") {
        counts[record.outputGapClass] = (counts[record.outputGapClass] || 0) + 1;
      }
      return counts;
    }, {}),
    benchmarksWithTokenOutputGaps: rows.filter((row) => row.missingOutputWithTokens > 0).length,
    benchmarksWithMissingInputs: rows.filter((row) => row.missingInput > 0).length,
  };

  return {
    schema: "eliza_benchmark_trajectory_io_completeness_v1",
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  };
}

function pct(part, total) {
  if (!total) return "";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function html(payload) {
  const rows = payload.rows
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.benchmark)}</code><br><span class="muted">${row.files} files / ${row.playbackFiles} playback</span></td>
        <td>${row.withInput}/${row.records}<br><span class="muted">${pct(row.withInput, row.records)}</span></td>
        <td>${row.withOutput}/${row.records}<br><span class="muted">${pct(row.withOutput, row.records)}</span></td>
        <td>${row.missingOutputWithTokens}<br><span class="muted">${escapeHtml(JSON.stringify(row.outputGapClasses))}</span></td>
        <td>${row.sampleGaps
          .map(
            (sample) =>
              `${link(sample.playbackHref, sample.taskId || `${sample.runId}:${sample.step}`)} <span class="muted">${escapeHtml(sample.outputGapClass)}</span>`,
          )
          .join("<br>")}</td>
      </tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Trajectory I/O Completeness</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0; }
    .card { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:10px; }
    .card b { display:block; font-size:20px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Trajectory I/O Completeness</h1><div class="muted">Generated ${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      <div class="card"><span class="muted">Records</span><b>${payload.summary.records}</b></div>
      <div class="card"><span class="muted">With input</span><b>${payload.summary.withInput}</b></div>
      <div class="card"><span class="muted">With output</span><b>${payload.summary.withOutput}</b></div>
      <div class="card"><span class="muted">Missing output + tokens</span><b>${payload.summary.missingOutputWithTokens}</b></div>
      <div class="card"><span class="muted">Missing input</span><b>${payload.summary.missingInput}</b></div>
      <div class="card"><span class="muted">Playback files</span><b>${payload.summary.playbackFiles}/${payload.summary.files}</b></div>
    </section>
    <table>
      <thead><tr><th>Benchmark</th><th>Input panes</th><th>Output panes</th><th>Token output gaps</th><th>Sample gap playback</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function readme(payload) {
  return [
    "# Benchmark Trajectory I/O Completeness",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Records: ${payload.summary.records}`,
    `- With normalized input: ${payload.summary.withInput}`,
    `- With normalized output: ${payload.summary.withOutput}`,
    `- Missing output with token usage: ${payload.summary.missingOutputWithTokens}`,
    `- Missing output without token usage: ${payload.summary.missingOutputWithoutTokens}`,
    `- Missing input: ${payload.summary.missingInput}`,
    `- Output gap classes: ${JSON.stringify(payload.summary.outputGapClasses)}`,
    "",
    "| benchmark | records | with input | with output | missing output with tokens |",
    "|---|---:|---:|---:|---:|",
    ...payload.rows.map(
      (row) =>
        `| \`${row.benchmark}\` | ${row.records} | ${row.withInput} | ${row.withOutput} | ${row.missingOutputWithTokens} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  const payload = buildPayload();
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    path.join(REPORT_DIR, "trajectory-io-completeness.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), readme(payload), "utf8");
  process.stdout.write(`benchmark trajectory io completeness ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
