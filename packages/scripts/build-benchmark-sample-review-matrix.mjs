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
  "benchmark-sample-review-matrix",
);
const SAMPLER_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmark-analysis",
  "benchmark-five-example-sampler",
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

function relSampler(href) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(SAMPLER_DIR, text);
  return path.relative(REPORT_DIR, absolute).replaceAll(path.sep, "/");
}

function classifyExample(example) {
  const hasTokens = Number(example.totalTokens || 0) > 0;
  const hasOutput = Boolean(String(example.outputPreview || "").trim());
  const hasActions = (example.actions || []).length > 0;
  const hasInput = Boolean(String(example.inputPreview || "").trim());
  if (!example.playbackExists) return "missing-playback";
  if (!hasInput) return "missing-input-preview";
  if (hasOutput) return "model-output-present";
  if (hasActions && hasTokens) return "tool-call-output";
  if (hasTokens) return "empty-response-token-usage";
  return "environment-or-dry-run";
}

function reviewCompleteness(example, reviewClass) {
  const hasTokens = Number(example.totalTokens || 0) > 0;
  const hasOutput = Boolean(String(example.outputPreview || "").trim());
  if (!example.playbackExists) return "missing-playback";
  if (!String(example.inputPreview || "").trim()) return "missing-input-preview";
  if (hasOutput && hasTokens) return "full-inline-io-with-cache";
  if (hasOutput) return "inline-output-no-token";
  if (reviewClass === "tool-call-output") return "tool-call-only-inline";
  if (hasTokens) return "empty-response-token-usage";
  return "playback-only-environment";
}

function reviewLimitation(row) {
  if (row.reviewCompleteness === "full-inline-io-with-cache") {
    return "Inline input, output, token, cache, provider, and model metadata are present.";
  }
  if (row.reviewCompleteness === "inline-output-no-token") {
    return "Inline input/output are present, but token/cache counters are absent.";
  }
  if (row.reviewCompleteness === "tool-call-only-inline") {
    return "No text output preview was captured; inspect the playback/tool action for the command result.";
  }
  if (row.reviewCompleteness === "empty-response-token-usage") {
    return "Token usage exists, but no text output preview was captured.";
  }
  if (row.reviewCompleteness === "playback-only-environment") {
    return "Playback exists with input/environment transcript, but no inline output or token/cache counters.";
  }
  return "Missing inline evidence required for review.";
}

function buildPayload() {
  const sampler = readJson(
    "reports/benchmark-analysis/benchmark-five-example-sampler/five-example-sampler.json",
  );
  const outcome = readJson(
    "reports/benchmark-analysis/benchmark-outcome-analysis/outcome-analysis.json",
  );
  const outcomeByBenchmark = new Map((outcome.rows || []).map((row) => [row.benchmark, row]));

  const rows = [];
  for (const benchmarkRow of sampler.rows || []) {
    const outcomeRow = outcomeByBenchmark.get(benchmarkRow.benchmark);
    for (const [index, example] of (benchmarkRow.examples || []).entries()) {
      const reviewClass = classifyExample(example);
      const completeness = reviewCompleteness(example, reviewClass);
      rows.push({
        id: `${benchmarkRow.benchmark}:${index + 1}`,
        benchmark: benchmarkRow.benchmark,
        sampleOrdinal: index + 1,
        benchmarkStatus: benchmarkRow.status,
        benchmarkDisposition: benchmarkRow.disposition,
        benchmarkQualityBand: outcomeRow?.qualityBand || "",
        taskId: example.taskId || "",
        evidenceId: example.evidenceId || "",
        evidenceMode: example.evidenceMode || "",
        recordIndex: example.recordIndex,
        step: example.step,
        model: example.model || "",
        provider: example.provider || "",
        totalTokens: Number(example.totalTokens || 0),
        cacheReadTokens: Number(example.cacheReadTokens || 0),
        cachePercent: example.cachePercent,
        inputSource: example.inputSource || "",
        outputSource: example.outputSource || "",
        responseChars: Number(example.responseChars || 0),
        toolCallCount: Number(example.toolCallCount || 0),
        actions: example.actions || [],
        hasInputPreview: Boolean(String(example.inputPreview || "").trim()),
        hasOutputPreview: Boolean(String(example.outputPreview || "").trim()),
        playbackHref: relSampler(example.playbackHref),
        sourceHref: relSampler(example.sourceHref),
        playbackExists: Boolean(example.playbackExists),
        reviewClass,
        reviewCompleteness: completeness,
        reviewReady:
          example.playbackExists &&
          Boolean(String(example.inputPreview || "").trim()) &&
          reviewClass !== "missing-playback" &&
          reviewClass !== "missing-input-preview",
        inputPreview: String(example.inputPreview || "").slice(0, 500),
        outputPreview: String(example.outputPreview || "").slice(0, 500),
      });
    }
  }

  const summary = {
    sampleRows: rows.length,
    benchmarkCount: new Set(rows.map((row) => row.benchmark)).size,
    rowsWithPlayback: rows.filter((row) => row.playbackExists).length,
    rowsWithTaskId: rows.filter((row) => row.taskId).length,
    reviewReadyRows: rows.filter((row) => row.reviewReady).length,
    fullInlineReviewRows: rows.filter((row) => row.reviewCompleteness === "full-inline-io-with-cache").length,
    inlineOutputRows: rows.filter((row) => row.hasOutputPreview).length,
    playbackOnlyEnvironmentRows: rows.filter((row) => row.reviewCompleteness === "playback-only-environment").length,
    toolCallOnlyInlineRows: rows.filter((row) => row.reviewCompleteness === "tool-call-only-inline").length,
    rowsWithModelProvider: rows.filter((row) => row.model || row.provider).length,
    rowsWithCachePercent: rows.filter((row) => Number.isFinite(row.cachePercent)).length,
    tokenRows: rows.filter((row) => row.totalTokens > 0).length,
    totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
    cacheReadTokens: rows.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    byReviewClass: rows.reduce((counts, row) => {
      counts[row.reviewClass] = (counts[row.reviewClass] || 0) + 1;
      return counts;
    }, {}),
    byReviewCompleteness: rows.reduce((counts, row) => {
      counts[row.reviewCompleteness] = (counts[row.reviewCompleteness] || 0) + 1;
      return counts;
    }, {}),
    byBenchmarkQualityBand: rows.reduce((counts, row) => {
      counts[row.benchmarkQualityBand] = (counts[row.benchmarkQualityBand] || 0) + 1;
      return counts;
    }, {}),
  };

  return {
    schema: "eliza_benchmark_sample_review_matrix_v1",
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  };
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function html(payload) {
  const rows = payload.rows
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.benchmark)}</code><br><span class="muted">sample ${row.sampleOrdinal}; ${escapeHtml(row.benchmarkQualityBand)}</span></td>
        <td>${escapeHtml(row.taskId || row.evidenceId || "sample-count-only")}</td>
        <td><b>${escapeHtml(row.reviewClass)}</b><br><code>${escapeHtml(row.reviewCompleteness)}</code><br><span class="muted">${escapeHtml(reviewLimitation(row))}</span></td>
        <td>${row.totalTokens.toLocaleString("en-US")}<br><span class="muted">cache ${row.cacheReadTokens.toLocaleString("en-US")}${Number.isFinite(row.cachePercent) ? ` (${escapeHtml(Number(row.cachePercent).toFixed(1))}%)` : ""}</span><br><span class="muted">${escapeHtml(row.provider || "provider n/a")} ${escapeHtml(row.model || "")}</span></td>
        <td>${link(row.playbackHref, "playback")} ${link(row.sourceHref, "source")}</td>
        <td><span class="muted">input ${escapeHtml(row.inputSource || "n/a")} / output ${escapeHtml(row.outputSource || "none")}; response chars ${escapeHtml(row.responseChars)}; tool calls ${escapeHtml(row.toolCallCount)}</span><br><span class="muted">${escapeHtml(row.inputPreview)}</span>${row.outputPreview ? `<br>${escapeHtml(row.outputPreview)}` : `<br><b>${escapeHtml(reviewLimitation(row))}</b>`}${row.actions.length ? `<br><span class="muted">actions: ${escapeHtml(row.actions.join(", "))}</span>` : ""}</td>
      </tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Sample Review Matrix</title>
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
    a { color:#116b5b; text-decoration:none; margin-right:8px; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Sample Review Matrix</h1><div class="muted">Generated ${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      <div class="card"><span class="muted">Samples</span><b>${payload.summary.sampleRows}</b></div>
      <div class="card"><span class="muted">Playback</span><b>${payload.summary.rowsWithPlayback}</b></div>
      <div class="card"><span class="muted">Task IDs</span><b>${payload.summary.rowsWithTaskId}</b></div>
      <div class="card"><span class="muted">Review-ready</span><b>${payload.summary.reviewReadyRows}</b></div>
      <div class="card"><span class="muted">Full inline I/O</span><b>${payload.summary.fullInlineReviewRows}</b></div>
      <div class="card"><span class="muted">Token rows</span><b>${payload.summary.tokenRows}</b></div>
      <div class="card"><span class="muted">Tokens</span><b>${payload.summary.totalTokens.toLocaleString("en-US")}</b></div>
    </section>
    <table>
      <thead><tr><th>Benchmark</th><th>Task</th><th>Review class</th><th>Tokens</th><th>Links</th><th>Preview</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function readme(payload) {
  return [
    "# Benchmark Sample Review Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Sample rows: ${payload.summary.sampleRows}`,
    `- Benchmarks: ${payload.summary.benchmarkCount}`,
    `- Rows with playback: ${payload.summary.rowsWithPlayback}`,
    `- Rows with task ID: ${payload.summary.rowsWithTaskId}`,
    `- Review-ready rows: ${payload.summary.reviewReadyRows}`,
    `- Full inline I/O rows: ${payload.summary.fullInlineReviewRows}`,
    `- Inline output rows: ${payload.summary.inlineOutputRows}`,
    `- Tool-call-only inline rows: ${payload.summary.toolCallOnlyInlineRows}`,
    `- Playback-only environment rows: ${payload.summary.playbackOnlyEnvironmentRows}`,
    `- Token rows: ${payload.summary.tokenRows}`,
    `- Total tokens: ${payload.summary.totalTokens}`,
    `- Cache-read tokens: ${payload.summary.cacheReadTokens}`,
    `- Review classes: ${JSON.stringify(payload.summary.byReviewClass)}`,
    `- Review completeness: ${JSON.stringify(payload.summary.byReviewCompleteness)}`,
    "",
    "| benchmark | sample | task | review class | completeness | tokens |",
    "|---|---:|---|---|---|---:|",
    ...payload.rows.map(
      (row) =>
        `| \`${row.benchmark}\` | ${row.sampleOrdinal} | \`${row.taskId || row.evidenceId || ""}\` | ${row.reviewClass} | ${row.reviewCompleteness} | ${row.totalTokens} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  const payload = buildPayload();
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    path.join(REPORT_DIR, "sample-review-matrix.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), readme(payload), "utf8");
  process.stdout.write(`benchmark sample review matrix ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
