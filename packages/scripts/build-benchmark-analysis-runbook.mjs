#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "runbook");

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
  const verification = readJson("reports/benchmark-analysis/verification/verification.json");
  const runContract = readJson("reports/benchmark-analysis/run-contract/run-contract.json");
  const objectiveEvidenceMap = readJson(
    "reports/benchmark-analysis/objective-evidence-map/objective-evidence-map.json",
  );
  const reviewReadinessLedger = readJson(
    "reports/benchmark-analysis/review-readiness-ledger/review-readiness-ledger.json",
  );
  const finalGoalReadiness = readJson(
    "reports/benchmark-analysis/final-goal-readiness/final-goal-readiness.json",
  );
  const audit = readJson("reports/benchmark-analysis/goal-audit.json");
  const gap = readJson("reports/benchmark-analysis/gap-evidence/gap-evidence.json");
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const corpusRemediationMatrix = readJson(
    "reports/benchmark-analysis/corpus-remediation-matrix/corpus-remediation.json",
  );
  const corpusReviewPacks = readJson(
    "reports/benchmark-analysis/corpus-review-packs/corpus-review-packs.json",
  );
  const cache = readJson("reports/benchmark-analysis/cache-analysis/cache-analysis.json");
  const trajectoryIoCompleteness = readJson(
    "reports/benchmark-analysis/trajectory-io-completeness/trajectory-io-completeness.json",
  );
  const globalPlaybackIndex = readJson(
    "reports/benchmark-analysis/global-playback-index/global-playback-index.json",
  );
  const agentBenchmarkReview = readJson(
    "reports/benchmark-analysis/agent-benchmark-review/agent-benchmark-review.json",
  );
  const benchmarkClosureMatrix = readJson(
    "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
  );
  const versionRemediationMatrix = readJson(
    "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
  );
  const benchmarkOutcomeAnalysis = readJson(
    "reports/benchmark-analysis/benchmark-outcome-analysis/outcome-analysis.json",
  );
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const fiveExampleSampler = readJson(
    "reports/benchmark-analysis/benchmark-five-example-sampler/five-example-sampler.json",
  );
  const sampleReviewMatrix = readJson(
    "reports/benchmark-analysis/benchmark-sample-review-matrix/sample-review-matrix.json",
  );
  const benchmarkReviewPacks = readJson(
    "reports/benchmark-analysis/benchmark-review-packs/benchmark-review-packs.json",
  );
  const reviewPackIndex = readJson(
    "reports/benchmark-analysis/review-pack-index/review-pack-index.json",
  );
  const reviewPackAgentVerdicts = readJson(
    "reports/benchmark-analysis/review-pack-agent-verdicts/review-pack-agent-verdicts.json",
  );
  const rerunCommandCatalog = readJson(
    "reports/benchmark-analysis/rerun-command-catalog/rerun-command-catalog.json",
  );
  const rerunBatches = readJson("reports/benchmark-analysis/rerun-batches/rerun-batches.json");
  const manualReviewProgress = readJson(
    "reports/benchmark-analysis/manual-review-progress/manual-review-progress.json",
  );
  const scenarios = readJson("reports/scenarios/catalog-execution-union/coverage.json");
  const failures = readJson("reports/scenarios/failure-analysis/failure-analysis.json");
  const scenarioAgentReview = readJson(
    "reports/benchmark-analysis/scenario-agent-review/scenario-agent-review.json",
  );
  const scenarioOutcomeMatrix = readJson(
    "reports/benchmark-analysis/scenario-outcome-matrix/scenario-outcome-matrix.json",
  );
  const scenarioRemediationMatrix = readJson(
    "reports/benchmark-analysis/scenario-remediation-matrix/scenario-remediation.json",
  );
  const scenarioReviewPacks = readJson(
    "reports/benchmark-analysis/scenario-review-packs/scenario-review-packs.json",
  );
  const live = readJson("reports/live-test-inventory/inventory.json");
  const liveFailureTriage = readJson(
    "reports/benchmark-analysis/live-test-failure-triage/failure-triage.json",
  );
  const liveModelEvidence = readJson(
    "reports/benchmark-analysis/live-test-model-evidence/model-evidence.json",
  );
  const livePromptResponseCompleteness = readJson(
    "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
  );
  const liveTestReviewPacks = readJson(
    "reports/benchmark-analysis/live-test-review-packs/live-test-review-packs.json",
  );
  const liveTestAgentReview = readJson(
    "reports/benchmark-analysis/live-test-agent-review/live-test-agent-review.json",
  );
  const queue = readJson("reports/benchmark-analysis/review-queue/review-queue.json");
  const manualReview = readJson("reports/benchmark-analysis/manual-review/manual-review.json");
  const agentReview = readJson("reports/benchmark-analysis/agent-review/agent-review.json");
  const remediationMatrix = readJson(
    "reports/benchmark-analysis/remediation-matrix/remediation-matrix.json",
  );
  const commands = [
    {
      id: "rebuild-analysis",
      command: "bun run bench:analysis:build",
      purpose: "Rebuild all ignored benchmark/scenario/live/e2e review reports and run the verifier.",
    },
    {
      id: "verify-analysis",
      command: "bun run bench:analysis:verify",
      purpose: "Verify generated report invariants without regenerating upstream artifacts.",
    },
    {
      id: "secret-scan",
      command:
        "rg -n \"csk-[A-Za-z0-9_-]+\" reports/benchmark-analysis reports/benchmarks/benchmark-results-corpus-review reports/benchmarks/code-agent-run-index reports/benchmarks/code-agent-runs reports/benchmarks/code-agent-version-comparison reports/benchmarks/code-agent-trajectory-catalog reports/scenarios reports/live-test-inventory reports/live-test-runs packages/benchmarks/benchmark_results",
      purpose: "Confirm generated artifacts do not contain raw Cerebras key strings.",
    },
  ];
  return {
    schema: "eliza_benchmark_analysis_runbook_v1",
    generatedAt: new Date().toISOString(),
    commands,
    entryPoints: [
      { label: "Unified hub", href: "../index.html" },
      { label: "Analysis summary", href: "../analysis-summary/index.html" },
      { label: "Run contract", href: "../run-contract/index.html" },
      { label: "Global playback index", href: "../global-playback-index/index.html" },
      { label: "Cache analysis", href: "../cache-analysis/index.html" },
      { label: "Trajectory I/O completeness", href: "../trajectory-io-completeness/index.html" },
      { label: "Agent benchmark review", href: "../agent-benchmark-review/index.html" },
      { label: "Benchmark closure matrix", href: "../benchmark-closure-matrix/index.html" },
      { label: "Version remediation matrix", href: "../version-remediation-matrix/index.html" },
      { label: "Benchmark outcome analysis", href: "../benchmark-outcome-analysis/index.html" },
      { label: "Verification report", href: "../verification/README.md" },
      { label: "Review queue", href: "../review-queue/index.html" },
      { label: "Manual review workspace", href: "../manual-review/index.html" },
      { label: "Manual review progress", href: "../manual-review-progress/index.html" },
      { label: "Rerun command catalog", href: "../rerun-command-catalog/index.html" },
      { label: "Rerun batches", href: "../rerun-batches/index.html" },
      { label: "Agent review digest", href: "../agent-review/index.html" },
      { label: "Remediation matrix", href: "../remediation-matrix/index.html" },
      { label: "Objective evidence map", href: "../objective-evidence-map/index.html" },
      { label: "Review readiness ledger", href: "../review-readiness-ledger/index.html" },
      { label: "Objective closure readiness", href: "../objective-closure/index.html" },
      { label: "Final goal readiness", href: "../final-goal-readiness/index.html" },
      { label: "Artifact manifest", href: "../artifact-manifest/index.html" },
      { label: "Benchmark examples", href: "../benchmark-examples/index.html" },
      { label: "Five-example sampler", href: "../benchmark-five-example-sampler/index.html" },
      { label: "Benchmark sample review matrix", href: "../benchmark-sample-review-matrix/index.html" },
      { label: "Benchmark review packs", href: "../benchmark-review-packs/index.html" },
      { label: "Global review pack index", href: "../review-pack-index/index.html" },
      { label: "Review pack agent verdicts", href: "../review-pack-agent-verdicts/index.html" },
      { label: "Benchmark review", href: "../benchmark-review/index.html" },
      { label: "Benchmark corpus", href: rel("reports/benchmarks/benchmark-results-corpus-review/index.html") },
      { label: "Corpus remediation matrix", href: "../corpus-remediation-matrix/index.html" },
      { label: "Corpus review packs", href: "../corpus-review-packs/index.html" },
      { label: "Scenario execution union", href: rel("reports/scenarios/catalog-execution-union/index.html") },
      { label: "Scenario failure analysis", href: rel("reports/scenarios/failure-analysis/index.html") },
      { label: "Scenario agent review", href: "../scenario-agent-review/index.html" },
      { label: "Scenario outcome matrix", href: "../scenario-outcome-matrix/index.html" },
      { label: "Scenario remediation matrix", href: "../scenario-remediation-matrix/index.html" },
      { label: "Scenario review packs", href: "../scenario-review-packs/index.html" },
      { label: "Live/e2e inventory", href: rel("reports/live-test-inventory/index.html") },
      { label: "Live/e2e agent review", href: "../live-test-agent-review/index.html" },
      { label: "Live/e2e failure triage", href: "../live-test-failure-triage/index.html" },
      { label: "Live/e2e model evidence", href: "../live-test-model-evidence/index.html" },
      { label: "Live/e2e prompt-response completeness", href: "../live-test-prompt-response-completeness/index.html" },
      { label: "Live/e2e review packs", href: "../live-test-review-packs/index.html" },
      { label: "OSWorld readiness", href: "../gap-evidence/osworld-live-readiness.html" },
      { label: "Hyperliquid gap page", href: rel("reports/benchmarks/benchmark-results-corpus-review/gap-pages/hyperliquid_bench.html") },
    ],
    currentCoverage: {
      verifierOk: verification.ok,
      goalAudit: audit.summary,
      objectiveCoverage: runContract.objectiveCoverage || {},
      objectiveEvidenceMap: `${objectiveEvidenceMap.summary?.proven || 0} proven, ${objectiveEvidenceMap.summary?.caveated || 0} caveated, ${objectiveEvidenceMap.summary?.blocked || 0} blocked`,
      reviewReadinessLedger: `${reviewReadinessLedger.summary?.ready || 0} ready, ${reviewReadinessLedger.summary?.caveated || 0} caveated, ${reviewReadinessLedger.summary?.blocked || 0} blocked surfaces`,
      finalGoalReadiness: `${finalGoalReadiness.summary?.proven || 0} proven, ${finalGoalReadiness.summary?.caveated || 0} caveated, ${finalGoalReadiness.summary?.blocked || 0} blocked, ${finalGoalReadiness.summary?.openGates || 0} open gates`,
      runContractOk: runContract.summary?.ok === true,
      externalCredentialPresence: gap.credentials || {},
      benchmarkReviewPages: review.summary.benchmarkCount,
      benchmarkFiveExampleSampler: `${fiveExampleSampler.summary.selectedWithPlayback}/${fiveExampleSampler.summary.selectedRows}`,
      benchmarkSampleReviewMatrix: `${sampleReviewMatrix.summary.reviewReadyRows}/${sampleReviewMatrix.summary.sampleRows} review-ready samples`,
      benchmarkReviewPacks: `${benchmarkReviewPacks.summary.packPages}/${benchmarkReviewPacks.summary.benchmarkCount} pack pages, ${benchmarkReviewPacks.summary.samplePlaybackRows}/${benchmarkReviewPacks.summary.sampleRows} sample playback`,
      reviewPackIndex: `${reviewPackIndex.summary.packCount} packs, ${reviewPackIndex.summary.withPlayback} playback-linked, ${reviewPackIndex.summary.withManualReviewNote} manual-note links`,
      reviewPackAgentVerdicts: `${reviewPackAgentVerdicts.summary.reviewedRows}/${reviewPackAgentVerdicts.summary.rowCount} reviewed, ${reviewPackAgentVerdicts.summary.acceptRows} accepted, ${reviewPackAgentVerdicts.summary.blockedRows} blocked`,
      rerunCommandCatalog: `${rerunCommandCatalog.summary.commandCount} commands, ${rerunCommandCatalog.summary.runnableNow} runnable now, ${rerunCommandCatalog.summary.blocked} blocked`,
      rerunBatches: `${rerunBatches.summary.batchCount} scripts, ${rerunBatches.summary.runnableCommands} runnable commands, ${rerunBatches.summary.blockedCommands} blocked excluded`,
      codeAgentTrajectoryCache: `${cache.codeAgent.summary.trajectoryCachePercent.toFixed(1)}%`,
      trajectoryIoCompleteness: `${trajectoryIoCompleteness.summary.withInput}/${trajectoryIoCompleteness.summary.records} input, ${trajectoryIoCompleteness.summary.withOutput}/${trajectoryIoCompleteness.summary.records} output, ${trajectoryIoCompleteness.summary.reviewRelevantOutputGaps} review-relevant output gaps`,
      globalPlaybackRows: `${globalPlaybackIndex.summary.playbackExisting}/${globalPlaybackIndex.summary.rowCount}`,
      globalPlaybackGroups: globalPlaybackIndex.summary.groupCount || 0,
      corpusNormalizedCallCache: `${cache.corpus.summary.cachePercent.toFixed(1)}%`,
      liveStructuredUsageRuns: cache.liveWrapperPlayback.summary.structuredUsageRuns,
      agentBenchmarkReview: `${agentBenchmarkReview.summary.totalReviewed} benchmark surfaces`,
      agentBenchmarkSampledPlayback: `${agentBenchmarkReview.summary.codeAgentSampledExamplesWithPlayback || 0}/${agentBenchmarkReview.summary.codeAgentSampledExamples || 0}`,
      benchmarkClosureMatrix: `${benchmarkClosureMatrix.summary.complete} complete, ${benchmarkClosureMatrix.summary.caveated} caveated, ${benchmarkClosureMatrix.summary.missing} missing`,
      benchmarkClosureTargetPlayback: `${benchmarkClosureMatrix.summary.targetPlaybackComplete}/${benchmarkClosureMatrix.summary.benchmarkCount}`,
      versionRemediationMatrix: `${versionRemediationMatrix.summary.completeHistory} complete, ${versionRemediationMatrix.summary.previousPlaybackGaps} previous-playback gaps, ${versionRemediationMatrix.summary.noPreviousRun} true no-previous-run, ${versionRemediationMatrix.summary.noEarlierPreviousRow || 0} no-earlier previous`,
      benchmarkOutcomeAnalysis: `${benchmarkOutcomeAnalysis.summary.reviewPass} review-pass, ${benchmarkOutcomeAnalysis.summary.needsOutputReview} needs-output-review, ${benchmarkOutcomeAnalysis.summary.blockedOrCaveated} caveated`,
      corpusFamilies: corpus.reviewFindingSummary?.findingCount || 0,
      corpusRemediationMatrix: `${corpusRemediationMatrix.summary.familyRows} families, ${corpusRemediationMatrix.summary.insufficientWarningLatestRows} insufficient-warning rows`,
      corpusReviewPacks: `${corpusReviewPacks.summary.packPages}/${corpusReviewPacks.summary.familyCount} pack pages, ${corpusReviewPacks.summary.withCanonicalPlayback} with playback`,
      scenarioPlayback: `${scenarios.scenarioPlaybackPages}/${scenarios.catalogScenarioCount}`,
      scenarioAgentReview: `${scenarioAgentReview.summary.reviewed}/${scenarioAgentReview.summary.scenarioCount}`,
      scenarioOutcomeMatrix: `${scenarioOutcomeMatrix.summary.passed} passed, ${scenarioOutcomeMatrix.summary.failedOnly} failed-only, ${scenarioOutcomeMatrix.summary.nonPassing} non-passing`,
      scenarioRemediationMatrix: `${scenarioRemediationMatrix.summary.nonPassingRows} non-passing, ${scenarioRemediationMatrix.summary.playbackLinkedRows} playback-linked`,
      scenarioReviewPacks: `${scenarioReviewPacks.summary.packPages}/${scenarioReviewPacks.summary.scenarioCount} pack pages, ${scenarioReviewPacks.summary.playbackLinkedRows} playback-linked`,
      scenarioFailureCategoryPages: failures.summary.categoryPages,
      liveModelScriptReviewPages: live.summary.modelScriptReviewPages,
      liveFailureTriage: `${liveFailureTriage.summary.failedRunCount} failed runs, ${liveFailureTriage.summary.likelyLlmFailedRuns} likely LLM`,
      liveModelEvidence: `${liveModelEvidence.summary.playbackLinkedScripts}/${liveModelEvidence.summary.scriptCount} playback, ${liveModelEvidence.summary.structuredLlmScripts} structured`,
      livePromptResponseCompleteness: `${livePromptResponseCompleteness.summary.scriptSidecarComplete}/${livePromptResponseCompleteness.summary.likelyLlmScripts} complete script sidecars, ${livePromptResponseCompleteness.summary.runtimeBlockedBeforeSidecar} runtime-blocked, ${livePromptResponseCompleteness.summary.structuredRunCallsParsed} run calls parsed`,
      liveTestReviewPacks: `${liveTestReviewPacks.summary.packPages}/${liveTestReviewPacks.summary.scriptCount} pack pages, ${liveTestReviewPacks.summary.playbackLinkedScripts} playback-linked`,
      liveTestAgentReview: `${liveTestAgentReview.summary.reviewed}/${liveTestAgentReview.summary.scriptCount}`,
      reviewQueueItems: queue.summary.itemCount,
      manualReviewNotes: manualReview.summary.noteCount,
      manualReviewProgress: `${manualReviewProgress.summary.reviewed}/${manualReviewProgress.summary.itemCount} reviewed, ${manualReviewProgress.summary.withPack} pack-linked, ${manualReviewProgress.summary.withPlayback} playback-linked`,
      manualReviewAgentTriage: manualReview.summary.agentReviewed || 0,
      manualReviewHighPriorityUnreviewed: manualReview.summary.highPriorityUnreviewed,
      agentReviewHighPriority: agentReview.summary.highPriorityCount,
      agentReviewLiveFailures: agentReview.summary.liveFailuresReviewed,
      remediationMatrixItems: remediationMatrix.summary.itemCount,
      remediationMatrixLocalActions: `${remediationMatrix.summary.localActionItems || 0}/${remediationMatrix.summary.itemCount || 0}`,
      remediationMatrixCredentialRequiredActions:
        remediationMatrix.summary.localCredentialRequiredItems || 0,
      remediationMatrixLocalActionByLane: remediationMatrix.summary.localActionByLane || {},
      remediationMatrixExternalBlockers: remediationMatrix.summary.externalBlockers,
      remediationMatrixLiveTestItems: remediationMatrix.summary.liveTestItems,
      remediationMatrixObjectiveCaveats: remediationMatrix.summary.objectiveCaveats,
      remediationMatrixObjectiveLocalActions: `${remediationMatrix.summary.objectiveLocalActionItems || 0}/${remediationMatrix.summary.objectiveCaveats || 0}`,
      remediationMatrixObjectiveLocalActionByLane:
        remediationMatrix.summary.objectiveLocalActionByLane || {},
      remediationMatrixLiveLocalActions: `${remediationMatrix.summary.liveLocalActionItems || 0}/${remediationMatrix.summary.liveTestItems || 0}`,
      remediationMatrixLiveLocalActionByClassification:
        remediationMatrix.summary.liveLocalActionByClassification || {},
      remediationMatrixLiveLocalActionByLane:
        remediationMatrix.summary.liveLocalActionByLane || {},
    },
    externalGates: [
      {
        id: "osworld-live",
        status: gap.osworld?.providerReadiness?.runnableProviderCount > 0 ? "ready-to-rerun" : "blocked",
        evidence: gap.osworld?.blockerSummary || "",
        required: [
          "At least one runnable OSWorld provider: Docker daemon, VMware, VirtualBox, or AWS.",
          "A live-scored OSWorld benchmark row replacing smoke-only evidence.",
        ],
        page: "../gap-evidence/osworld-live-readiness.html",
        rerunCommands: gap.remediationCommands?.osworld || [],
      },
      {
        id: "hyperliquid_bench",
        status: corpus.credentialGaps?.hyperliquid?.runnable ? "ready-to-rerun" : "blocked",
        evidence: `missing=${(corpus.credentialGaps?.hyperliquid?.missing || []).join(",") || "none"}`,
        required: ["HL_PRIVATE_KEY", "CEREBRAS_API_KEY"],
        page: rel("reports/benchmarks/benchmark-results-corpus-review/gap-pages/hyperliquid_bench.html"),
        rerunCommands: gap.remediationCommands?.hyperliquid || [],
      },
    ],
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Analysis Runbook</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; margin-bottom:12px; overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .bad { color:#a12222; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Analysis Runbook</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="panel"><h2>Commands</h2><div class="body"><table><thead><tr><th>id</th><th>command</th><th>purpose</th></tr></thead><tbody>${payload.commands
      .map((row) => `<tr><td>${escapeHtml(row.id)}</td><td><code>${escapeHtml(row.command)}</code></td><td>${escapeHtml(row.purpose)}</td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Entry Points</h2><div class="body"><table><tbody>${payload.entryPoints
      .map((row) => `<tr><th>${escapeHtml(row.label)}</th><td><a href="${escapeHtml(row.href)}">${escapeHtml(row.href)}</a></td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Current Coverage</h2><div class="body"><pre>${escapeHtml(JSON.stringify(payload.currentCoverage, null, 2))}</pre></div></section>
    <section class="panel"><h2>External Gates</h2><div class="body"><table><thead><tr><th>gate</th><th>status</th><th>evidence</th><th>page</th></tr></thead><tbody>${payload.externalGates
      .map((gate) => `<tr><td><code>${escapeHtml(gate.id)}</code></td><td class="${gate.status === "blocked" ? "bad" : "ok"}">${escapeHtml(gate.status)}</td><td>${escapeHtml(gate.evidence)}${(gate.rerunCommands || []).map((command) => `<br><code>${escapeHtml(command.command)}</code>`).join("")}</td><td><a href="${escapeHtml(gate.page)}">open</a></td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Analysis Runbook",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "## Commands",
    "",
    ...payload.commands.map((row) => `- \`${row.command}\` — ${row.purpose}`),
    "",
    "## Entry Points",
    "",
    ...payload.entryPoints.map((row) => `- ${row.label}: \`${row.href}\``),
    "",
    "## Current Coverage",
    "",
    "```json",
    JSON.stringify(payload.currentCoverage, null, 2),
    "```",
    "",
    "## External Gates",
    "",
    ...payload.externalGates.map(
      (gate) =>
        `- \`${gate.id}\`: ${gate.status}; ${gate.evidence}; page \`${gate.page}\`${(gate.rerunCommands || []).map((command) => `\n  - rerun: \`${command.command}\`; then \`${command.followedBy}\``).join("")}`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "runbook.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`benchmark analysis runbook ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
