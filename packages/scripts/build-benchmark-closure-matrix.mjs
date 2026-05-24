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
  "benchmark-closure-matrix",
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

function pct(value) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "n/a";
}

function number(value) {
  return typeof value === "number" ? value : 0;
}

function byBenchmark(rows) {
  return new Map((rows || []).map((row) => [row.benchmark, row]));
}

function readiness(row) {
  if (row.agentVerdict === "blocked-live-runtime" || row.runMode === "smoke") {
    return "caveated";
  }
  if (!row.reviewComplete || !row.fiveExamplesComplete || !row.trajectoryEvidence) {
    return "missing";
  }
  return "complete";
}

function buildPayload() {
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const sampler = readJson(
    "reports/benchmark-analysis/benchmark-five-example-sampler/five-example-sampler.json",
  );
  const agentReview = readJson(
    "reports/benchmark-analysis/agent-benchmark-review/agent-benchmark-review.json",
  );

  const reviewRows = byBenchmark(review.rows);
  const samplerRows = byBenchmark(sampler.rows);
  const agentRows = byBenchmark(agentReview.codeAgentRows);

  const benchmarks = [...reviewRows.keys()].sort((a, b) => a.localeCompare(b));
  const rows = benchmarks.map((benchmark) => {
    const reviewRow = reviewRows.get(benchmark) || {};
    const samplerRow = samplerRows.get(benchmark) || {};
    const agentRow = agentRows.get(benchmark) || {};
    const targetPlaybackLinks = (reviewRow.playbackLinks || []).filter(
      (link) => link.side === "target" && link.href,
    );
    const representativeRecords = reviewRow.representativeRecords || [];
    const sampleExamples = agentRow.selectedExamples || samplerRow.examples || [];
    const caveats = [
      ...(reviewRow.caveats || []),
      ...(reviewRow.version?.hasPrevious ? [] : ["No previous indexed run for version comparison."]),
      ...(agentRow.targetPlaybackHref ? [] : ["No aggregate target telemetry playback link."]),
    ].filter(Boolean);

    const row = {
      benchmark,
      disposition: reviewRow.disposition || agentRow.disposition || "",
      status: reviewRow.status || agentRow.status || "",
      runMode: reviewRow.runMode || agentRow.runMode || "",
      runId: reviewRow.runId || "",
      reviewComplete: Boolean(reviewRow.reviewLinks?.benchmarkReview && agentRow.focusedReviewHref),
      focusedReviewHref: agentRow.focusedReviewHref || "",
      runViewerHref: reviewRow.viewerHref || "",
      fiveExamplesSelected: number(agentRow.selectedExampleCount || samplerRow.selectedCount),
      fiveExamplesWithPlayback: number(
        agentRow.selectedExamplesWithPlayback || samplerRow.selectedWithPlayback,
      ),
      fiveExamplesWithTaskId: number(
        agentRow.selectedExamplesWithTaskId || samplerRow.selectedWithTaskId,
      ),
      fiveExamplesComplete:
        number(agentRow.selectedExamplesWithPlayback || samplerRow.selectedWithPlayback) >= 5,
      samplePlaybackHrefs: sampleExamples
        .map((example) => example.playbackHref)
        .filter(Boolean)
        .slice(0, 5),
      targetPlaybackComplete: Boolean(agentRow.targetPlaybackHref),
      targetPlaybackHref: agentRow.targetPlaybackHref || "",
      targetPlaybackLinkCount: targetPlaybackLinks.length,
      trajectoryFiles: number(reviewRow.trajectory?.files || agentRow.trajectoryFiles),
      trajectoryRecords: number(reviewRow.trajectory?.records || agentRow.trajectoryRecords),
      trajectoryTokens: number(reviewRow.trajectory?.totalTokens),
      trajectoryCacheReadTokens: number(reviewRow.trajectory?.cacheReadTokens),
      trajectoryCachePercent:
        typeof reviewRow.trajectory?.cachePercent === "number"
          ? reviewRow.trajectory.cachePercent
          : agentRow.trajectoryCachePercent,
      trajectoryEvidence:
        number(reviewRow.trajectory?.files || agentRow.trajectoryFiles) > 0 &&
        number(reviewRow.trajectory?.records || agentRow.trajectoryRecords) > 0,
      representativeRecords: representativeRecords.length,
      representativeWithInput: representativeRecords.filter((record) => record.inputPreview).length,
      representativeWithOutput: representativeRecords.filter((record) => record.outputPreview).length,
      versionAvailable: Boolean(reviewRow.version?.hasPrevious || agentRow.versionAvailable),
      previousRunId: reviewRow.version?.previousRunId || "",
      versionNotes: reviewRow.version?.notes || [],
      targetAccuracy: reviewRow.target?.accuracy ?? agentRow.targetAccuracy ?? null,
      baselineAccuracy: reviewRow.baseline?.accuracy ?? agentRow.baselineAccuracy ?? null,
      targetTotal: reviewRow.target?.total ?? agentRow.targetTotal ?? null,
      targetTokens: reviewRow.target?.totalTokens ?? agentRow.targetTokens ?? 0,
      baselineTokens: reviewRow.baseline?.totalTokens ?? agentRow.baselineTokens ?? 0,
      targetCachePercent: reviewRow.target?.cachePercent ?? agentRow.targetCachePercent ?? null,
      baselineCachePercent: reviewRow.baseline?.cachePercent ?? agentRow.baselineCachePercent ?? null,
      agentVerdict: agentRow.verdict || "",
      recommendedAction: agentRow.recommendedAction || "",
      evidence: agentRow.evidence || [],
      caveats,
    };
    return { ...row, readiness: readiness(row) };
  });

  return {
    schema: "eliza_benchmark_closure_matrix_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      benchmarkCount: rows.length,
      reviewed: rows.filter((row) => row.reviewComplete).length,
      agentReviewed: rows.filter((row) => row.agentVerdict).length,
      fivePlaybackComplete: rows.filter((row) => row.fiveExamplesComplete).length,
      targetPlaybackComplete: rows.filter((row) => row.targetPlaybackComplete).length,
      trajectoryEvidence: rows.filter((row) => row.trajectoryEvidence).length,
      versionAvailable: rows.filter((row) => row.versionAvailable).length,
      complete: rows.filter((row) => row.readiness === "complete").length,
      caveated: rows.filter((row) => row.readiness === "caveated").length,
      missing: rows.filter((row) => row.readiness === "missing").length,
      sampledExamples: rows.reduce((sum, row) => sum + row.fiveExamplesSelected, 0),
      sampledExamplesWithPlayback: rows.reduce(
        (sum, row) => sum + row.fiveExamplesWithPlayback,
        0,
      ),
      sampledExamplesWithTaskId: rows.reduce((sum, row) => sum + row.fiveExamplesWithTaskId, 0),
      trajectoryFiles: rows.reduce((sum, row) => sum + row.trajectoryFiles, 0),
      trajectoryRecords: rows.reduce((sum, row) => sum + row.trajectoryRecords, 0),
      trajectoryTokens: rows.reduce((sum, row) => sum + row.trajectoryTokens, 0),
      trajectoryCacheReadTokens: rows.reduce(
        (sum, row) => sum + row.trajectoryCacheReadTokens,
        0,
      ),
    },
    rows,
  };
}

function html(payload) {
  const cards = [
    ["Benchmarks", payload.summary.benchmarkCount],
    ["Reviewed", payload.summary.reviewed],
    ["Five playback", `${payload.summary.fivePlaybackComplete}/${payload.summary.benchmarkCount}`],
    ["Target playback", `${payload.summary.targetPlaybackComplete}/${payload.summary.benchmarkCount}`],
    ["Version rows", `${payload.summary.versionAvailable}/${payload.summary.benchmarkCount}`],
    ["Caveated", payload.summary.caveated],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Closure Matrix</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .muted { color:#5f685d; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    .card { padding:10px 12px; }
    .metric { font-size:22px; font-weight:700; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; min-width:1180px; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#fbfcfa; position:sticky; top:0; z-index:1; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .ok { color:#17633a; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .bad { color:#a12222; font-weight:700; }
    .small { font-size:12px; }
  </style>
</head>
<body>
  <header><h1>Benchmark Closure Matrix</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">${cards
      .map(
        ([label, value]) =>
          `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${escapeHtml(value)}</div></div>`,
      )
      .join("")}</section>
    <section class="panel"><h2>Per-Benchmark Closure</h2><div class="body"><table><thead><tr><th>benchmark</th><th>readiness</th><th>review</th><th>five examples</th><th>target playback</th><th>trajectory</th><th>version</th><th>success/cache</th><th>agent verdict</th><th>caveats</th></tr></thead><tbody>${payload.rows
      .map((row) => {
        const cls = row.readiness === "complete" ? "ok" : row.readiness === "caveated" ? "warn" : "bad";
        return `<tr><td><code>${escapeHtml(row.benchmark)}</code><div class="small muted">${escapeHtml(row.runMode)} ${escapeHtml(row.runId)}</div></td><td class="${cls}">${escapeHtml(row.readiness)}</td><td>${row.focusedReviewHref ? `<a href="${escapeHtml(row.focusedReviewHref)}">focused review</a>` : "missing"}${row.runViewerHref ? `<br><a href="${escapeHtml(row.runViewerHref)}">run viewer</a>` : ""}</td><td>${escapeHtml(row.fiveExamplesWithPlayback)}/${escapeHtml(row.fiveExamplesSelected)} playback<br>${escapeHtml(row.fiveExamplesWithTaskId)}/${escapeHtml(row.fiveExamplesSelected)} task IDs</td><td>${row.targetPlaybackHref ? `<a href="${escapeHtml(row.targetPlaybackHref)}">telemetry playback</a>` : "aggregate missing"}<br>${escapeHtml(row.targetPlaybackLinkCount)} target playback links</td><td>${escapeHtml(row.trajectoryFiles)} files, ${escapeHtml(row.trajectoryRecords)} records<br>${escapeHtml(row.trajectoryTokens)} tokens, cache ${escapeHtml(pct(row.trajectoryCachePercent))}<br>${escapeHtml(row.representativeWithInput)}/${escapeHtml(row.representativeRecords)} representative inputs, ${escapeHtml(row.representativeWithOutput)}/${escapeHtml(row.representativeRecords)} outputs</td><td>${row.versionAvailable ? `previous <code>${escapeHtml(row.previousRunId)}</code>` : "no previous row"}${(row.versionNotes || []).map((note) => `<br><span class="small muted">${escapeHtml(note)}</span>`).join("")}</td><td>target ${escapeHtml(row.targetAccuracy ?? "n/a")} / baseline ${escapeHtml(row.baselineAccuracy ?? "n/a")}<br>target tokens ${escapeHtml(row.targetTokens)}<br>target cache ${escapeHtml(pct(row.targetCachePercent))}</td><td><code>${escapeHtml(row.agentVerdict)}</code><br>${escapeHtml(row.recommendedAction)}</td><td>${(row.caveats || []).map((caveat) => `<div>${escapeHtml(caveat)}</div>`).join("")}</td></tr>`;
      })
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Closure Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Benchmarks: ${payload.summary.benchmarkCount}`,
    `Reviewed: ${payload.summary.reviewed}`,
    `Five-example playback complete: ${payload.summary.fivePlaybackComplete}/${payload.summary.benchmarkCount}`,
    `Target aggregate playback complete: ${payload.summary.targetPlaybackComplete}/${payload.summary.benchmarkCount}`,
    `Version rows available: ${payload.summary.versionAvailable}/${payload.summary.benchmarkCount}`,
    `Readiness: ${payload.summary.complete} complete, ${payload.summary.caveated} caveated, ${payload.summary.missing} missing`,
    "",
    "| benchmark | readiness | five playback | target playback | trajectory | version | verdict |",
    "| --- | --- | ---: | --- | ---: | --- | --- |",
    ...payload.rows.map(
      (row) =>
        `| ${row.benchmark} | ${row.readiness} | ${row.fiveExamplesWithPlayback}/${row.fiveExamplesSelected} | ${row.targetPlaybackComplete ? "yes" : "aggregate missing"} | ${row.trajectoryFiles} files / ${row.trajectoryRecords} records | ${row.versionAvailable ? row.previousRunId : "no previous row"} | ${row.agentVerdict} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "benchmark-closure-matrix.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `Wrote benchmark closure matrix for ${payload.summary.benchmarkCount} benchmarks to ${path.relative(REPO_ROOT, REPORT_DIR)}\n`,
  );
}

main();
