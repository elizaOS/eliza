#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "analysis-summary");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function rel(target, from = REPORT_DIR) {
  return path.relative(from, path.join(REPO_ROOT, target)).replaceAll(path.sep, "/");
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

function buildPayload() {
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const scenarios = readJson("reports/scenarios/catalog-execution-union/coverage.json");
  const failures = readJson("reports/scenarios/failure-analysis/failure-analysis.json");
  const live = readJson("reports/live-test-inventory/inventory.json");
  const audit = readJson("reports/benchmark-analysis/goal-audit.json");
  const gap = readJson("reports/benchmark-analysis/gap-evidence/gap-evidence.json");
  const remediation = readJson("reports/benchmark-analysis/remediation-matrix/remediation-matrix.json");
  const sampleReview = readJson("reports/benchmark-analysis/benchmark-sample-review-matrix/sample-review-matrix.json");
  const versionRemediation = readJson(
    "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
  );
  const corpusPacks = readJson("reports/benchmark-analysis/corpus-review-packs/corpus-review-packs.json");
  const livePromptResponse = readJson(
    "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
  );
  const rerunBatches = readJson("reports/benchmark-analysis/rerun-batches/rerun-batches.json");
  const manualProgress = readJson(
    "reports/benchmark-analysis/manual-review-progress/manual-review-progress.json",
  );
  const benchmarkFocus = (review.rows || [])
    .filter((row) => row.disposition !== "review-pass")
    .map((row) => ({
      id: row.benchmark,
      disposition: row.disposition,
      status: row.status,
      score: `${row.target?.right}/${row.target?.total}`,
      cachePercent: row.target?.cachePercent ?? null,
      tokenDelta: row.deltas?.totalTokens ?? null,
      reasons: [
        ...(row.releaseReadinessBlockingRequirements || []),
        ...(row.caveats || []),
      ].slice(0, 8),
      href: rel(`reports/benchmark-analysis/benchmark-review/${row.reviewLinks?.benchmarkReview || "index.html"}`),
    }));
  const corpusFocus = (corpus.reviewFindings || [])
    .filter((finding) => finding.disposition !== "review-pass")
    .slice()
    .sort((a, b) => {
      const rank = { blocked: 3, "needs-review": 2, "telemetry-gap": 1 };
      return (rank[b.disposition] || 0) - (rank[a.disposition] || 0) ||
        Number(b.normalized_calls || 0) - Number(a.normalized_calls || 0);
    })
    .slice(0, 12)
    .map((finding) => ({
      id: finding.benchmark_id,
      disposition: finding.disposition,
      calls: finding.normalized_calls,
      tokens: finding.token_total,
      cachePercent: finding.cache_percent,
      reasons: finding.reasons || [],
      href: finding.gap_page
        ? rel(finding.gap_page)
        : rel("reports/benchmarks/benchmark-results-corpus-review/index.html"),
    }));
  const scenarioFocus = (failures.categories || []).map((category) => ({
    id: category.key,
    count: category.count,
    disposition: category.disposition,
    nextAction: category.nextAction,
    href: rel(`reports/scenarios/failure-analysis/${category.pageHref || "index.html"}`),
  }));
  const liveFocus = (live.scriptFindings || [])
    .filter((finding) => finding.likelyLlm && finding.disposition !== "model-wrapper-pass")
    .map((finding) => ({
      id: `${finding.packageJson}:${finding.script}`,
      disposition: finding.disposition,
      wrappedRuns: finding.wrappedRunCount,
      latestExit: finding.latestWrappedExitCode,
      reasons: finding.reasons || [],
      href: finding.latestWrappedPlayback
        ? rel(`reports/live-test-inventory/${finding.latestWrappedPlayback}`)
        : rel(`reports/live-test-inventory/${finding.modelReviewHref || "index.html"}`),
    }));
  return {
    schema: "eliza_benchmark_analysis_summary_v1",
    generatedAt: new Date().toISOString(),
    headline: {
      goalAudit: audit.summary,
      benchmarkReview: review.summary,
      corpusFindings: corpus.reviewFindingSummary,
      scenarioExecution: scenarios.findingSummary,
      scenarioFailures: failures.summary,
      liveFindings: live.findingSummary,
      corpusCoverage: {
        normalizedCallCount: corpus.callCatalogSummary?.normalizedCallCount || 0,
        rowsWithNormalizedCalls: corpus.callCatalogSummary?.rowsWithNormalizedCalls || 0,
        benchmarksWithNormalizedCalls:
          corpus.callCatalogSummary?.benchmarksWithNormalizedCalls || 0,
        canonicalTrajectoryFiles: corpus.summary?.canonicalTrajectoryFiles || 0,
        noPlaybackGapPages: corpus.summary?.noPlaybackGapPages || 0,
        tokenlessFamilies: corpus.telemetryGapSummary?.tokenlessFamilyCount || 0,
        zeroMetricLatestRows: corpus.telemetryGapSummary?.zeroMetricLatestRows || 0,
        evidenceAbsentLatestRows: corpus.telemetryGapSummary?.evidenceAbsentLatestRows || 0,
      },
      strictReviewSignals: {
        sampledExamples: sampleReview.summary?.sampleRows || 0,
        reviewReadySamples: sampleReview.summary?.reviewReadyRows || 0,
        fullInlineSampleRows: sampleReview.summary?.fullInlineReviewRows || 0,
        toolCallOnlySampleRows: sampleReview.summary?.toolCallOnlyInlineRows || 0,
        playbackOnlyEnvironmentRows: sampleReview.summary?.playbackOnlyEnvironmentRows || 0,
        previousAggregateOnlyReviewRows:
          versionRemediation.summary?.previousAggregateOnlyReviewRows || 0,
        corpusWarningRowsWithPlayback: corpusPacks.summary?.warningRowsWithPlayback || 0,
        corpusWarningRowsWithCallPreview: corpusPacks.summary?.warningRowsWithCallPreview || 0,
        liveOfflineReviewSummaries:
          livePromptResponse.summary?.rowsWithOfflineReviewSummary || 0,
        liveNoSidecarOfflineSummaries:
          livePromptResponse.summary?.noSidecarRowsWithOfflineReviewSummary || 0,
      },
      readinessActions: {
        remediationItems: remediation.summary?.itemCount || 0,
        localActionItems: remediation.summary?.localActionItems || 0,
        localCredentialRequiredItems: remediation.summary?.localCredentialRequiredItems || 0,
        localActionByLane: remediation.summary?.localActionByLane || {},
        objectiveCaveats: remediation.summary?.objectiveCaveats || 0,
        objectiveLocalActionItems: remediation.summary?.objectiveLocalActionItems || 0,
        objectiveLocalActionByLane: remediation.summary?.objectiveLocalActionByLane || {},
        liveLocalActionItems: remediation.summary?.liveLocalActionItems || 0,
        liveLocalActionByLane: remediation.summary?.liveLocalActionByLane || {},
        rerunBatches: rerunBatches.summary?.batchCount || 0,
        runnableCommands: rerunBatches.summary?.runnableCommands || 0,
        blockedCommands: rerunBatches.summary?.blockedCommands || 0,
        manualReviewed: manualProgress.summary?.reviewed || 0,
        manualReviewItems: manualProgress.summary?.itemCount || 0,
      },
    },
    externalGates: [
      {
        id: "osworld-live",
        status: gap.osworld?.providerReadiness?.runnableProviderCount > 0 ? "ready-to-rerun" : "blocked",
        evidence:
          Object.entries(gap.osworld?.providerReadiness?.providers || {})
            .map(([provider, detail]) => `${provider}: ${detail.detail}`)
            .join("; ") || "",
        href: "../gap-evidence/osworld-live-readiness.html",
      },
      {
        id: "hyperliquid_bench",
        status: corpus.credentialGaps?.hyperliquid?.runnable ? "ready-to-rerun" : "blocked",
        evidence: `missing=${(corpus.credentialGaps?.hyperliquid?.missing || []).join(",") || "none"}`,
        href: rel("reports/benchmarks/benchmark-results-corpus-review/gap-pages/hyperliquid_bench.html"),
      },
    ],
    focus: {
      benchmark: benchmarkFocus,
      corpus: corpusFocus,
      scenarioCategories: scenarioFocus,
      liveModelScripts: liveFocus,
    },
  };
}

function table(rows, columns) {
  return `<table><thead><tr>${columns
    .map((column) => `<th>${escapeHtml(column.label)}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map(
      (row) =>
        `<tr>${columns
          .map((column) => `<td>${column.render ? column.render(row) : escapeHtml(row[column.key])}</td>`)
          .join("")}</tr>`,
    )
    .join("")}</tbody></table>`;
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Analysis Summary</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Analysis Summary</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="grid">
      ${[
        ["Goal audit", `${payload.headline.goalAudit.proven}/${payload.headline.goalAudit.total} proven`],
        ["Benchmark review", `${payload.headline.benchmarkReview.reviewPass}/${payload.headline.benchmarkReview.benchmarkCount} pass`],
        ["Corpus families", `${payload.headline.corpusFindings.reviewPass}/${payload.headline.corpusFindings.findingCount} pass`],
        ["Scenarios", `${payload.headline.scenarioExecution.passed}/${payload.headline.scenarioExecution.findingCount} passed`],
        ["Failed scenarios", payload.headline.scenarioFailures.failedScenarios],
        ["Live model gaps", payload.headline.liveFindings.modelArtifactGap],
        ["Sample review", `${payload.headline.strictReviewSignals.reviewReadySamples}/${payload.headline.strictReviewSignals.sampledExamples} ready`],
        ["Corpus warnings", `${payload.headline.strictReviewSignals.corpusWarningRowsWithPlayback}/${payload.headline.strictReviewSignals.corpusWarningRowsWithCallPreview} playback/calls`],
        ["Rerun commands", `${payload.headline.readinessActions.runnableCommands} runnable`],
        ["Manual notes", `${payload.headline.readinessActions.manualReviewed}/${payload.headline.readinessActions.manualReviewItems} reviewed`],
      ]
        .map(([label, value]) => `<div class="card"><span class="muted">${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`)
        .join("")}
    </div>
    <section class="panel"><h2>Strict Review Signals</h2><div class="body">${table([
      { label: "sample review", value: `${payload.headline.strictReviewSignals.fullInlineSampleRows} full inline, ${payload.headline.strictReviewSignals.toolCallOnlySampleRows} tool-call-only, ${payload.headline.strictReviewSignals.playbackOnlyEnvironmentRows} playback-only environment` },
      { label: "version gaps", value: `${payload.headline.strictReviewSignals.previousAggregateOnlyReviewRows} previous aggregate-only rows have review summaries` },
      { label: "corpus warnings", value: `${payload.headline.strictReviewSignals.corpusWarningRowsWithPlayback} rows with playback, ${payload.headline.strictReviewSignals.corpusWarningRowsWithCallPreview} rows with call previews` },
      { label: "live/e2e offline review", value: `${payload.headline.strictReviewSignals.liveOfflineReviewSummaries} offline summaries, ${payload.headline.strictReviewSignals.liveNoSidecarOfflineSummaries} no-sidecar guidance rows` },
      { label: "local action lanes", value: `${payload.headline.readinessActions.objectiveLocalActionItems}/${payload.headline.readinessActions.objectiveCaveats} objective caveats and ${payload.headline.readinessActions.liveLocalActionItems} live/e2e rows have local actions` },
      { label: "all remediation rows", value: `${payload.headline.readinessActions.localActionItems}/${payload.headline.readinessActions.remediationItems} rows have local actions; ${payload.headline.readinessActions.localCredentialRequiredItems} require credentials` },
    ], [
      { label: "signal", key: "label" },
      { label: "evidence", key: "value" },
    ])}</div></section>
    <section class="panel"><h2>External Gates</h2><div class="body">${table(payload.externalGates, [
      { label: "gate", render: (row) => `<code>${escapeHtml(row.id)}</code>` },
      { label: "status", render: (row) => `<span class="${row.status === "blocked" ? "bad" : "ok"}">${escapeHtml(row.status)}</span>` },
      { label: "evidence", key: "evidence" },
      { label: "review", render: (row) => `<a href="${escapeHtml(row.href)}">open</a>` },
    ])}</div></section>
    <section class="panel"><h2>Benchmark Focus</h2><div class="body">${table(payload.focus.benchmark, [
      { label: "benchmark", render: (row) => `<code>${escapeHtml(row.id)}</code>` },
      { label: "disposition", key: "disposition" },
      { label: "score", key: "score" },
      { label: "token delta", key: "tokenDelta" },
      { label: "reasons", render: (row) => escapeHtml((row.reasons || []).join("; ")) },
      { label: "review", render: (row) => `<a href="${escapeHtml(row.href)}">open</a>` },
    ])}</div></section>
    <section class="panel"><h2>Corpus Focus</h2><div class="body">${table(payload.focus.corpus, [
      { label: "benchmark", render: (row) => `<code>${escapeHtml(row.id)}</code>` },
      { label: "disposition", key: "disposition" },
      { label: "calls", key: "calls" },
      { label: "tokens", key: "tokens" },
      { label: "reasons", render: (row) => escapeHtml((row.reasons || []).join("; ")) },
      { label: "review", render: (row) => `<a href="${escapeHtml(row.href)}">open</a>` },
    ])}</div></section>
    <section class="panel"><h2>Scenario Failure Categories</h2><div class="body">${table(payload.focus.scenarioCategories, [
      { label: "category", render: (row) => `<code>${escapeHtml(row.id)}</code>` },
      { label: "count", key: "count" },
      { label: "disposition", key: "disposition" },
      { label: "next action", key: "nextAction" },
      { label: "review", render: (row) => `<a href="${escapeHtml(row.href)}">open</a>` },
    ])}</div></section>
    <section class="panel"><h2>Live/E2E Model-Call Focus</h2><div class="body">${table(payload.focus.liveModelScripts, [
      { label: "script", render: (row) => `<code>${escapeHtml(row.id)}</code>` },
      { label: "disposition", key: "disposition" },
      { label: "wrapped", key: "wrappedRuns" },
      { label: "exit", key: "latestExit" },
      { label: "reasons", render: (row) => escapeHtml((row.reasons || []).join("; ")) },
      { label: "review", render: (row) => `<a href="${escapeHtml(row.href)}">open</a>` },
    ])}</div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Analysis Summary",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Goal audit: ${payload.headline.goalAudit.proven}/${payload.headline.goalAudit.total} proven, ${payload.headline.goalAudit.caveated} caveated, ${payload.headline.goalAudit.blocked || 0} blocked, ${payload.headline.goalAudit.missing} missing`,
    `Benchmark focus rows: ${payload.focus.benchmark.length}`,
    `Corpus focus rows: ${payload.focus.corpus.length}`,
    `Scenario category rows: ${payload.focus.scenarioCategories.length}`,
    `Live/e2e model-call focus rows: ${payload.focus.liveModelScripts.length}`,
    `Sample review: ${payload.headline.strictReviewSignals.reviewReadySamples}/${payload.headline.strictReviewSignals.sampledExamples} ready`,
    `Corpus warning rows: ${payload.headline.strictReviewSignals.corpusWarningRowsWithPlayback} with playback, ${payload.headline.strictReviewSignals.corpusWarningRowsWithCallPreview} with call previews`,
    `Local actions: ${payload.headline.readinessActions.localActionItems}/${payload.headline.readinessActions.remediationItems} remediation rows; ${payload.headline.readinessActions.objectiveLocalActionItems}/${payload.headline.readinessActions.objectiveCaveats} objective caveats and ${payload.headline.readinessActions.liveLocalActionItems} live/e2e rows`,
    `Rerun commands: ${payload.headline.readinessActions.runnableCommands} runnable across ${payload.headline.readinessActions.rerunBatches} batches; ${payload.headline.readinessActions.blockedCommands} blocked`,
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "summary.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(REPORT_DIR, "summary-data.js"),
    `window.BENCHMARK_ANALYSIS_SUMMARY = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `benchmark analysis summary ${payload.focus.benchmark.length} benchmark focus rows\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
