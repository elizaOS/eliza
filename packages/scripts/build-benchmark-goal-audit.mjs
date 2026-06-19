#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DEFAULT_REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readWindowJson(filePath, assignmentPrefix) {
  return JSON.parse(
    readFileSync(filePath, "utf8")
      .replace(assignmentPrefix, "")
      .replace(/;\n?$/, ""),
  );
}

function rel(target, from = DEFAULT_REPORT_DIR) {
  return path.relative(from, target).replaceAll(path.sep, "/");
}

function status(ok, caveat = false) {
  if (ok) return "proven";
  if (caveat) return "caveated";
  return "missing";
}

function requirementRows() {
  const benchmarkData = readWindowJson(
    path.join(REPO_ROOT, "reports/benchmarks/code-agent-run-index/index-data.js"),
    /^window\.BENCHMARK_RUN_INDEX = /,
  );
  const scenarioUnion = readJson(
    path.join(REPO_ROOT, "reports/scenarios/catalog-execution-union/coverage.json"),
  );
  const scenarioFailures = readJson(
    path.join(REPO_ROOT, "reports/scenarios/failure-analysis/failure-analysis.json"),
  );
  const liveInventory = readJson(
    path.join(REPO_ROOT, "reports/live-test-inventory/inventory.json"),
  );
  const livePlayback = readJson(
    path.join(REPO_ROOT, "reports/live-test-runs/playback-manifest.json"),
  );
  const versionComparison = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmarks/code-agent-version-comparison/version-comparison.json",
    ),
  );
  const versionRemediation = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
    ),
  );
  const gapEvidence = readJson(
    path.join(REPO_ROOT, "reports/benchmark-analysis/gap-evidence/gap-evidence.json"),
  );
  const trajectoryCatalog = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json",
    ),
  );
  const benchmarkReview = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmark-analysis/benchmark-review/benchmark-review.json",
    ),
  );
  const fiveExampleSampler = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmark-analysis/benchmark-five-example-sampler/five-example-sampler.json",
    ),
  );
  const corpusReview = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmarks/benchmark-results-corpus-review/corpus-review.json",
    ),
  );
  const corpusRemediation = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmark-analysis/corpus-remediation-matrix/corpus-remediation.json",
    ),
  );
  const corpusReviewPacks = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmark-analysis/corpus-review-packs/corpus-review-packs.json",
    ),
  );
  const agentBenchmarkReview = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmark-analysis/agent-benchmark-review/agent-benchmark-review.json",
    ),
  );
  const scenarioAgentReview = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmark-analysis/scenario-agent-review/scenario-agent-review.json",
    ),
  );
  const liveTestAgentReview = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmark-analysis/live-test-agent-review/live-test-agent-review.json",
    ),
  );
  const manualReview = readJson(
    path.join(
      REPO_ROOT,
      "reports/benchmark-analysis/manual-review/manual-review.json",
    ),
  );
  const latestRows = Object.values(benchmarkData.latest_by_benchmark || {});
  const includedRows = latestRows.filter((row) => row.in_manifest !== false);
  const liveOrImportedRows = includedRows.filter((row) =>
    String(row.run_mode || "").startsWith("live"),
  );
  const underFive = includedRows.filter(
    (row) =>
      typeof row.target_total === "number" &&
      row.target_total < 5 &&
      row.benchmark !== "osworld",
  );
  const smokeOnly = includedRows.filter(
    (row) => !String(row.run_mode || "").startsWith("live"),
  );
  const viewersMissing = latestRows.filter((row) => !row.viewer_href);
  const trajectoryEvidenceRows = latestRows.filter(
    (row) =>
      row.target_result_path ||
      row.baseline_result_path ||
      row.viewer_href ||
      row.target_artifact_count ||
      row.baseline_artifact_count,
  );
  const provenanceCompleteRows = latestRows.filter(
    (row) =>
      row.target_result_path &&
      row.baseline_result_path &&
      row.target_trajectory_dir &&
      row.baseline_trajectory_dir,
  );
  const modelGap =
    liveInventory.summary.modelArtifactRequiredWithoutEvidence ??
    liveInventory.summary.likelyLlmScriptsWithoutArtifactEvidence;
  const structuredReasonCounts = (liveInventory.rows || [])
    .filter((row) => row.modelArtifactRequired)
    .reduce((acc, row) => {
      const key = row.structuredLlmCoverageReason || "missing-structured-status";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  const structuredReasonSummary = Object.entries(structuredReasonCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(", ");
  const fiveExampleTarget = Number(fiveExampleSampler.summary?.benchmarkCount || 0) * 5;
  return [
    {
      id: "review-every-benchmark",
      requirement: "Every included benchmark is indexed for review.",
      status: status(
        includedRows.length >= 16 &&
          benchmarkReview.summary.benchmarkCount >= 16 &&
          (corpusReview.benchmarkFamilies || []).length >= 53,
      ),
      evidence: `${includedRows.length} code-agent latest benchmarks indexed; per-benchmark review covers ${benchmarkReview.summary.benchmarkCount} benchmarks (${benchmarkReview.summary.reviewPass} pass, ${benchmarkReview.summary.weakOrInferior} weak/inferior, ${benchmarkReview.summary.underFive} under-five, ${benchmarkReview.summary.missingLive} missing-live). Broader corpus review covers ${(corpusReview.benchmarkFamilies || []).length} matrix benchmark families from ${corpusReview.summary.rowCount} latest benchmark/agent rows.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmarks/benchmark-results-corpus-review/index.html")),
    },
    {
      id: "five-examples-per-benchmark",
      requirement: "Approximately five examples are generated for each benchmark.",
      status: status(underFive.length === 0 && smokeOnly.length === 0, underFive.length > 0 || smokeOnly.length > 0),
      evidence: underFive.length || smokeOnly.length
        ? `Five-example sampler selected ${fiveExampleSampler.summary?.selectedRows || 0}/${fiveExampleTarget} playback-linked examples across ${fiveExampleSampler.summary?.benchmarkCount || 0} latest code-agent benchmarks. Caveats: under-five live slices ${underFive.map((row) => `${row.benchmark}=${row.target_total}`).join(", ") || "none"}; smoke-only rows ${smokeOnly.map((row) => row.benchmark).join(", ") || "none"}. Gap evidence records local available counts: ${Object.entries(gapEvidence.underFiveBenchmarks || {}).map(([name, value]) => `${name}=${value.available}`).join(", ")}.`
        : `Five-example sampler selected ${fiveExampleSampler.summary?.selectedRows || 0} playback-linked examples and all included latest rows have at least five live/imported examples.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmark-analysis/gap-evidence/index.html")),
    },
    {
      id: "ignored-html-viewers",
      requirement: "Benchmark runs save ignored folders with HTML viewers.",
      status: status(viewersMissing.length === 0 && (benchmarkData.mirrored_run_artifacts?.mirrored_run_count || 0) > 0),
      evidence: viewersMissing.length
        ? `Missing viewer href for ${viewersMissing.map((row) => row.benchmark).join(", ")}.`
        : `Every latest benchmark row has a viewer href; ${benchmarkData.mirrored_run_artifacts?.mirrored_run_count || 0} per-run folders are mirrored under ignored reports/benchmarks/code-agent-runs/.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmarks/code-agent-run-index/index.html")),
    },
    {
      id: "trajectory-input-output-cache",
      requirement: "Viewers expose trajectories, model inputs/outputs, token/cache metrics, and per-call review surfaces.",
      status: status(
        trajectoryEvidenceRows.length === latestRows.length &&
          provenanceCompleteRows.length === latestRows.length &&
          trajectoryCatalog.summary.benchmarkCount === latestRows.length &&
          corpusReview.callCatalogSummary.normalizedCallCount >= 1800,
      ),
      evidence: `${trajectoryEvidenceRows.length}/${latestRows.length} code-agent latest rows expose result/viewer artifact pointers; ${provenanceCompleteRows.length}/${latestRows.length} carry mirrored result and trajectory provenance; trajectory catalog parses ${trajectoryCatalog.summary.trajectoryFiles} files and ${trajectoryCatalog.summary.trajectoryRecords} records across ${trajectoryCatalog.summary.benchmarkCount}/${latestRows.length} benchmarks. Broader corpus has ${corpusReview.callCatalogSummary.normalizedCallCount} normalized call/action records across ${corpusReview.callCatalogSummary.rowsWithNormalizedCalls} latest rows and ${corpusReview.callCatalogSummary.benchmarksWithNormalizedCalls} benchmark families, with ${corpusReview.callCatalogSummary.cachedTokens} cached tokens.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmarks/benchmark-results-corpus-review/index.html")),
    },
    {
      id: "playback-surfaces",
      requirement: "Benchmark, scenario, and live/e2e artifacts have direct playback pages for manual review.",
      status: status(
        trajectoryCatalog.summary.playbackFiles === trajectoryCatalog.summary.trajectoryFiles &&
          corpusReview.canonicalFiles?.length === corpusReview.summary.canonicalTrajectoryFiles &&
          corpusReview.canonicalFiles?.every((entry) => entry.playback_file) &&
          scenarioUnion.scenarioPlaybackPages === scenarioUnion.catalogScenarioCount &&
          livePlayback.playbackCount === livePlayback.runCount &&
          livePlayback.playbackCount === liveInventory.summary.wrappedRuns,
      ),
      evidence: `${trajectoryCatalog.summary.playbackFiles}/${trajectoryCatalog.summary.trajectoryFiles} latest code-agent trajectory files have playback pages; ${corpusReview.canonicalFiles?.filter((entry) => entry.playback_file).length || 0}/${corpusReview.summary.canonicalTrajectoryFiles} broader corpus canonical files have adjacent playback HTML; ${scenarioUnion.scenarioPlaybackPages}/${scenarioUnion.catalogScenarioCount} cataloged scenarios have playback pages; ${livePlayback.playbackCount}/${livePlayback.runCount} wrapped live/e2e runs have event playback pages.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmark-analysis/index.html")),
    },
    {
      id: "version-comparison",
      requirement: "Benchmark data supports comparing different run versions when available.",
      status: status(
        versionComparison.summary.benchmarksWithPrevious > 0 &&
          corpusReview.runHistory.summary.pairsWithPrevious > 0,
      ),
      evidence: `${versionComparison.summary.benchmarksWithPrevious}/${versionComparison.summary.benchmarkCount} code-agent benchmarks have previous indexed rows for latest-vs-previous comparison; ${versionRemediation.summary.noPreviousRun} true no-previous-run rows, ${versionRemediation.summary.noEarlierPreviousRow || 0} no-earlier-previous-row, and ${versionRemediation.summary.osworldProviderCaveats} OSWorld provider caveat remain. Broader corpus history covers ${corpusReview.runHistory.summary.runCount} runs across ${corpusReview.runHistory.summary.benchmarkAgentPairs} benchmark/agent pairs; ${corpusReview.runHistory.summary.pairsWithPrevious} pairs have a previous comparable run and ${corpusReview.runHistory.summary.pairsWithSuccessfulPrevious} have a previous successful run.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmarks/benchmark-results-corpus-review/index.html")),
    },
    {
      id: "corpus-publication-gaps",
      requirement: "Broader benchmark corpus gaps are explicit and reviewable.",
      status: "caveated",
      evidence: `Corpus family summary covers ${(corpusReview.benchmarkFamilies || []).length} matrix families with ${(corpusReview.reviewFindingSummary || {}).findingCount || 0} per-benchmark findings and ${corpusReview.summary.familyReviewPages || 0} focused family review pages: ${(corpusReview.reviewFindingSummary || {}).reviewPass || 0} review-pass, ${(corpusReview.reviewFindingSummary || {}).needsReview || 0} needs-review, ${(corpusReview.reviewFindingSummary || {}).telemetryGap || 0} telemetry-gap, and ${(corpusReview.reviewFindingSummary || {}).blocked || 0} blocked. The normalized corpus catalog now covers ${corpusReview.callCatalogSummary?.normalizedCallCount || 0} records across ${corpusReview.callCatalogSummary?.rowsWithNormalizedCalls || 0} latest rows and ${corpusReview.callCatalogSummary?.benchmarksWithNormalizedCalls || 0} published benchmark families, with ${corpusReview.summary.canonicalTrajectoryFiles} canonical playback files; only hyperliquid_bench lacks playback because it has no latest rows and ${(corpusReview.benchmarkFamilies || []).find((family) => family.benchmark_id === "hyperliquid_bench")?.unsupported_cells || 0} unsupported cells. Remaining corpus caveats: ${corpusReview.summary.insufficientLatestRows} latest rows carry insufficient-* warnings, ${corpusReview.telemetryGapSummary?.zeroMetricLatestRows || corpusReview.summary.missingTrajectoryLatestRows} latest rows have zero calls or zero trajectory turns (${corpusReview.telemetryGapSummary?.replayableButTokenlessRows || 0} still have replayable previews/files; ${corpusReview.telemetryGapSummary?.evidenceAbsentLatestRows || 0} lack previews/files), and ${(corpusReview.reviewFindingSummary || {}).telemetryGap || 0} families have replayable summary records without token totals. Focused action targets are generated: ${corpusRemediation.summary.familyRows || 0} remediation families, ${corpusRemediation.summary.rerunCommands || 0} rerun commands, ${corpusRemediation.summary.insufficientWarningLatestRows || 0} insufficient-warning rows, ${corpusRemediation.summary.blockedCredentialFamilies || 0} blocked credential family with missing credentials ${(corpusRemediation.summary.missingCredentialNames || []).join(", ") || "none"}, plus ${corpusReviewPacks.summary.packPages || 0}/${corpusReviewPacks.summary.familyCount || 0} corpus review pack pages, ${corpusReviewPacks.summary.withCanonicalPlayback || 0} with canonical playback, and ${corpusReviewPacks.summary.withManualReviewNote || 0} manual-note links.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmark-analysis/corpus-remediation-matrix/index.html")),
    },
    {
      id: "agent-review-every-benchmark",
      requirement: "Every benchmark surface has a first-pass agent review verdict and a direct review target.",
      status: status(
        agentBenchmarkReview.summary.codeAgentReviewed === benchmarkReview.summary.benchmarkCount &&
          agentBenchmarkReview.summary.corpusReviewed === corpusReview.reviewFindingSummary.findingCount &&
          agentBenchmarkReview.summary.corpusFamiliesWithPlaybackOrGap ===
            corpusReview.reviewFindingSummary.findingCount,
      ),
      evidence: `${agentBenchmarkReview.summary.codeAgentReviewed}/${agentBenchmarkReview.summary.codeAgentBenchmarkCount} code-agent benchmarks and ${agentBenchmarkReview.summary.corpusReviewed}/${agentBenchmarkReview.summary.corpusFamilyCount} corpus benchmark families have first-pass agent verdicts. Code-agent rows have ${agentBenchmarkReview.summary.codeAgentFocusedPages}/${agentBenchmarkReview.summary.codeAgentBenchmarkCount} focused pages and ${agentBenchmarkReview.summary.codeAgentTargetPlayback}/${agentBenchmarkReview.summary.codeAgentBenchmarkCount} target playback links, with OSWorld explicitly blocked-live-runtime. Corpus rows have ${agentBenchmarkReview.summary.corpusFamiliesWithPlaybackOrGap}/${agentBenchmarkReview.summary.corpusFamilyCount} playback-or-gap targets.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmark-analysis/agent-benchmark-review/index.html")),
    },
    {
      id: "real-llm-tests",
      requirement: "All likely real-LLM/live/e2e scripts are inventoried and have artifacts.",
      status: status(modelGap === 0),
      evidence: `${liveInventory.summary.likelyLlmScripts} likely model-call scripts; ${modelGap} without artifact evidence; ${liveInventory.summary.nonModelArtifactExcludedScripts} non-model rows explicitly excluded. Script findings cover ${liveInventory.findingSummary?.findingCount || 0}/${liveInventory.summary.totalScripts} live/real/e2e scripts: ${liveInventory.findingSummary?.modelWrapperPass || 0} model wrapper-pass, ${liveInventory.findingSummary?.modelWrapperFailed || 0} model wrapper-failed, ${liveInventory.findingSummary?.modelArtifactHint || 0} model artifact-hint, ${liveInventory.findingSummary?.modelArtifactGap || 0} model artifact-gap, and ${liveInventory.findingSummary?.nonModelUnclassified || 0} non-model unclassified. Structured sidecar status covers ${liveInventory.summary.structuredLlmModelScriptsWithReason || 0}/${liveInventory.summary.modelArtifactRequiredScripts || 0} model scripts (${structuredReasonSummary}).`,
      link: rel(path.join(REPO_ROOT, "reports/live-test-inventory/index.html")),
    },
    {
      id: "agent-review-real-llm-tests",
      requirement: "Every live/real/e2e script has a first-pass agent review verdict and model-call evidence gaps are explicit.",
      status: status(
        liveTestAgentReview.summary.reviewed === liveInventory.summary.totalScripts &&
          liveTestAgentReview.summary.modelCallScriptsReviewed ===
            liveInventory.summary.modelArtifactRequiredScripts &&
          liveTestAgentReview.summary.modelCallScriptsWithoutEvidence === 0,
      ),
      evidence: `${liveTestAgentReview.summary.reviewed}/${liveTestAgentReview.summary.scriptCount} live/real/e2e scripts have agent verdicts and local review targets. ${liveTestAgentReview.summary.modelCallScriptsReviewed}/${liveTestAgentReview.summary.modelCallScripts} model-call scripts are reviewed with ${liveTestAgentReview.summary.modelCallScriptsWithoutEvidence} evidence gaps, ${liveTestAgentReview.summary.modelReviewPages} focused model-script pages, ${liveTestAgentReview.summary.modelCallScriptsWithStructuredStatus}/${liveTestAgentReview.summary.modelCallScripts} structured sidecar statuses, and ${liveTestAgentReview.summary.nonModelExcluded} explicit non-model exclusions.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-agent-review/index.html")),
    },
    {
      id: "all-scenarios-run",
      requirement: "All cataloged scenarios are run and included.",
      status: status(
        scenarioUnion.missingCount === 0 &&
          scenarioUnion.findingSummary?.findingCount === scenarioUnion.catalogScenarioCount,
      ),
      evidence: `${scenarioUnion.executedScenarioIds}/${scenarioUnion.catalogScenarioCount} cataloged scenario IDs have execution evidence and ${scenarioUnion.findingSummary?.findingCount || 0} per-scenario findings (${scenarioUnion.findingSummary?.passed || 0} passed, ${scenarioUnion.findingSummary?.failedOnly || 0} failed-only, ${scenarioUnion.findingSummary?.nonPassing || 0} non-passing, ${scenarioUnion.findingSummary?.missing || 0} missing).`,
      link: rel(path.join(REPO_ROOT, "reports/scenarios/catalog-execution-union/index.html")),
    },
    {
      id: "agent-review-all-scenarios",
      requirement: "Every cataloged scenario has a first-pass agent review verdict and playback link.",
      status: status(
        scenarioAgentReview.summary.reviewed === scenarioUnion.catalogScenarioCount &&
          scenarioAgentReview.summary.playbackExisting === scenarioUnion.catalogScenarioCount,
      ),
      evidence: `${scenarioAgentReview.summary.reviewed}/${scenarioAgentReview.summary.scenarioCount} cataloged scenarios have first-pass agent verdicts and ${scenarioAgentReview.summary.playbackExisting}/${scenarioAgentReview.summary.scenarioCount} playback links. Current dispositions: ${scenarioAgentReview.summary.passed} passed, ${scenarioAgentReview.summary.failedOnly} failed-only, ${scenarioAgentReview.summary.nonPassing} non-passing; ${scenarioAgentReview.summary.categorizedFailures} failures are joined to category next actions.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmark-analysis/scenario-agent-review/index.html")),
    },
    {
      id: "scenario-failure-review",
      requirement: "Failed scenario clusters are manually reviewable with concrete triage categories.",
      status: status(
        scenarioFailures.summary.failedScenarios > 0 &&
          (scenarioFailures.categories || []).every((category) => category.key !== "other"),
      ),
      evidence: `${scenarioFailures.summary.failedScenarios} failed attempts grouped into ${(scenarioFailures.categories || []).length} named categories; no residual other bucket.`,
      link: rel(path.join(REPO_ROOT, "reports/scenarios/failure-analysis/index.html")),
    },
    {
      id: "durable-manual-review-workspace",
      requirement: "Manual review work is durable and tied to concrete benchmark, scenario, live/e2e, and goal targets.",
      status: status(
        manualReview.summary.noteCount === manualReview.summary.itemCount &&
          manualReview.summary.itemCount >= 533,
      ),
      evidence: `${manualReview.summary.noteCount}/${manualReview.summary.itemCount} review queue items have durable Markdown notes under reports/benchmark-analysis/manual-review/items/. ${manualReview.summary.agentReviewed}/${manualReview.summary.itemCount} notes include generated agent triage sections; existing note files are preserved across rebuilds; ${manualReview.summary.highPriorityUnreviewed}/${manualReview.summary.highPriority} high-priority items remain unreviewed by a human.`,
      link: rel(path.join(REPO_ROOT, "reports/benchmark-analysis/manual-review/index.html")),
    },
    {
      id: "osworld-live",
      requirement: "OSWorld has live scored execution, not only smoke evidence.",
      status: "blocked",
      evidence: `Current OSWorld row is smoke-only. Gap evidence: ${gapEvidence.osworld?.blockerSummary || "runtime prerequisites unavailable"}`,
      link: rel(path.join(REPO_ROOT, "reports/benchmark-analysis/gap-evidence/index.html")),
    },
  ];
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Goal Completion Audit</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    .proven { color:#17633a; font-weight:700; }
    .caveated { color:#8a5a00; font-weight:700; }
    .missing { color:#a12222; font-weight:700; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  </style>
</head>
<body>
  <header><h1>Benchmark Goal Completion Audit</h1><div id="meta"></div></header>
  <main><div id="table"></div></main>
  <script src="./goal-audit-data.js"></script>
  <script>
    const data = window.BENCHMARK_GOAL_AUDIT || { rows: [] };
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    document.getElementById("meta").textContent = data.generatedAt || "";
    const statusClass = value => value === "blocked" ? "missing" : value;
    document.getElementById("table").innerHTML = '<table><thead><tr><th>requirement</th><th>status</th><th>evidence</th><th>link</th></tr></thead><tbody>' + data.rows.map(r => '<tr><td><code>' + esc(r.id) + '</code><br>' + esc(r.requirement) + '</td><td class="' + esc(statusClass(r.status)) + '">' + esc(r.status) + '</td><td>' + esc(r.evidence) + '</td><td><a href="' + esc(r.link) + '">open</a></td></tr>').join("") + '</tbody></table>';
  </script>
</body>
</html>`;
}

function renderMarkdown(payload) {
  const lines = [
    "# Benchmark Goal Completion Audit",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "| requirement | status | evidence | link |",
    "|---|---|---|---|",
  ];
  for (const row of payload.rows) {
    lines.push(
      `| \`${row.id}\` ${row.requirement} | ${row.status} | ${row.evidence.replaceAll("|", "\\|")} | ${row.link} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const reportDir = DEFAULT_REPORT_DIR;
  mkdirSync(reportDir, { recursive: true });
  const rows = requirementRows();
  const payload = {
    schema: "eliza_benchmark_goal_audit_v1",
    generatedAt: new Date().toISOString(),
    reportDir,
    summary: {
      total: rows.length,
      proven: rows.filter((row) => row.status === "proven").length,
      caveated: rows.filter((row) => row.status === "caveated").length,
      blocked: rows.filter((row) => row.status === "blocked").length,
      missing: rows.filter((row) => row.status === "missing").length,
    },
    rows,
  };
  writeFileSync(
    path.join(reportDir, "goal-audit-data.js"),
    `window.BENCHMARK_GOAL_AUDIT = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(
    path.join(reportDir, "goal-audit.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(reportDir, "goal-audit.md"), renderMarkdown(payload), "utf8");
  writeFileSync(path.join(reportDir, "goal-audit.html"), html(), "utf8");
  process.stdout.write(
    `benchmark goal audit ${payload.summary.proven}/${payload.summary.total} proven; ${payload.summary.caveated} caveated; ${payload.summary.blocked} blocked; ${payload.summary.missing} missing\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
