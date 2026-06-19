#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "run-contract");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function readWindowJson(relativePath, assignmentPrefix) {
  return JSON.parse(
    readFileSync(path.join(REPO_ROOT, relativePath), "utf8")
      .replace(assignmentPrefix, "")
      .replace(/;\n?$/, ""),
  );
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

function exists(relativePath) {
  return existsSync(path.join(REPO_ROOT, relativePath));
}

function ignored(relativePath) {
  const result = spawnSync("git", ["check-ignore", "-q", "--", relativePath], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  return result.status === 0;
}

function buildPayload() {
  const pkg = readJson("package.json");
  const hub = readWindowJson(
    "reports/benchmark-analysis/hub-data.js",
    /^window\.BENCHMARK_ANALYSIS_HUB = /,
  );
  const indexData = readWindowJson(
    "reports/benchmarks/code-agent-run-index/index-data.js",
    /^window\.BENCHMARK_RUN_INDEX = /,
  );
  const trajectory = readJson("reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json");
  const version = readJson("reports/benchmarks/code-agent-version-comparison/version-comparison.json");
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const scenarios = readJson("reports/scenarios/catalog-execution-union/coverage.json");
  const livePlayback = readJson("reports/live-test-runs/playback-manifest.json");
  const liveInventory = readJson("reports/live-test-inventory/inventory.json");
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const fiveExampleSampler = readJson(
    "reports/benchmark-analysis/benchmark-five-example-sampler/five-example-sampler.json",
  );
  const globalPlaybackIndex = readJson(
    "reports/benchmark-analysis/global-playback-index/global-playback-index.json",
  );
  const reviewQueue = readJson("reports/benchmark-analysis/review-queue/review-queue.json");
  const manualReview = readJson("reports/benchmark-analysis/manual-review/manual-review.json");
  const artifactManifest = readJson("reports/benchmark-analysis/artifact-manifest/manifest.json");
  const commands = [
    {
      id: "build",
      command: pkg.scripts?.["bench:analysis:build"] || "",
      required: true,
      present: Boolean(pkg.scripts?.["bench:analysis:build"]),
    },
    {
      id: "verify",
      command: pkg.scripts?.["bench:analysis:verify"] || "",
      required: true,
      present: Boolean(pkg.scripts?.["bench:analysis:verify"]),
    },
  ];
  const ignoredRoots = [
    "reports/benchmark-analysis/index.html",
    "reports/benchmarks/code-agent-runs/manifest.json",
    "reports/benchmarks/benchmark-results-corpus-review/index.html",
    "reports/scenarios/catalog-execution-union/index.html",
    "reports/live-test-runs/playback-manifest.json",
    "reports/live-test-inventory/index.html",
    "packages/benchmarks/benchmark_results",
  ].map((entry) => ({ path: entry, ignored: ignored(entry), exists: exists(entry) }));
  const viewerEntrypoints = [
    ["Unified hub", "reports/benchmark-analysis/index.html"],
    ["Run contract", "reports/benchmark-analysis/run-contract/index.html"],
    ["Benchmark run index", "reports/benchmarks/code-agent-run-index/index.html"],
    ["Mirrored benchmark runs", "reports/benchmarks/code-agent-runs/manifest.json"],
    ["Code-agent trajectory catalog", "reports/benchmarks/code-agent-trajectory-catalog/index.html"],
    ["Benchmark version comparison", "reports/benchmarks/code-agent-version-comparison/index.html"],
    ["Benchmark corpus review", "reports/benchmarks/benchmark-results-corpus-review/index.html"],
    ["Scenario execution union", "reports/scenarios/catalog-execution-union/index.html"],
    ["Scenario agent review", "reports/benchmark-analysis/scenario-agent-review/index.html"],
    ["Live/e2e inventory", "reports/live-test-inventory/index.html"],
    ["Live/e2e agent review", "reports/benchmark-analysis/live-test-agent-review/index.html"],
    ["Manual review workspace", "reports/benchmark-analysis/manual-review/index.html"],
  ].map(([label, target]) => ({
    label,
    path: target,
    href: rel(target),
    exists: target === "reports/benchmark-analysis/run-contract/index.html" || exists(target),
  }));
  const playback = {
    codeAgentTrajectory: `${trajectory.summary.playbackFiles}/${trajectory.summary.trajectoryFiles}`,
    corpusCanonical: `${(corpus.canonicalFiles || []).filter((entry) => entry.playback_file).length}/${corpus.summary.canonicalTrajectoryFiles}`,
    corpusGapPages: (corpus.noPlaybackGapPages || []).length,
    scenario: `${scenarios.scenarioPlaybackPages}/${scenarios.catalogScenarioCount}`,
    liveWrapped: `${livePlayback.playbackCount}/${livePlayback.runCount}`,
  };
  const versionSupport = {
    codeAgentBenchmarksWithPrevious: version.summary.benchmarksWithPrevious,
    codeAgentBenchmarkCount: version.summary.benchmarkCount,
    codeAgentPreviousPlaybackLinks: version.summary.previousTargetPlaybackLinks || 0,
    codeAgentComparablePlaybackPairs: version.summary.comparablePlaybackPairs || 0,
    codeAgentPreviousPlaybackGapCount: version.summary.previousPlaybackGapCount || 0,
    codeAgentRecoveredPreviousPlaybackBenchmarks:
      version.summary.recoveredPreviousPlaybackBenchmarks || [],
    codeAgentPreviousPlaybackGapBenchmarks:
      version.summary.previousPlaybackGapBenchmarks || [],
    codeAgentPlaybackComparisonStatus: version.summary.playbackComparisonStatus || "",
    corpusRunHistoryRows: corpus.runHistory?.summary?.runCount || 0,
    corpusPairsWithPrevious: corpus.runHistory?.summary?.pairsWithPrevious || 0,
    corpusPairsWithSuccessfulPrevious: corpus.runHistory?.summary?.pairsWithSuccessfulPrevious || 0,
  };
  const objectiveCoverage = {
    benchmarkReviewRows: review.summary?.benchmarkCount || 0,
    benchmarkLatestRows: Object.keys(indexData.latest_by_benchmark || {}).length,
    fiveExampleSelectedRows: fiveExampleSampler.summary?.selectedRows || 0,
    fiveExampleExpectedRows: Number(fiveExampleSampler.summary?.benchmarkCount || 0) * 5,
    fiveExampleRowsWithPlayback: fiveExampleSampler.summary?.selectedWithPlayback || 0,
    trajectoryRecords: trajectory.summary?.trajectoryRecords || 0,
    trajectoryRecordsWithInput: trajectory.summary?.inputOutput?.recordsWithInput || 0,
    trajectoryRecordsWithOutput: trajectory.summary?.inputOutput?.recordsWithOutput || 0,
    globalPlaybackRows: globalPlaybackIndex.summary?.rowCount || 0,
    globalPlaybackRowsExisting: globalPlaybackIndex.summary?.playbackExisting || 0,
    globalPlaybackCallOrEventCount: globalPlaybackIndex.summary?.totalCallOrEventCount || 0,
    globalPlaybackTotalTokens: globalPlaybackIndex.summary?.totalTokens || 0,
    globalPlaybackCachedTokens: globalPlaybackIndex.summary?.cachedTokens || 0,
    scenarioFindings: scenarios.findingSummary?.findingCount || 0,
    scenarioMissing: scenarios.findingSummary?.missing || 0,
    liveModelScripts: liveInventory.summary?.modelArtifactRequiredScripts || 0,
    liveModelScriptsWithoutEvidence:
      liveInventory.summary?.modelArtifactRequiredWithoutEvidence || 0,
    liveModelScriptsWithStructuredStatus:
      liveInventory.summary?.structuredLlmModelScriptsWithReason || 0,
    liveStructuredCallCount: liveInventory.summary?.structuredLlmCallCount || 0,
    versionBenchmarksWithPrevious: version.summary?.benchmarksWithPrevious || 0,
    versionComparablePlaybackPairs: version.summary?.comparablePlaybackPairs || 0,
    versionPreviousPlaybackGaps: version.summary?.previousPlaybackGapCount || 0,
    versionPreviousPlaybackGapBenchmarks:
      version.summary?.previousPlaybackGapBenchmarks || [],
    versionPlaybackComparisonStatus: version.summary?.playbackComparisonStatus || "",
    reviewQueueItems: reviewQueue.summary?.itemCount || 0,
    manualReviewNotes: manualReview.summary?.noteCount || 0,
    manualReviewAgentTriage: manualReview.summary?.agentReviewed || 0,
  };
  const checks = [
    {
      id: "commands-present",
      ok: commands.every((command) => command.present),
      detail: commands.map((command) => `${command.id}=${command.command || "missing"}`).join("; "),
    },
    {
      id: "ignored-roots",
      ok: ignoredRoots.every((entry) => entry.ignored),
      detail: ignoredRoots.map((entry) => `${entry.path}:${entry.ignored ? "ignored" : "tracked"}`).join("; "),
    },
    {
      id: "viewer-entrypoints-exist",
      ok: viewerEntrypoints.every((entry) => entry.exists),
      detail: `${viewerEntrypoints.filter((entry) => entry.exists).length}/${viewerEntrypoints.length}`,
    },
    {
      id: "playback-coverage",
      ok:
        trajectory.summary.playbackFiles === trajectory.summary.trajectoryFiles &&
        (corpus.canonicalFiles || []).filter((entry) => entry.playback_file).length ===
          corpus.summary.canonicalTrajectoryFiles &&
        scenarios.scenarioPlaybackPages === scenarios.catalogScenarioCount &&
        livePlayback.playbackCount === livePlayback.runCount,
      detail: JSON.stringify(playback),
    },
    {
      id: "version-support",
      ok:
        version.summary.benchmarksWithPrevious > 0 &&
        (corpus.runHistory?.summary?.pairsWithPrevious || 0) > 0,
      detail: JSON.stringify(versionSupport),
    },
    {
      id: "artifact-manifest",
      ok: artifactManifest.summary?.totalFiles >= 7000 && artifactManifest.summary?.htmlFiles >= 1180,
      detail: JSON.stringify(artifactManifest.summary || {}),
    },
    {
      id: "objective-coverage",
      ok:
        objectiveCoverage.benchmarkReviewRows === objectiveCoverage.benchmarkLatestRows &&
        objectiveCoverage.fiveExampleSelectedRows === objectiveCoverage.fiveExampleExpectedRows &&
        objectiveCoverage.fiveExampleRowsWithPlayback === objectiveCoverage.fiveExampleExpectedRows &&
        objectiveCoverage.trajectoryRecordsWithInput >= 530 &&
        objectiveCoverage.trajectoryRecordsWithOutput >= 300 &&
        objectiveCoverage.globalPlaybackRows === objectiveCoverage.globalPlaybackRowsExisting &&
        objectiveCoverage.globalPlaybackCallOrEventCount >= 14000 &&
        objectiveCoverage.globalPlaybackTotalTokens > 0 &&
        objectiveCoverage.globalPlaybackCachedTokens > 0 &&
        objectiveCoverage.scenarioFindings === scenarios.catalogScenarioCount &&
        objectiveCoverage.scenarioMissing === 0 &&
        objectiveCoverage.liveModelScriptsWithoutEvidence === 0 &&
        objectiveCoverage.liveModelScriptsWithStructuredStatus ===
          objectiveCoverage.liveModelScripts &&
        objectiveCoverage.liveStructuredCallCount > 0 &&
        objectiveCoverage.versionBenchmarksWithPrevious ===
          versionSupport.codeAgentBenchmarksWithPrevious &&
        objectiveCoverage.versionComparablePlaybackPairs ===
          versionSupport.codeAgentComparablePlaybackPairs &&
        objectiveCoverage.versionPreviousPlaybackGaps ===
          versionSupport.codeAgentPreviousPlaybackGapCount &&
        JSON.stringify(objectiveCoverage.versionPreviousPlaybackGapBenchmarks) ===
          JSON.stringify(versionSupport.codeAgentPreviousPlaybackGapBenchmarks) &&
        objectiveCoverage.manualReviewNotes === objectiveCoverage.reviewQueueItems &&
        objectiveCoverage.manualReviewAgentTriage === objectiveCoverage.reviewQueueItems,
      detail: JSON.stringify(objectiveCoverage),
    },
  ];
  return {
    schema: "eliza_benchmark_run_contract_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      ok: checks.every((check) => check.ok),
      commandCount: commands.length,
      ignoredRootCount: ignoredRoots.length,
      viewerEntrypointCount: viewerEntrypoints.length,
      artifactFiles: artifactManifest.summary?.totalFiles || 0,
      htmlFiles: artifactManifest.summary?.htmlFiles || 0,
      playbackHtmlFiles: artifactManifest.summary?.playbackHtmlFiles || 0,
      mirroredBenchmarkRuns: indexData.mirrored_run_artifacts?.mirrored_run_count || 0,
    },
    commands,
    ignoredRoots,
    viewerEntrypoints,
    playback,
    versionSupport,
    objectiveCoverage,
    hubLinks: hub.links,
    checks,
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Run Contract</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
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
    .ok { color:#17633a; font-weight:700; }
    .bad { color:#a12222; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Run Contract</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">Contract</span><b class="${payload.summary.ok ? "ok" : "bad"}">${payload.summary.ok ? "pass" : "fail"}</b><span>machine-checked</span></div>
      <div class="card"><span class="muted">Viewer entrypoints</span><b>${escapeHtml(payload.summary.viewerEntrypointCount)}</b><span>local ignored targets</span></div>
      <div class="card"><span class="muted">Artifact files</span><b>${escapeHtml(payload.summary.artifactFiles)}</b><span>${escapeHtml(payload.summary.htmlFiles)} HTML</span></div>
      <div class="card"><span class="muted">Mirrored runs</span><b>${escapeHtml(payload.summary.mirroredBenchmarkRuns)}</b><span>benchmark folders</span></div>
    </div>
    <section class="panel"><h2>Checks</h2><div class="body"><table><thead><tr><th>check</th><th>status</th><th>detail</th></tr></thead><tbody>${payload.checks
      .map((check) => `<tr><td><code>${escapeHtml(check.id)}</code></td><td class="${check.ok ? "ok" : "bad"}">${check.ok ? "pass" : "fail"}</td><td>${escapeHtml(check.detail)}</td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Viewer Entrypoints</h2><div class="body"><table><tbody>${payload.viewerEntrypoints
      .map((entry) => `<tr><th>${escapeHtml(entry.label)}</th><td><a href="${escapeHtml(entry.href)}">${escapeHtml(entry.path)}</a></td><td class="${entry.exists ? "ok" : "bad"}">${entry.exists ? "exists" : "missing"}</td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Ignored Storage</h2><div class="body"><table><tbody>${payload.ignoredRoots
      .map((entry) => `<tr><td><code>${escapeHtml(entry.path)}</code></td><td class="${entry.ignored ? "ok" : "bad"}">${entry.ignored ? "ignored" : "not ignored"}</td><td>${entry.exists ? "exists" : "not present"}</td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Objective Coverage</h2><div class="body"><table><tbody>${Object.entries(payload.objectiveCoverage)
      .map(([key, value]) => `<tr><th><code>${escapeHtml(key)}</code></th><td>${escapeHtml(value)}</td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Run Contract",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Contract status: ${payload.summary.ok ? "pass" : "fail"}`,
    `- Viewer entrypoints: ${payload.summary.viewerEntrypointCount}`,
    `- Artifact files: ${payload.summary.artifactFiles}`,
    `- HTML files: ${payload.summary.htmlFiles}`,
    `- Playback HTML files: ${payload.summary.playbackHtmlFiles}`,
    `- Mirrored benchmark runs: ${payload.summary.mirroredBenchmarkRuns}`,
    "",
    "## Objective Coverage",
    "",
    ...Object.entries(payload.objectiveCoverage).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Checks",
    "",
    ...payload.checks.map((check) => `- ${check.id}: ${check.ok ? "pass" : "fail"}; ${check.detail}`),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "run-contract.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `benchmark run contract ${payload.summary.ok ? "passed" : "failed"} at ${path.join(REPORT_DIR, "index.html")}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
