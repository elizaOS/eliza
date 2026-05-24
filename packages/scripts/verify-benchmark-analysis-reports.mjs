#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "verification");

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

function readScenarioViewerData(filePath) {
  const text = readFileSync(filePath, "utf8");
  if (text.startsWith("window.SCENARIO_RUN_DATA = ")) {
    return {
      kind: "standard",
      data: JSON.parse(
        text.replace(/^window\.SCENARIO_RUN_DATA = /, "").replace(/;\n?$/, ""),
      ),
    };
  }
  if (text.startsWith("window.PARTIAL_SCENARIO_RUN = ")) {
    return {
      kind: "partial",
      data: JSON.parse(
        text.replace(/^window\.PARTIAL_SCENARIO_RUN = /, "").replace(/;\n?$/, ""),
      ),
    };
  }
  return { kind: "unknown", data: null };
}

function assertCheck(checks, id, ok, detail, severity = "required") {
  checks.push({ id, ok: Boolean(ok), severity, detail });
}

function checkIgnored(files) {
  return files.every((file) => {
    const completed = spawnSync("git", ["check-ignore", "-q", "--", file], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return completed.status === 0;
  });
}

function rawCerebrasKeyScan() {
  const scanPaths = [
    "reports/benchmark-analysis",
    "reports/benchmarks/benchmark-results-corpus-review",
    "reports/benchmarks/code-agent-run-index",
    "reports/benchmarks/code-agent-runs",
    "reports/benchmarks/code-agent-version-comparison",
    "reports/benchmarks/code-agent-trajectory-catalog",
    "reports/scenarios",
    "reports/live-test-inventory",
    "reports/live-test-runs",
    "packages/benchmarks/benchmark_results",
  ];
  const completed = spawnSync(
    "rg",
    ["-l", "csk-[A-Za-z0-9_-]+", ...scanPaths],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const matchedFiles = String(completed.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    ok: completed.status === 1 && matchedFiles.length === 0,
    exitCode: completed.status,
    matchedFileCount: matchedFiles.length,
    error: completed.status > 1 ? String(completed.stderr || "").slice(0, 300) : "",
  };
}

function main() {
  const checks = [];
  const requiredFiles = [
    "reports/benchmark-analysis/index.html",
    "reports/benchmark-analysis/hub-data.js",
    "reports/benchmark-analysis/current-status.md",
    "reports/benchmark-analysis/goal-audit.html",
    "reports/benchmark-analysis/goal-audit.json",
    "reports/benchmark-analysis/analysis-summary/index.html",
    "reports/benchmark-analysis/analysis-summary/summary.json",
    "reports/benchmark-analysis/run-contract/index.html",
    "reports/benchmark-analysis/run-contract/run-contract.json",
    "reports/benchmark-analysis/global-playback-index/index.html",
    "reports/benchmark-analysis/global-playback-index/global-playback-index.json",
    "reports/benchmark-analysis/cache-analysis/index.html",
    "reports/benchmark-analysis/cache-analysis/cache-analysis.json",
    "reports/benchmark-analysis/trajectory-io-completeness/index.html",
    "reports/benchmark-analysis/trajectory-io-completeness/trajectory-io-completeness.json",
    "reports/benchmark-analysis/agent-benchmark-review/index.html",
    "reports/benchmark-analysis/agent-benchmark-review/agent-benchmark-review.json",
    "reports/benchmark-analysis/benchmark-closure-matrix/index.html",
    "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
    "reports/benchmark-analysis/version-remediation-matrix/index.html",
    "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
    "reports/benchmark-analysis/benchmark-outcome-analysis/index.html",
    "reports/benchmark-analysis/benchmark-outcome-analysis/outcome-analysis.json",
    "reports/benchmark-analysis/benchmark-review/index.html",
    "reports/benchmark-analysis/benchmark-review/benchmark-review.json",
    "reports/benchmark-analysis/benchmark-examples/index.html",
    "reports/benchmark-analysis/benchmark-examples/examples.json",
    "reports/benchmark-analysis/benchmark-five-example-sampler/index.html",
    "reports/benchmark-analysis/benchmark-five-example-sampler/five-example-sampler.json",
    "reports/benchmark-analysis/benchmark-sample-review-matrix/index.html",
    "reports/benchmark-analysis/benchmark-sample-review-matrix/sample-review-matrix.json",
    "reports/benchmark-analysis/benchmark-review-packs/index.html",
    "reports/benchmark-analysis/benchmark-review-packs/benchmark-review-packs.json",
    "reports/benchmark-analysis/review-pack-index/index.html",
    "reports/benchmark-analysis/review-pack-index/review-pack-index.json",
    "reports/benchmark-analysis/review-pack-agent-verdicts/index.html",
    "reports/benchmark-analysis/review-pack-agent-verdicts/review-pack-agent-verdicts.json",
    "reports/benchmark-analysis/rerun-command-catalog/index.html",
    "reports/benchmark-analysis/rerun-command-catalog/rerun-command-catalog.json",
    "reports/benchmark-analysis/rerun-batches/index.html",
    "reports/benchmark-analysis/rerun-batches/rerun-batches.json",
    "reports/benchmark-analysis/rerun-batches/all-runnable.sh",
    "reports/benchmark-analysis/rerun-batches/benchmarks.sh",
    "reports/benchmark-analysis/rerun-batches/corpus.sh",
    "reports/benchmark-analysis/rerun-batches/scenarios.sh",
    "reports/benchmark-analysis/rerun-batches/live-e2e.sh",
    "reports/benchmark-analysis/corpus-remediation-matrix/index.html",
    "reports/benchmark-analysis/corpus-remediation-matrix/corpus-remediation.json",
    "reports/benchmark-analysis/corpus-review-packs/index.html",
    "reports/benchmark-analysis/corpus-review-packs/corpus-review-packs.json",
    "reports/benchmark-analysis/review-queue/index.html",
    "reports/benchmark-analysis/review-queue/review-queue.json",
    "reports/benchmark-analysis/manual-review/index.html",
    "reports/benchmark-analysis/manual-review/manual-review.json",
    "reports/benchmark-analysis/manual-review-progress/index.html",
    "reports/benchmark-analysis/manual-review-progress/manual-review-progress.json",
    "reports/benchmark-analysis/agent-review/index.html",
    "reports/benchmark-analysis/agent-review/agent-review.json",
    "reports/benchmark-analysis/remediation-matrix/index.html",
    "reports/benchmark-analysis/remediation-matrix/remediation-matrix.json",
    "reports/benchmark-analysis/objective-evidence-map/index.html",
    "reports/benchmark-analysis/objective-evidence-map/objective-evidence-map.json",
    "reports/benchmark-analysis/review-readiness-ledger/index.html",
    "reports/benchmark-analysis/review-readiness-ledger/review-readiness-ledger.json",
    "reports/benchmark-analysis/live-test-failure-triage/index.html",
    "reports/benchmark-analysis/live-test-failure-triage/failure-triage.json",
    "reports/benchmark-analysis/live-test-model-evidence/index.html",
    "reports/benchmark-analysis/live-test-model-evidence/model-evidence.json",
    "reports/benchmark-analysis/live-test-prompt-response-completeness/index.html",
    "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
    "reports/benchmark-analysis/live-test-review-packs/index.html",
    "reports/benchmark-analysis/live-test-review-packs/live-test-review-packs.json",
    "reports/benchmark-analysis/scenario-remediation-matrix/index.html",
    "reports/benchmark-analysis/scenario-remediation-matrix/scenario-remediation.json",
    "reports/benchmark-analysis/scenario-review-packs/index.html",
    "reports/benchmark-analysis/scenario-review-packs/scenario-review-packs.json",
    "reports/benchmark-analysis/objective-closure/index.html",
    "reports/benchmark-analysis/objective-closure/objective-closure.json",
    "reports/benchmark-analysis/final-goal-readiness/index.html",
    "reports/benchmark-analysis/final-goal-readiness/final-goal-readiness.json",
    "reports/benchmark-analysis/runbook/index.html",
    "reports/benchmark-analysis/runbook/runbook.json",
    "reports/benchmark-analysis/artifact-manifest/index.html",
    "reports/benchmark-analysis/artifact-manifest/manifest.json",
    "reports/benchmarks/code-agent-run-index/index.html",
    "reports/benchmarks/code-agent-run-index/index-data.js",
    "reports/benchmarks/code-agent-runs/manifest.json",
    "reports/benchmarks/code-agent-trajectory-catalog/index.html",
    "reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json",
    "reports/benchmarks/code-agent-version-comparison/index.html",
    "reports/benchmarks/code-agent-version-comparison/version-comparison.json",
    "reports/benchmarks/benchmark-results-corpus-review/index.html",
    "reports/benchmarks/benchmark-results-corpus-review/corpus-review.json",
    "reports/benchmark-analysis/gap-evidence/index.html",
    "reports/benchmark-analysis/gap-evidence/osworld-live-readiness.html",
    "reports/benchmark-analysis/gap-evidence/gap-evidence.json",
    "reports/live-test-inventory/index.html",
    "reports/live-test-inventory/inventory.json",
    "reports/benchmark-analysis/live-test-agent-review/index.html",
    "reports/benchmark-analysis/live-test-agent-review/live-test-agent-review.json",
    "reports/live-test-runs/playback-manifest.json",
    "reports/scenarios/catalog-execution-union/index.html",
    "reports/scenarios/catalog-execution-union/coverage.json",
    "reports/scenarios/failure-analysis/index.html",
    "reports/scenarios/failure-analysis/failure-analysis.json",
    "reports/benchmark-analysis/scenario-agent-review/index.html",
    "reports/benchmark-analysis/scenario-agent-review/scenario-agent-review.json",
    "reports/benchmark-analysis/scenario-outcome-matrix/index.html",
    "reports/benchmark-analysis/scenario-outcome-matrix/scenario-outcome-matrix.json",
  ];
  for (const file of requiredFiles) {
    assertCheck(checks, `file:${file}`, existsSync(path.join(REPO_ROOT, file)), file);
  }
  assertCheck(
    checks,
    "reports.generated-under-ignored-root",
    requiredFiles.every((file) => file.startsWith("reports/")) &&
      checkIgnored([
        "reports/benchmark-analysis/index.html",
        "reports/benchmarks/code-agent-runs/manifest.json",
        "reports/benchmarks/benchmark-results-corpus-review/index.html",
        "reports/scenarios/catalog-execution-union/index.html",
        "reports/live-test-inventory/index.html",
      ]),
    "benchmark, scenario, and live/e2e report entry points are ignored by git",
  );
  const secretScan = rawCerebrasKeyScan();
  assertCheck(
    checks,
    "security.no-raw-cerebras-keys",
    secretScan.ok,
    secretScan.ok
      ? "no raw Cerebras key patterns found in generated report artifacts"
      : `raw key pattern matched ${secretScan.matchedFileCount} file(s); rg exit=${secretScan.exitCode}${secretScan.error ? `; ${secretScan.error}` : ""}`,
  );

  const indexData = readWindowJson(
    "reports/benchmarks/code-agent-run-index/index-data.js",
    /^window\.BENCHMARK_RUN_INDEX = /,
  );
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const examples = readJson("reports/benchmark-analysis/benchmark-examples/examples.json");
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
  const analysisSummary = readJson("reports/benchmark-analysis/analysis-summary/summary.json");
  const runContract = readJson("reports/benchmark-analysis/run-contract/run-contract.json");
  const globalPlaybackIndex = readJson(
    "reports/benchmark-analysis/global-playback-index/global-playback-index.json",
  );
  const cacheAnalysis = readJson("reports/benchmark-analysis/cache-analysis/cache-analysis.json");
  const trajectoryIoCompleteness = readJson(
    "reports/benchmark-analysis/trajectory-io-completeness/trajectory-io-completeness.json",
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
  const trajectory = readJson("reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json");
  const version = readJson("reports/benchmarks/code-agent-version-comparison/version-comparison.json");
  const gap = readJson("reports/benchmark-analysis/gap-evidence/gap-evidence.json");
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const corpusRemediationMatrix = readJson(
    "reports/benchmark-analysis/corpus-remediation-matrix/corpus-remediation.json",
  );
  const corpusReviewPacks = readJson(
    "reports/benchmark-analysis/corpus-review-packs/corpus-review-packs.json",
  );
  const live = readJson("reports/live-test-inventory/inventory.json");
  const liveTestAgentReview = readJson(
    "reports/benchmark-analysis/live-test-agent-review/live-test-agent-review.json",
  );
  const liveTestFailureTriage = readJson(
    "reports/benchmark-analysis/live-test-failure-triage/failure-triage.json",
  );
  const liveTestModelEvidence = readJson(
    "reports/benchmark-analysis/live-test-model-evidence/model-evidence.json",
  );
  const liveTestPromptResponseCompleteness = readJson(
    "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
  );
  const liveTestReviewPacks = readJson(
    "reports/benchmark-analysis/live-test-review-packs/live-test-review-packs.json",
  );
  const livePlayback = readJson("reports/live-test-runs/playback-manifest.json");
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
  const audit = readJson("reports/benchmark-analysis/goal-audit.json");
  const reviewQueue = readJson("reports/benchmark-analysis/review-queue/review-queue.json");
  const manualReview = readJson("reports/benchmark-analysis/manual-review/manual-review.json");
  const manualReviewProgress = readJson(
    "reports/benchmark-analysis/manual-review-progress/manual-review-progress.json",
  );
  const agentReview = readJson("reports/benchmark-analysis/agent-review/agent-review.json");
  const remediationMatrix = readJson(
    "reports/benchmark-analysis/remediation-matrix/remediation-matrix.json",
  );
  const objectiveEvidenceMap = readJson(
    "reports/benchmark-analysis/objective-evidence-map/objective-evidence-map.json",
  );
  const reviewReadinessLedger = readJson(
    "reports/benchmark-analysis/review-readiness-ledger/review-readiness-ledger.json",
  );
  const objectiveClosure = readJson(
    "reports/benchmark-analysis/objective-closure/objective-closure.json",
  );
  const finalGoalReadiness = readJson(
    "reports/benchmark-analysis/final-goal-readiness/final-goal-readiness.json",
  );
  const runbook = readJson("reports/benchmark-analysis/runbook/runbook.json");
  const artifactManifest = readJson("reports/benchmark-analysis/artifact-manifest/manifest.json");
  const currentStatus = readFileSync(
    path.join(REPO_ROOT, "reports/benchmark-analysis/current-status.md"),
    "utf8",
  );
  const hub = readWindowJson(
    "reports/benchmark-analysis/hub-data.js",
    /^window\.BENCHMARK_ANALYSIS_HUB = /,
  );

  const latestRows = Object.values(indexData.latest_by_benchmark || {});
  assertCheck(checks, "benchmarks.latest-count", latestRows.length === 16, `${latestRows.length}/16 latest benchmarks`);
  assertCheck(checks, "benchmarks.review-count", review.summary.benchmarkCount === latestRows.length, `${review.summary.benchmarkCount}/${latestRows.length} review rows`);
  assertCheck(
    checks,
    "benchmarks.examples-manifest",
    examples.summary?.benchmarkCount === latestRows.length &&
      examples.summary?.withFiveExamples === latestRows.length &&
      examples.summary?.withExplicitFiveTaskIds >= latestRows.length - 1 &&
      (examples.rows || []).every((row) => row.hasFiveExamples && row.evidenceCount >= 5),
    `${examples.summary?.withFiveExamples || 0}/${examples.summary?.benchmarkCount || 0} with five-example evidence; explicit=${examples.summary?.withExplicitFiveTaskIds || 0}`,
  );
  assertCheck(
    checks,
    "benchmarks.five-example-sampler",
    fiveExampleSampler.summary?.benchmarkCount === latestRows.length &&
      fiveExampleSampler.summary?.withFiveSelected === latestRows.length &&
      fiveExampleSampler.summary?.selectedRows === latestRows.length * 5 &&
      fiveExampleSampler.summary?.selectedWithPlayback === latestRows.length * 5 &&
      fiveExampleSampler.summary?.selectedWithTaskId >= latestRows.length * 5 - 5 &&
      fiveExampleSampler.summary?.sampleCountOnlyBenchmarks === 1 &&
      (fiveExampleSampler.rows || []).every(
        (row) =>
          row.selectedCount === 5 &&
          row.selectedWithPlayback === 5 &&
          (row.examples || []).every(
            (example) =>
              example.playbackHref &&
              example.playbackExists === true &&
              !String(example.playbackHref).startsWith("/") &&
              !String(example.playbackHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-five-example-sampler", example.playbackHref)),
          ),
      ),
    `${fiveExampleSampler.summary?.selectedWithPlayback || 0}/${fiveExampleSampler.summary?.selectedRows || 0} selected examples with playback`,
  );
  assertCheck(
    checks,
    "benchmarks.sample-review-matrix",
    sampleReviewMatrix.summary?.sampleRows === fiveExampleSampler.summary?.selectedRows &&
      sampleReviewMatrix.summary?.benchmarkCount === fiveExampleSampler.summary?.benchmarkCount &&
      sampleReviewMatrix.summary?.rowsWithPlayback === fiveExampleSampler.summary?.selectedWithPlayback &&
      sampleReviewMatrix.summary?.rowsWithTaskId === fiveExampleSampler.summary?.selectedWithTaskId &&
      sampleReviewMatrix.summary?.reviewReadyRows === 80 &&
      sampleReviewMatrix.summary?.fullInlineReviewRows === 52 &&
      sampleReviewMatrix.summary?.inlineOutputRows === 64 &&
      sampleReviewMatrix.summary?.playbackOnlyEnvironmentRows === 10 &&
      sampleReviewMatrix.summary?.toolCallOnlyInlineRows === 6 &&
      sampleReviewMatrix.summary?.rowsWithModelProvider === 61 &&
      sampleReviewMatrix.summary?.rowsWithCachePercent === 32 &&
      sampleReviewMatrix.summary?.tokenRows === 58 &&
      sampleReviewMatrix.summary?.totalTokens === fiveExampleSampler.summary?.selectedTokenTotal &&
      sampleReviewMatrix.summary?.cacheReadTokens === fiveExampleSampler.summary?.selectedCacheReadTokens &&
      sampleReviewMatrix.summary?.byReviewClass?.["model-output-present"] === 64 &&
      sampleReviewMatrix.summary?.byReviewClass?.["tool-call-output"] === 6 &&
      sampleReviewMatrix.summary?.byReviewClass?.["environment-or-dry-run"] === 10 &&
      sampleReviewMatrix.summary?.byReviewCompleteness?.["full-inline-io-with-cache"] === 52 &&
      sampleReviewMatrix.summary?.byReviewCompleteness?.["inline-output-no-token"] === 12 &&
      sampleReviewMatrix.summary?.byReviewCompleteness?.["tool-call-only-inline"] === 6 &&
      sampleReviewMatrix.summary?.byReviewCompleteness?.["playback-only-environment"] === 10 &&
      !sampleReviewMatrix.summary?.byReviewClass?.["missing-input-preview"] &&
      (sampleReviewMatrix.rows || []).length === fiveExampleSampler.summary?.selectedRows &&
      (sampleReviewMatrix.rows || []).every(
        (row) =>
          row.id &&
          row.benchmark &&
          row.sampleOrdinal >= 1 &&
          row.sampleOrdinal <= 5 &&
          row.reviewCompleteness &&
          row.inputSource !== undefined &&
          row.outputSource !== undefined &&
          Number.isFinite(Number(row.responseChars || 0)) &&
          Number.isFinite(Number(row.toolCallCount || 0)) &&
          row.playbackExists === true &&
          row.playbackHref &&
          !String(row.playbackHref).startsWith("/") &&
          !String(row.playbackHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-sample-review-matrix", row.playbackHref)) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (sampleReviewMatrix.rows || []).filter((row) => row.reviewReady === false).length === 0 &&
      (sampleReviewMatrix.rows || []).filter((row) => row.reviewCompleteness === "full-inline-io-with-cache").length ===
        sampleReviewMatrix.summary?.fullInlineReviewRows &&
      (sampleReviewMatrix.rows || []).filter((row) => row.reviewCompleteness === "tool-call-only-inline").every(
        (row) => row.totalTokens > 0 && !row.hasOutputPreview && row.actions.length > 0,
      ) &&
      (sampleReviewMatrix.rows || []).filter((row) => row.reviewCompleteness === "playback-only-environment").every(
        (row) => row.totalTokens === 0 && !row.hasOutputPreview,
      ) &&
      (sampleReviewMatrix.rows || []).filter((row) => row.benchmark === "osworld").length === 5,
    JSON.stringify(sampleReviewMatrix.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "analysis-summary.coverage",
    analysisSummary.headline?.goalAudit?.total === audit.summary.total &&
      (analysisSummary.focus?.benchmark || []).length === review.summary.weakOrInferior + review.summary.missingLive &&
      (analysisSummary.focus?.scenarioCategories || []).length === (failures.categories || []).length &&
      (analysisSummary.focus?.liveModelScripts || []).length ===
        (live.scriptFindings || []).filter(
          (finding) => finding.likelyLlm && finding.disposition !== "model-wrapper-pass",
        ).length &&
      analysisSummary.headline?.strictReviewSignals?.sampledExamples === sampleReviewMatrix.summary?.sampleRows &&
      analysisSummary.headline?.strictReviewSignals?.reviewReadySamples ===
        sampleReviewMatrix.summary?.reviewReadyRows &&
      analysisSummary.headline?.strictReviewSignals?.fullInlineSampleRows ===
        sampleReviewMatrix.summary?.fullInlineReviewRows &&
      analysisSummary.headline?.strictReviewSignals?.corpusWarningRowsWithPlayback ===
        corpusReviewPacks.summary?.warningRowsWithPlayback &&
      analysisSummary.headline?.strictReviewSignals?.corpusWarningRowsWithCallPreview ===
        corpusReviewPacks.summary?.warningRowsWithCallPreview &&
      analysisSummary.headline?.strictReviewSignals?.liveOfflineReviewSummaries ===
        liveTestPromptResponseCompleteness.summary?.rowsWithOfflineReviewSummary &&
      analysisSummary.headline?.readinessActions?.localActionItems ===
        remediationMatrix.summary?.localActionItems &&
      analysisSummary.headline?.readinessActions?.localCredentialRequiredItems ===
        remediationMatrix.summary?.localCredentialRequiredItems &&
      analysisSummary.headline?.readinessActions?.objectiveLocalActionItems ===
        remediationMatrix.summary?.objectiveLocalActionItems &&
      analysisSummary.headline?.readinessActions?.liveLocalActionItems ===
        remediationMatrix.summary?.liveLocalActionItems &&
      analysisSummary.headline?.readinessActions?.runnableCommands ===
        rerunBatches.summary?.runnableCommands &&
      analysisSummary.headline?.readinessActions?.manualReviewed ===
        manualReviewProgress.summary?.reviewed &&
      (analysisSummary.externalGates || []).some((gate) => gate.id === "osworld-live") &&
      (analysisSummary.externalGates || []).some(
        (gate) => gate.id === "osworld-live" && /Docker daemon/.test(gate.evidence || ""),
      ) &&
      (analysisSummary.externalGates || []).some((gate) => gate.id === "hyperliquid_bench"),
    `benchmark=${(analysisSummary.focus?.benchmark || []).length}; scenarioCategories=${(analysisSummary.focus?.scenarioCategories || []).length}; live=${(analysisSummary.focus?.liveModelScripts || []).length}`,
  );
  assertCheck(
    checks,
    "run-contract.coverage",
    runContract.summary?.ok === true &&
      (runContract.commands || []).some((row) => row.id === "build" && row.present) &&
      (runContract.commands || []).some((row) => row.id === "verify" && row.present) &&
      (runContract.ignoredRoots || []).every((row) => row.ignored === true) &&
      (runContract.viewerEntrypoints || []).every((row) => row.exists === true) &&
      (runContract.checks || []).every((row) => row.ok === true) &&
      runContract.objectiveCoverage?.benchmarkReviewRows ===
        runContract.objectiveCoverage?.benchmarkLatestRows &&
      runContract.objectiveCoverage?.fiveExampleSelectedRows ===
        runContract.objectiveCoverage?.fiveExampleExpectedRows &&
      runContract.objectiveCoverage?.fiveExampleRowsWithPlayback ===
        runContract.objectiveCoverage?.fiveExampleExpectedRows &&
      runContract.objectiveCoverage?.globalPlaybackRows ===
        runContract.objectiveCoverage?.globalPlaybackRowsExisting &&
      runContract.objectiveCoverage?.scenarioFindings ===
        scenarios.catalogScenarioCount &&
      runContract.objectiveCoverage?.scenarioMissing === 0 &&
      runContract.objectiveCoverage?.liveModelScriptsWithoutEvidence === 0 &&
      runContract.objectiveCoverage?.liveModelScriptsWithStructuredStatus ===
        runContract.objectiveCoverage?.liveModelScripts &&
      runContract.objectiveCoverage?.versionBenchmarksWithPrevious ===
        version.summary.benchmarksWithPrevious &&
      runContract.objectiveCoverage?.versionComparablePlaybackPairs ===
        version.summary.comparablePlaybackPairs &&
      runContract.objectiveCoverage?.versionPreviousPlaybackGaps ===
        version.summary.previousPlaybackGapCount &&
      JSON.stringify(
        runContract.objectiveCoverage?.versionPreviousPlaybackGapBenchmarks || [],
      ) === JSON.stringify(version.summary.previousPlaybackGapBenchmarks || []) &&
      runContract.objectiveCoverage?.manualReviewNotes ===
        runContract.objectiveCoverage?.reviewQueueItems &&
      runContract.objectiveCoverage?.manualReviewAgentTriage ===
        runContract.objectiveCoverage?.reviewQueueItems &&
      runContract.summary?.artifactFiles >= 7000 &&
      runContract.versionSupport?.codeAgentBenchmarksWithPrevious ===
        version.summary.benchmarksWithPrevious &&
      runContract.versionSupport?.codeAgentPreviousPlaybackGapCount ===
        version.summary.previousPlaybackGapCount &&
      JSON.stringify(runContract.versionSupport?.codeAgentRecoveredPreviousPlaybackBenchmarks || []) ===
        JSON.stringify(version.summary.recoveredPreviousPlaybackBenchmarks || []) &&
      JSON.stringify(runContract.versionSupport?.codeAgentPreviousPlaybackGapBenchmarks || []) ===
        JSON.stringify(version.summary.previousPlaybackGapBenchmarks || []) &&
      runContract.versionSupport?.corpusPairsWithPrevious ===
        corpus.runHistory?.summary?.pairsWithPrevious,
    JSON.stringify(runContract.summary || {}),
  );
  assertCheck(
    checks,
    "global-playback-index.coverage",
    globalPlaybackIndex.summary?.rowCount ===
      trajectory.summary.playbackFiles +
        (corpus.canonicalFiles || []).filter((entry) => entry.playback_file).length +
        scenarios.scenarioPlaybackPages +
        livePlayback.playbackCount &&
      globalPlaybackIndex.summary?.playbackExisting === globalPlaybackIndex.summary?.rowCount &&
      globalPlaybackIndex.summary?.bySurface?.["code-agent"]?.count === trajectory.summary.playbackFiles &&
      globalPlaybackIndex.summary?.bySurface?.["benchmark-corpus"]?.count ===
        (corpus.canonicalFiles || []).filter((entry) => entry.playback_file).length &&
      globalPlaybackIndex.summary?.bySurface?.scenario?.count === scenarios.scenarioPlaybackPages &&
      globalPlaybackIndex.summary?.bySurface?.["live-e2e"]?.count === livePlayback.playbackCount &&
      globalPlaybackIndex.summary?.bySurface?.["live-e2e"]?.totalTokens ===
        livePlayback.structuredTotalTokens &&
      globalPlaybackIndex.summary?.bySurface?.["live-e2e"]?.cachedTokens ===
        livePlayback.structuredCacheReadInputTokens &&
      (globalPlaybackIndex.rows || [])
        .filter((row) => row.surface === "live-e2e")
        .reduce((sum, row) => sum + Number(row.structuredLlmCallCount || 0), 0) ===
        livePlayback.structuredLlmCallCount &&
      globalPlaybackIndex.summary?.groupCount === (globalPlaybackIndex.groupRows || []).length &&
      globalPlaybackIndex.summary?.benchmarkGroupCount ===
        (globalPlaybackIndex.groupRows || []).filter(
          (row) => row.surface === "code-agent" || row.surface === "benchmark-corpus",
        ).length &&
      globalPlaybackIndex.summary?.groupCount >=
        Object.keys(globalPlaybackIndex.summary?.bySurface || {}).length &&
      (globalPlaybackIndex.groupRows || []).every(
        (row) =>
          row.surface &&
          row.group &&
          row.rowCount > 0 &&
          row.playbackExisting === row.rowCount &&
          row.firstPlaybackHref &&
          !String(row.firstPlaybackHref).startsWith("/") &&
          !String(row.firstPlaybackHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/global-playback-index", row.firstPlaybackHref)),
      ) &&
      (globalPlaybackIndex.rows || []).every(
        (row) =>
          row.playbackHref &&
          row.playbackExists === true &&
          !String(row.playbackHref).startsWith("/") &&
          !String(row.playbackHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/global-playback-index", row.playbackHref)),
      ),
    `${globalPlaybackIndex.summary?.playbackExisting || 0}/${globalPlaybackIndex.summary?.rowCount || 0} playback rows; groups=${globalPlaybackIndex.summary?.groupCount || 0}; liveTokens=${globalPlaybackIndex.summary?.bySurface?.["live-e2e"]?.totalTokens || 0}`,
  );
  assertCheck(
    checks,
    "cache-analysis.coverage",
    cacheAnalysis.codeAgent?.summary?.benchmarkCount === review.summary.benchmarkCount &&
      cacheAnalysis.codeAgent?.summary?.trajectoryFiles === trajectory.summary.trajectoryFiles &&
      cacheAnalysis.codeAgent?.summary?.playbackFiles === trajectory.summary.playbackFiles &&
      cacheAnalysis.codeAgent?.summary?.trajectoryTotalTokens === review.summary.totalTrajectoryTokens &&
      cacheAnalysis.codeAgent?.summary?.trajectoryCacheReadTokens === review.summary.totalCacheReadTokens &&
      cacheAnalysis.corpus?.summary?.normalizedCallCount === corpus.callCatalogSummary?.normalizedCallCount &&
      cacheAnalysis.corpus?.summary?.totalTokens === corpus.callCatalogSummary?.totalTokens &&
      cacheAnalysis.corpus?.summary?.cachedTokens === corpus.callCatalogSummary?.cachedTokens &&
      cacheAnalysis.liveWrapperPlayback?.summary?.wrappedRuns === livePlayback.runCount &&
      cacheAnalysis.liveWrapperPlayback?.summary?.playbackPages === livePlayback.playbackCount &&
      cacheAnalysis.liveWrapperPlayback?.summary?.modelTelemetryRuns === livePlayback.modelTelemetryRuns &&
      cacheAnalysis.liveWrapperPlayback?.summary?.modelTotalMsSum === livePlayback.modelTotalMsSum &&
      cacheAnalysis.liveWrapperPlayback?.summary?.structuredUsageRuns === livePlayback.structuredLlmRuns &&
      cacheAnalysis.liveWrapperPlayback?.summary?.structuredUsageRuns >= 1,
    `code-agent=${cacheAnalysis.codeAgent?.summary?.trajectoryCachePercent}; corpus=${cacheAnalysis.corpus?.summary?.cachePercent}; live-model=${cacheAnalysis.liveWrapperPlayback?.summary?.modelTelemetryRuns}; live-structured=${cacheAnalysis.liveWrapperPlayback?.summary?.structuredUsageRuns}`,
  );
  assertCheck(
    checks,
    "trajectory-io-completeness.coverage",
    trajectoryIoCompleteness.summary?.benchmarkCount === trajectory.summary.benchmarkCount &&
      trajectoryIoCompleteness.summary?.files === trajectory.summary.trajectoryFiles &&
      trajectoryIoCompleteness.summary?.playbackFiles === trajectory.summary.playbackFiles &&
      trajectoryIoCompleteness.summary?.records === trajectory.summary.trajectoryRecords &&
      trajectoryIoCompleteness.summary?.llmLikeRecords === trajectory.summary.llmLikeRecords &&
      trajectoryIoCompleteness.summary?.withInput ===
        trajectory.summary.inputOutput?.recordsWithInput &&
      trajectoryIoCompleteness.summary?.withOutput ===
        trajectory.summary.inputOutput?.recordsWithOutput &&
      trajectoryIoCompleteness.summary?.missingInput ===
        trajectory.summary.trajectoryRecords -
          trajectory.summary.inputOutput?.recordsWithInput &&
      trajectoryIoCompleteness.summary?.missingOutput ===
        trajectory.summary.trajectoryRecords -
          trajectory.summary.inputOutput?.recordsWithOutput &&
      trajectoryIoCompleteness.summary?.missingOutputWithTokens === 197 &&
      trajectoryIoCompleteness.summary?.missingOutputWithoutTokens === 48 &&
      trajectoryIoCompleteness.summary?.outputGapClasses?.["tool-call-or-action-only-output"] === 135 &&
      trajectoryIoCompleteness.summary?.outputGapClasses?.["aggregate-usage-only-output"] === 30 &&
      trajectoryIoCompleteness.summary?.outputGapClasses?.["provider-empty-response-with-completion-tokens"] === 32 &&
      !trajectoryIoCompleteness.summary?.outputGapClasses?.["empty-response-with-token-usage"] &&
      trajectoryIoCompleteness.summary?.outputGapClasses?.["environment-or-dry-run-no-token-output"] === 48 &&
      trajectoryIoCompleteness.summary?.reviewRelevantOutputGaps === 32 &&
      trajectoryIoCompleteness.summary?.reviewRelevantGapRows ===
        trajectoryIoCompleteness.summary?.reviewRelevantOutputGaps &&
      trajectoryIoCompleteness.summary?.reviewRelevantGapReviewPages ===
        trajectoryIoCompleteness.summary?.reviewRelevantOutputGaps &&
      trajectoryIoCompleteness.summary?.reviewRelevantGapPlaybacks >= 4 &&
      trajectoryIoCompleteness.summary?.reviewRelevantGapTasks >= 5 &&
      trajectoryIoCompleteness.summary?.benignOutputGaps === 213 &&
      trajectoryIoCompleteness.summary?.benchmarksWithTokenOutputGaps === 8 &&
      trajectoryIoCompleteness.summary?.benchmarksWithReviewRelevantOutputGaps === 1 &&
      trajectoryIoCompleteness.summary?.benchmarksWithMissingInputs === 0 &&
      (trajectoryIoCompleteness.reviewRelevantGaps || []).length ===
        trajectoryIoCompleteness.summary?.reviewRelevantOutputGaps &&
      (trajectoryIoCompleteness.reviewRelevantGaps || []).every(
        (row) =>
          row.id &&
          row.benchmark === "webshop" &&
          row.outputGapClass === "provider-empty-response-with-completion-tokens" &&
          row.reviewDisposition === "provider-empty-response-with-completion-tokens" &&
          row.href &&
          row.playbackHref &&
          row.inputPreview &&
          row.playbackGapCount > 0 &&
          row.taskGapCount > 0 &&
          row.webshopGoal &&
          ["search", "results", "product"].includes(row.webshopPage) &&
          Array.isArray(row.webshopAvailableActions) &&
          row.webshopAvailableActions.length > 0 &&
          Array.isArray(row.webshopRecentActions) &&
          row.webshopRecentActions.length > 0 &&
          Array.isArray(row.toolNames) &&
          row.toolNames.includes("webshop_action") &&
          row.toolSchemaCount === 1 &&
          row.responseChars === 0 &&
          row.toolCallCount === 0 &&
          (String(row.previousBenchmarkCommand || "").match(/^(search|click)\[/) ||
            String(row.nextBenchmarkCommand || "").match(/^(search|click)\[/)) &&
          Array.isArray(row.sameTaskGapSteps) &&
          row.sameTaskGapSteps.includes(row.step) &&
          row.consecutiveEmptyGapIndex >= 1 &&
          row.completionTokens > 0 &&
          !String(row.href).startsWith("/") &&
          !String(row.href).startsWith("file://") &&
          !String(row.playbackHref).startsWith("/") &&
          !String(row.playbackHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/trajectory-io-completeness", row.href)) &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/trajectory-io-completeness", row.playbackHref)) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (trajectoryIoCompleteness.rows || []).length === trajectory.summary.benchmarkCount &&
      (trajectoryIoCompleteness.rows || []).every(
        (row) =>
          row.benchmark &&
          row.records > 0 &&
          row.playbackFiles === row.files &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)) &&
          (row.sampleGaps || []).every(
            (sample) =>
              sample.outputGapClass &&
              sample.playbackHref &&
              !String(sample.playbackHref).startsWith("/") &&
              !String(sample.playbackHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/trajectory-io-completeness", sample.playbackHref)),
          ),
      ),
    JSON.stringify(trajectoryIoCompleteness.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "agent-benchmark-review.coverage",
      agentBenchmarkReview.summary?.codeAgentBenchmarkCount === review.summary.benchmarkCount &&
      agentBenchmarkReview.summary?.codeAgentReviewed === review.summary.benchmarkCount &&
      agentBenchmarkReview.summary?.codeAgentFocusedPages === review.summary.benchmarkCount &&
      agentBenchmarkReview.summary?.codeAgentTargetPlayback ===
        review.summary.benchmarkCount - review.summary.missingLive &&
      agentBenchmarkReview.summary?.codeAgentSampledExamples ===
        fiveExampleSampler.summary?.selectedRows &&
      agentBenchmarkReview.summary?.codeAgentSampledExamplesWithPlayback ===
        fiveExampleSampler.summary?.selectedWithPlayback &&
      agentBenchmarkReview.summary?.codeAgentSampledExamplesWithTaskId ===
        fiveExampleSampler.summary?.selectedWithTaskId &&
      agentBenchmarkReview.summary?.corpusFamilyCount === corpus.reviewFindingSummary?.findingCount &&
      agentBenchmarkReview.summary?.corpusReviewed === corpus.reviewFindingSummary?.findingCount &&
      agentBenchmarkReview.summary?.corpusFamiliesWithPlaybackOrGap ===
        corpus.reviewFindingSummary?.findingCount &&
      (agentBenchmarkReview.codeAgentRows || []).every(
        (row) =>
          row.verdict &&
          row.recommendedAction &&
          row.selectedExampleCount === 5 &&
          row.selectedExamplesWithPlayback === 5 &&
          Array.isArray(row.selectedExamples) &&
          row.selectedExamples.length === 5 &&
          row.selectedExamples.every(
            (example) =>
              example.playbackHref &&
              !String(example.playbackHref).startsWith("/") &&
              !String(example.playbackHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/agent-benchmark-review", example.playbackHref)),
          ) &&
          row.focusedReviewHref &&
          !String(row.focusedReviewHref).startsWith("/") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/agent-benchmark-review", row.focusedReviewHref)) &&
          (row.targetPlaybackHref
            ? !String(row.targetPlaybackHref).startsWith("/") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/agent-benchmark-review", row.targetPlaybackHref))
            : row.verdict === "blocked-live-runtime"),
      ) &&
      (agentBenchmarkReview.corpusRows || []).every(
        (row) =>
          row.verdict &&
          row.recommendedAction &&
          row.viewerHref &&
          !String(row.viewerHref).startsWith("/") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/agent-benchmark-review", row.viewerHref)),
      ),
    `code-agent=${agentBenchmarkReview.summary?.codeAgentReviewed}/${review.summary.benchmarkCount}; corpus=${agentBenchmarkReview.summary?.corpusReviewed}/${corpus.reviewFindingSummary?.findingCount}`,
  );
  const osworldClosure = (benchmarkClosureMatrix.rows || []).find(
    (row) => row.benchmark === "osworld",
  );
  assertCheck(
    checks,
    "benchmark-closure-matrix.coverage",
    benchmarkClosureMatrix.summary?.benchmarkCount === review.summary.benchmarkCount &&
      benchmarkClosureMatrix.summary?.benchmarkCount === 16 &&
      benchmarkClosureMatrix.summary?.reviewed === 16 &&
      benchmarkClosureMatrix.summary?.agentReviewed === 16 &&
      benchmarkClosureMatrix.summary?.fivePlaybackComplete === 16 &&
      benchmarkClosureMatrix.summary?.targetPlaybackComplete === 15 &&
      benchmarkClosureMatrix.summary?.trajectoryEvidence === 16 &&
      benchmarkClosureMatrix.summary?.versionAvailable === 8 &&
      benchmarkClosureMatrix.summary?.complete === 15 &&
      benchmarkClosureMatrix.summary?.caveated === 1 &&
      benchmarkClosureMatrix.summary?.missing === 0 &&
      (benchmarkClosureMatrix.rows || []).length === 16 &&
      (benchmarkClosureMatrix.rows || []).every(
        (row) =>
          row.reviewComplete === true &&
          row.focusedReviewHref &&
          !String(row.focusedReviewHref).startsWith("/") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-closure-matrix", row.focusedReviewHref)) &&
          row.fiveExamplesWithPlayback >= 5 &&
          row.trajectoryEvidence === true &&
          row.agentVerdict &&
          row.recommendedAction,
      ) &&
      osworldClosure?.readiness === "caveated" &&
      osworldClosure?.agentVerdict === "blocked-live-runtime" &&
      osworldClosure?.targetPlaybackComplete === false &&
      (osworldClosure?.caveats || []).some((caveat) => /No runnable OSWorld provider/.test(caveat)),
    JSON.stringify(benchmarkClosureMatrix.summary || {}),
    "known-caveat",
  );
  const benchmarkReviewPages = (review.rows || []).filter((row) => {
    const href = String(row.reviewLinks?.benchmarkReview || "");
    if (!href || href.startsWith("/") || href.startsWith("file://")) return false;
    const resolved = path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-review", href);
    const html = existsSync(resolved) ? readFileSync(resolved, "utf8") : "";
    return (
      existsSync(resolved) &&
      /Representative Trajectory Records/.test(html) &&
      /Playback Links/.test(html)
    );
  });
  assertCheck(
    checks,
    "benchmarks.review-drilldown-pages",
    benchmarkReviewPages.length === latestRows.length &&
      (review.rows || []).every((row) => (row.playbackLinks || []).length > 0),
    `${benchmarkReviewPages.length}/${latestRows.length} benchmark drilldown pages`,
  );
  assertCheck(checks, "benchmarks.trajectory-count", trajectory.summary.benchmarkCount === latestRows.length, `${trajectory.summary.benchmarkCount}/${latestRows.length} trajectory benchmarks`);
  assertCheck(checks, "benchmarks.version-count", version.summary.benchmarkCount === latestRows.length, `${version.summary.benchmarkCount}/${latestRows.length} version benchmarks`);
  assertCheck(
    checks,
    "benchmarks.version-playback-links",
      version.summary.currentTargetPlaybackLinks === latestRows.length &&
      version.summary.previousViewerLinks === version.summary.benchmarksWithPrevious &&
      version.summary.comparableViewerPairs === version.summary.benchmarksWithPrevious &&
      version.summary.onlyOneIndexedRowBenchmarks ===
        (version.benchmarks || []).filter((entry) => !entry.comparison?.hasPrevious && entry.rowCount === 1).length &&
      version.summary.noEarlierPreviousRowBenchmarks ===
        (version.benchmarks || []).filter((entry) => entry.comparison?.noEarlierPreviousRow).length &&
      version.summary.onlyOneIndexedRowBenchmarks === 7 &&
      version.summary.noEarlierPreviousRowBenchmarks === 1 &&
      version.summary.previousPlaybackGapCount ===
        version.summary.benchmarksWithPrevious - version.summary.previousTargetPlaybackLinks &&
      (version.summary.recoveredPreviousPlaybackBenchmarks || []).length ===
        version.summary.previousTargetPlaybackLinks &&
      (version.summary.previousPlaybackGapBenchmarks || []).length ===
        version.summary.previousPlaybackGapCount &&
      version.summary.playbackComparisonStatus ===
        (version.summary.previousPlaybackGapCount > 0
          ? "aggregate-previous-viewer-only"
          : "call-by-call-playback") &&
      (version.benchmarks || []).every((entry) => {
        const currentHref = String(entry.comparison?.current?.targetPlaybackHref || "");
        if (
          !currentHref ||
          currentHref.startsWith("/") ||
          currentHref.startsWith("file://") ||
          !existsSync(path.join(REPO_ROOT, "reports/benchmarks/code-agent-version-comparison", currentHref))
        ) {
          return false;
        }
        const previousViewer = String(entry.comparison?.previous?.viewerHref || "");
        if (!entry.comparison?.hasPrevious) return previousViewer === "";
        const previousHref = String(entry.comparison?.previous?.targetPlaybackHref || "");
        if (
          previousHref &&
          (previousHref.startsWith("/") ||
            previousHref.startsWith("file://") ||
            !existsSync(path.join(REPO_ROOT, "reports/benchmarks/code-agent-version-comparison", previousHref)) ||
            !Number.isFinite(entry.comparison.previous.targetPlaybackRecords) ||
            entry.comparison.previous.targetPlaybackRecords <= 0 ||
            entry.comparison.previous.targetTrajectoryFiles <= 0)
        ) {
          return false;
        }
        if (
          !previousHref &&
          (!(entry.comparison.notes || []).some((note) =>
            /Previous target playback is unavailable/.test(String(note)),
          ) ||
            entry.comparison.previous.targetTrajectoryFiles !== 0)
        ) {
          return false;
        }
        return (
          previousViewer &&
          !previousViewer.startsWith("/") &&
          !previousViewer.startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmarks/code-agent-version-comparison", previousViewer))
        );
      }),
    `currentPlayback=${version.summary.currentTargetPlaybackLinks || 0}; previousViewers=${version.summary.previousViewerLinks || 0}; comparableViewers=${version.summary.comparableViewerPairs || 0}; previousPlaybackGaps=${version.summary.previousPlaybackGapCount || 0}`,
  );
  assertCheck(
    checks,
    "benchmarks.version-remediation-matrix",
    versionRemediationMatrix.summary?.benchmarkCount === latestRows.length &&
      versionRemediationMatrix.summary?.benchmarkCount === 16 &&
      versionRemediationMatrix.summary?.withPrevious === version.summary.benchmarksWithPrevious &&
      versionRemediationMatrix.summary?.withoutPrevious === version.summary.benchmarksWithoutPrevious &&
      versionRemediationMatrix.summary?.currentPlaybackLinks === version.summary.currentTargetPlaybackLinks &&
      versionRemediationMatrix.summary?.comparablePlaybackPairs === version.summary.comparablePlaybackPairs &&
      versionRemediationMatrix.summary?.previousPlaybackGaps === version.summary.previousPlaybackGapCount &&
      versionRemediationMatrix.summary?.previousAggregateOnly === 2 &&
      versionRemediationMatrix.summary?.previousAggregateOnlyWithViewer === 2 &&
      versionRemediationMatrix.summary?.previousAggregateOnlyWithNoTrajectoryFiles === 2 &&
      versionRemediationMatrix.summary?.previousAggregateOnlyReviewRows === 2 &&
      versionRemediationMatrix.summary?.completeHistory === version.summary.comparablePlaybackPairs &&
      versionRemediationMatrix.summary?.noPreviousRun === 6 &&
      versionRemediationMatrix.summary?.noEarlierPreviousRow ===
        version.summary.noEarlierPreviousRowBenchmarks &&
      versionRemediationMatrix.summary?.noEarlierPreviousRow === 1 &&
      versionRemediationMatrix.summary?.osworldProviderCaveats === 1 &&
      versionRemediationMatrix.summary?.rerunCommands === 16 &&
      JSON.stringify(versionRemediationMatrix.summary?.previousPlaybackGapBenchmarks || []) ===
        JSON.stringify(version.summary.previousPlaybackGapBenchmarks || []) &&
      JSON.stringify(versionRemediationMatrix.summary?.previousAggregateOnlyBenchmarks || []) ===
        JSON.stringify(["mind2web", "nl2repo"]) &&
      JSON.stringify(versionRemediationMatrix.summary?.noPreviousRunBenchmarks || []) ===
        JSON.stringify(["app_eval_coding", "clawbench", "mint", "swe_bench", "swe_bench_multilingual", "visualwebbench"]) &&
      JSON.stringify(versionRemediationMatrix.summary?.noEarlierPreviousRowBenchmarks || []) ===
        JSON.stringify(["standard_humaneval"]) &&
      versionRemediationMatrix.summary?.versionGapReviewRows === 16 &&
      (versionRemediationMatrix.rows || []).length === 16 &&
      (versionRemediationMatrix.rows || []).every(
        (row) =>
          row.benchmark &&
          row.gapType &&
          row.disposition &&
          row.rerunCommand &&
          /--benchmarks /.test(row.rerunCommand) &&
          row.followedBy === "bun run bench:analysis:build" &&
          row.currentTargetPlaybackHref &&
          row.versionGapReview?.canReviewOffline === true &&
          row.versionGapReview?.reviewClass &&
          row.versionGapReview?.primaryEvidenceHref &&
          !String(row.versionGapReview?.primaryEvidenceHref).startsWith("/") &&
          !String(row.versionGapReview?.primaryEvidenceHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/version-remediation-matrix", row.versionGapReview.primaryEvidenceHref)) &&
          !String(row.currentTargetPlaybackHref).startsWith("/") &&
          !String(row.currentTargetPlaybackHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/version-remediation-matrix", row.currentTargetPlaybackHref)) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (versionRemediationMatrix.rows || []).some(
        (row) =>
          row.benchmark === "standard_humaneval" &&
          row.gapType === "no-earlier-previous-row" &&
          row.rowCount === 2 &&
          row.noEarlierPreviousRow === true,
      ) &&
      (versionRemediationMatrix.rows || []).some(
        (row) =>
          row.benchmark === "mind2web" &&
          row.gapType === "previous-aggregate-only" &&
          row.previousViewerHref &&
          row.previousTargetTrajectoryFiles === 0 &&
          row.previousBaselineTrajectoryFiles === 0,
      ) &&
      (versionRemediationMatrix.rows || [])
        .filter((row) => row.gapType === "previous-aggregate-only")
        .every(
          (row) =>
            row.versionGapReview?.reviewClass === "previous-viewer-no-trajectory" &&
            /zero/.test(row.versionGapReview?.summary || "") &&
            row.previousTargetPlaybackRecords === 0,
        ) &&
      (versionRemediationMatrix.rows || []).some(
        (row) =>
          row.benchmark === "nl2repo" &&
          row.gapType === "previous-aggregate-only" &&
          row.previousViewerHref &&
          row.previousTargetTrajectoryFiles === 0 &&
          row.previousBaselineTrajectoryFiles === 0,
      ) &&
      (versionRemediationMatrix.rows || []).some(
        (row) => row.benchmark === "osworld" && row.gapType === "osworld-provider-caveat" && /--max-tasks 5/.test(row.rerunCommand),
      ),
    JSON.stringify(versionRemediationMatrix.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "benchmarks.outcome-analysis",
    benchmarkOutcomeAnalysis.summary?.benchmarkCount === latestRows.length &&
      benchmarkOutcomeAnalysis.summary?.benchmarkCount === 16 &&
      benchmarkOutcomeAnalysis.summary?.reviewPass === review.summary?.reviewPass &&
      benchmarkOutcomeAnalysis.summary?.needsOutputReview === review.summary?.weakOrInferior &&
      benchmarkOutcomeAnalysis.summary?.blockedOrCaveated === benchmarkClosureMatrix.summary?.caveated &&
      benchmarkOutcomeAnalysis.summary?.targetPlaybackComplete ===
        benchmarkClosureMatrix.summary?.targetPlaybackComplete &&
      benchmarkOutcomeAnalysis.summary?.sampledExamples ===
        benchmarkClosureMatrix.summary?.sampledExamples &&
      benchmarkOutcomeAnalysis.summary?.sampledExamplesWithPlayback ===
        benchmarkClosureMatrix.summary?.sampledExamplesWithPlayback &&
      benchmarkOutcomeAnalysis.summary?.sampledExamplesWithTaskId ===
        benchmarkClosureMatrix.summary?.sampledExamplesWithTaskId &&
      benchmarkOutcomeAnalysis.summary?.trajectoryFiles ===
        benchmarkClosureMatrix.summary?.trajectoryFiles &&
      benchmarkOutcomeAnalysis.summary?.trajectoryRecords ===
        benchmarkClosureMatrix.summary?.trajectoryRecords &&
      benchmarkOutcomeAnalysis.summary?.trajectoryTokens ===
        benchmarkClosureMatrix.summary?.trajectoryTokens &&
      benchmarkOutcomeAnalysis.summary?.trajectoryCacheReadTokens ===
        benchmarkClosureMatrix.summary?.trajectoryCacheReadTokens &&
      benchmarkOutcomeAnalysis.summary?.versionPreviousPlaybackGaps ===
        versionRemediationMatrix.summary?.previousPlaybackGaps &&
      benchmarkOutcomeAnalysis.summary?.versionNoPreviousRun ===
        versionRemediationMatrix.summary?.noPreviousRun &&
      benchmarkOutcomeAnalysis.summary?.osworldCaveats === 1 &&
      (benchmarkOutcomeAnalysis.rows || []).length === 16 &&
      (benchmarkOutcomeAnalysis.rows || []).every(
        (row) =>
          row.benchmark &&
          row.qualityBand &&
          row.nextAction &&
          row.focusedReviewHref &&
          row.runViewerHref &&
          row.sampledExamplesWithPlayback === 5 &&
          !String(row.focusedReviewHref).startsWith("/") &&
          !String(row.focusedReviewHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-outcome-analysis", row.focusedReviewHref)) &&
          !String(row.runViewerHref).startsWith("/") &&
          !String(row.runViewerHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-outcome-analysis", row.runViewerHref)) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (benchmarkOutcomeAnalysis.rows || []).some(
        (row) => row.benchmark === "osworld" && row.qualityBand === "blocked-or-caveated",
      ) &&
      (benchmarkOutcomeAnalysis.rows || []).some(
        (row) => row.benchmark === "mind2web" && row.versionGapType === "previous-aggregate-only",
      ),
    JSON.stringify(benchmarkOutcomeAnalysis.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "benchmarks.review-packs",
    benchmarkReviewPacks.summary?.benchmarkCount === latestRows.length &&
      benchmarkReviewPacks.summary?.packPages === latestRows.length &&
      benchmarkReviewPacks.summary?.withFiveSamples === latestRows.length &&
      benchmarkReviewPacks.summary?.sampleRows === latestRows.length * 5 &&
      benchmarkReviewPacks.summary?.samplePlaybackRows === latestRows.length * 5 &&
      benchmarkReviewPacks.summary?.reviewReadySamples === sampleReviewMatrix.summary?.reviewReadyRows &&
      benchmarkReviewPacks.summary?.fullInlineReviewSamples === sampleReviewMatrix.summary?.fullInlineReviewRows &&
      benchmarkReviewPacks.summary?.toolCallOnlyInlineSamples === sampleReviewMatrix.summary?.toolCallOnlyInlineRows &&
      benchmarkReviewPacks.summary?.playbackOnlyEnvironmentSamples === sampleReviewMatrix.summary?.playbackOnlyEnvironmentRows &&
      benchmarkReviewPacks.summary?.withTargetPlayback ===
        benchmarkOutcomeAnalysis.summary?.targetPlaybackComplete &&
      benchmarkReviewPacks.summary?.withManualReviewNote === 10 &&
      benchmarkReviewPacks.summary?.withVersionPrevious === versionRemediationMatrix.summary?.withPrevious &&
      benchmarkReviewPacks.summary?.withComparablePlaybackPair ===
        versionRemediationMatrix.summary?.comparablePlaybackPairs &&
      benchmarkReviewPacks.summary?.totalTrajectoryTokens ===
        benchmarkOutcomeAnalysis.summary?.trajectoryTokens &&
      benchmarkReviewPacks.summary?.totalTrajectoryCacheReadTokens ===
        benchmarkOutcomeAnalysis.summary?.trajectoryCacheReadTokens &&
      (benchmarkReviewPacks.packs || []).every(
        (pack) =>
          pack.href &&
          !String(pack.href).startsWith("/") &&
          !String(pack.href).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-review-packs", pack.href)) &&
          (pack.samples || []).length === 5 &&
          (pack.samples || []).every(
            (sample) =>
              sample.playbackHref &&
              sample.reviewCompleteness &&
              sample.reviewLimitation &&
              sample.inputSource !== undefined &&
              sample.outputSource !== undefined &&
              Number.isFinite(Number(sample.responseChars || 0)) &&
              Number.isFinite(Number(sample.toolCallCount || 0)) &&
              !String(sample.playbackHref).startsWith("/") &&
              !String(sample.playbackHref).startsWith("file://") &&
              existsSync(
                path.join(REPO_ROOT, "reports/benchmark-analysis/benchmark-review-packs/benchmarks", sample.playbackHref),
              ),
          ) &&
          pack.trajectory?.focusedReviewHref &&
          !String(pack.trajectory.focusedReviewHref).startsWith("/") &&
          !String(pack.trajectory.focusedReviewHref).startsWith("file://") &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(pack)),
      ) &&
      (benchmarkReviewPacks.packs || []).some(
        (pack) =>
          pack.benchmark === "osworld" &&
          pack.qualityBand === "blocked-or-caveated" &&
          pack.trajectory?.targetPlaybackComplete === false,
      ) &&
      (benchmarkReviewPacks.packs || []).some(
        (pack) =>
          pack.benchmark === "webshop" &&
          (pack.samples || []).every(
            (sample) =>
              sample.reviewCompleteness === "tool-call-only-inline" &&
              sample.reviewLimitation.includes("No text response") &&
              sample.toolCallCount > 0,
          ),
      ) &&
      (benchmarkReviewPacks.packs || []).some(
        (pack) =>
          pack.benchmark === "agentbench" &&
          (pack.samples || []).every(
            (sample) =>
              sample.reviewCompleteness === "playback-only-environment" &&
              sample.reviewLimitation.includes("Playback exists"),
          ),
      ) &&
      (benchmarkReviewPacks.packs || []).some(
        (pack) => pack.benchmark === "mind2web" && pack.version?.gapType === "previous-aggregate-only",
      ),
    JSON.stringify(benchmarkReviewPacks.summary || {}),
    "known-caveat",
  );
  assertCheck(checks, "benchmarks.mirrored-runs", (indexData.mirrored_run_artifacts?.mirrored_run_count || 0) >= 26, `${indexData.mirrored_run_artifacts?.mirrored_run_count || 0} mirrored runs`);
  assertCheck(checks, "benchmarks.no-temp-viewer-links", latestRows.every((row) => !String(row.viewer_href || "").startsWith("file:///tmp") && !String(row.viewer_href || "").startsWith("file:///private/tmp")), "latest viewer links are repo-local");
  assertCheck(checks, "benchmarks.trajectory-records", trajectory.summary.trajectoryRecords >= 566, `${trajectory.summary.trajectoryRecords} trajectory records`);
  assertCheck(
    checks,
    "benchmarks.trajectory-input-output-fields",
    trajectory.summary.inputOutput?.records === trajectory.summary.trajectoryRecords &&
      trajectory.summary.inputOutput?.recordsWithInput >= 530 &&
      trajectory.summary.inputOutput?.recordsWithOutput >= 418 &&
      trajectory.summary.inputOutput?.promptTextRecords >= 490 &&
      trajectory.summary.inputOutput?.responseTextRecords >= 300 &&
      (trajectory.summary.inputOutput?.byOutputSource?.["transcript.assistant_text"] || 0) >= 22 &&
      (trajectory.entries || []).every((entry) =>
        (entry.records || []).every((record) =>
          typeof record.inputSource === "string" &&
          typeof record.outputSource === "string" &&
          typeof record.inputPreview === "string" &&
          typeof record.outputPreview === "string",
        ),
      ),
    `input=${trajectory.summary.inputOutput?.recordsWithInput || 0}; output=${trajectory.summary.inputOutput?.recordsWithOutput || 0}; prompt_text=${trajectory.summary.inputOutput?.promptTextRecords || 0}; response_text=${trajectory.summary.inputOutput?.responseTextRecords || 0}; transcript_assistant=${trajectory.summary.inputOutput?.byOutputSource?.["transcript.assistant_text"] || 0}`,
  );
  assertCheck(
    checks,
    "benchmarks.trajectory-html-playback",
    trajectory.summary.playbackFiles === trajectory.summary.trajectoryFiles &&
      trajectory.summary.playbackFiles >= 92 &&
      (trajectory.entries || []).every((entry) =>
        entry.playbackHref &&
        !String(entry.playbackHref).startsWith("/") &&
        existsSync(path.join(REPO_ROOT, "reports/benchmarks/code-agent-trajectory-catalog", entry.playbackHref)),
      ),
    `${trajectory.summary.playbackFiles || 0}/${trajectory.summary.trajectoryFiles || 0} trajectory playback pages`,
  );
  assertCheck(checks, "benchmarks.no-under-five", review.summary.underFive === 0, `underFive=${review.summary.underFive}`);
  assertCheck(checks, "benchmarks.review-known-caveats", review.summary.missingLive === 1, `missingLive=${review.summary.missingLive}`, "known-caveat");
  assertCheck(checks, "benchmarks.osworld-blocker-explicit", gap.osworld?.docker?.serverAvailable === false && gap.osworld?.providerReadiness?.runnableProviderCount === 0, gap.osworld?.blockerSummary || "", "known-caveat");
  const osworldReadinessHtml = readFileSync(
    path.join(REPO_ROOT, "reports/benchmark-analysis/gap-evidence/osworld-live-readiness.html"),
    "utf8",
  );
  assertCheck(
    checks,
    "benchmarks.osworld-readiness-page",
    /OSWorld Live Readiness/.test(osworldReadinessHtml) &&
      /Provider Checklist/.test(osworldReadinessHtml) &&
      /Rerun Gate/.test(osworldReadinessHtml) &&
      /--benchmarks osworld/.test(osworldReadinessHtml),
    "focused OSWorld readiness page exists with provider checklist and rerun command",
  );
  assertCheck(
    checks,
    "benchmarks.external-rerun-commands",
    /--benchmarks osworld/.test(gap.remediationCommands?.osworld?.[0]?.command || "") &&
      /--benchmarks hyperliquid_bench/.test(
        gap.remediationCommands?.hyperliquid?.[0]?.command || "",
      ) &&
      !/csk-[A-Za-z0-9_-]+/.test(
        JSON.stringify(gap.remediationCommands || {}),
      ),
    JSON.stringify(gap.remediationCommands || {}),
  );
  assertCheck(checks, "benchmarks.claw-eval-expanded", (gap.underFiveBenchmarks?.claw_eval?.available || 0) >= 5, `claw_eval=${gap.underFiveBenchmarks?.claw_eval?.available || 0}`);
  assertCheck(checks, "benchmarks.qwen-claw-expanded", (gap.underFiveBenchmarks?.qwen_claw_bench?.available || 0) >= 5, `qwen_claw_bench=${gap.underFiveBenchmarks?.qwen_claw_bench?.available || 0}`);
  assertCheck(checks, "benchmarks.openclaw-expanded", (gap.underFiveBenchmarks?.openclaw_benchmark?.available || 0) >= 5, `openclaw_benchmark=${gap.underFiveBenchmarks?.openclaw_benchmark?.available || 0}`);
  assertCheck(checks, "benchmarks.results-corpus-rows", corpus.summary?.rowCount === 156 && corpus.summary?.benchmarkCount === 52, `${corpus.summary?.rowCount} rows; ${corpus.summary?.benchmarkCount} benchmark families`);
  assertCheck(checks, "benchmarks.results-corpus-trajectories", (corpus.trajectory?.trajectory_rows || 0) >= 1795, `${corpus.trajectory?.trajectory_rows || 0} SQLite trajectory rows`);
  assertCheck(checks, "benchmarks.results-corpus-artifacts", (corpus.summary?.latestRowsWithTrajectoryFiles || 0) >= 150 && (corpus.summary?.latestOutputFileCount || 0) >= 658, `${corpus.summary?.latestRowsWithTrajectoryFiles || 0} rows with trajectory-like files; ${corpus.summary?.latestOutputFileCount || 0} output files`);
  assertCheck(checks, "benchmarks.results-corpus-call-previews", (corpus.summary?.latestRowsWithCallPreviews || 0) >= 150 && (corpus.summary?.latestCallPreviewCount || 0) >= 352, `${corpus.summary?.latestRowsWithCallPreviews || 0} rows with call previews; ${corpus.summary?.latestCallPreviewCount || 0} previews`);
  assertCheck(checks, "benchmarks.results-corpus-normalized-calls", (corpus.callCatalogSummary?.normalizedCallCount || 0) >= 2161 && (corpus.callCatalogSummary?.rowsWithNormalizedCalls || 0) >= 150 && (corpus.callCatalogSummary?.benchmarksWithNormalizedCalls || 0) >= 52, `${corpus.callCatalogSummary?.normalizedCallCount || 0} normalized calls; ${corpus.callCatalogSummary?.rowsWithNormalizedCalls || 0} rows; ${corpus.callCatalogSummary?.benchmarksWithNormalizedCalls || 0} benchmark families`);
  assertCheck(checks, "benchmarks.results-corpus-canonical-playback", (corpus.summary?.canonicalTrajectoryFiles || 0) >= 129 && (corpus.canonicalFiles || []).length === corpus.summary?.canonicalTrajectoryFiles, `${corpus.summary?.canonicalTrajectoryFiles || 0} canonical files`);
  assertCheck(
    checks,
    "benchmarks.results-corpus-html-playback",
    (corpus.canonicalFiles || []).length >= 129 &&
      (corpus.canonicalFiles || []).every((entry) =>
        entry.playback_file &&
        !String(entry.playback_file).startsWith("/") &&
        existsSync(path.join(REPO_ROOT, entry.playback_file)),
      ),
    `${(corpus.canonicalFiles || []).filter((entry) => entry.playback_file && existsSync(path.join(REPO_ROOT, entry.playback_file))).length} playback HTML files`,
  );
  assertCheck(checks, "benchmarks.results-corpus-sqlite-playback", (corpus.sqliteTrajectoryRows || []).length >= 1795, `${(corpus.sqliteTrajectoryRows || []).length} SQLite playback rows`);
  assertCheck(checks, "benchmarks.results-corpus-review-findings", corpus.reviewFindingSummary?.findingCount === (corpus.benchmarkFamilies || []).length && corpus.reviewFindingSummary?.findingCount === 53, `${corpus.reviewFindingSummary?.findingCount || 0} findings`);
  assertCheck(
    checks,
    "benchmarks.results-corpus-telemetry-gaps",
      corpus.telemetryGapSummary?.tokenlessFamilyCount === corpus.reviewFindingSummary?.telemetryGap &&
      corpus.telemetryGapSummary?.zeroMetricLatestRows === corpus.summary?.missingTrajectoryLatestRows &&
      corpus.telemetryGapSummary?.evidenceAbsentLatestRows === 0 &&
      corpus.telemetryGapSummary?.replayableButTokenlessRows === 9 &&
      (corpus.telemetryGapSummary?.tokenlessFamilies || []).every((entry) => entry.normalized_calls > 0),
    `${corpus.telemetryGapSummary?.tokenlessFamilyCount || 0} tokenless families; ${corpus.telemetryGapSummary?.zeroMetricLatestRows || 0} zero-metric rows; evidence-absent=${corpus.telemetryGapSummary?.evidenceAbsentLatestRows || 0}`,
  );
  assertCheck(
    checks,
    "benchmarks.results-corpus-family-pages",
    corpus.summary?.familyReviewPages === (corpus.benchmarkFamilies || []).length &&
      (corpus.familyReviewPages || []).length === (corpus.benchmarkFamilies || []).length &&
      (corpus.benchmarkFamilies || []).every((family) =>
        family.family_page &&
        !String(family.family_page).startsWith("/") &&
        existsSync(path.join(REPO_ROOT, family.family_page)),
      ) &&
      (corpus.reviewFindings || []).every((finding) =>
        finding.family_page &&
        !String(finding.family_page).startsWith("/") &&
        existsSync(path.join(REPO_ROOT, finding.family_page)),
      ),
    `${corpus.summary?.familyReviewPages || 0}/${(corpus.benchmarkFamilies || []).length} corpus family review pages`,
  );
  assertCheck(
    checks,
    "benchmarks.results-corpus-gap-pages",
    (corpus.noPlaybackGapPages || []).length === 1 &&
      (corpus.noPlaybackGapPages || []).every((entry) =>
        entry.gap_page &&
        !String(entry.gap_page).startsWith("/") &&
        existsSync(path.join(REPO_ROOT, entry.gap_page)),
      ),
    `${(corpus.noPlaybackGapPages || []).length} no-playback gap pages`,
  );
  assertCheck(
    checks,
    "corpus-remediation-matrix.coverage",
    corpusRemediationMatrix.summary?.familyRows === (corpusRemediationMatrix.rows || []).length &&
      corpusRemediationMatrix.summary?.familyRows === 32 &&
      corpusRemediationMatrix.summary?.needsReviewFamilies === corpus.reviewFindingSummary?.needsReview &&
      corpusRemediationMatrix.summary?.telemetryGapFamilies === corpus.reviewFindingSummary?.telemetryGap &&
      corpusRemediationMatrix.summary?.blockedFamilies === corpus.reviewFindingSummary?.blocked &&
      corpusRemediationMatrix.summary?.reviewPassIncludedFamilies === 1 &&
      corpusRemediationMatrix.summary?.publicationWarningLatestRows ===
        (corpus.latestRows || []).filter((row) => (row.publication_warnings || []).length > 0).length &&
      corpusRemediationMatrix.summary?.insufficientWarningLatestRows ===
        corpus.summary?.insufficientLatestRows &&
      corpusRemediationMatrix.summary?.zeroMetricRows ===
        corpus.telemetryGapSummary?.zeroMetricLatestRows &&
      corpusRemediationMatrix.summary?.tokenlessFamilies ===
        corpus.telemetryGapSummary?.tokenlessFamilyCount &&
      corpusRemediationMatrix.summary?.blockedCredentialFamilies === 1 &&
      JSON.stringify(corpusRemediationMatrix.summary?.missingCredentialNames || []) ===
        JSON.stringify(["HL_PRIVATE_KEY"]) &&
      corpusRemediationMatrix.summary?.familyPagesLinked === corpusRemediationMatrix.summary?.familyRows &&
      corpusRemediationMatrix.summary?.canonicalPlaybackFamilies ===
        corpusRemediationMatrix.summary?.familyRows - corpusRemediationMatrix.summary?.blockedFamilies &&
      corpusRemediationMatrix.summary?.rerunCommands === corpusRemediationMatrix.summary?.familyRows &&
      (corpusRemediationMatrix.rows || []).every(
        (row) =>
          row.benchmarkId &&
          row.rerunCommand &&
          /--benchmarks /.test(row.rerunCommand) &&
          (row.familyPageExists === true || row.gapPageExists === true) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (corpusRemediationMatrix.rows || []).some(
        (row) =>
          row.benchmarkId === "hyperliquid_bench" &&
          row.disposition === "blocked" &&
          row.credentialReadiness?.runnable === false &&
          row.credentialReadiness?.present?.CEREBRAS_API_KEY === true &&
          row.credentialReadiness?.present?.HL_PRIVATE_KEY === false &&
          JSON.stringify(row.credentialReadiness?.missing || []) ===
            JSON.stringify(["HL_PRIVATE_KEY"]),
      ) &&
      (corpusRemediationMatrix.rows || []).some(
        (row) => row.disposition === "review-pass" && row.zeroMetricRows.length > 0,
      ),
    JSON.stringify(corpusRemediationMatrix.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "corpus-review-packs.coverage",
    corpusReviewPacks.summary?.familyCount === (corpus.reviewFindings || []).length &&
      corpusReviewPacks.summary?.familyCount === 53 &&
      corpusReviewPacks.summary?.packPages === 53 &&
      corpusReviewPacks.summary?.reviewPass === corpus.reviewFindingSummary?.reviewPass &&
      corpusReviewPacks.summary?.needsReview === corpus.reviewFindingSummary?.needsReview &&
      corpusReviewPacks.summary?.telemetryGap === corpus.reviewFindingSummary?.telemetryGap &&
      corpusReviewPacks.summary?.blocked === corpus.reviewFindingSummary?.blocked &&
      corpusReviewPacks.summary?.withFamilyPage === corpus.summary?.familyReviewPages &&
      corpusReviewPacks.summary?.withCanonicalPlayback ===
        corpus.summary?.benchmarkCount &&
      corpusReviewPacks.summary?.canonicalPlaybackFiles === corpus.summary?.canonicalTrajectoryFiles &&
      corpusReviewPacks.summary?.withManualReviewNote === manualReview.summary?.byKind?.["benchmark-family"] &&
      corpusReviewPacks.summary?.rerunCommands === corpusRemediationMatrix.summary?.rerunCommands &&
      corpusReviewPacks.summary?.warningRows === corpusRemediationMatrix.summary?.publicationWarningLatestRows &&
      corpusReviewPacks.summary?.warningFamilies ===
        (corpusReviewPacks.packs || []).filter((pack) => pack.warningRows.length > 0).length &&
      corpusReviewPacks.summary?.warningRowsWithPlayback === corpusReviewPacks.summary?.warningRows &&
      corpusReviewPacks.summary?.warningRowsWithCallPreview === corpusReviewPacks.summary?.warningRows &&
      Object.entries(corpus.summary?.warningCounts || {}).every(
        ([warning, count]) => corpusReviewPacks.summary?.warningCounts?.[warning] === count,
      ) &&
      corpusReviewPacks.summary?.zeroMetricRows === corpusRemediationMatrix.summary?.zeroMetricRows &&
      corpusReviewPacks.summary?.normalizedCalls === corpus.callCatalogSummary?.normalizedCallCount &&
      (corpusReviewPacks.packs || []).every(
        (pack) =>
          pack.href &&
          !String(pack.href).startsWith("/") &&
          !String(pack.href).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/corpus-review-packs", pack.href)) &&
          pack.familyPageHref &&
          !String(pack.familyPageHref).startsWith("/") &&
          !String(pack.familyPageHref).startsWith("file://") &&
          Object.values(pack.warningCounts || {}).reduce((sum, count) => sum + count, 0) ===
            pack.warningRows.length &&
          (pack.warningRows || []).every(
            (row) =>
              row.provider &&
              row.model &&
              Number.isFinite(Number(row.callPreviewCount)) &&
              Number(row.callPreviewCount) > 0 &&
              row.playbackHref &&
              !String(row.playbackHref).startsWith("/") &&
              !String(row.playbackHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/corpus-review-packs", row.playbackHref)),
          ) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(pack)),
      ) &&
      (corpusReviewPacks.packs || []).some(
        (pack) => pack.benchmarkId === "hyperliquid_bench" && pack.disposition === "blocked" && pack.gapPageHref,
      ) &&
      (corpusReviewPacks.packs || []).some(
        (pack) => pack.disposition === "review-pass" && !pack.manualReview,
      ),
    JSON.stringify(corpusReviewPacks.summary || {}),
    "known-caveat",
  );
  assertCheck(checks, "benchmarks.results-corpus-family-summary", (corpus.benchmarkFamilies || []).length === 53 && (corpus.benchmarkFamilies || []).some((family) => family.benchmark_id === "hyperliquid_bench" && family.matrix_complete === false && family.unsupported_cells === 3), `${(corpus.benchmarkFamilies || []).length} benchmark families`);
  assertCheck(checks, "benchmarks.results-corpus-run-history", corpus.runHistory?.summary?.runCount === 398 && corpus.runHistory?.summary?.benchmarkAgentPairs === 165 && corpus.runHistory?.summary?.pairsWithPrevious >= 44, `${corpus.runHistory?.summary?.runCount || 0} runs; ${corpus.runHistory?.summary?.benchmarkAgentPairs || 0} pairs; previous=${corpus.runHistory?.summary?.pairsWithPrevious || 0}`);
  assertCheck(checks, "benchmarks.hyperliquid-blocker-explicit", corpus.credentialGaps?.hyperliquid?.present?.CEREBRAS_API_KEY === true && corpus.credentialGaps?.hyperliquid?.present?.HL_PRIVATE_KEY === false, `missing=${(corpus.credentialGaps?.hyperliquid?.missing || []).join(",")}`, "known-caveat");
  assertCheck(
    checks,
    "benchmarks.external-credential-presence",
    gap.credentials?.cerebrasApiKeyPresent === true &&
      gap.credentials?.hyperliquidPrivateKeyPresent === false &&
      gap.credentials?.awsAccessKeyIdPresent === false &&
      gap.credentials?.awsSecretAccessKeyPresent === false &&
      /not persisted/.test(String(gap.credentials?.note || "")),
    JSON.stringify(gap.credentials || {}),
    "known-caveat",
  );
  const hyperliquidGapHtml = readFileSync(
    path.join(
      REPO_ROOT,
      "reports/benchmarks/benchmark-results-corpus-review/gap-pages/hyperliquid_bench.html",
    ),
    "utf8",
  );
  assertCheck(
    checks,
    "benchmarks.hyperliquid-readiness-page",
    /Credential Readiness/.test(hyperliquidGapHtml) &&
      /HL_PRIVATE_KEY/.test(hyperliquidGapHtml) &&
      /Secret values are not persisted/.test(hyperliquidGapHtml),
    "hyperliquid gap page includes credential readiness without secret values",
  );

  assertCheck(checks, "live.model-artifact-gap", live.summary.modelArtifactRequiredWithoutEvidence === 0, `${live.summary.modelArtifactRequiredWithoutEvidence} model-call scripts without evidence`);
  assertCheck(checks, "live.non-model-unclassified-gap", live.summary.nonModelUnclassifiedWithoutArtifactEvidence === 0, `${live.summary.nonModelUnclassifiedWithoutArtifactEvidence} non-model rows unclassified`);
  assertCheck(checks, "live.script-findings-complete", live.findingSummary?.findingCount === live.summary.totalScripts && live.findingSummary?.modelArtifactGap === 0 && live.findingSummary?.nonModelUnclassified === 0, `${live.findingSummary?.findingCount || 0}/${live.summary.totalScripts}; model gaps=${live.findingSummary?.modelArtifactGap ?? "n/a"}; non-model unclassified=${live.findingSummary?.nonModelUnclassified ?? "n/a"}`);
  const liveModelRows = (live.rows || []).filter(
    (row) => row.modelArtifactRequired || row.likelyLlm,
  );
  const liveModelRowsWithReviewableEvidence = liveModelRows.filter((row) => {
    const reviewHref = String(row.modelReviewHref || "");
    if (reviewHref) {
      const resolved = path.resolve(REPO_ROOT, "reports/live-test-inventory", reviewHref);
      const repoRelative = path.relative(REPO_ROOT, resolved).replaceAll(path.sep, "/");
      if (!repoRelative.startsWith("reports/") || !existsSync(resolved)) return false;
    }
    const playback = String(row.latestWrappedRun?.playbackIndex || "");
    if (playback) {
      const resolved = path.resolve(REPO_ROOT, "reports/live-test-inventory", playback);
      const repoRelative = path.relative(REPO_ROOT, resolved).replaceAll(path.sep, "/");
      return repoRelative.startsWith("reports/") && existsSync(resolved);
    }
    return row.hasArtifactEvidence === true && row.knownArtifactPath === true;
  });
  assertCheck(
    checks,
    "live.model-evidence-routable",
    liveModelRows.length === live.summary.modelArtifactRequiredScripts &&
      liveModelRowsWithReviewableEvidence.length === liveModelRows.length,
    `${liveModelRowsWithReviewableEvidence.length}/${liveModelRows.length} model-call scripts have playback or built-in artifact evidence`,
  );
  const liveModelReviewPages = liveModelRows.filter((row) => {
    const reviewHref = String(row.modelReviewHref || "");
    if (!reviewHref || reviewHref.startsWith("/") || reviewHref.startsWith("file://")) {
      return false;
    }
    return existsSync(path.join(REPO_ROOT, "reports/live-test-inventory", reviewHref));
  });
  assertCheck(
    checks,
    "live.model-review-pages",
    live.summary.modelScriptReviewPages === liveModelRows.length &&
      liveModelReviewPages.length === liveModelRows.length &&
      (live.scriptFindings || [])
        .filter((finding) => finding.likelyLlm)
        .every((finding) => String(finding.modelReviewHref || "").startsWith("model-scripts/")),
    `${liveModelReviewPages.length}/${liveModelRows.length} model-call script review pages`,
  );
  assertCheck(
    checks,
    "live.playback-pages",
      livePlayback.runCount === live.summary.wrappedRuns &&
      livePlayback.playbackCount === live.summary.wrappedRuns &&
      live.summary.structuredLlmRuns === livePlayback.structuredLlmRuns &&
      live.summary.structuredLlmCallCount === livePlayback.structuredLlmCallCount &&
      livePlayback.modelTelemetryRuns >= 1 &&
      livePlayback.tokenLikeTextRuns >= 3 &&
      livePlayback.modelTotalMsSum > 0 &&
      livePlayback.artifactLinkRuns === livePlayback.runCount &&
      livePlayback.artifactLinkCount >= livePlayback.runCount * 4 &&
      livePlayback.exitCodeCounts &&
      livePlayback.eventTypeTotals?.start === livePlayback.runCount &&
      livePlayback.eventTypeTotals?.exit === livePlayback.runCount &&
      livePlayback.structuredLlmRuns >= 1 &&
      livePlayback.structuredLlmCallCount >= 1 &&
      livePlayback.structuredTotalTokens > 0 &&
      live.summary.wrapperPlaybackRuns === live.summary.wrappedRuns &&
      (livePlayback.manifest || []).every((row) =>
        row.playbackIndex &&
        row.modelTelemetry &&
        row.durationMs >= 0 &&
        row.commandText &&
        row.eventTypeCounts?.start >= 1 &&
        row.eventTypeCounts?.exit >= 1 &&
        (row.artifactLinks || []).length >= 4 &&
        (row.artifactLinks || []).every(
          (artifact) =>
            artifact.href &&
            !String(artifact.href).startsWith("/") &&
            !String(artifact.href).startsWith("file://") &&
            existsSync(path.join(REPO_ROOT, artifact.href)),
        ) &&
        typeof row.modelTelemetry.realLlmMode === "boolean" &&
        typeof row.modelTelemetry.tokenLikeText === "boolean" &&
        !String(row.playbackIndex).startsWith("/") &&
        existsSync(path.join(REPO_ROOT, row.playbackIndex)),
      ),
    `${livePlayback.playbackCount || 0}/${live.summary.wrappedRuns || 0} wrapped live/e2e playback pages; modelTelemetry=${livePlayback.modelTelemetryRuns || 0}`,
  );
  const proofOnlyStructuredLabels = new Set(["live-wrapper-structured-llm-sidecar-proof"]);
  const nonProofStructuredRuns = (livePlayback.manifest || []).filter(
    (row) =>
      Number(row.structuredLlmCallCount || 0) > 0 &&
      !proofOnlyStructuredLabels.has(String(row.label || "")),
  );
  const likelyLlmRowsWithoutPlayback = liveModelRows.filter(
    (row) => !row.latestWrappedRun?.playbackIndex,
  );
  const likelyLlmRowsWithPlaybackNoStructured = liveModelRows.filter(
    (row) =>
      row.latestWrappedRun?.playbackIndex &&
      Number(row.latestWrappedRun?.structuredLlmCallCount || 0) === 0,
  );
  const likelyLlmRowsWithoutStructuredStatus = liveModelRows.filter(
    (row) => !row.structuredLlmCoverageReason,
  );
  const likelyLlmRowsWithPlaybackNoStructuredWithoutReason =
    likelyLlmRowsWithPlaybackNoStructured.filter(
      (row) =>
        !row.structuredLlmCoverageReason ||
        row.structuredLlmCoverageReason === "structured-present",
    );
  const realOrTokenLikeRowsWithoutStructured = (livePlayback.manifest || []).filter(
    (row) =>
      (row.modelTelemetry?.realLlmMode || row.modelTelemetry?.tokenLikeText) &&
      Number(row.structuredLlmCallCount || 0) === 0,
  );
  assertCheck(
    checks,
    "live.structured-sidecar-breadth",
    nonProofStructuredRuns.length > 0 &&
      likelyLlmRowsWithoutStructuredStatus.length === 0 &&
      likelyLlmRowsWithPlaybackNoStructuredWithoutReason.length === 0 &&
      live.summary.structuredLlmModelScriptsWithReason === live.summary.modelArtifactRequiredScripts,
    JSON.stringify({
      nonProofStructuredRuns: nonProofStructuredRuns.map((row) => row.label),
      proofStructuredRuns: (livePlayback.manifest || [])
        .filter((row) => Number(row.structuredLlmCallCount || 0) > 0)
        .map((row) => row.label),
      likelyLlmRowsWithoutPlayback: likelyLlmRowsWithoutPlayback.map(
        (row) => `${row.packageJson}:${row.script}`,
      ),
      likelyLlmRowsWithPlaybackNoStructured: likelyLlmRowsWithPlaybackNoStructured.map(
        (row) => `${row.packageJson}:${row.script}`,
      ),
      likelyLlmRowsWithoutStructuredStatus: likelyLlmRowsWithoutStructuredStatus.map(
        (row) => `${row.packageJson}:${row.script}`,
      ),
      likelyLlmRowsWithPlaybackNoStructuredWithoutReason:
        likelyLlmRowsWithPlaybackNoStructuredWithoutReason.map(
          (row) => `${row.packageJson}:${row.script}`,
        ),
      realOrTokenLikeRunsWithoutStructured: realOrTokenLikeRowsWithoutStructured.map(
        (row) => row.label,
      ),
    }),
    "known-caveat",
  );
  assertCheck(
    checks,
    "live-test-agent-review.coverage",
    liveTestAgentReview.summary?.scriptCount === live.summary.totalScripts &&
      liveTestAgentReview.summary?.reviewed === live.summary.totalScripts &&
      liveTestAgentReview.summary?.targetLinksExisting === live.summary.totalScripts &&
      liveTestAgentReview.summary?.modelCallScripts === live.summary.modelArtifactRequiredScripts &&
      liveTestAgentReview.summary?.modelCallScriptsReviewed === live.summary.modelArtifactRequiredScripts &&
      liveTestAgentReview.summary?.modelCallScriptsWithoutEvidence ===
        live.summary.modelArtifactRequiredWithoutEvidence &&
      liveTestAgentReview.summary?.modelReviewPages === live.summary.modelScriptReviewPages &&
      liveTestAgentReview.summary?.structuredLlmRows ===
        (live.scriptFindings || []).filter((finding) => finding.structuredLlmCallCount > 0).length &&
      liveTestAgentReview.summary?.structuredLlmCallCount ===
        (live.scriptFindings || []).reduce(
          (sum, finding) => sum + Number(finding.structuredLlmCallCount || 0),
          0,
        ) &&
      liveTestAgentReview.summary?.modelCallScriptsWithStructuredLlm ===
        live.summary.structuredLlmModelScripts &&
      liveTestAgentReview.summary?.modelCallScriptsWithStructuredStatus ===
        live.summary.structuredLlmModelScriptsWithReason &&
      liveTestAgentReview.summary?.modelCallScriptsWithStructuredStatus ===
        live.summary.modelArtifactRequiredScripts &&
      liveTestAgentReview.summary?.nonModelExcluded === live.summary.nonModelArtifactExcludedScripts &&
      (liveTestAgentReview.rows || []).every(
        (row) =>
          row.verdict &&
          row.recommendedAction &&
          row.targetHref &&
          row.targetExists === true &&
          !String(row.targetHref).startsWith("/") &&
          !String(row.targetHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-agent-review", row.targetHref)),
      ),
    `${liveTestAgentReview.summary?.reviewed || 0}/${live.summary.totalScripts} live/e2e scripts reviewed`,
  );
  assertCheck(
    checks,
    "live-test-failure-triage.coverage",
    liveTestFailureTriage.summary?.failedRunCount ===
      (livePlayback.manifest || []).filter((row) => Number(row.exitCode) !== 0).length &&
      liveTestFailureTriage.summary?.failedRunCount >= 14 &&
      liveTestFailureTriage.summary?.likelyLlmFailedRuns >= 9 &&
      liveTestFailureTriage.summary?.timeoutRuns >= 3 &&
      liveTestFailureTriage.summary?.rowsWithPlayback === liveTestFailureTriage.summary?.failedRunCount &&
      liveTestFailureTriage.summary?.rowsWithRerunCommand === liveTestFailureTriage.summary?.failedRunCount &&
      (liveTestFailureTriage.rows || []).every(
        (row) =>
          row.classification &&
          row.playbackHref &&
          row.viewerHref &&
          row.reportHref &&
          row.command &&
          !String(row.playbackHref).startsWith("/") &&
          !String(row.playbackHref).startsWith("file://") &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (liveTestFailureTriage.rows || []).some((row) => row.classification === "missing-model-provider") &&
      (liveTestFailureTriage.rows || []).some((row) => row.classification === "missing-android-emulator") &&
      (liveTestFailureTriage.rows || []).some((row) => row.classification === "timeout"),
    JSON.stringify(liveTestFailureTriage.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "live-test-model-evidence.coverage",
    liveTestModelEvidence.summary?.scriptCount === live.summary.modelArtifactRequiredScripts &&
      liveTestModelEvidence.summary?.scriptCount === 27 &&
      liveTestModelEvidence.summary?.artifactEvidenceScripts === 27 &&
      liveTestModelEvidence.summary?.playbackLinkedScripts === 27 &&
      liveTestModelEvidence.summary?.focusedReviewPages === 27 &&
      liveTestModelEvidence.summary?.structuredStatusScripts === 27 &&
      liveTestModelEvidence.summary?.structuredLlmScripts === live.summary.structuredLlmModelScripts &&
      liveTestModelEvidence.summary?.structuredLlmCallCount ===
        (live.scriptFindings || [])
          .filter((row) => row.likelyLlm)
          .reduce((sum, row) => sum + Number(row.structuredLlmCallCount || 0), 0) &&
      liveTestModelEvidence.summary?.latestStructuredLlmCallCount ===
        (live.scriptFindings || [])
          .filter((row) => row.likelyLlm)
          .reduce((sum, row) => sum + Number(row.latestStructuredLlmCallCount ?? row.structuredLlmCallCount ?? 0), 0) &&
      liveTestModelEvidence.summary?.failedScripts ===
        (live.scriptFindings || []).filter(
          (row) => row.likelyLlm && Number(row.latestWrappedExitCode || 0) !== 0,
        ).length &&
      liveTestModelEvidence.summary?.rowsWithFailureClassification ===
        (liveTestFailureTriage.rows || []).filter((row) => row.likelyLlm).length &&
      liveTestModelEvidence.summary?.rowsWithEmptyLlmCallSidecar >= 1 &&
      liveTestModelEvidence.summary?.rowsWithNoLlmCallSidecar >= 1 &&
      liveTestModelEvidence.summary?.rowsWithLatestRunExcerpt >= 10 &&
      (liveTestModelEvidence.rows || []).every(
        (row) =>
          row.id &&
          row.playbackExists === true &&
          row.modelReviewExists === true &&
          row.rerunCommand &&
          Number.isFinite(Number(row.latestStructuredLlmCallCount)) &&
          Number(row.structuredLlmCallCount || 0) >= Number(row.latestStructuredLlmCallCount || 0) &&
          row.llmCallsStatus &&
          (row.llmCallsStatus !== "empty-sidecar-zero-calls" || row.llmCallsLines === 0) &&
          row.latestReportHref &&
          (row.latestStdoutExcerpt || row.latestStderrExcerpt || row.structuredLlmCallCount > 0) &&
          !String(row.playbackHref).startsWith("/") &&
          !String(row.playbackHref).startsWith("file://") &&
          !String(row.latestReportHref).startsWith("/") &&
          !String(row.latestReportHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence", row.latestReportHref)) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (liveTestModelEvidence.rows || []).some(
        (row) => row.structuredLlmCallCount > 0 && row.sampleCalls.length > 0,
      ),
    JSON.stringify(liveTestModelEvidence.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "live-test-prompt-response-completeness.coverage",
    liveTestPromptResponseCompleteness.summary?.likelyLlmScripts ===
      live.summary.modelArtifactRequiredScripts &&
      liveTestPromptResponseCompleteness.summary?.scriptsWithPlayback ===
        live.summary.modelArtifactRequiredScripts &&
      liveTestPromptResponseCompleteness.summary?.scriptsWithStructuredSidecar ===
        live.summary.structuredLlmModelScripts &&
      liveTestPromptResponseCompleteness.summary?.scriptsWithStructuredStatus ===
        live.summary.structuredLlmModelScriptsWithReason &&
      liveTestPromptResponseCompleteness.summary?.reasonCodedNoSidecar ===
        live.summary.modelArtifactRequiredScripts - live.summary.structuredLlmModelScripts &&
      liveTestPromptResponseCompleteness.summary?.scriptSidecarComplete === 1 &&
      liveTestPromptResponseCompleteness.summary?.scriptSidecarPartial === 0 &&
      liveTestPromptResponseCompleteness.summary?.reasonCodedNoModelCall === 11 &&
      liveTestPromptResponseCompleteness.summary?.runtimeBlockedBeforeSidecar === 15 &&
      liveTestPromptResponseCompleteness.summary?.missingCallArtifact === 0 &&
      liveTestPromptResponseCompleteness.summary?.rowsWithFailureClassification ===
        liveTestModelEvidence.summary?.rowsWithFailureClassification &&
      liveTestPromptResponseCompleteness.summary?.rowsWithFailureClassification ===
        (liveTestFailureTriage.rows || []).filter((row) => row.likelyLlm).length &&
      liveTestPromptResponseCompleteness.summary?.runtimeBlockedWithFailureClassification >= 5 &&
      liveTestPromptResponseCompleteness.summary?.rowsWithFailureExcerpts ===
        (liveTestFailureTriage.rows || []).filter(
          (row) => row.likelyLlm && (row.stdoutExcerpt || row.stderrExcerpt),
        ).length &&
      liveTestPromptResponseCompleteness.summary?.rowsWithEmptyLlmCallSidecar ===
        liveTestModelEvidence.summary?.rowsWithEmptyLlmCallSidecar &&
      liveTestPromptResponseCompleteness.summary?.rowsWithNoLlmCallSidecar ===
        liveTestModelEvidence.summary?.rowsWithNoLlmCallSidecar &&
      liveTestPromptResponseCompleteness.summary?.rowsWithLatestRunExcerpt ===
        liveTestModelEvidence.summary?.rowsWithLatestRunExcerpt &&
      liveTestPromptResponseCompleteness.summary?.rowsWithOfflineReviewSummary ===
        liveTestPromptResponseCompleteness.summary?.likelyLlmScripts &&
      liveTestPromptResponseCompleteness.summary?.noSidecarRowsWithOfflineReviewSummary ===
        liveTestPromptResponseCompleteness.summary?.reasonCodedNoSidecar &&
      liveTestPromptResponseCompleteness.summary?.scriptStructuredCalls ===
        liveTestModelEvidence.summary?.structuredLlmCallCount &&
      liveTestPromptResponseCompleteness.summary?.scriptLatestStructuredCalls ===
        liveTestModelEvidence.summary?.latestStructuredLlmCallCount &&
      liveTestPromptResponseCompleteness.summary?.scriptLatestStructuredCalls === 27 &&
      liveTestPromptResponseCompleteness.summary?.scriptCallsParsed ===
        liveTestPromptResponseCompleteness.summary?.scriptLatestStructuredCalls &&
      liveTestPromptResponseCompleteness.summary?.scriptCallsWithPrompt ===
        liveTestPromptResponseCompleteness.summary?.scriptCallsParsed &&
      liveTestPromptResponseCompleteness.summary?.scriptCallsWithResponse ===
        liveTestPromptResponseCompleteness.summary?.scriptCallsParsed &&
      liveTestPromptResponseCompleteness.summary?.structuredRunCount ===
        livePlayback.structuredLlmRuns &&
      liveTestPromptResponseCompleteness.summary?.structuredRunCalls ===
        livePlayback.structuredLlmCallCount &&
      liveTestPromptResponseCompleteness.summary?.structuredRunCallsParsed ===
        livePlayback.structuredLlmCallCount &&
      liveTestPromptResponseCompleteness.summary?.structuredRunCallsWithPrompt ===
        livePlayback.structuredLlmCallCount &&
      liveTestPromptResponseCompleteness.summary?.structuredRunCallsWithResponse ===
        livePlayback.structuredLlmCallCount &&
      JSON.stringify(liveTestPromptResponseCompleteness.summary?.byStructuredReason || {}) ===
        JSON.stringify(liveTestModelEvidence.summary?.byStructuredReason || {}) &&
      JSON.stringify(liveTestPromptResponseCompleteness.summary?.byEvidenceTier || {}) ===
        JSON.stringify({
          "reason-coded-no-model-call": 11,
          "runtime-blocked-before-sidecar": 15,
          "script-sidecar-complete": 1,
        }) &&
      (liveTestPromptResponseCompleteness.rows || []).length ===
        live.summary.modelArtifactRequiredScripts &&
      (liveTestPromptResponseCompleteness.rows || []).every(
        (row) =>
          row.id &&
          row.playbackHref &&
          row.modelReviewHref &&
          row.structuredLlmCoverageReason &&
          Number.isFinite(Number(row.latestStructuredLlmCallCount)) &&
          Number(row.structuredLlmCallCount || 0) >= Number(row.latestStructuredLlmCallCount || 0) &&
          row.llmCallsStatus &&
          row.latestReportHref &&
          row.offlineReviewSummary?.canReviewOffline === true &&
          row.offlineReviewSummary?.blockerKind &&
          row.offlineReviewSummary?.reviewSurface &&
          row.offlineReviewSummary?.primaryEvidenceHref &&
          !String(row.offlineReviewSummary?.primaryEvidenceHref).startsWith("/") &&
          !String(row.offlineReviewSummary?.primaryEvidenceHref).startsWith("file://") &&
          !String(row.playbackHref).startsWith("/") &&
          !String(row.playbackHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-prompt-response-completeness", row.playbackHref)) &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-prompt-response-completeness", row.latestReportHref)) &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-prompt-response-completeness", row.offlineReviewSummary.primaryEvidenceHref)) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (liveTestPromptResponseCompleteness.rows || [])
        .filter((row) => row.evidenceTier !== "script-sidecar-complete")
        .every(
          (row) =>
            row.offlineReviewSummary?.canReviewOffline === true &&
            (row.offlineReviewSummary?.excerpt || row.offlineReviewSummary?.supportingEvidenceHrefs?.length),
        ) &&
      (liveTestPromptResponseCompleteness.rows || [])
        .filter((row) => row.failureClassification)
        .every(
          (row) =>
            row.failureTriageHref === "../live-test-failure-triage/index.html" &&
            row.failureReportHref &&
            row.failureViewerHref &&
            (row.stdoutExcerpt || row.stderrExcerpt) &&
            !String(row.failureReportHref).startsWith("/") &&
            !String(row.failureReportHref).startsWith("file://") &&
            existsSync(
              path.join(
                REPO_ROOT,
                "reports/benchmark-analysis/live-test-prompt-response-completeness",
                row.failureReportHref,
              ),
            ),
        ) &&
      (liveTestPromptResponseCompleteness.rows || [])
        .filter((row) => Number(row.latestStructuredLlmCallCount || 0) > 0)
        .every(
          (row) =>
            row.calls === row.latestStructuredLlmCallCount &&
            row.withPrompt === row.calls &&
            row.withResponse === row.calls &&
            row.structuredLlmCallCount >= row.latestStructuredLlmCallCount,
        ) &&
      (liveTestPromptResponseCompleteness.structuredRuns || []).every(
        (row) =>
          row.llmCallsHref &&
          row.playbackHref &&
          row.calls === row.structuredLlmCallCount &&
          row.withPrompt === row.calls &&
          row.withResponse === row.calls &&
          !String(row.llmCallsHref).startsWith("/") &&
          !String(row.llmCallsHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-prompt-response-completeness", row.llmCallsHref)),
      ),
    JSON.stringify(liveTestPromptResponseCompleteness.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "live-test-review-packs.coverage",
    liveTestReviewPacks.summary?.scriptCount === live.summary.modelArtifactRequiredScripts &&
      liveTestReviewPacks.summary?.packPages === live.summary.modelArtifactRequiredScripts &&
      liveTestReviewPacks.summary?.playbackLinkedScripts === liveTestModelEvidence.summary?.playbackLinkedScripts &&
      liveTestReviewPacks.summary?.focusedReviewPages === liveTestModelEvidence.summary?.focusedReviewPages &&
      liveTestReviewPacks.summary?.structuredSidecarScripts ===
        liveTestPromptResponseCompleteness.summary?.scriptsWithStructuredSidecar &&
      liveTestReviewPacks.summary?.structuredStatusScripts ===
        liveTestPromptResponseCompleteness.summary?.scriptsWithStructuredStatus &&
      liveTestReviewPacks.summary?.scriptStructuredCalls ===
        liveTestPromptResponseCompleteness.summary?.scriptStructuredCalls &&
      liveTestReviewPacks.summary?.scriptLatestStructuredCalls ===
        liveTestPromptResponseCompleteness.summary?.scriptLatestStructuredCalls &&
      liveTestReviewPacks.summary?.scriptCallsParsed ===
        liveTestPromptResponseCompleteness.summary?.scriptCallsParsed &&
      liveTestReviewPacks.summary?.scriptCallsWithPrompt ===
        liveTestPromptResponseCompleteness.summary?.scriptCallsWithPrompt &&
      liveTestReviewPacks.summary?.scriptCallsWithResponse ===
        liveTestPromptResponseCompleteness.summary?.scriptCallsWithResponse &&
      liveTestReviewPacks.summary?.failedScripts === liveTestModelEvidence.summary?.failedScripts &&
      liveTestReviewPacks.summary?.rowsWithFailureClassification ===
        liveTestModelEvidence.summary?.rowsWithFailureClassification &&
      liveTestReviewPacks.summary?.rowsWithRerunCommand === liveTestModelEvidence.summary?.rowsWithRerunCommand &&
      liveTestReviewPacks.summary?.manualReviewNotes === manualReview.summary?.byKind?.["live-test"] &&
      liveTestReviewPacks.summary?.sampleCallRows === liveTestModelEvidence.summary?.sampleCallRows &&
      liveTestReviewPacks.summary?.emptyLlmCallSidecars ===
        liveTestModelEvidence.summary?.rowsWithEmptyLlmCallSidecar &&
      liveTestReviewPacks.summary?.noLlmCallSidecars ===
        liveTestModelEvidence.summary?.rowsWithNoLlmCallSidecar &&
      liveTestReviewPacks.summary?.rowsWithLatestRunExcerpt ===
        liveTestModelEvidence.summary?.rowsWithLatestRunExcerpt &&
      liveTestReviewPacks.summary?.scriptSidecarComplete ===
        liveTestPromptResponseCompleteness.summary?.scriptSidecarComplete &&
      liveTestReviewPacks.summary?.reasonCodedNoModelCall ===
        liveTestPromptResponseCompleteness.summary?.reasonCodedNoModelCall &&
      liveTestReviewPacks.summary?.runtimeBlockedBeforeSidecar ===
        liveTestPromptResponseCompleteness.summary?.runtimeBlockedBeforeSidecar &&
      liveTestReviewPacks.summary?.rowsWithOfflineReviewSummary ===
        liveTestPromptResponseCompleteness.summary?.rowsWithOfflineReviewSummary &&
      liveTestReviewPacks.summary?.noSidecarRowsWithOfflineReviewSummary ===
        liveTestPromptResponseCompleteness.summary?.noSidecarRowsWithOfflineReviewSummary &&
      JSON.stringify(liveTestReviewPacks.summary?.byEvidenceTier || {}) ===
        JSON.stringify(liveTestPromptResponseCompleteness.summary?.byEvidenceTier || {}) &&
      liveTestReviewPacks.summary?.allStructuredRunCallsParsed ===
        liveTestPromptResponseCompleteness.summary?.structuredRunCallsParsed &&
      liveTestReviewPacks.summary?.allStructuredRunCallsWithPrompt ===
        liveTestPromptResponseCompleteness.summary?.structuredRunCallsWithPrompt &&
      liveTestReviewPacks.summary?.allStructuredRunCallsWithResponse ===
        liveTestPromptResponseCompleteness.summary?.structuredRunCallsWithResponse &&
      (liveTestReviewPacks.packs || []).every(
        (pack) =>
          pack.href &&
          !String(pack.href).startsWith("/") &&
          !String(pack.href).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-review-packs", pack.href)) &&
          pack.playbackHref &&
          !String(pack.playbackHref).startsWith("/") &&
          !String(pack.playbackHref).startsWith("file://") &&
          pack.modelReviewHref &&
          pack.latestReportHref &&
          pack.structured?.llmCallsStatus &&
          pack.structured?.evidenceTier &&
          pack.structured?.limitation &&
          pack.structured?.offlineReviewSummary?.canReviewOffline === true &&
          pack.structured?.offlineReviewSummary?.blockerKind &&
          pack.structured?.offlineReviewSummary?.reviewSurface &&
          pack.structured?.offlineReviewSummary?.primaryEvidenceHref &&
          !String(pack.structured?.offlineReviewSummary?.primaryEvidenceHref).startsWith("/") &&
          !String(pack.structured?.offlineReviewSummary?.primaryEvidenceHref).startsWith("file://") &&
          existsSync(
            path.join(
              REPO_ROOT,
              "reports/benchmark-analysis/live-test-review-packs",
              pack.structured.offlineReviewSummary.primaryEvidenceHref,
            ),
          ) &&
          Number.isFinite(Number(pack.structured?.latestCallCount)) &&
          Number(pack.structured?.callCount || 0) >= Number(pack.structured?.latestCallCount || 0) &&
          Number(pack.structured?.parsedCalls || 0) === Number(pack.structured?.latestCallCount || 0) &&
          Number(pack.structured?.withPrompt || 0) === Number(pack.structured?.parsedCalls || 0) &&
          Number(pack.structured?.withResponse || 0) === Number(pack.structured?.parsedCalls || 0) &&
          pack.rerunCommand &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(pack)),
      ) &&
      (liveTestReviewPacks.packs || [])
        .filter((pack) => pack.structured?.evidenceTier === "script-sidecar-complete")
        .every((pack) => Number(pack.structured?.latestCallCount || 0) > 0 && pack.sampleCalls.length > 0) &&
      (liveTestReviewPacks.packs || [])
        .filter((pack) => pack.structured?.evidenceTier === "reason-coded-no-model-call")
        .every((pack) => String(pack.structured?.limitation || "").includes("no-model-call")) &&
      (liveTestReviewPacks.packs || [])
        .filter((pack) => pack.structured?.evidenceTier === "runtime-blocked-before-sidecar")
        .every(
          (pack) =>
            pack.structured?.offlineReviewSummary?.manualReviewPrompt &&
            pack.structured?.offlineReviewSummary?.reviewSurface !== "playback-report-and-logs",
        ) &&
      (liveTestReviewPacks.packs || []).some(
        (pack) => pack.structured.callCount > 0 && pack.sampleCalls.length > 0,
      ) &&
      (liveTestReviewPacks.packs || []).filter((pack) => pack.manualReview?.noteHref).length ===
        manualReview.summary?.byKind?.["live-test"],
    JSON.stringify(liveTestReviewPacks.summary || {}),
    "known-caveat",
  );
  assertCheck(checks, "live.viewer-links-relative", (live.rows || []).every((row) => !String(row.latestWrappedRun?.viewerIndex || "").startsWith("/") && !String(row.latestWrappedRun?.viewerIndex || "").startsWith("file://") && !String(row.latestWrappedRun?.playbackIndex || "").startsWith("/") && !String(row.latestWrappedRun?.playbackIndex || "").startsWith("file://")) && (live.scriptFindings || []).every((row) => !String(row.latestWrappedViewer || "").startsWith("/") && !String(row.latestWrappedViewer || "").startsWith("file://") && !String(row.latestWrappedPlayback || "").startsWith("/") && !String(row.latestWrappedPlayback || "").startsWith("file://")), "live wrapped viewer/playback links are report-relative");
  assertCheck(checks, "scenarios.catalog-executed", scenarios.missingCount === 0 && scenarios.executedScenarioIds === scenarios.catalogScenarioCount, `${scenarios.executedScenarioIds}/${scenarios.catalogScenarioCount}; missing=${scenarios.missingCount}`);
  assertCheck(checks, "scenarios.full-catalog-count", scenarios.catalogScenarioCount === 686 && scenarios.inventoryCatalogScenarioCount === 686, `${scenarios.catalogScenarioCount} catalog; source=${scenarios.catalogSource}; cli=${scenarios.cliCatalogScenarioCount}; inventory=${scenarios.inventoryCatalogScenarioCount}`);
  assertCheck(checks, "scenarios.findings-complete", scenarios.findingSummary?.findingCount === scenarios.catalogScenarioCount && scenarios.findingSummary?.missing === 0, `${scenarios.findingSummary?.findingCount || 0}/${scenarios.catalogScenarioCount}; missing=${scenarios.findingSummary?.missing ?? "n/a"}`);
  assertCheck(
    checks,
    "scenarios.playback-pages",
    scenarios.scenarioPlaybackPages === scenarios.catalogScenarioCount &&
      (scenarios.scenarioFindings || []).every((finding) =>
        finding.playbackHref &&
        !String(finding.playbackHref).startsWith("/") &&
        existsSync(path.join(REPO_ROOT, "reports/scenarios/catalog-execution-union", finding.playbackHref)),
      ),
    `${scenarios.scenarioPlaybackPages || 0}/${scenarios.catalogScenarioCount || 0} scenario playback pages`,
  );
  const scenarioRunViewers = readdirSync(path.join(REPO_ROOT, "reports/scenarios"))
    .map((name) => {
      const viewerData = path.join(REPO_ROOT, "reports/scenarios", name, "viewer", "data.js");
      if (!existsSync(viewerData)) return null;
      const parsed = readScenarioViewerData(viewerData);
      const artifactPaths =
        parsed.kind === "standard"
          ? parsed.data?.report?.artifactPaths
          : parsed.data?.artifactPaths;
      return {
        name,
        kind: parsed.kind,
        artifactPaths,
      };
    })
    .filter(Boolean);
  assertCheck(
    checks,
    "scenarios.run-viewer-artifact-paths",
    scenarioRunViewers.length >= 10 &&
      scenarioRunViewers.every(
        (row) =>
          row.kind !== "unknown" &&
          row.artifactPaths?.runDir &&
          row.artifactPaths?.matrixJson &&
          row.artifactPaths?.viewerIndex &&
          row.artifactPaths?.viewerData,
      ),
    `${scenarioRunViewers.filter((row) => row.artifactPaths?.viewerData).length}/${scenarioRunViewers.length} scenario run viewers expose artifact paths`,
  );
  assertCheck(checks, "scenarios.failure-categorized", failures.summary.failedScenarios > 0 && !(failures.categories || []).some((category) => category.key === "other"), `${failures.summary.failedScenarios} failures; categories=${(failures.categories || []).length}`);
  assertCheck(
    checks,
    "scenarios.failure-category-pages",
    failures.summary.categoryPages === (failures.categories || []).length &&
      (failures.categories || []).length >= 10 &&
      (failures.categories || []).every((category) => {
        const href = String(category.pageHref || "");
        return (
          href.startsWith("categories/") &&
          existsSync(path.join(REPO_ROOT, "reports/scenarios/failure-analysis", href))
        );
      }) &&
      (failures.failures || []).filter((failure) => failure.playbackHref).length > 0,
    `${failures.summary.categoryPages || 0}/${(failures.categories || []).length} category pages; ${(failures.failures || []).filter((failure) => failure.playbackHref).length} failures with scenario playback links`,
  );
  assertCheck(
    checks,
    "scenario-agent-review.coverage",
    scenarioAgentReview.summary?.scenarioCount === scenarios.catalogScenarioCount &&
      scenarioAgentReview.summary?.reviewed === scenarios.catalogScenarioCount &&
      scenarioAgentReview.summary?.playbackLinks === scenarios.catalogScenarioCount &&
      scenarioAgentReview.summary?.playbackExisting === scenarios.catalogScenarioCount &&
      scenarioAgentReview.summary?.passed === scenarios.findingSummary?.passed &&
      scenarioAgentReview.summary?.failedOnly === scenarios.findingSummary?.failedOnly &&
      scenarioAgentReview.summary?.nonPassing === scenarios.findingSummary?.nonPassing &&
      scenarioAgentReview.summary?.failureCategoryPages === (failures.categories || []).length &&
      (scenarioAgentReview.rows || []).every(
        (row) =>
          row.verdict &&
          row.recommendedAction &&
          row.playbackHref &&
          row.playbackExists === true &&
          !String(row.playbackHref).startsWith("/") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/scenario-agent-review", row.playbackHref)),
      ),
    `${scenarioAgentReview.summary?.reviewed || 0}/${scenarios.catalogScenarioCount} scenarios reviewed`,
  );
  assertCheck(
    checks,
    "scenario-outcome-matrix.coverage",
    scenarioOutcomeMatrix.summary?.scenarioCount === scenarios.catalogScenarioCount &&
      scenarioOutcomeMatrix.summary?.executionScenarioCount === scenarios.catalogScenarioCount &&
      scenarioOutcomeMatrix.summary?.missingExecution === scenarios.missingCount &&
      scenarioOutcomeMatrix.summary?.playbackLinkedRows === scenarios.catalogScenarioCount &&
      scenarioOutcomeMatrix.summary?.playbackExistingRows === scenarios.catalogScenarioCount &&
      scenarioOutcomeMatrix.summary?.passed === scenarioAgentReview.summary?.passed &&
      scenarioOutcomeMatrix.summary?.failedOnly === scenarioAgentReview.summary?.failedOnly &&
      scenarioOutcomeMatrix.summary?.nonPassing === scenarioAgentReview.summary?.nonPassing &&
      scenarioOutcomeMatrix.summary?.evidenceLimitedRows ===
        scenarioAgentReview.summary?.byVerdict?.["evidence-limited"] &&
      scenarioOutcomeMatrix.summary?.uncategorizedNonPassingRows ===
        scenarioAgentReview.summary?.byVerdict?.["non-passing-no-failure-category"] &&
      scenarioOutcomeMatrix.summary?.rerunCommands ===
        (scenarioAgentReview.summary?.failedOnly || 0) + (scenarioAgentReview.summary?.nonPassing || 0) &&
      scenarioOutcomeMatrix.summary?.categoryLinkedRows === scenarioAgentReview.summary?.categorizedFailures &&
      JSON.stringify(scenarioOutcomeMatrix.summary?.byVerdict || {}) ===
        JSON.stringify(scenarioAgentReview.summary?.byVerdict || {}) &&
      (scenarioOutcomeMatrix.rows || []).length === scenarios.catalogScenarioCount &&
      (scenarioOutcomeMatrix.rows || []).every(
        (row) =>
          row.id &&
          row.scope &&
          row.verdict &&
          row.playbackHref &&
          row.playbackExists === true &&
          !String(row.playbackHref).startsWith("/") &&
          !String(row.playbackHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/scenario-outcome-matrix", row.playbackHref)) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ),
    JSON.stringify(scenarioOutcomeMatrix.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "scenario-remediation-matrix.coverage",
    scenarioRemediationMatrix.summary?.scenarioCount === scenarios.catalogScenarioCount &&
      scenarioRemediationMatrix.summary?.nonPassingRows ===
        (scenarioAgentReview.summary?.failedOnly || 0) + (scenarioAgentReview.summary?.nonPassing || 0) &&
      scenarioRemediationMatrix.summary?.nonPassingRows === 468 &&
      scenarioRemediationMatrix.summary?.failedOnlyRows === scenarioAgentReview.summary?.failedOnly &&
      scenarioRemediationMatrix.summary?.nonPassingWithoutCategory ===
        scenarioAgentReview.summary?.nonPassing &&
      scenarioRemediationMatrix.summary?.playbackLinkedRows ===
        scenarioRemediationMatrix.summary?.nonPassingRows &&
      scenarioRemediationMatrix.summary?.categoryLinkedRows ===
        scenarioAgentReview.summary?.categorizedFailures &&
      scenarioRemediationMatrix.summary?.rerunCommands ===
        scenarioRemediationMatrix.summary?.nonPassingRows &&
      scenarioRemediationMatrix.summary?.failureAttemptsJoined === failures.summary?.failedScenarios &&
      scenarioRemediationMatrix.summary?.executionCoverage?.missingCount === 0 &&
      (scenarioRemediationMatrix.rows || []).every(
        (row) =>
          row.id &&
          row.verdict &&
          row.recommendedAction &&
          row.playbackExists === true &&
          row.rerunCommand &&
          /^SCENARIO_USE_LLM_PROXY=1 bun packages\/scenario-runner\/src\/cli\.ts run packages\/test\/scenarios --scenario /.test(row.rerunCommand) &&
          !String(row.playbackHref).startsWith("/") &&
          !String(row.playbackHref).startsWith("file://") &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (scenarioRemediationMatrix.rows || []).some((row) => row.verdict === "product-or-routing-fix") &&
      (scenarioRemediationMatrix.rows || []).some((row) => row.verdict === "evidence-limited"),
    JSON.stringify(scenarioRemediationMatrix.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "scenario-review-packs.coverage",
    scenarioReviewPacks.summary?.scenarioCount === scenarios.catalogScenarioCount &&
      scenarioReviewPacks.summary?.packPages === scenarios.catalogScenarioCount &&
      scenarioReviewPacks.summary?.playbackLinkedRows === scenarioOutcomeMatrix.summary?.playbackLinkedRows &&
      scenarioReviewPacks.summary?.passed === scenarioOutcomeMatrix.summary?.passed &&
      scenarioReviewPacks.summary?.failedOnly === scenarioOutcomeMatrix.summary?.failedOnly &&
      scenarioReviewPacks.summary?.nonPassing === scenarioOutcomeMatrix.summary?.nonPassing &&
      scenarioReviewPacks.summary?.actionableRows === scenarioOutcomeMatrix.summary?.actionableRows &&
      scenarioReviewPacks.summary?.evidenceLimitedRows === scenarioOutcomeMatrix.summary?.evidenceLimitedRows &&
      scenarioReviewPacks.summary?.categoryLinkedRows === scenarioOutcomeMatrix.summary?.categoryLinkedRows &&
      scenarioReviewPacks.summary?.rerunCommands === scenarioOutcomeMatrix.summary?.rerunCommands &&
      scenarioReviewPacks.summary?.manualReviewNotes === manualReview.summary?.byKind?.scenario &&
      scenarioReviewPacks.summary?.failureDetailRows === failures.summary?.failedScenarios &&
      Object.keys(scenarioOutcomeMatrix.summary?.byScope || {}).every(
        (scope) => scenarioReviewPacks.summary?.byScope?.[scope] === scenarioOutcomeMatrix.summary?.byScope?.[scope],
      ) &&
      Object.keys(scenarioReviewPacks.summary?.byScope || {}).every(
        (scope) => scenarioReviewPacks.summary?.byScope?.[scope] === scenarioOutcomeMatrix.summary?.byScope?.[scope],
      ) &&
      (scenarioReviewPacks.packs || []).every(
        (pack) =>
          pack.href &&
          !String(pack.href).startsWith("/") &&
          !String(pack.href).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/scenario-review-packs", pack.href)) &&
          pack.playbackHref &&
          !String(pack.playbackHref).startsWith("/") &&
          !String(pack.playbackHref).startsWith("file://") &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(pack)),
      ) &&
      (scenarioReviewPacks.packs || []).filter((pack) => pack.manualReview?.noteHref).length ===
        manualReview.summary?.byKind?.scenario &&
      (scenarioReviewPacks.packs || []).some((pack) => pack.disposition === "passed" && !pack.rerunCommand) &&
      (scenarioReviewPacks.packs || []).some((pack) => pack.verdict === "product-or-routing-fix"),
    JSON.stringify(scenarioReviewPacks.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "review-pack-index.coverage",
    reviewPackIndex.summary?.packCount ===
        benchmarkReviewPacks.summary?.packPages +
          corpusReviewPacks.summary?.packPages +
          scenarioReviewPacks.summary?.packPages +
          liveTestReviewPacks.summary?.packPages &&
      reviewPackIndex.summary?.packCount === 782 &&
      reviewPackIndex.summary?.benchmarkPacks === benchmarkReviewPacks.summary?.packPages &&
      reviewPackIndex.summary?.corpusPacks === corpusReviewPacks.summary?.packPages &&
      reviewPackIndex.summary?.scenarioPacks === scenarioReviewPacks.summary?.packPages &&
      reviewPackIndex.summary?.liveTestPacks === liveTestReviewPacks.summary?.packPages &&
      reviewPackIndex.summary?.withPlayback ===
        benchmarkReviewPacks.summary?.packPages +
          corpusReviewPacks.summary?.withCanonicalPlayback +
          scenarioReviewPacks.summary?.playbackLinkedRows +
          liveTestReviewPacks.summary?.playbackLinkedScripts &&
      reviewPackIndex.summary?.withPlayback === 781 &&
      reviewPackIndex.summary?.withManualReviewNote ===
        benchmarkReviewPacks.summary?.withManualReviewNote +
          corpusReviewPacks.summary?.withManualReviewNote +
          scenarioReviewPacks.summary?.manualReviewNotes +
          liveTestReviewPacks.summary?.manualReviewNotes &&
      reviewPackIndex.summary?.withManualReviewNote === 520 &&
      reviewPackIndex.summary?.withRerunCommand ===
        benchmarkReviewPacks.summary?.packPages +
          corpusReviewPacks.summary?.rerunCommands +
          scenarioReviewPacks.summary?.rerunCommands +
          liveTestReviewPacks.summary?.rowsWithRerunCommand &&
      reviewPackIndex.summary?.withRerunCommand === 543 &&
      reviewPackIndex.summary?.humanReviewed === manualReview.summary?.reviewed &&
      reviewPackIndex.summary?.agentTriaged === manualReview.summary?.agentReviewed &&
      (reviewPackIndex.rows || []).length === reviewPackIndex.summary?.packCount &&
      (reviewPackIndex.rows || []).every(
        (row) =>
          row.packHref &&
          !String(row.packHref).startsWith("/") &&
          !String(row.packHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/review-pack-index", row.packHref)) &&
          (!row.playbackHref ||
            (!String(row.playbackHref).startsWith("/") &&
              !String(row.playbackHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/review-pack-index", row.playbackHref)))) &&
          (!row.gapHref ||
            (!String(row.gapHref).startsWith("/") &&
              !String(row.gapHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/review-pack-index", row.gapHref)))) &&
          (!row.manualNoteHref ||
            (!String(row.manualNoteHref).startsWith("/") &&
              !String(row.manualNoteHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/review-pack-index", row.manualNoteHref)))) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (reviewPackIndex.rows || []).some(
        (row) => row.surface === "corpus" && row.id === "hyperliquid_bench" && !row.playbackHref && row.gapHref,
      ) &&
      (reviewPackIndex.rows || []).some(
        (row) => row.surface === "benchmark" && row.id === "osworld" && row.reviewClass === "blocked-or-caveated",
      ),
    JSON.stringify(reviewPackIndex.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "review-pack-agent-verdicts.coverage",
    reviewPackAgentVerdicts.summary?.rowCount === reviewPackIndex.summary?.packCount &&
      reviewPackAgentVerdicts.summary?.reviewedRows === reviewPackIndex.summary?.packCount &&
      reviewPackAgentVerdicts.summary?.withPack === reviewPackIndex.summary?.packCount &&
      reviewPackAgentVerdicts.summary?.withPlayback === reviewPackIndex.summary?.withPlayback &&
      reviewPackAgentVerdicts.summary?.withManualNote === reviewPackIndex.summary?.withManualReviewNote &&
      reviewPackAgentVerdicts.summary?.withRerunCommand === reviewPackIndex.summary?.withRerunCommand &&
      reviewPackAgentVerdicts.summary?.acceptRows === 242 &&
      reviewPackAgentVerdicts.summary?.acceptCaveatRows === 16 &&
      reviewPackAgentVerdicts.summary?.inspectRows === 43 &&
      reviewPackAgentVerdicts.summary?.fixRows === 194 &&
      reviewPackAgentVerdicts.summary?.rerunRows === 285 &&
      reviewPackAgentVerdicts.summary?.blockedRows === 2 &&
      Object.keys(reviewPackIndex.summary?.surfaceCounts || {}).every(
        (surface) =>
          reviewPackAgentVerdicts.summary?.bySurface?.[surface] ===
          reviewPackIndex.summary?.surfaceCounts?.[surface],
      ) &&
      Object.keys(reviewPackAgentVerdicts.summary?.bySurface || {}).every(
        (surface) =>
          reviewPackAgentVerdicts.summary?.bySurface?.[surface] ===
          reviewPackIndex.summary?.surfaceCounts?.[surface],
      ) &&
      (reviewPackAgentVerdicts.rows || []).length === reviewPackIndex.summary?.packCount &&
      (reviewPackAgentVerdicts.rows || []).every(
        (row) =>
          row.verdict &&
          row.decision &&
          row.confidence &&
          row.reason &&
          row.action &&
          row.packHref &&
          !String(row.packHref).startsWith("/") &&
          !String(row.packHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/review-pack-agent-verdicts", row.packHref)) &&
          (!row.playbackHref ||
            (!String(row.playbackHref).startsWith("/") &&
              !String(row.playbackHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/review-pack-agent-verdicts", row.playbackHref)))) &&
          (!row.gapHref ||
            (!String(row.gapHref).startsWith("/") &&
              !String(row.gapHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/review-pack-agent-verdicts", row.gapHref)))) &&
          (!row.manualNoteHref ||
            (!String(row.manualNoteHref).startsWith("/") &&
              !String(row.manualNoteHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/review-pack-agent-verdicts", row.manualNoteHref)))) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (reviewPackAgentVerdicts.rows || []).some(
        (row) => row.id === "osworld" && row.verdict === "blocked-external-runtime",
      ) &&
      (reviewPackAgentVerdicts.rows || []).some(
        (row) => row.id === "hyperliquid_bench" && row.verdict === "blocked-external-credential",
      ),
    JSON.stringify(reviewPackAgentVerdicts.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "rerun-command-catalog.coverage",
    rerunCommandCatalog.summary?.commandCount === reviewPackIndex.summary?.withRerunCommand &&
      rerunCommandCatalog.summary?.commandCount === 543 &&
      rerunCommandCatalog.summary?.runnableNow === 541 &&
      rerunCommandCatalog.summary?.blocked === 2 &&
      rerunCommandCatalog.summary?.withPack === rerunCommandCatalog.summary?.commandCount &&
      rerunCommandCatalog.summary?.withPlayback === 542 &&
      rerunCommandCatalog.summary?.withManualNote === reviewPackIndex.summary?.withManualReviewNote &&
      rerunCommandCatalog.summary?.withGapPage === 1 &&
      rerunCommandCatalog.summary?.bySurface?.benchmark === 16 &&
      rerunCommandCatalog.summary?.bySurface?.corpus === 32 &&
      rerunCommandCatalog.summary?.bySurface?.scenario === 468 &&
      rerunCommandCatalog.summary?.bySurface?.["live/e2e"] === 27 &&
      rerunCommandCatalog.summary?.byBlocker?.["missing-OSWorld-provider"] === 1 &&
      rerunCommandCatalog.summary?.byBlocker?.["missing-HL_PRIVATE_KEY"] === 1 &&
      rerunCommandCatalog.summary?.byBlocker?.none === 541 &&
      (rerunCommandCatalog.rows || []).length === rerunCommandCatalog.summary?.commandCount &&
      (rerunCommandCatalog.rows || []).every(
        (row) =>
          row.command &&
          row.followUp &&
          row.packHref &&
          !String(row.packHref).startsWith("/") &&
          !String(row.packHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/rerun-command-catalog", row.packHref)) &&
          (!row.playbackHref ||
            (!String(row.playbackHref).startsWith("/") &&
              !String(row.playbackHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/rerun-command-catalog", row.playbackHref)))) &&
          (!row.gapHref ||
            (!String(row.gapHref).startsWith("/") &&
              !String(row.gapHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/rerun-command-catalog", row.gapHref)))) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (rerunCommandCatalog.rows || []).some(
        (row) => row.id === "osworld" && row.runnableNow === false && row.blocker === "missing-OSWorld-provider",
      ) &&
      (rerunCommandCatalog.rows || []).some(
        (row) => row.id === "hyperliquid_bench" && row.runnableNow === false && row.blocker === "missing-HL_PRIVATE_KEY",
      ),
    JSON.stringify(rerunCommandCatalog.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "rerun-batches.coverage",
    rerunBatches.summary?.batchCount === 5 &&
      rerunBatches.summary?.runnableCommands === rerunCommandCatalog.summary?.runnableNow &&
      rerunBatches.summary?.blockedCommands === rerunCommandCatalog.summary?.blocked &&
      rerunBatches.summary?.allRunnableCommands === 541 &&
      rerunBatches.summary?.benchmarkCommands === 15 &&
      rerunBatches.summary?.corpusCommands === 31 &&
      rerunBatches.summary?.scenarioCommands === 468 &&
      rerunBatches.summary?.liveE2eCommands === 27 &&
      (rerunBatches.batches || []).length === 5 &&
      (rerunBatches.batches || []).every((batch) => {
        const scriptPath = path.join(REPO_ROOT, "reports/benchmark-analysis/rerun-batches", batch.href || "");
        const text = existsSync(scriptPath) ? readFileSync(scriptPath, "utf8") : "";
        return batch.href &&
          !String(batch.href).startsWith("/") &&
          !String(batch.href).startsWith("file://") &&
          existsSync(scriptPath) &&
          (statSync(scriptPath).mode & 0o111) !== 0 &&
          /^#!\/usr\/bin\/env bash/.test(text) &&
          /bun run bench:analysis:build/.test(text) &&
          /bun run bench:analysis:verify/.test(text) &&
          !/csk-[A-Za-z0-9_-]+/.test(text);
      }) &&
      (rerunBatches.blockedRows || []).length === rerunCommandCatalog.summary?.blocked &&
      (rerunBatches.blockedRows || []).some((row) => row.id === "osworld" && row.blocker === "missing-OSWorld-provider") &&
      (rerunBatches.blockedRows || []).some((row) => row.id === "hyperliquid_bench" && row.blocker === "missing-HL_PRIVATE_KEY"),
    JSON.stringify(rerunBatches.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "goal-audit.expected-state",
    audit.summary.total === 15 &&
      audit.summary.proven === 12 &&
      audit.summary.caveated === 2 &&
      audit.summary.blocked === 1 &&
      audit.summary.missing === 0 &&
      (audit.rows || []).some(
        (row) => row.id === "playback-surfaces" && row.status === "proven",
      ) &&
      (audit.rows || []).some(
        (row) => row.id === "agent-review-every-benchmark" && row.status === "proven",
      ) &&
      (audit.rows || []).some(
        (row) => row.id === "agent-review-real-llm-tests" && row.status === "proven",
      ) &&
      (audit.rows || []).some(
        (row) => row.id === "agent-review-all-scenarios" && row.status === "proven",
      ) &&
      (audit.rows || []).some(
        (row) => row.id === "durable-manual-review-workspace" && row.status === "proven",
      ) &&
      (audit.rows || []).some(
        (row) => row.id === "corpus-publication-gaps" && row.status === "caveated",
      ) &&
      (audit.rows || []).some((row) => row.id === "osworld-live" && row.status === "blocked"),
    JSON.stringify(audit.summary),
    "known-caveat",
  );
  assertCheck(
    checks,
    "objective-evidence-map.coverage",
    objectiveEvidenceMap.summary?.total === 13 &&
      objectiveEvidenceMap.summary?.proven === 7 &&
      objectiveEvidenceMap.summary?.caveated === 5 &&
      objectiveEvidenceMap.summary?.blocked === 1 &&
      objectiveEvidenceMap.summary?.missing === 0 &&
      objectiveEvidenceMap.summary?.closureReady === false &&
      (objectiveEvidenceMap.rows || []).some(
        (row) => row.id === "review-every-benchmark" && row.status === "proven",
      ) &&
      (objectiveEvidenceMap.rows || []).some(
        (row) => row.id === "five-examples" && row.status === "caveated",
      ) &&
      (objectiveEvidenceMap.rows || []).some(
        (row) => row.id === "trajectory-playback-input-output-cache" && row.status === "caveated",
      ) &&
      (objectiveEvidenceMap.rows || []).some(
        (row) => row.id === "version-comparison" && row.status === "caveated",
      ) &&
      (objectiveEvidenceMap.rows || []).some(
        (row) =>
          row.id === "real-llm-e2e-tests" &&
          row.status === "caveated" &&
          /27\/27 rows have offline review summaries/.test(row.evidence || "") &&
          /26\/26 no-sidecar rows have offline evidence guidance/.test(row.evidence || ""),
      ) &&
      (objectiveEvidenceMap.rows || []).some(
        (row) =>
          row.id === "broader-corpus" &&
          row.status === "caveated" &&
          /2,230 full-corpus normalized calls/.test(row.evidence || "") &&
          /1,560 in the focused remediation subset/.test(row.evidence || "") &&
          /74\/74 publication-warning rows have playback/.test(row.evidence || "") &&
          /74\/74 have call previews/.test(row.evidence || ""),
      ) &&
      (objectiveEvidenceMap.rows || []).some(
        (row) => row.id === "manual-review-workspace" && row.status === "proven",
      ) &&
      (objectiveEvidenceMap.rows || []).some(
        (row) =>
          row.id === "external-gates" &&
          row.status === "blocked" &&
          /OSWorld/.test(row.evidence || "") &&
          /HL_PRIVATE_KEY present=no/.test(row.evidence || ""),
      ) &&
      (objectiveEvidenceMap.rows || []).some(
        (row) => row.id === "secret-handling" && row.status === "proven",
      ) &&
      (objectiveEvidenceMap.rows || []).every(
        (row) =>
          row.link &&
          !String(row.link).startsWith("/") &&
          !String(row.link).startsWith("file://") &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ),
    JSON.stringify(objectiveEvidenceMap.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "review-readiness-ledger.coverage",
    reviewReadinessLedger.summary?.surfaceCount === 8 &&
      reviewReadinessLedger.summary?.ready === 3 &&
      reviewReadinessLedger.summary?.caveated === 4 &&
      reviewReadinessLedger.summary?.blocked === 1 &&
      reviewReadinessLedger.summary?.affordanceCount === 39 &&
      reviewReadinessLedger.summary?.readyAffordances === 28 &&
      reviewReadinessLedger.summary?.caveatedAffordances === 9 &&
      reviewReadinessLedger.summary?.blockedAffordances === 2 &&
      reviewReadinessLedger.summary?.reviewTargets === 2419 &&
      (reviewReadinessLedger.rows || []).some(
        (row) =>
          row.id === "code-agent-benchmarks" &&
          row.status === "caveated" &&
          (row.affordances || []).some((item) => item.label === "five examples" && item.status === "ready") &&
          (row.affordances || []).some((item) => item.label === "model input/output" && item.status === "caveated") &&
          (row.affordances || []).some((item) => item.label === "tokens/cache" && item.status === "ready"),
      ) &&
      (reviewReadinessLedger.rows || []).some(
        (row) =>
          row.id === "scenarios" &&
          row.status === "ready" &&
          row.reviewTargetCount === scenarioOutcomeMatrix.summary?.scenarioCount,
      ) &&
      (reviewReadinessLedger.rows || []).some(
        (row) =>
          row.id === "live-e2e-tests" &&
          row.status === "caveated" &&
          (row.affordances || []).some(
            (item) =>
              item.label === "prompt/response" &&
              item.status === "caveated" &&
              /27\/27 rows have offline review summaries/.test(item.evidence || "") &&
              /26\/26 no-sidecar rows have offline evidence guidance/.test(item.evidence || ""),
          ) &&
          (row.caveats || []).some((item) => /offline review summaries/.test(item)),
      ) &&
      (reviewReadinessLedger.rows || []).some(
        (row) =>
          row.id === "benchmark-corpus" &&
          row.status === "caveated" &&
          (row.affordances || []).some(
            (item) =>
              item.label === "tokens/cache" &&
              /1,560 normalized calls/.test(item.evidence || "") &&
              /full corpus has 2,230 normalized calls/.test(item.evidence || ""),
          ),
      ) &&
      (reviewReadinessLedger.rows || []).some(
        (row) =>
          row.id === "benchmark-corpus" &&
          row.status === "caveated" &&
          (row.affordances || []).some(
            (item) =>
              item.label === "publication warnings" &&
              /74\/74 warning rows have canonical playback/.test(item.evidence || "") &&
              /74\/74 have call previews/.test(item.evidence || ""),
          ) &&
          (row.caveats || []).some((item) => /locally reviewable/.test(item)),
      ) &&
      (reviewReadinessLedger.rows || []).some(
        (row) =>
          row.id === "version-comparison" &&
          row.status === "caveated" &&
          (row.affordances || []).some(
            (item) =>
              item.label === "previous rows" &&
              /6 true no-previous-run rows/.test(item.evidence || "") &&
              /1 no-earlier-previous-row/.test(item.evidence || ""),
          ) &&
          (row.affordances || []).some(
            (item) =>
              item.label === "playback pairs" &&
              /mind2web, nl2repo/.test(item.evidence || "") &&
              /zero target\/baseline trajectory files/.test(item.evidence || ""),
          ) &&
          (row.caveats || []).some((item) => /zero previous target\/baseline trajectory files/.test(item)) &&
          (row.caveats || []).some((item) => /six benchmarks have no previous run history/.test(item)),
      ) &&
      (reviewReadinessLedger.rows || []).some(
        (row) =>
          row.id === "manual-review" &&
          row.status === "ready" &&
          (row.affordances || []).some((item) => item.label === "human verdicts" && item.status === "ready"),
      ) &&
      (reviewReadinessLedger.rows || []).some(
        (row) =>
          row.id === "external-gates" &&
          row.status === "blocked" &&
          (row.affordances || []).some((item) => item.label === "OSWorld provider" && item.status === "blocked") &&
          (row.affordances || []).some((item) => item.label === "Hyperliquid credential" && item.status === "blocked"),
      ) &&
      (reviewReadinessLedger.rows || []).every(
        (row) =>
          row.primaryViewer &&
          !String(row.primaryViewer).startsWith("/") &&
          !String(row.primaryViewer).startsWith("file://") &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ),
    JSON.stringify(reviewReadinessLedger.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "objective-closure.coverage",
    objectiveClosure.summary?.total === 12 &&
      objectiveClosure.summary?.proven === 7 &&
      objectiveClosure.summary?.caveated === 5 &&
      objectiveClosure.summary?.missing === 0 &&
      objectiveClosure.summary?.closureReady === false &&
      (objectiveClosure.requirements || []).some(
        (row) => row.id === "global-playback-viewer" && row.status === "proven",
      ) &&
      (objectiveClosure.requirements || []).some(
        (row) => row.id === "all-scenarios-included" && row.status === "proven",
      ) &&
      (objectiveClosure.requirements || []).some(
        (row) =>
          row.id === "real-llm-e2e-tests" &&
          row.status === "caveated" &&
          /1\/27 complete script sidecars/.test(row.evidence || "") &&
          /27\/27 offline review summaries/.test(row.evidence || ""),
      ) &&
      (objectiveClosure.requirements || []).some(
        (row) =>
          row.id === "five-examples-per-benchmark" &&
          row.status === "caveated" &&
          /80\/80 sampled examples/.test(row.evidence || "") &&
          /75\/80 carry explicit task IDs/.test(row.evidence || "") &&
          /52 full inline I\/O\/cache rows/.test(row.evidence || ""),
      ) &&
      (objectiveClosure.requirements || []).some(
        (row) =>
          row.id === "version-comparison" &&
          row.status === "caveated" &&
          /mind2web, nl2repo/.test(row.evidence || "") &&
          /explicit version-gap review rows/.test(row.evidence || ""),
      ) &&
      (objectiveClosure.requirements || []).some(
        (row) =>
          row.id === "broader-corpus-review" &&
          row.status === "caveated" &&
          /69 insufficient-\* publication-warning rows/.test(row.evidence || "") &&
          /9 replayable token\/turn-zero latest rows/.test(row.evidence || "") &&
          /hyperliquid_bench pending HL_PRIVATE_KEY/.test(row.evidence || "") &&
          /74\/74 publication-warning rows have playback/.test(row.evidence || "") &&
          /74\/74 have call previews/.test(row.evidence || ""),
      ) &&
      (objectiveClosure.requirements || []).some(
        (row) =>
          row.id === "external-gates" &&
          row.status === "caveated" &&
          /Docker daemon is unreachable/.test(row.evidence || "") &&
          /--benchmarks osworld/.test(row.evidence || "") &&
          /--benchmarks hyperliquid_bench/.test(row.evidence || "") &&
          /HL_PRIVATE_KEY=<set-in-shell>/.test(row.evidence || ""),
      ),
    JSON.stringify(objectiveClosure.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "final-goal-readiness.coverage",
    finalGoalReadiness.summary?.closureReady === false &&
      finalGoalReadiness.summary?.gateCount === 8 &&
      finalGoalReadiness.summary?.proven === 3 &&
      finalGoalReadiness.summary?.caveated === 3 &&
      finalGoalReadiness.summary?.blocked === 2 &&
      finalGoalReadiness.summary?.missing === 0 &&
      finalGoalReadiness.summary?.openGates === 5 &&
      finalGoalReadiness.summary?.runContractOk === true &&
      finalGoalReadiness.summary?.objectiveClosure === "7/12 proven, 5 caveated, 0 missing" &&
      finalGoalReadiness.summary?.remediationLocalActions === "20/20" &&
      finalGoalReadiness.summary?.remediationCredentialRequiredActions === 1 &&
      finalGoalReadiness.summary?.objectiveLocalActionItems === 4 &&
      finalGoalReadiness.summary?.liveLocalActionItems === 11 &&
      finalGoalReadiness.summary?.reviewAffordances === "28/39 ready" &&
      /not-complete/.test(finalGoalReadiness.finalDecision || "") &&
      (finalGoalReadiness.gates || []).some(
        (gate) => gate.id === "manual-review-verdicts" && gate.status === "proven",
      ) &&
      (finalGoalReadiness.gates || []).some(
        (gate) =>
          gate.id === "external-osworld" &&
          gate.status === "blocked-external" &&
          gate.blockerKind === "external-runtime-provider" &&
          (gate.blockerDetails || []).some(
            (detail) => detail.provider === "docker" && /Docker daemon/.test(detail.detail || ""),
          ) &&
          (gate.blockerDetails || []).some(
            (detail) => detail.provider === "aws" && /AWS_ACCESS_KEY_ID/.test(detail.detail || ""),
          ),
      ) &&
      (finalGoalReadiness.gates || []).some(
        (gate) =>
          gate.id === "external-hyperliquid" &&
          gate.status === "blocked-external" &&
          gate.blockerKind === "external-credential" &&
          gate.credentialPresence?.hyperliquidPrivateKeyPresent === false &&
          (gate.nextActions || []).some((action) => /HL_PRIVATE_KEY/.test(action)),
      ) &&
      (finalGoalReadiness.gates || []).some(
        (gate) =>
          gate.id === "rerunability" &&
          gate.status === "caveated" &&
          gate.commandBreakdown?.scenarioCommands === 468 &&
          (gate.blockedBy || []).includes("external-osworld") &&
          (gate.blockedBy || []).includes("external-hyperliquid"),
      ) &&
      (finalGoalReadiness.gates || []).some(
        (gate) =>
          gate.id === "objective-evidence" &&
          gate.status === "caveated" &&
          gate.closureSummary?.proven === 7 &&
          gate.closureSummary?.caveated === 5 &&
          (gate.caveatDetails || []).some(
            (detail) => detail.id === "broader-corpus-review" && /74\/74 publication-warning rows/.test(detail.evidence || ""),
          ) &&
          gate.localActionLanes?.["real-llm-e2e-tests"]?.actionLane === "resolve-live-sidecar-breadth" &&
          gate.localActionLanes?.["version-comparison"]?.actionLane === "restore-previous-trajectory-history",
      ) &&
      (finalGoalReadiness.gates || []).some(
        (gate) =>
          gate.id === "review-readiness" &&
          gate.status === "caveated" &&
          gate.affordanceSummary?.ready === 28 &&
          gate.affordanceSummary?.blocked === 2 &&
          (gate.blockedSurfaces || []).some((surface) => surface.id === "external-gates"),
      ) &&
      (finalGoalReadiness.gates || []).every(
        (gate) =>
          gate.href &&
          !String(gate.href).startsWith("/") &&
          !String(gate.href).startsWith("file://") &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(gate)),
      ),
    JSON.stringify(finalGoalReadiness.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "review-queue.complete",
    reviewQueue.summary?.itemCount === (reviewQueue.items || []).length &&
      reviewQueue.summary?.itemCount >= 533 &&
      reviewQueue.summary?.scenarioItems >= 468 &&
      reviewQueue.summary?.benchmarkItems >= 41 &&
      reviewQueue.summary?.liveTestItems >=
        (liveTestAgentReview.summary?.byVerdict?.["model-wrapper-fix"] || 0) +
          (liveTestAgentReview.summary?.byVerdict?.["model-wrapper-timeout"] || 0) &&
      reviewQueue.summary?.highPriority >= 15,
    JSON.stringify(reviewQueue.summary || {}),
  );
  assertCheck(
    checks,
    "review-queue.links-relative",
    (reviewQueue.items || []).every((item) => !String(item.viewer || "").startsWith("/") && !String(item.viewer || "").startsWith("file://")) &&
      (reviewQueue.items || []).some((item) => item.kind === "code-agent-benchmark" && String(item.viewer || "").startsWith("../../benchmarks/code-agent-trajectory-catalog/playback/") && String(item.viewer || "").endsWith(".playback.html")) &&
      (reviewQueue.items || []).some((item) => item.kind === "benchmark-family" && String(item.viewer || "").startsWith("../../benchmarks/benchmark-results-corpus-review/canonical-trajectories/") && String(item.viewer || "").endsWith(".playback.html")) &&
      (reviewQueue.items || []).some((item) => item.kind === "benchmark-family" && String(item.viewer || "").startsWith("../../benchmarks/benchmark-results-corpus-review/gap-pages/") && String(item.viewer || "").endsWith(".html")) &&
      (reviewQueue.items || []).some((item) => item.kind === "scenario" && String(item.viewer || "").startsWith("../../scenarios/catalog-execution-union/playback/")) &&
      (reviewQueue.items || []).some((item) => item.kind === "scenario-failure-category" && String(item.viewer || "").startsWith("../../scenarios/failure-analysis/categories/")) &&
      (reviewQueue.items || []).some((item) => item.kind === "live-test" && String(item.viewer || "").startsWith("../../live-test-runs/") && String(item.viewer || "").endsWith("/playback.html")) &&
      !(reviewQueue.items || []).some((item) => item.kind === "live-test" && item.disposition === "model-artifact-hint") &&
      (reviewQueue.items || []).some((item) => item.kind === "goal" && item.id === "osworld-live" && String(item.viewer || "").endsWith("gap-evidence/osworld-live-readiness.html")) &&
      (reviewQueue.items || []).some((item) => item.kind === "goal" && item.id === "corpus-publication-gaps" && String(item.viewer || "").startsWith("../corpus-remediation-matrix/")),
    "queue viewer links are relative to reports/benchmark-analysis/review-queue and prefer playback pages",
  );
  const reviewQueueRoot = path.join(REPO_ROOT, "reports/benchmark-analysis/review-queue");
  const reviewQueueMissingTargets = (reviewQueue.items || []).filter((item) => {
    const viewer = String(item.viewer || "");
    if (!viewer || viewer.startsWith("/") || viewer.startsWith("file://")) {
      return true;
    }
    const resolved = path.resolve(reviewQueueRoot, viewer);
    const repoRelative = path.relative(REPO_ROOT, resolved).replaceAll(path.sep, "/");
    return !repoRelative.startsWith("reports/") || !existsSync(resolved);
  });
  assertCheck(
    checks,
    "review-queue.targets-exist",
    reviewQueueMissingTargets.length === 0,
    `${reviewQueueMissingTargets.length} missing targets across ${(reviewQueue.items || []).length} review queue items`,
  );
  assertCheck(
    checks,
    "manual-review-workspace.coverage",
    manualReview.summary?.itemCount === reviewQueue.summary?.itemCount &&
      manualReview.summary?.noteCount === reviewQueue.summary?.itemCount &&
      manualReview.summary?.highPriority === reviewQueue.summary?.highPriority &&
      manualReview.summary?.agentReviewed === reviewQueue.summary?.itemCount &&
      manualReview.summary?.highPriorityAgentReviewed === reviewQueue.summary?.highPriority &&
      (manualReview.items || []).length === reviewQueue.summary?.itemCount &&
      (manualReview.items || []).every((item) => {
        const noteHref = String(item.noteHref || "");
        if (!noteHref.startsWith("items/") || noteHref.startsWith("/") || noteHref.startsWith("file://")) {
          return false;
        }
        const notePath = path.join(REPO_ROOT, "reports/benchmark-analysis/manual-review", noteHref);
        const text = existsSync(notePath) ? readFileSync(notePath, "utf8") : "";
        return existsSync(notePath) &&
          /^verdict:\s*\S+/m.test(text) &&
          /Manual notes:/.test(text) &&
          /Agent triage:/.test(text) &&
          /Agent verdict:/.test(text) &&
          /Recommended action:/.test(text) &&
          /Agent evidence:/.test(text) &&
          Boolean(item.agentVerdict) &&
          Boolean(item.recommendedAction) &&
          Boolean(item.agentEvidence);
      }),
    `${manualReview.summary?.noteCount || 0}/${reviewQueue.summary?.itemCount || 0} manual review notes; agent triage=${manualReview.summary?.agentReviewed || 0}`,
  );
  assertCheck(
    checks,
    "manual-review-progress.coverage",
    manualReviewProgress.summary?.itemCount === manualReview.summary?.itemCount &&
      manualReviewProgress.summary?.noteCount === manualReview.summary?.noteCount &&
      manualReviewProgress.summary?.reviewed === manualReview.summary?.reviewed &&
      manualReviewProgress.summary?.unreviewed === manualReview.summary?.unreviewed &&
      manualReviewProgress.summary?.highPriority === manualReview.summary?.highPriority &&
      manualReviewProgress.summary?.highPriorityUnreviewed === manualReview.summary?.highPriorityUnreviewed &&
      manualReviewProgress.summary?.withPack === reviewPackIndex.summary?.withManualReviewNote &&
      manualReviewProgress.summary?.withPack === 520 &&
      manualReviewProgress.summary?.withPlayback === reviewPackIndex.summary?.withManualReviewNote - 1 &&
      manualReviewProgress.summary?.withGapPage === 1 &&
      manualReviewProgress.summary?.withRerunCommand === reviewPackIndex.summary?.withManualReviewNote &&
      JSON.stringify(manualReviewProgress.summary?.byKind || {}) ===
        JSON.stringify(manualReview.summary?.byKind || {}) &&
      (manualReviewProgress.rows || []).length === manualReview.summary?.itemCount &&
      (manualReviewProgress.rows || []).every(
        (row) =>
          row.noteHref &&
          !String(row.noteHref).startsWith("/") &&
          !String(row.noteHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/manual-review-progress", row.noteHref)) &&
          row.viewerHref &&
          !String(row.viewerHref).startsWith("/") &&
          !String(row.viewerHref).startsWith("file://") &&
          existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/manual-review-progress", row.viewerHref)) &&
          (!row.packHref ||
            (!String(row.packHref).startsWith("/") &&
              !String(row.packHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/manual-review-progress", row.packHref)))) &&
          (!row.playbackHref ||
            (!String(row.playbackHref).startsWith("/") &&
              !String(row.playbackHref).startsWith("file://") &&
              existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/manual-review-progress", row.playbackHref)))) &&
          !/csk-[A-Za-z0-9_-]+/.test(JSON.stringify(row)),
      ) &&
      (manualReviewProgress.nextUnreviewed || []).length === 0,
    JSON.stringify(manualReviewProgress.summary || {}),
    "known-caveat",
  );
  const highPriorityQueueItems = (reviewQueue.items || []).filter((item) => Number(item.priority) >= 80);
  assertCheck(
    checks,
    "agent-review-digest.coverage",
    agentReview.summary?.highPriorityCount === highPriorityQueueItems.length &&
      agentReview.summary?.targetLinksExisting === highPriorityQueueItems.length &&
      agentReview.summary?.manualNotesLinked === highPriorityQueueItems.length &&
      agentReview.summary?.liveFailuresReviewed ===
        highPriorityQueueItems.filter((item) => item.kind === "live-test").length &&
      agentReview.summary?.externalBlockers === 2 &&
      agentReview.summary?.caveatsReviewed === 2 &&
      (agentReview.items || []).every(
        (item) =>
          item.agentVerdict &&
          item.recommendedAction &&
          item.agentEvidence &&
          item.targetExists === true &&
          String(item.targetHref || "") &&
          !String(item.targetHref || "").startsWith("/") &&
          !String(item.targetHref || "").startsWith("file://") &&
          String(item.manualNoteHref || "").startsWith("../manual-review/items/"),
      ),
    `${agentReview.summary?.highPriorityCount || 0}/${highPriorityQueueItems.length} high-priority items triaged; live=${agentReview.summary?.liveFailuresReviewed || 0}`,
  );
  assertCheck(
    checks,
    "remediation-matrix.coverage",
    remediationMatrix.summary?.itemCount === (remediationMatrix.rows || []).length &&
      remediationMatrix.summary?.itemCount >= 19 &&
      remediationMatrix.summary?.localActionItems === remediationMatrix.summary?.itemCount &&
      remediationMatrix.summary?.localCredentialRequiredItems === 1 &&
      remediationMatrix.summary?.localActionByLane?.["provide-external-credential"] === 1 &&
      remediationMatrix.summary?.localActionByLane?.["provision-external-runtime"] === 1 &&
      remediationMatrix.summary?.localActionByLane?.["replace-smoke-with-live-run"] === 1 &&
      remediationMatrix.summary?.localActionByLane?.["review-corpus-publication-warnings"] === 1 &&
      remediationMatrix.summary?.localActionByLane?.["restore-version-trajectory-history"] === 1 &&
      remediationMatrix.summary?.externalBlockers === 2 &&
      remediationMatrix.summary?.liveTestItems === 11 &&
      remediationMatrix.summary?.objectiveCaveats === 4 &&
      remediationMatrix.summary?.objectiveLocalActionItems === remediationMatrix.summary?.objectiveCaveats &&
      JSON.stringify(remediationMatrix.summary?.objectiveLocalActionByLane || {}) ===
        JSON.stringify({
          "review-corpus-warning-families": 1,
          "osworld-live-provider-needed": 1,
          "resolve-live-sidecar-breadth": 1,
          "restore-previous-trajectory-history": 1,
        }) &&
      remediationMatrix.summary?.liveLocalActionItems === remediationMatrix.summary?.liveTestItems &&
      JSON.stringify(remediationMatrix.summary?.liveLocalActionByClassification || {}) ===
        JSON.stringify({
          "bad-command-or-missing-args": 2,
          "missing-android-emulator": 2,
          timeout: 2,
          "missing-test-preload": 1,
          "missing-model-provider": 2,
          "missing-database-url": 1,
          "test-assertion-failure": 1,
        }) &&
      remediationMatrix.summary?.runnableCommands >= 13 &&
      (remediationMatrix.rows || []).some(
        (row) =>
          row.id === "osworld-live" &&
          row.blockerType === "external-runtime" &&
          row.actionLane === "provision-external-runtime" &&
          row.credentialRequired === false &&
          /--benchmarks osworld/.test(row.command || "") &&
          row.followedBy === "bun run bench:analysis:build",
      ) &&
      (remediationMatrix.rows || []).some(
        (row) =>
          row.id === "hyperliquid_bench" &&
          row.blockerType === "external-credential" &&
          row.actionLane === "provide-external-credential" &&
          row.credentialRequired === true &&
          /HL_PRIVATE_KEY=<set-in-shell>/.test(row.command || "") &&
          !/csk-[A-Za-z0-9_-]+/.test(row.command || ""),
      ) &&
      (remediationMatrix.rows || []).some(
        (row) =>
          row.id === "osworld" &&
          row.source === "benchmark-closure-matrix" &&
          row.status === "caveated" &&
          row.actionLane === "replace-smoke-with-live-run",
      ) &&
      (remediationMatrix.rows || [])
        .filter((row) => row.surface === "objective")
        .every(
          (row) =>
            row.localAction &&
            row.actionLane &&
            row.credentialRequired === false &&
            row.nextAction === row.localAction &&
            !/Use the linked report to clear/.test(row.nextAction || ""),
        ) &&
      (remediationMatrix.rows || []).some(
        (row) =>
          row.id === "corpus-publication-gaps" &&
          /69 insufficient-warning latest rows/.test(row.evidence || "") &&
          row.actionLane === "review-corpus-publication-warnings",
      ) &&
      (remediationMatrix.rows || []).some(
        (row) =>
          row.id === "version-comparison-gaps" &&
          row.actionLane === "restore-version-trajectory-history" &&
          row.credentialRequired === false,
      ) &&
      (remediationMatrix.rows || []).filter((row) => row.surface === "live-e2e-test").length ===
        agentReview.summary?.liveFailuresReviewed &&
      (remediationMatrix.rows || [])
        .filter((row) => row.surface === "live-e2e-test")
        .every(
          (row) =>
            row.command &&
            /^node packages\/scripts\/run-live-test-with-artifacts\.mjs/.test(row.command) &&
            row.targetHref &&
            row.failureClassification &&
            row.localAction &&
            row.actionLane &&
            row.credentialRequired === false &&
            row.failureTriageHref === "../live-test-failure-triage/index.html" &&
            row.modelEvidenceHref === "../live-test-model-evidence/index.html" &&
            !String(row.targetHref).startsWith("/") &&
            !String(row.targetHref).startsWith("file://"),
        ),
    JSON.stringify(remediationMatrix.summary || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "runbook.coverage",
    (runbook.commands || []).some((row) => row.command === "bun run bench:analysis:build") &&
      (runbook.commands || []).some((row) => row.command === "bun run bench:analysis:verify") &&
      (runbook.commands || []).some((row) => row.id === "secret-scan") &&
      (runbook.entryPoints || []).some((row) => row.label === "Run contract") &&
      (runbook.entryPoints || []).some((row) => row.label === "Global playback index") &&
      (runbook.entryPoints || []).some((row) => row.label === "Cache analysis") &&
      (runbook.entryPoints || []).some((row) => row.label === "Trajectory I/O completeness") &&
      (runbook.entryPoints || []).some((row) => row.label === "Five-example sampler") &&
      (runbook.entryPoints || []).some((row) => row.label === "Benchmark sample review matrix") &&
      (runbook.entryPoints || []).some((row) => row.label === "Benchmark review packs") &&
      (runbook.entryPoints || []).some((row) => row.label === "Global review pack index") &&
      (runbook.entryPoints || []).some((row) => row.label === "Review pack agent verdicts") &&
      (runbook.entryPoints || []).some((row) => row.label === "Agent benchmark review") &&
      (runbook.entryPoints || []).some((row) => row.label === "Benchmark closure matrix") &&
      (runbook.entryPoints || []).some((row) => row.label === "Version remediation matrix") &&
      (runbook.entryPoints || []).some((row) => row.label === "Benchmark outcome analysis") &&
      (runbook.entryPoints || []).some((row) => row.label === "Corpus remediation matrix") &&
      (runbook.entryPoints || []).some((row) => row.label === "Manual review workspace") &&
      (runbook.entryPoints || []).some((row) => row.label === "Manual review progress") &&
      (runbook.entryPoints || []).some((row) => row.label === "Rerun command catalog") &&
      (runbook.entryPoints || []).some((row) => row.label === "Rerun batches") &&
      (runbook.entryPoints || []).some((row) => row.label === "Agent review digest") &&
      (runbook.entryPoints || []).some((row) => row.label === "Remediation matrix") &&
      (runbook.entryPoints || []).some((row) => row.label === "Objective evidence map") &&
      (runbook.entryPoints || []).some((row) => row.label === "Review readiness ledger") &&
      (runbook.entryPoints || []).some((row) => row.label === "Objective closure readiness") &&
      (runbook.entryPoints || []).some((row) => row.label === "Final goal readiness") &&
      (runbook.entryPoints || []).some((row) => row.label === "Scenario agent review") &&
      (runbook.entryPoints || []).some((row) => row.label === "Scenario outcome matrix") &&
      (runbook.entryPoints || []).some((row) => row.label === "Scenario remediation matrix") &&
      (runbook.entryPoints || []).some((row) => row.label === "Live/e2e agent review") &&
      (runbook.entryPoints || []).some((row) => row.label === "Live/e2e failure triage") &&
      (runbook.entryPoints || []).some((row) => row.label === "Live/e2e model evidence") &&
      (runbook.entryPoints || []).some((row) => row.label === "Live/e2e prompt-response completeness") &&
      (runbook.externalGates || []).some((gate) => gate.id === "osworld-live") &&
      (runbook.externalGates || []).some((gate) => gate.id === "hyperliquid_bench") &&
      (runbook.externalGates || []).some((gate) =>
        (gate.rerunCommands || []).some((command) => /--benchmarks osworld/.test(command.command || "")),
      ) &&
      (runbook.externalGates || []).some((gate) =>
        (gate.rerunCommands || []).some((command) => /--benchmarks hyperliquid_bench/.test(command.command || "")),
      ) &&
      runbook.currentCoverage?.runContractOk === true &&
      runbook.currentCoverage?.objectiveEvidenceMap ===
        `${objectiveEvidenceMap.summary?.proven} proven, ${objectiveEvidenceMap.summary?.caveated} caveated, ${objectiveEvidenceMap.summary?.blocked} blocked` &&
      runbook.currentCoverage?.reviewReadinessLedger ===
        `${reviewReadinessLedger.summary?.ready} ready, ${reviewReadinessLedger.summary?.caveated} caveated, ${reviewReadinessLedger.summary?.blocked} blocked surfaces` &&
      runbook.currentCoverage?.finalGoalReadiness ===
        `${finalGoalReadiness.summary?.proven} proven, ${finalGoalReadiness.summary?.caveated} caveated, ${finalGoalReadiness.summary?.blocked} blocked, ${finalGoalReadiness.summary?.openGates} open gates` &&
      JSON.stringify(runbook.currentCoverage?.objectiveCoverage || {}) ===
        JSON.stringify(runContract.objectiveCoverage || {}) &&
      JSON.stringify(runbook.currentCoverage?.externalCredentialPresence || {}) ===
        JSON.stringify(gap.credentials || {}) &&
      runbook.currentCoverage?.liveStructuredUsageRuns ===
        cacheAnalysis.liveWrapperPlayback?.summary?.structuredUsageRuns &&
      runbook.currentCoverage?.trajectoryIoCompleteness ===
        `${trajectoryIoCompleteness.summary?.withInput}/${trajectoryIoCompleteness.summary?.records} input, ${trajectoryIoCompleteness.summary?.withOutput}/${trajectoryIoCompleteness.summary?.records} output, ${trajectoryIoCompleteness.summary?.reviewRelevantOutputGaps} review-relevant output gaps` &&
      runbook.currentCoverage?.benchmarkFiveExampleSampler ===
        `${fiveExampleSampler.summary?.selectedWithPlayback}/${fiveExampleSampler.summary?.selectedRows}` &&
      runbook.currentCoverage?.benchmarkSampleReviewMatrix ===
        `${sampleReviewMatrix.summary?.reviewReadyRows}/${sampleReviewMatrix.summary?.sampleRows} review-ready samples` &&
      runbook.currentCoverage?.benchmarkReviewPacks ===
        `${benchmarkReviewPacks.summary?.packPages}/${benchmarkReviewPacks.summary?.benchmarkCount} pack pages, ${benchmarkReviewPacks.summary?.samplePlaybackRows}/${benchmarkReviewPacks.summary?.sampleRows} sample playback` &&
      runbook.currentCoverage?.reviewPackIndex ===
        `${reviewPackIndex.summary?.packCount} packs, ${reviewPackIndex.summary?.withPlayback} playback-linked, ${reviewPackIndex.summary?.withManualReviewNote} manual-note links` &&
      runbook.currentCoverage?.reviewPackAgentVerdicts ===
        `${reviewPackAgentVerdicts.summary?.reviewedRows}/${reviewPackAgentVerdicts.summary?.rowCount} reviewed, ${reviewPackAgentVerdicts.summary?.acceptRows} accepted, ${reviewPackAgentVerdicts.summary?.blockedRows} blocked` &&
      runbook.currentCoverage?.rerunCommandCatalog ===
        `${rerunCommandCatalog.summary?.commandCount} commands, ${rerunCommandCatalog.summary?.runnableNow} runnable now, ${rerunCommandCatalog.summary?.blocked} blocked` &&
      runbook.currentCoverage?.rerunBatches ===
        `${rerunBatches.summary?.batchCount} scripts, ${rerunBatches.summary?.runnableCommands} runnable commands, ${rerunBatches.summary?.blockedCommands} blocked excluded` &&
      runbook.currentCoverage?.manualReviewProgress ===
        `${manualReviewProgress.summary?.reviewed}/${manualReviewProgress.summary?.itemCount} reviewed, ${manualReviewProgress.summary?.withPack} pack-linked, ${manualReviewProgress.summary?.withPlayback} playback-linked` &&
      runbook.currentCoverage?.globalPlaybackRows ===
        `${globalPlaybackIndex.summary?.playbackExisting}/${globalPlaybackIndex.summary?.rowCount}` &&
      runbook.currentCoverage?.globalPlaybackGroups === globalPlaybackIndex.summary?.groupCount &&
      runbook.currentCoverage?.agentBenchmarkReview ===
        `${agentBenchmarkReview.summary?.totalReviewed} benchmark surfaces` &&
      runbook.currentCoverage?.benchmarkClosureMatrix ===
        `${benchmarkClosureMatrix.summary?.complete} complete, ${benchmarkClosureMatrix.summary?.caveated} caveated, ${benchmarkClosureMatrix.summary?.missing} missing` &&
      runbook.currentCoverage?.benchmarkClosureTargetPlayback ===
        `${benchmarkClosureMatrix.summary?.targetPlaybackComplete}/${benchmarkClosureMatrix.summary?.benchmarkCount}` &&
      runbook.currentCoverage?.versionRemediationMatrix ===
        `${versionRemediationMatrix.summary?.completeHistory} complete, ${versionRemediationMatrix.summary?.previousPlaybackGaps} previous-playback gaps, ${versionRemediationMatrix.summary?.noPreviousRun} true no-previous-run, ${versionRemediationMatrix.summary?.noEarlierPreviousRow || 0} no-earlier previous` &&
      runbook.currentCoverage?.benchmarkOutcomeAnalysis ===
        `${benchmarkOutcomeAnalysis.summary?.reviewPass} review-pass, ${benchmarkOutcomeAnalysis.summary?.needsOutputReview} needs-output-review, ${benchmarkOutcomeAnalysis.summary?.blockedOrCaveated} caveated` &&
      runbook.currentCoverage?.corpusRemediationMatrix ===
        `${corpusRemediationMatrix.summary?.familyRows} families, ${corpusRemediationMatrix.summary?.insufficientWarningLatestRows} insufficient-warning rows` &&
      runbook.currentCoverage?.corpusReviewPacks ===
        `${corpusReviewPacks.summary?.packPages}/${corpusReviewPacks.summary?.familyCount} pack pages, ${corpusReviewPacks.summary?.withCanonicalPlayback} with playback` &&
      runbook.currentCoverage?.scenarioAgentReview ===
        `${scenarioAgentReview.summary?.reviewed}/${scenarioAgentReview.summary?.scenarioCount}` &&
      runbook.currentCoverage?.scenarioOutcomeMatrix ===
        `${scenarioOutcomeMatrix.summary?.passed} passed, ${scenarioOutcomeMatrix.summary?.failedOnly} failed-only, ${scenarioOutcomeMatrix.summary?.nonPassing} non-passing` &&
      runbook.currentCoverage?.scenarioRemediationMatrix ===
        `${scenarioRemediationMatrix.summary?.nonPassingRows} non-passing, ${scenarioRemediationMatrix.summary?.playbackLinkedRows} playback-linked` &&
      runbook.currentCoverage?.scenarioReviewPacks ===
        `${scenarioReviewPacks.summary?.packPages}/${scenarioReviewPacks.summary?.scenarioCount} pack pages, ${scenarioReviewPacks.summary?.playbackLinkedRows} playback-linked` &&
      runbook.currentCoverage?.liveTestAgentReview ===
        `${liveTestAgentReview.summary?.reviewed}/${liveTestAgentReview.summary?.scriptCount}` &&
      runbook.currentCoverage?.liveFailureTriage ===
        `${liveTestFailureTriage.summary?.failedRunCount} failed runs, ${liveTestFailureTriage.summary?.likelyLlmFailedRuns} likely LLM` &&
      runbook.currentCoverage?.liveModelEvidence ===
        `${liveTestModelEvidence.summary?.playbackLinkedScripts}/${liveTestModelEvidence.summary?.scriptCount} playback, ${liveTestModelEvidence.summary?.structuredLlmScripts} structured` &&
      runbook.currentCoverage?.livePromptResponseCompleteness ===
        `${liveTestPromptResponseCompleteness.summary?.scriptSidecarComplete}/${liveTestPromptResponseCompleteness.summary?.likelyLlmScripts} complete script sidecars, ${liveTestPromptResponseCompleteness.summary?.runtimeBlockedBeforeSidecar} runtime-blocked, ${liveTestPromptResponseCompleteness.summary?.structuredRunCallsParsed} run calls parsed` &&
      runbook.currentCoverage?.liveTestReviewPacks ===
        `${liveTestReviewPacks.summary?.packPages}/${liveTestReviewPacks.summary?.scriptCount} pack pages, ${liveTestReviewPacks.summary?.playbackLinkedScripts} playback-linked` &&
      runbook.currentCoverage?.manualReviewNotes === manualReview.summary?.noteCount &&
      runbook.currentCoverage?.manualReviewAgentTriage === manualReview.summary?.agentReviewed &&
      runbook.currentCoverage?.agentReviewHighPriority === agentReview.summary?.highPriorityCount &&
      runbook.currentCoverage?.reviewQueueItems === reviewQueue.summary?.itemCount &&
      runbook.currentCoverage?.remediationMatrixItems === remediationMatrix.summary?.itemCount &&
      runbook.currentCoverage?.remediationMatrixLocalActions ===
        `${remediationMatrix.summary?.localActionItems}/${remediationMatrix.summary?.itemCount}` &&
      runbook.currentCoverage?.remediationMatrixCredentialRequiredActions ===
        remediationMatrix.summary?.localCredentialRequiredItems &&
      JSON.stringify(runbook.currentCoverage?.remediationMatrixLocalActionByLane || {}) ===
        JSON.stringify(remediationMatrix.summary?.localActionByLane || {}) &&
      runbook.currentCoverage?.remediationMatrixExternalBlockers ===
        remediationMatrix.summary?.externalBlockers &&
      runbook.currentCoverage?.remediationMatrixLiveTestItems ===
        remediationMatrix.summary?.liveTestItems &&
      runbook.currentCoverage?.remediationMatrixObjectiveCaveats ===
        remediationMatrix.summary?.objectiveCaveats &&
      runbook.currentCoverage?.remediationMatrixObjectiveLocalActions ===
        `${remediationMatrix.summary?.objectiveLocalActionItems}/${remediationMatrix.summary?.objectiveCaveats}` &&
      JSON.stringify(runbook.currentCoverage?.remediationMatrixObjectiveLocalActionByLane || {}) ===
        JSON.stringify(remediationMatrix.summary?.objectiveLocalActionByLane || {}) &&
      runbook.currentCoverage?.remediationMatrixLiveLocalActions ===
        `${remediationMatrix.summary?.liveLocalActionItems}/${remediationMatrix.summary?.liveTestItems}` &&
      JSON.stringify(runbook.currentCoverage?.remediationMatrixLiveLocalActionByClassification || {}) ===
        JSON.stringify(remediationMatrix.summary?.liveLocalActionByClassification || {}) &&
      JSON.stringify(runbook.currentCoverage?.remediationMatrixLiveLocalActionByLane || {}) ===
        JSON.stringify(remediationMatrix.summary?.liveLocalActionByLane || {}),
    JSON.stringify(runbook.currentCoverage || {}),
  );
  assertCheck(
    checks,
    "artifact-manifest.coverage",
    artifactManifest.summary?.totalFiles >= 5400 &&
      artifactManifest.summary?.htmlFiles >= 1100 &&
      artifactManifest.summary?.playbackHtmlFiles >= 1000 &&
      artifactManifest.summary?.trajectoryDataFiles >= 250 &&
      (artifactManifest.files || []).some((row) => row.path === "reports/benchmark-analysis/index.html") &&
      (artifactManifest.files || []).some((row) => row.path === "reports/scenarios/catalog-execution-union/index.html"),
    JSON.stringify(artifactManifest.summary || {}),
  );
  assertCheck(
    checks,
    "current-status.objective-evidence-map",
    /Generated objective evidence map/.test(currentStatus) &&
      /Generated review readiness ledger/.test(currentStatus) &&
      /reports\/benchmark-analysis\/objective-evidence-map\/index\.html/.test(currentStatus) &&
      /reports\/benchmark-analysis\/review-readiness-ledger\/index\.html/.test(currentStatus) &&
      /13 requirement rows: 7 proven, 5 caveated,\s+1 blocked, and 0 missing/.test(
        currentStatus,
      ) &&
      /8\s+surfaces: 3 ready, 4 caveated, and 1 blocked, with 28\/39 affordances ready/.test(
        currentStatus,
      ) &&
      /Generated benchmark review packs/.test(currentStatus) &&
      /16\/16 pack pages, 80\/80 sample playback rows, 80 review-ready sample rows,\s+52 full inline sample rows, 6 tool-call-only sample rows, 10 playback-only\s+environment sample rows, 15\/16 target playback links, 10 benchmark\s+manual-note links, 8 benchmarks with previous rows, and 6 comparable\s+previous playback pairs/.test(currentStatus) &&
      /Generated global review pack index/.test(currentStatus) &&
      /782 pack rows across benchmark, corpus, scenario,\s+and live\/e2e review packs, 781 playback-linked rows, 520 manual-note links,\s+543 rerun commands, 533 human-reviewed notes, and 533 agent-triaged notes/.test(currentStatus) &&
      /Generated review pack agent verdicts/.test(currentStatus) &&
      /782\/782 pack rows have agent verdicts: 242 accepted, 16 accepted\s+with caveat, 43 inspect, 194 fix, 285 rerun, and 2 blocked rows/.test(currentStatus) &&
      /Generated rerun command catalog/.test(currentStatus) &&
      /543 rerun commands across benchmark, corpus,\s+scenario, and live\/e2e rows: 541 runnable now, 2 blocked by external\s+prerequisites, 543 pack-linked, 542 playback-linked, 520 manual-note linked,\s+and 1 gap-page linked/.test(currentStatus) &&
      /Generated rerun batch scripts/.test(currentStatus) &&
      /5 executable batch scripts: 541 all-runnable commands, 15 benchmark commands,\s+31 corpus commands, 468 scenario commands, and 27 live\/e2e commands; 2 blocked\s+commands are excluded and documented/.test(currentStatus) &&
      /Generated final goal readiness gate/.test(currentStatus) &&
      /8 final gates: 3 proven, 3 caveated, 2 blocked, 0 missing, and\s+5 open/.test(currentStatus) &&
      /Generated manual-review progress board/.test(currentStatus) &&
      /533\/533 human-reviewed items, 533\/533 notes\s+present, 0 high-priority unreviewed items, 520 review items linked to pack\s+pages, 519 linked directly to playback, 1 linked to a gap page, and 520 with\s+rerun commands/.test(currentStatus) &&
      /Generated corpus review packs/.test(currentStatus) &&
      /53\/53\s+pack pages, 22 review-pass families, 25 needs-review, 5 telemetry-gap,\s+1 blocked, 53 family pages, 52 families with canonical playback,\s+246 canonical playback files, 31 manual-note links, 32 rerun commands,\s+74 warning rows, 74 warning rows with playback, 74 warning rows with call\s+previews, 9 zero-metric rows, and 2,230 normalized calls/.test(currentStatus) &&
      /Generated live\/e2e review packs/.test(currentStatus) &&
      /27\/27 pack pages,\s+27\/27 playback links, 27\/27 focused review links, 1\/27 script-level\s+structured sidecar rows, 27\/27 latest sidecar calls parsed with prompt and\s+response from 54 aggregate script calls, 11 failed scripts, 9 failure\s+classifications, evidence tiers of 1 complete script sidecar,\s+11 no-model-call scripts, and 15 runtime-blocked scripts, 27 offline review\s+summaries, 27 rerun commands, 11 manual\s+review notes, and 5,427\/5,427 all-run structured calls parsed with prompt\s+and response/.test(currentStatus) &&
      /Generated scenario review packs/.test(currentStatus) &&
      /686\/686 pack pages,\s+686\/686 playback links, 218 passed, 466 failed-only, 2 non-passing, 181\s+actionable, 285 evidence-limited, 466 category-linked, 468 rerun commands,\s+468 scenario manual-note links, and 474 failure detail rows/.test(currentStatus) &&
      /indexes 10,098\s+ignored report files, including 2,121 HTML files, 1,108 playback HTML pages,\s+366 trajectory-data files, 3,704 JSON files, and 2,719 Markdown files/.test(
        currentStatus,
      ),
    "status ledger includes objective evidence map, review readiness ledger, review pack index, agent verdicts, rerun command catalog, rerun batches, final goal readiness, manual review progress, benchmark/corpus/scenario/live review packs, and final manifest counts",
  );
  assertCheck(checks, "hub.links", Boolean(hub.links?.analysisSummary && hub.links?.runContract && hub.links?.globalPlaybackIndex && hub.links?.cacheAnalysis && hub.links?.trajectoryIoCompleteness && hub.links?.agentBenchmarkReview && hub.links?.benchmarkClosureMatrix && hub.links?.versionRemediationMatrix && hub.links?.benchmarkOutcomeAnalysis && hub.links?.benchmarkReview && hub.links?.benchmarkExamples && hub.links?.benchmarkFiveExampleSampler && hub.links?.benchmarkSampleReviewMatrix && hub.links?.benchmarkReviewPacks && hub.links?.reviewPackIndex && hub.links?.reviewPackAgentVerdicts && hub.links?.rerunCommandCatalog && hub.links?.rerunBatches && hub.links?.reviewQueue && hub.links?.manualReviewWorkspace && hub.links?.manualReviewProgress && hub.links?.agentReviewDigest && hub.links?.remediationMatrix && hub.links?.objectiveEvidenceMap && hub.links?.reviewReadinessLedger && hub.links?.objectiveClosure && hub.links?.finalGoalReadiness && hub.links?.runbook && hub.links?.artifactManifest && hub.links?.benchmarkResultsCorpus && hub.links?.corpusRemediationMatrix && hub.links?.corpusReviewPacks && hub.links?.benchmarkTrajectoryCatalog && hub.links?.benchmarkGapEvidence && hub.links?.scenarioAgentReview && hub.links?.scenarioOutcomeMatrix && hub.links?.scenarioRemediationMatrix && hub.links?.scenarioReviewPacks && hub.links?.liveTestAgentReview && hub.links?.liveTestFailureTriage && hub.links?.liveTestModelEvidence && hub.links?.liveTestPromptResponseCompleteness && hub.links?.liveTestReviewPacks), JSON.stringify(hub.links || {}));
  assertCheck(checks, "hub.no-file-scenario-links", (hub.scenarios?.runs || []).every((row) => !String(row.viewerHref || "").startsWith("file://") && !String(row.viewerHref || "").startsWith("/")), `${(hub.scenarios?.runs || []).filter((row) => String(row.viewerHref || "").startsWith("file://") || String(row.viewerHref || "").startsWith("/")).length} absolute scenario links`);
  assertCheck(checks, "hub.no-local-absolute-paths", !/file:\/\/|\/Users\/shawwalters|\/private\/tmp|\/tmp\//.test(JSON.stringify(hub)), "hub payload contains no local absolute paths");
  assertCheck(
    checks,
    "hub.finding-summaries",
      hub.benchmarks?.reviewFindings?.findingCount === 53 &&
      hub.benchmarks?.versionRemediationMatrix?.benchmarkCount ===
        versionRemediationMatrix.summary?.benchmarkCount &&
      hub.benchmarks?.benchmarkOutcomeAnalysis?.benchmarkCount ===
        benchmarkOutcomeAnalysis.summary?.benchmarkCount &&
      hub.benchmarks?.benchmarkSampleReviewMatrix?.sampleRows ===
        sampleReviewMatrix.summary?.sampleRows &&
      hub.benchmarks?.benchmarkReviewPacks?.packPages ===
        benchmarkReviewPacks.summary?.packPages &&
      hub.benchmarks?.reviewPackIndex?.packCount === reviewPackIndex.summary?.packCount &&
      hub.benchmarks?.reviewPackAgentVerdicts?.reviewedRows ===
        reviewPackAgentVerdicts.summary?.reviewedRows &&
      hub.benchmarks?.rerunCommandCatalog?.commandCount ===
        rerunCommandCatalog.summary?.commandCount &&
      hub.benchmarks?.rerunBatches?.runnableCommands === rerunBatches.summary?.runnableCommands &&
      hub.benchmarks?.corpusReviewPacks?.packPages ===
        corpusReviewPacks.summary?.packPages &&
      hub.benchmarks?.trajectoryIoCompleteness?.records ===
        trajectoryIoCompleteness.summary?.records &&
      hub.benchmarks?.agentBenchmarkReview?.totalReviewed ===
        agentBenchmarkReview.summary?.totalReviewed &&
      hub.scenarios?.findingSummary?.findingCount === scenarios.catalogScenarioCount &&
      hub.scenarios?.agentReview?.reviewed === scenarioAgentReview.summary?.reviewed &&
      hub.scenarios?.outcomeMatrix?.scenarioCount === scenarioOutcomeMatrix.summary?.scenarioCount &&
      hub.scenarios?.reviewPacks?.packPages === scenarioReviewPacks.summary?.packPages &&
      hub.liveTests?.findingSummary?.findingCount === live.summary.totalScripts &&
      hub.liveTests?.agentReview?.reviewed === liveTestAgentReview.summary?.reviewed &&
      hub.liveTests?.promptResponseCompleteness?.likelyLlmScripts ===
        liveTestPromptResponseCompleteness.summary?.likelyLlmScripts &&
      hub.liveTests?.reviewPacks?.packPages === liveTestReviewPacks.summary?.packPages,
    `benchmark=${hub.benchmarks?.reviewFindings?.findingCount || 0}; scenarios=${hub.scenarios?.findingSummary?.findingCount || 0}; live=${hub.liveTests?.findingSummary?.findingCount || 0}`,
  );
  assertCheck(
    checks,
    "hub.final-goal-readiness",
    hub.finalGoalReadiness?.openGates === finalGoalReadiness.summary?.openGates &&
      hub.finalGoalReadiness?.blocked === finalGoalReadiness.summary?.blocked &&
      hub.finalGoalReadiness?.closureReady === finalGoalReadiness.summary?.closureReady,
    JSON.stringify(hub.finalGoalReadiness || {}),
    "known-caveat",
  );
  assertCheck(
    checks,
    "hub.review-queue-summary",
    hub.reviewQueue?.itemCount === reviewQueue.summary?.itemCount &&
      hub.reviewQueue?.scenarioItems === reviewQueue.summary?.scenarioItems &&
      hub.reviewQueue?.liveTestItems === reviewQueue.summary?.liveTestItems &&
      hub.manualReview?.noteCount === reviewQueue.summary?.itemCount &&
      hub.manualReviewProgress?.withPack === manualReviewProgress.summary?.withPack &&
      hub.manualReviewProgress?.withPlayback === manualReviewProgress.summary?.withPlayback &&
      hub.agentReview?.highPriorityCount === agentReview.summary?.highPriorityCount &&
      hub.agentReview?.liveFailuresReviewed === agentReview.summary?.liveFailuresReviewed,
    JSON.stringify({ reviewQueue: hub.reviewQueue || {}, manualReview: hub.manualReview || {}, manualReviewProgress: hub.manualReviewProgress || {}, agentReview: hub.agentReview || {} }),
  );
  assertCheck(
    checks,
    "hub.playback-coverage-summary",
    hub.playbackCoverage?.codeAgentTrajectoryPlayback === trajectory.summary.playbackFiles &&
      hub.playbackCoverage?.codeAgentTrajectoryFiles === trajectory.summary.trajectoryFiles &&
      hub.playbackCoverage?.corpusCanonicalPlayback ===
        (corpus.canonicalFiles || []).filter((entry) => entry.playback_file).length &&
      hub.playbackCoverage?.corpusCanonicalFiles === corpus.summary?.canonicalTrajectoryFiles &&
      hub.playbackCoverage?.corpusNoPlaybackGapPages === (corpus.noPlaybackGapPages || []).length &&
      hub.playbackCoverage?.scenarioPlaybackPages === scenarios.scenarioPlaybackPages &&
      hub.playbackCoverage?.scenarioCount === scenarios.catalogScenarioCount &&
      hub.playbackCoverage?.livePlaybackPages === live.summary.wrapperPlaybackRuns &&
      hub.playbackCoverage?.wrappedLiveRuns === live.summary.wrappedRuns &&
      hub.playbackCoverage?.reviewQueueExistingTargets === reviewQueue.summary?.itemCount &&
      hub.playbackCoverage?.reviewQueueItems === reviewQueue.summary?.itemCount,
    JSON.stringify(hub.playbackCoverage || {}),
  );
  assertCheck(
    checks,
    "hub.drilldown-coverage-summary",
    hub.drilldownCoverage?.benchmarkReviewPages === review.summary?.benchmarkCount &&
      hub.drilldownCoverage?.benchmarkReviewRows === review.summary?.benchmarkCount &&
      hub.drilldownCoverage?.liveModelScriptReviewPages === live.summary.modelScriptReviewPages &&
      hub.drilldownCoverage?.liveModelScripts === live.summary.modelArtifactRequiredScripts &&
      hub.drilldownCoverage?.scenarioFailureCategoryPages === failures.summary.categoryPages &&
      hub.drilldownCoverage?.scenarioFailureCategories === (failures.categories || []).length &&
      hub.drilldownCoverage?.scenarioFailuresWithPlayback ===
        (failures.failures || []).filter((failure) => failure.playbackHref).length &&
      hub.drilldownCoverage?.scenarioFailureRows === (failures.failures || []).length,
    JSON.stringify(hub.drilldownCoverage || {}),
  );

  const requiredFailures = checks.filter((check) => check.severity === "required" && !check.ok);
  const payload = {
    schema: "eliza_benchmark_analysis_verification_v1",
    generatedAt: new Date().toISOString(),
    ok: requiredFailures.length === 0,
    requiredFailures: requiredFailures.length,
    knownCaveats: checks.filter((check) => check.severity === "known-caveat"),
    checks,
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    path.join(REPORT_DIR, "verification.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(REPORT_DIR, "README.md"),
    [
      "# Benchmark Analysis Verification",
      "",
      `Generated: ${payload.generatedAt}`,
      `Required checks pass: ${payload.ok ? "yes" : "no"}`,
      `Required failures: ${payload.requiredFailures}`,
      "",
      "| check | severity | status | detail |",
      "|---|---|---:|---|",
      ...checks.map((check) => `| \`${check.id}\` | ${check.severity} | ${check.ok ? "pass" : "fail"} | ${String(check.detail || "").replaceAll("|", "\\|")} |`),
      "",
    ].join("\n"),
    "utf8",
  );
  process.stdout.write(
    `benchmark analysis verification ${payload.ok ? "passed" : "failed"}; required failures=${payload.requiredFailures}\n`,
  );
  if (!payload.ok) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
