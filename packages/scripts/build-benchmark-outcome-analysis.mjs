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
  "benchmark-outcome-analysis",
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

function fmtNumber(value) {
  if (!Number.isFinite(value)) return "";
  return Math.round(value).toLocaleString("en-US");
}

function fmtPercent(value) {
  if (!Number.isFinite(value)) return "";
  return `${value.toFixed(1)}%`;
}

function relFrom(relativePath, sourceDir) {
  if (!relativePath) return "";
  const text = String(relativePath);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(sourceDir, text);
  return path.relative(REPORT_DIR, absolute).replaceAll(path.sep, "/");
}

function qualityBand(row) {
  if (row.readiness !== "complete") return "blocked-or-caveated";
  if (row.disposition === "review-pass") return "review-pass";
  if (row.status === "superior" || row.status === "comparable") return "acceptable-with-review";
  if (row.status === "weak" || row.status === "inferior") return "needs-output-review";
  if (row.status === "missing") return "missing-live-result";
  return "needs-review";
}

function actionFor(row, versionRow) {
  if (row.benchmark === "osworld") {
    return "Configure a runnable OSWorld provider, rerun live OSWorld, then rebuild analysis.";
  }
  if (versionRow?.gapType === "previous-aggregate-only") {
    return "Rerun with trajectory output so the previous baseline has playback-backed evidence.";
  }
  if (versionRow?.gapType === "no-previous-run") {
    return "Keep current evidence and rerun after the next benchmark/instrumentation change to create history.";
  }
  if (row.disposition !== "review-pass") {
    return "Use the linked playback and focused review page to inspect wrong or weak outputs before accepting the benchmark result.";
  }
  return row.recommendedAction || "Keep as current evidence; inspect playback for qualitative review.";
}

function buildPayload() {
  const closure = readJson(
    "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
  );
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const versionRemediation = readJson(
    "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
  );
  const cache = readJson("reports/benchmark-analysis/cache-analysis/cache-analysis.json");
  const versionByBenchmark = new Map(
    (versionRemediation.rows || []).map((row) => [row.benchmark, row]),
  );
  const reviewByBenchmark = new Map((review.rows || []).map((row) => [row.benchmark, row]));

  const rows = (closure.rows || []).map((row) => {
    const versionRow = versionByBenchmark.get(row.benchmark);
    const reviewRow = reviewByBenchmark.get(row.benchmark);
    const targetAccuracy = Number.isFinite(row.targetAccuracy) ? row.targetAccuracy : null;
    const baselineAccuracy = Number.isFinite(row.baselineAccuracy) ? row.baselineAccuracy : null;
    const accuracyDelta =
      targetAccuracy !== null && baselineAccuracy !== null ? targetAccuracy - baselineAccuracy : null;
    const cacheDelta =
      Number.isFinite(row.targetCachePercent) && Number.isFinite(row.baselineCachePercent)
        ? row.targetCachePercent - row.baselineCachePercent
        : null;
    const evidence = [
      ...(row.evidence || []),
      ...(versionRow?.notes || []).map((note) => `version: ${note}`),
      ...(row.caveats || []).map((caveat) => `caveat: ${caveat}`),
    ];
    return {
      benchmark: row.benchmark,
      runId: row.runId,
      runMode: row.runMode,
      status: row.status,
      disposition: row.disposition,
      qualityBand: qualityBand(row),
      readiness: row.readiness,
      targetTotal: row.targetTotal,
      targetAccuracy,
      baselineAccuracy,
      accuracyDelta,
      targetTokens: row.targetTokens || 0,
      baselineTokens: row.baselineTokens || 0,
      targetCachePercent: row.targetCachePercent,
      baselineCachePercent: row.baselineCachePercent,
      cacheDelta,
      trajectoryFiles: row.trajectoryFiles || 0,
      trajectoryRecords: row.trajectoryRecords || 0,
      trajectoryTokens: row.trajectoryTokens || 0,
      trajectoryCacheReadTokens: row.trajectoryCacheReadTokens || 0,
      trajectoryCachePercent: row.trajectoryCachePercent,
      representativeRecords: row.representativeRecords || 0,
      representativeWithInput: row.representativeWithInput || 0,
      representativeWithOutput: row.representativeWithOutput || 0,
      sampledExamples: row.fiveExamplesSelected || 0,
      sampledExamplesWithPlayback: row.fiveExamplesWithPlayback || 0,
      sampledExamplesWithTaskId: row.fiveExamplesWithTaskId || 0,
      targetPlaybackComplete: Boolean(row.targetPlaybackComplete),
      versionGapType: versionRow?.gapType || "",
      versionDisposition: versionRow?.disposition || "",
      versionComparablePlaybackPair: Boolean(versionRow?.comparablePlaybackPair),
      focusedReviewHref: relFrom(row.focusedReviewHref, path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-closure-matrix")),
      runViewerHref: relFrom(row.runViewerHref, path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-closure-matrix")),
      targetPlaybackHref: relFrom(row.targetPlaybackHref, path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-closure-matrix")),
      versionRowHref: "../version-remediation-matrix/index.html",
      reviewPageHref: relFrom(
        reviewRow?.reviewLinks?.benchmarkReview || row.focusedReviewHref,
        path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-review"),
      ),
      samplePlaybackHrefs: (row.samplePlaybackHrefs || []).map((href) =>
        relFrom(href, path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-closure-matrix")),
      ),
      evidence,
      nextAction: actionFor(row, versionRow),
    };
  });

  const summary = {
    benchmarkCount: rows.length,
    reviewPass: rows.filter((row) => row.qualityBand === "review-pass").length,
    acceptableWithReview: rows.filter((row) => row.qualityBand === "acceptable-with-review")
      .length,
    needsOutputReview: rows.filter((row) => row.qualityBand === "needs-output-review").length,
    blockedOrCaveated: rows.filter((row) => row.qualityBand === "blocked-or-caveated").length,
    targetPlaybackComplete: rows.filter((row) => row.targetPlaybackComplete).length,
    sampledExamples: rows.reduce((sum, row) => sum + row.sampledExamples, 0),
    sampledExamplesWithPlayback: rows.reduce((sum, row) => sum + row.sampledExamplesWithPlayback, 0),
    sampledExamplesWithTaskId: rows.reduce((sum, row) => sum + row.sampledExamplesWithTaskId, 0),
    trajectoryFiles: rows.reduce((sum, row) => sum + row.trajectoryFiles, 0),
    trajectoryRecords: rows.reduce((sum, row) => sum + row.trajectoryRecords, 0),
    trajectoryTokens: rows.reduce((sum, row) => sum + row.trajectoryTokens, 0),
    trajectoryCacheReadTokens: rows.reduce((sum, row) => sum + row.trajectoryCacheReadTokens, 0),
    trajectoryCachePercent: cache.codeAgent?.summary?.trajectoryCachePercent || 0,
    versionPreviousPlaybackGaps: rows.filter(
      (row) => row.versionGapType === "previous-aggregate-only",
    ).length,
    versionNoPreviousRun: rows.filter((row) => row.versionGapType === "no-previous-run").length,
    osworldCaveats: rows.filter((row) => row.benchmark === "osworld" && row.readiness !== "complete")
      .length,
  };

  return {
    schema: "eliza_benchmark_outcome_analysis_v1",
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
        <td><code>${escapeHtml(row.benchmark)}</code><br><span class="muted">${escapeHtml(row.runMode)} · ${escapeHtml(row.status)}</span></td>
        <td><b>${escapeHtml(row.qualityBand)}</b><br><span class="muted">${escapeHtml(row.disposition)} / ${escapeHtml(row.readiness)}</span></td>
        <td>${row.targetAccuracy === null ? "" : fmtPercent(row.targetAccuracy * 100)}<br><span class="muted">baseline ${row.baselineAccuracy === null ? "" : fmtPercent(row.baselineAccuracy * 100)}; delta ${row.accuracyDelta === null ? "" : fmtPercent(row.accuracyDelta * 100)}</span></td>
        <td>${fmtNumber(row.trajectoryTokens)} tokens<br><span class="muted">${fmtPercent(row.trajectoryCachePercent)} trajectory cache; target ${fmtPercent(row.targetCachePercent)}</span></td>
        <td>${row.trajectoryFiles} files / ${row.trajectoryRecords} records<br><span class="muted">${row.representativeWithInput}/${row.representativeRecords} with input; ${row.representativeWithOutput}/${row.representativeRecords} with output</span></td>
        <td>${row.sampledExamplesWithPlayback}/${row.sampledExamples} playback<br><span class="muted">${row.sampledExamplesWithTaskId}/${row.sampledExamples} task IDs</span></td>
        <td>${link(row.focusedReviewHref, "focused review")} ${link(row.runViewerHref, "run viewer")} ${link(row.targetPlaybackHref, "target playback")} ${link(row.versionRowHref, "version")}</td>
        <td>${escapeHtml(row.nextAction)}<br><span class="muted">${escapeHtml(row.evidence.slice(0, 2).join(" "))}</span></td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Outcome Analysis</title>
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
    a { color:#116b5b; text-decoration:none; margin-right:8px; white-space:nowrap; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Outcome Analysis</h1><div class="muted">Generated ${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      <div class="card"><span class="muted">Benchmarks</span><b>${payload.summary.benchmarkCount}</b></div>
      <div class="card"><span class="muted">Review pass</span><b>${payload.summary.reviewPass}</b></div>
      <div class="card"><span class="muted">Needs output review</span><b>${payload.summary.needsOutputReview}</b></div>
      <div class="card"><span class="muted">Playback</span><b>${payload.summary.targetPlaybackComplete}/${payload.summary.benchmarkCount}</b></div>
      <div class="card"><span class="muted">Examples</span><b>${payload.summary.sampledExamplesWithPlayback}/${payload.summary.sampledExamples}</b></div>
      <div class="card"><span class="muted">Trajectory cache</span><b>${fmtPercent(payload.summary.trajectoryCachePercent)}</b></div>
    </section>
    <table>
      <thead><tr><th>Benchmark</th><th>Verdict</th><th>Success</th><th>Cache</th><th>Trajectory</th><th>Samples</th><th>Links</th><th>Next action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function readme(payload) {
  return [
    "# Benchmark Outcome Analysis",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Benchmarks: ${payload.summary.benchmarkCount}`,
    `- Review pass: ${payload.summary.reviewPass}`,
    `- Acceptable with review: ${payload.summary.acceptableWithReview}`,
    `- Needs output review: ${payload.summary.needsOutputReview}`,
    `- Blocked or caveated: ${payload.summary.blockedOrCaveated}`,
    `- Target playback complete: ${payload.summary.targetPlaybackComplete}/${payload.summary.benchmarkCount}`,
    `- Sampled playback examples: ${payload.summary.sampledExamplesWithPlayback}/${payload.summary.sampledExamples}`,
    `- Trajectory records: ${payload.summary.trajectoryRecords}`,
    `- Trajectory cache: ${fmtPercent(payload.summary.trajectoryCachePercent)}`,
    "",
    "| benchmark | quality | status | accuracy | trajectory cache | next action |",
    "|---|---|---|---:|---:|---|",
    ...payload.rows.map(
      (row) =>
        `| \`${row.benchmark}\` | ${row.qualityBand} | ${row.status} | ${row.targetAccuracy === null ? "" : fmtPercent(row.targetAccuracy * 100)} | ${fmtPercent(row.trajectoryCachePercent)} | ${row.nextAction.replaceAll("|", "\\|")} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  const payload = buildPayload();
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    path.join(REPORT_DIR, "outcome-analysis.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), readme(payload), "utf8");
  process.stdout.write(`benchmark outcome analysis ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
