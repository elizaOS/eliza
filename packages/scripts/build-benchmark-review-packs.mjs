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
  "benchmark-review-packs",
);
const PACK_DIR = path.join(REPORT_DIR, "benchmarks");

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

function fmt(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : String(value ?? "");
}

function pct(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
}

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}

function relFromReport(href, fromDir = REPORT_DIR) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(REPORT_DIR, text);
  return path.relative(fromDir, absolute).replaceAll(path.sep, "/");
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function buildPayload() {
  const outcome = readJson("reports/benchmark-analysis/benchmark-outcome-analysis/outcome-analysis.json");
  const samples = readJson(
    "reports/benchmark-analysis/benchmark-sample-review-matrix/sample-review-matrix.json",
  );
  const closure = readJson(
    "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
  );
  const version = readJson(
    "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
  );
  const manual = readJson("reports/benchmark-analysis/manual-review/manual-review.json");

  const samplesByBenchmark = new Map();
  for (const row of samples.rows || []) {
    if (!samplesByBenchmark.has(row.benchmark)) samplesByBenchmark.set(row.benchmark, []);
    samplesByBenchmark.get(row.benchmark).push(row);
  }
  const closureByBenchmark = new Map((closure.rows || []).map((row) => [row.benchmark, row]));
  const versionByBenchmark = new Map((version.rows || []).map((row) => [row.benchmark, row]));
  const manualByBenchmark = new Map(
    (manual.items || [])
      .filter((item) => item.kind === "code-agent-benchmark")
      .map((item) => [item.id, item]),
  );

  const packs = (outcome.rows || [])
    .slice()
    .sort((a, b) => String(a.benchmark).localeCompare(String(b.benchmark)))
    .map((row) => {
      const sampleRows = (samplesByBenchmark.get(row.benchmark) || []).sort(
        (a, b) => Number(a.sampleOrdinal || 0) - Number(b.sampleOrdinal || 0),
      );
      const closureRow = closureByBenchmark.get(row.benchmark) || {};
      const versionRow = versionByBenchmark.get(row.benchmark) || {};
      const manualItem = manualByBenchmark.get(row.benchmark) || null;
      const fileName = `${slug(row.benchmark)}.html`;
      const pack = {
        benchmark: row.benchmark,
        fileName,
        href: `benchmarks/${fileName}`,
        status: row.status,
        disposition: row.disposition,
        qualityBand: row.qualityBand,
        readiness: row.readiness,
        runId: row.runId,
        runMode: row.runMode,
        success: {
          targetTotal: row.targetTotal,
          targetAccuracy: row.targetAccuracy,
          baselineAccuracy: row.baselineAccuracy,
          accuracyDelta: row.accuracyDelta,
        },
        tokens: {
          targetTokens: row.targetTokens || 0,
          baselineTokens: row.baselineTokens || 0,
          trajectoryTokens: row.trajectoryTokens || 0,
          trajectoryCacheReadTokens: row.trajectoryCacheReadTokens || 0,
          trajectoryCachePercent: row.trajectoryCachePercent,
          targetCachePercent: row.targetCachePercent,
          baselineCachePercent: row.baselineCachePercent,
        },
        trajectory: {
          files: row.trajectoryFiles || 0,
          records: row.trajectoryRecords || 0,
          representativeRecords: row.representativeRecords || 0,
          representativeWithInput: row.representativeWithInput || 0,
          representativeWithOutput: row.representativeWithOutput || 0,
          targetPlaybackComplete: Boolean(row.targetPlaybackComplete),
          targetPlaybackHref: relFromReport(row.targetPlaybackHref, PACK_DIR),
          runViewerHref: relFromReport(row.runViewerHref, PACK_DIR),
          focusedReviewHref: relFromReport(row.focusedReviewHref, PACK_DIR),
        },
        samples: sampleRows.map((sample) => ({
          sampleOrdinal: sample.sampleOrdinal,
          taskId: sample.taskId,
          evidenceId: sample.evidenceId,
          reviewClass: sample.reviewClass,
          reviewReady: sample.reviewReady,
          totalTokens: sample.totalTokens,
          cacheReadTokens: sample.cacheReadTokens,
          cachePercent: sample.cachePercent,
          playbackHref: relFromReport(sample.playbackHref, PACK_DIR),
          sourceHref: relFromReport(sample.sourceHref, PACK_DIR),
          hasInputPreview: sample.hasInputPreview,
          hasOutputPreview: sample.hasOutputPreview,
          inputPreview: sample.inputPreview,
          outputPreview: sample.outputPreview,
        })),
        version: {
          gapType: versionRow.gapType || row.versionGapType || "",
          disposition: versionRow.disposition || row.versionDisposition || "",
          hasPrevious: Boolean(versionRow.hasPrevious),
          comparablePlaybackPair: Boolean(versionRow.comparablePlaybackPair),
          currentViewerHref: relFromReport(versionRow.currentViewerHref, PACK_DIR),
          currentTargetPlaybackHref: relFromReport(versionRow.currentTargetPlaybackHref, PACK_DIR),
          previousViewerHref: relFromReport(versionRow.previousViewerHref, PACK_DIR),
          previousTargetPlaybackHref: relFromReport(versionRow.previousTargetPlaybackHref, PACK_DIR),
          rerunCommand: versionRow.rerunCommand || "",
          followedBy: versionRow.followedBy || "",
          notes: versionRow.notes || row.evidence?.filter((item) => String(item).startsWith("version: ")) || [],
          caveats: versionRow.caveats || [],
        },
        manualReview: manualItem
          ? {
              disposition: manualItem.disposition,
              priority: manualItem.priority,
              summary: manualItem.summary,
              agentVerdict: manualItem.agentVerdict,
              recommendedAction: manualItem.recommendedAction,
              noteHref: relFromReport(`reports/benchmark-analysis/manual-review/${manualItem.noteHref}`, PACK_DIR),
            }
          : null,
        evidence: row.evidence || [],
        nextAction: row.nextAction,
      };
      return pack;
    });

  const summary = {
    benchmarkCount: packs.length,
    packPages: packs.length,
    withFiveSamples: packs.filter((pack) => pack.samples.length === 5).length,
    sampleRows: packs.reduce((sum, pack) => sum + pack.samples.length, 0),
    samplePlaybackRows: packs.reduce(
      (sum, pack) => sum + pack.samples.filter((sample) => sample.playbackHref).length,
      0,
    ),
    reviewReadySamples: packs.reduce(
      (sum, pack) => sum + pack.samples.filter((sample) => sample.reviewReady).length,
      0,
    ),
    withTargetPlayback: packs.filter((pack) => pack.trajectory.targetPlaybackComplete).length,
    withManualReviewNote: packs.filter((pack) => pack.manualReview?.noteHref).length,
    withVersionPrevious: packs.filter((pack) => pack.version.hasPrevious).length,
    withComparablePlaybackPair: packs.filter((pack) => pack.version.comparablePlaybackPair).length,
    totalTrajectoryTokens: packs.reduce((sum, pack) => sum + pack.tokens.trajectoryTokens, 0),
    totalTrajectoryCacheReadTokens: packs.reduce(
      (sum, pack) => sum + pack.tokens.trajectoryCacheReadTokens,
      0,
    ),
  };

  return {
    schema: "eliza_benchmark_review_packs_v1",
    generatedAt: new Date().toISOString(),
    summary,
    packs,
  };
}

function packHtml(payload, pack) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pack.benchmark)} Review Pack</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:8px; margin-bottom:12px; }
    .metric,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    .metric { padding:10px; }
    .metric strong { display:block; font-size:20px; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    th { background:#fbfcfa; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { white-space:pre-wrap; margin:0; max-height:180px; overflow:auto; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(pack.benchmark)} Review Pack</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="grid">
      <div class="metric"><span>quality</span><strong>${escapeHtml(pack.qualityBand)}</strong></div>
      <div class="metric"><span>target/baseline</span><strong>${escapeHtml(pack.success.targetAccuracy)} / ${escapeHtml(pack.success.baselineAccuracy)}</strong></div>
      <div class="metric"><span>trajectory cache</span><strong>${escapeHtml(pct(pack.tokens.trajectoryCachePercent))}</strong></div>
      <div class="metric"><span>sample playback</span><strong>${pack.samples.filter((sample) => sample.playbackHref).length}/${pack.samples.length}</strong></div>
      <div class="metric"><span>input/output reps</span><strong>${pack.trajectory.representativeWithInput}/${pack.trajectory.representativeWithOutput}</strong></div>
      <div class="metric"><span>version</span><strong>${escapeHtml(pack.version.gapType || "none")}</strong></div>
    </section>
    <section class="panel"><h2>Primary Links</h2><div class="body">
      ${link(pack.trajectory.runViewerHref, "run viewer")} ${link(pack.trajectory.focusedReviewHref, "focused review")} ${link(pack.trajectory.targetPlaybackHref, "target playback")} ${pack.manualReview ? link(pack.manualReview.noteHref, "manual note") : ""} ${link(pack.version.previousTargetPlaybackHref, "previous target playback")}
    </div></section>
    <section class="panel"><h2>Outcome And Cache</h2><div class="body"><table><tbody>
      <tr><th>run</th><td>${escapeHtml(pack.runId)} (${escapeHtml(pack.runMode)})</td></tr>
      <tr><th>status</th><td>${escapeHtml(pack.status)} / ${escapeHtml(pack.disposition)} / ${escapeHtml(pack.readiness)}</td></tr>
      <tr><th>success</th><td>target ${escapeHtml(pack.success.targetAccuracy)} over ${escapeHtml(pack.success.targetTotal)}; baseline ${escapeHtml(pack.success.baselineAccuracy)}; delta ${escapeHtml(pack.success.accuracyDelta)}</td></tr>
      <tr><th>tokens/cache</th><td>${fmt(pack.tokens.trajectoryTokens)} trajectory tokens, ${fmt(pack.tokens.trajectoryCacheReadTokens)} cached-read; target cache ${pct(pack.tokens.targetCachePercent)}, baseline cache ${pct(pack.tokens.baselineCachePercent)}</td></tr>
      <tr><th>trajectory</th><td>${pack.trajectory.files} files, ${pack.trajectory.records} records, ${pack.trajectory.representativeRecords} representative records</td></tr>
    </tbody></table></div></section>
    <section class="panel"><h2>Five Sampled Examples</h2><div class="body"><table><thead><tr><th>#</th><th>task</th><th>class</th><th>tokens/cache</th><th>links</th><th>preview</th></tr></thead><tbody>
      ${pack.samples.map((sample) => `<tr><td>${sample.sampleOrdinal}</td><td><code>${escapeHtml(sample.taskId || sample.evidenceId || "")}</code></td><td>${escapeHtml(sample.reviewClass)}<br><span class="muted">${sample.reviewReady ? "review-ready" : "needs evidence"}</span></td><td>${fmt(sample.totalTokens)}<br><span class="muted">${fmt(sample.cacheReadTokens)} cached, ${escapeHtml(pct(sample.cachePercent))}</span></td><td>${link(sample.playbackHref, "playback")} ${link(sample.sourceHref, "source")}</td><td><b>input</b><pre>${escapeHtml(sample.inputPreview)}</pre>${sample.outputPreview ? `<b>output</b><pre>${escapeHtml(sample.outputPreview)}</pre>` : ""}</td></tr>`).join("")}
    </tbody></table></div></section>
    <section class="panel"><h2>Version And Manual Review</h2><div class="body"><table><tbody>
      <tr><th>version</th><td>${escapeHtml(pack.version.disposition)}; previous=${pack.version.hasPrevious ? "yes" : "no"}; playback pair=${pack.version.comparablePlaybackPair ? "yes" : "no"}; ${pack.version.notes.map(escapeHtml).join("; ")}</td></tr>
      <tr><th>rerun</th><td><code>${escapeHtml(pack.version.rerunCommand)}</code>${pack.version.followedBy ? `<br><code>${escapeHtml(pack.version.followedBy)}</code>` : ""}</td></tr>
      <tr><th>manual</th><td>${pack.manualReview ? `${escapeHtml(pack.manualReview.agentVerdict)}; ${escapeHtml(pack.manualReview.recommendedAction)}` : "no code-agent benchmark manual-review note"}</td></tr>
      <tr><th>next action</th><td>${escapeHtml(pack.nextAction)}</td></tr>
    </tbody></table></div></section>
  </main>
</body>
</html>`;
}

function indexHtml(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Review Packs</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    .card { padding:10px; }
    .card strong { display:block; font-size:20px; }
    table { width:100%; border-collapse:collapse; background:#fff; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Review Packs</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      ${Object.entries(payload.summary).slice(0, 8).map(([key, value]) => `<div class="card"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
    </section>
    <section class="panel"><table><thead><tr><th>benchmark</th><th>quality</th><th>success</th><th>cache</th><th>samples</th><th>version</th><th>links</th></tr></thead><tbody>
      ${payload.packs.map((pack) => `<tr><td><code>${escapeHtml(pack.benchmark)}</code><br><span class="muted">${escapeHtml(pack.runId)}</span></td><td>${escapeHtml(pack.qualityBand)}<br>${escapeHtml(pack.disposition)}</td><td>${escapeHtml(pack.success.targetAccuracy)} / ${escapeHtml(pack.success.baselineAccuracy)}</td><td>${pct(pack.tokens.trajectoryCachePercent)}</td><td>${pack.samples.filter((sample) => sample.playbackHref).length}/${pack.samples.length} playback<br>${pack.samples.filter((sample) => sample.reviewReady).length} review-ready</td><td>${escapeHtml(pack.version.gapType || "")}</td><td><a href="${escapeHtml(pack.href)}">pack</a> ${link(pack.trajectory.targetPlaybackHref ? `benchmarks/${pack.fileName}` : "", "")}</td></tr>`).join("")}
    </tbody></table></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Review Packs",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Summary: ${payload.summary.packPages}/${payload.summary.benchmarkCount} pack pages, ${payload.summary.samplePlaybackRows}/${payload.summary.sampleRows} sample playback rows, ${payload.summary.withManualReviewNote} manual-review notes, ${payload.summary.withComparablePlaybackPair} comparable playback pairs.`,
    "",
    "| Benchmark | Pack | Quality | Samples | Cache | Version |",
    "| --- | --- | --- | ---: | ---: | --- |",
    ...payload.packs.map(
      (pack) =>
        `| \`${pack.benchmark}\` | \`${pack.href}\` | ${pack.qualityBand} | ${pack.samples.length} | ${pct(pack.tokens.trajectoryCachePercent)} | ${pack.version.gapType || ""} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(PACK_DIR, { recursive: true });
  const payload = buildPayload();
  for (const pack of payload.packs) {
    writeFileSync(path.join(PACK_DIR, pack.fileName), packHtml(payload, pack), "utf8");
  }
  writeFileSync(
    path.join(REPORT_DIR, "benchmark-review-packs.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), indexHtml(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`benchmark review packs ${payload.summary.packPages} pages at ${REPORT_DIR}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
