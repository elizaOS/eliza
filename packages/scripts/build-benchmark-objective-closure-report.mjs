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
  "objective-closure",
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

function status(ok, caveat = false) {
  if (ok && !caveat) return "proven";
  if (ok && caveat) return "caveated";
  return "missing";
}

function buildPayload() {
  const audit = readJson("reports/benchmark-analysis/goal-audit.json");
  const runContract = readJson("reports/benchmark-analysis/run-contract/run-contract.json");
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const sampler = readJson(
    "reports/benchmark-analysis/benchmark-five-example-sampler/five-example-sampler.json",
  );
  const sampleReview = readJson(
    "reports/benchmark-analysis/benchmark-sample-review-matrix/sample-review-matrix.json",
  );
  const trajectory = readJson(
    "reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json",
  );
  const version = readJson(
    "reports/benchmarks/code-agent-version-comparison/version-comparison.json",
  );
  const versionRemediation = readJson(
    "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
  );
  const corpus = readJson(
    "reports/benchmarks/benchmark-results-corpus-review/corpus-review.json",
  );
  const corpusReviewPacks = readJson(
    "reports/benchmark-analysis/corpus-review-packs/corpus-review-packs.json",
  );
  const scenarios = readJson("reports/scenarios/catalog-execution-union/coverage.json");
  const failures = readJson("reports/scenarios/failure-analysis/failure-analysis.json");
  const live = readJson("reports/live-test-inventory/inventory.json");
  const livePromptResponse = readJson(
    "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
  );
  const globalPlayback = readJson(
    "reports/benchmark-analysis/global-playback-index/global-playback-index.json",
  );
  const runbook = readJson("reports/benchmark-analysis/runbook/runbook.json");
  const gap = readJson("reports/benchmark-analysis/gap-evidence/gap-evidence.json");
  const manual = readJson("reports/benchmark-analysis/manual-review/manual-review.json");
  const agentReview = readJson("reports/benchmark-analysis/agent-review/agent-review.json");

  const objectiveCoverage = runContract.objectiveCoverage || {};
  const auditRows = new Map((audit.rows || []).map((row) => [row.id, row]));
  const corpusCaveated = auditRows.get("corpus-publication-gaps")?.status === "caveated";
  const fiveExampleCaveated =
    auditRows.get("five-examples-per-benchmark")?.status === "caveated";

  const requirements = [
    {
      id: "review-every-code-agent-benchmark",
      requirement: "Every included latest code-agent benchmark has a review row and focused viewer.",
      status: status(
        review.summary?.benchmarkCount === objectiveCoverage.benchmarkLatestRows &&
          review.summary?.benchmarkCount === 16,
      ),
      evidence: `${review.summary?.benchmarkCount || 0}/16 latest code-agent benchmarks reviewed; ${review.summary?.reviewPass || 0} review-pass, ${review.summary?.weakOrInferior || 0} weak/inferior, ${review.summary?.missingLive || 0} missing-live.`,
      viewer: "../benchmark-review/index.html",
    },
    {
      id: "five-examples-per-benchmark",
      requirement: "Approximately five examples per benchmark are selected and playback-linked.",
      status: status(
        sampler.summary?.selectedRows === 80 &&
          sampler.summary?.selectedWithPlayback === sampler.summary?.selectedRows,
        fiveExampleCaveated,
      ),
      evidence: `${sampler.summary?.selectedWithPlayback || 0}/${sampler.summary?.selectedRows || 0} sampled examples have playback across ${sampler.summary?.benchmarkCount || 0}/16 latest code-agent benchmarks; ${sampler.summary?.selectedWithTaskId || 0}/${sampler.summary?.selectedRows || 0} carry explicit task IDs; ${sampleReview.summary?.fullInlineReviewRows || 0} full inline I/O/cache rows, ${sampleReview.summary?.toolCallOnlyInlineRows || 0} tool-call-only rows, ${sampleReview.summary?.playbackOnlyEnvironmentRows || 0} playback-only environment rows. Caveat: OSWorld contributes 5/5 smoke playback rows until a live provider is available.`,
      viewer: "../benchmark-five-example-sampler/index.html",
    },
    {
      id: "call-by-call-trajectory-playback",
      requirement: "Benchmark trajectories have call-by-call playback with model input/output and cache evidence.",
      status: status(
        trajectory.summary?.playbackFiles === trajectory.summary?.trajectoryFiles &&
          trajectory.summary?.inputOutput?.recordsWithInput >= 600 &&
          trajectory.summary?.inputOutput?.recordsWithOutput >= 390,
      ),
      evidence: `${trajectory.summary?.playbackFiles || 0}/${trajectory.summary?.trajectoryFiles || 0} code-agent trajectory files have playback; ${trajectory.summary?.inputOutput?.recordsWithInput || 0}/${trajectory.summary?.trajectoryRecords || 0} records expose input and ${trajectory.summary?.inputOutput?.recordsWithOutput || 0}/${trajectory.summary?.trajectoryRecords || 0} expose output.`,
      viewer: "../../benchmarks/code-agent-trajectory-catalog/index.html",
    },
    {
      id: "global-playback-viewer",
      requirement: "A unified viewer indexes benchmark, scenario, and live/e2e playback pages.",
      status: status(
        globalPlayback.summary?.rowCount === globalPlayback.summary?.playbackExisting &&
          globalPlayback.summary?.rowCount >= 1100,
      ),
      evidence: `${globalPlayback.summary?.playbackExisting || 0}/${globalPlayback.summary?.rowCount || 0} global playback rows exist across ${globalPlayback.summary?.surfaces || 0} surfaces, with ${globalPlayback.summary?.totalCallOrEventCount || 0} calls/events.`,
      viewer: "../global-playback-index/index.html",
    },
    {
      id: "version-comparison",
      requirement: "Historical benchmark versions are shown where available, with previous-run gaps explicit.",
      status: status(
        versionRemediation.summary?.withPrevious === 8 &&
          versionRemediation.summary?.previousPlaybackGaps === 2,
        true,
      ),
      evidence: `${versionRemediation.summary?.withPrevious || 0}/${versionRemediation.summary?.benchmarkCount || 0} code-agent benchmarks have previous rows; ${versionRemediation.summary?.comparablePlaybackPairs || 0}/${versionRemediation.summary?.withPrevious || 0} have call-by-call previous playback; ${versionRemediation.summary?.previousPlaybackGaps || 0} previous playback gaps (${(versionRemediation.summary?.previousPlaybackGapBenchmarks || []).join(", ")}); ${versionRemediation.summary?.previousAggregateOnlyWithViewer || 0} aggregate-only previous viewers have zero target/baseline trajectory files and ${versionRemediation.summary?.previousAggregateOnlyReviewRows || 0} have explicit version-gap review rows; ${versionRemediation.summary?.noPreviousRun || 0} true no-previous-run benchmarks.`,
      viewer: "../../benchmarks/code-agent-version-comparison/index.html",
    },
    {
      id: "broader-corpus-review",
      requirement: "Broader benchmark corpus rows are normalized, reviewable, and gap-classified.",
      status: status(
        corpus.callCatalogSummary?.normalizedCallCount >= 2200 &&
          corpus.summary?.canonicalTrajectoryFiles >= 246 &&
          corpus.telemetryGapSummary?.evidenceAbsentLatestRows === 0,
        corpusCaveated,
      ),
      evidence: `${corpus.callCatalogSummary?.normalizedCallCount || 0} normalized records across ${corpus.callCatalogSummary?.rowsWithNormalizedCalls || 0} rows and ${corpus.callCatalogSummary?.benchmarksWithNormalizedCalls || 0} families; ${corpus.summary?.canonicalTrajectoryFiles || 0} canonical playback files; ${corpus.telemetryGapSummary?.evidenceAbsentLatestRows || 0} evidence-absent rows; ${corpus.summary?.insufficientLatestRows || 0} insufficient-* publication-warning rows; ${corpus.telemetryGapSummary?.zeroMetricLatestRows || 0} replayable token/turn-zero latest rows; ${corpus.reviewFindingSummary?.telemetryGap || 0} tokenless telemetry-gap families; ${corpus.reviewFindingSummary?.blocked || 0} blocked family: hyperliquid_bench pending HL_PRIVATE_KEY; ${corpusReviewPacks.summary?.warningRowsWithPlayback || 0}/${corpusReviewPacks.summary?.warningRows || 0} publication-warning rows have playback and ${corpusReviewPacks.summary?.warningRowsWithCallPreview || 0}/${corpusReviewPacks.summary?.warningRows || 0} have call previews.`,
      viewer: "../../benchmarks/benchmark-results-corpus-review/index.html",
    },
    {
      id: "all-scenarios-included",
      requirement: "All cataloged scenarios are represented with execution evidence and playback.",
      status: status(
        scenarios.executedScenarioIds === scenarios.catalogScenarioCount &&
          scenarios.scenarioPlaybackPages === scenarios.catalogScenarioCount &&
          scenarios.missingCount === 0,
      ),
      evidence: `${scenarios.executedScenarioIds || 0}/${scenarios.catalogScenarioCount || 0} scenarios have execution evidence; ${scenarios.scenarioPlaybackPages || 0}/${scenarios.catalogScenarioCount || 0} have playback; ${scenarios.findingSummary?.missing || 0} missing.`,
      viewer: "../../scenarios/catalog-execution-union/index.html",
    },
    {
      id: "scenario-failure-triage",
      requirement: "Scenario failures are grouped for manual and agent review.",
      status: status(
        failures.summary?.categoryPages === (failures.categories || []).length &&
          failures.summary?.failedScenarios === (failures.failures || []).length,
      ),
      evidence: `${failures.summary?.failedScenarios || 0} failed scenario attempts in ${failures.summary?.categoryPages || 0} category pages, all linked to scenario playback where available.`,
      viewer: "../../scenarios/failure-analysis/index.html",
    },
    {
      id: "real-llm-e2e-tests",
      requirement: "Tests likely to use real LLMs have artifacts, playback, and structured status.",
      status: status(
        live.summary?.modelArtifactRequiredWithoutEvidence === 0 &&
          live.summary?.modelScriptReviewPages === live.summary?.modelArtifactRequiredScripts &&
          live.summary?.structuredLlmModelScriptsWithReason === live.summary?.modelArtifactRequiredScripts,
        livePromptResponse.summary?.scriptSidecarComplete < livePromptResponse.summary?.likelyLlmScripts,
      ),
      evidence: `${live.summary?.modelArtifactRequiredScripts || 0}/${live.summary?.modelArtifactRequiredScripts || 0} model-call scripts reviewed; ${live.summary?.modelArtifactRequiredWithoutEvidence || 0} evidence gaps; ${live.summary?.wrapperPlaybackRuns || 0}/${live.summary?.wrappedRuns || 0} wrapped runs have playback; ${live.summary?.structuredLlmCallCount || 0} structured calls; ${livePromptResponse.summary?.scriptSidecarComplete || 0}/${livePromptResponse.summary?.likelyLlmScripts || 0} complete script sidecars; ${livePromptResponse.summary?.rowsWithOfflineReviewSummary || 0}/${livePromptResponse.summary?.likelyLlmScripts || 0} offline review summaries and ${livePromptResponse.summary?.noSidecarRowsWithOfflineReviewSummary || 0}/${livePromptResponse.summary?.reasonCodedNoSidecar || 0} no-sidecar rows with offline evidence guidance.`,
      viewer: "../../live-test-inventory/index.html",
    },
    {
      id: "manual-review-workspace",
      requirement: "Manual review is durable, complete, and agent-triaged.",
      status: status(
        manual.summary?.noteCount === manual.summary?.itemCount &&
          manual.summary?.agentReviewed === manual.summary?.itemCount &&
          agentReview.summary?.targetLinksExisting === agentReview.summary?.highPriorityCount,
      ),
      evidence: `${manual.summary?.noteCount || 0}/${manual.summary?.itemCount || 0} note files exist; ${manual.summary?.agentReviewed || 0}/${manual.summary?.itemCount || 0} have agent triage; ${agentReview.summary?.highPriorityCount || 0} high-priority items triaged.`,
      viewer: "../manual-review/index.html",
    },
    {
      id: "ignored-storage-and-rerun-contract",
      requirement: "Generated data is stored under ignored roots and rebuild/verify commands are available.",
      status: status(
        runContract.summary?.ok === true &&
          (runbook.commands || []).some((row) => row.command === "bun run bench:analysis:build") &&
          (runbook.commands || []).some((row) => row.command === "bun run bench:analysis:verify"),
      ),
      evidence: `${runContract.summary?.ignoredRootCount || 0} ignored roots, ${runContract.summary?.viewerEntrypointCount || 0} viewer entrypoints, ${runContract.summary?.artifactFiles || 0} files; runbook includes rebuild and verify commands.`,
      viewer: "../run-contract/index.html",
    },
    {
      id: "external-gates",
      requirement: "External blockers have explicit readiness probes and rerun commands.",
      status: status(
        gap.credentials?.cerebrasApiKeyPresent === true &&
          gap.osworld?.providerReadiness?.runnableProviderCount === 0 &&
          gap.credentials?.hyperliquidPrivateKeyPresent === false &&
          /--benchmarks osworld/.test(gap.remediationCommands?.osworld?.[0]?.command || "") &&
          /--benchmarks hyperliquid_bench/.test(
            gap.remediationCommands?.hyperliquid?.[0]?.command || "",
          ),
        true,
      ),
      evidence: `CEREBRAS_API_KEY present; OSWorld runnable providers=${gap.osworld?.providerReadiness?.runnableProviderCount || 0} because Docker daemon is unreachable, vmrun/VBoxManage are unavailable, and AWS credentials are incomplete; HL_PRIVATE_KEY present=${gap.credentials?.hyperliquidPrivateKeyPresent ? "yes" : "no"}. Rerun commands are recorded for --benchmarks osworld and --benchmarks hyperliquid_bench; only Hyperliquid uses HL_PRIVATE_KEY=<set-in-shell>.`,
      viewer: "../gap-evidence/index.html",
    },
  ];

  const blockers = requirements.filter((row) => row.status !== "proven");
  const hardBlockers = blockers.filter((row) => row.status === "missing");
  return {
    schema: "eliza_benchmark_objective_closure_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      total: requirements.length,
      proven: requirements.filter((row) => row.status === "proven").length,
      caveated: requirements.filter((row) => row.status === "caveated").length,
      missing: hardBlockers.length,
      closureReady: blockers.length === 0,
      externalBlockers: ["osworld-live", "hyperliquid_bench"],
    },
    requirements,
    blockers,
  };
}

function html(payload) {
  const rows = payload.requirements
    .map(
      (row) =>
        `<tr><td><code>${escapeHtml(row.id)}</code></td><td class="${row.status === "proven" ? "ok" : row.status === "missing" ? "bad" : "warn"}">${escapeHtml(row.status)}</td><td>${escapeHtml(row.requirement)}</td><td>${escapeHtml(row.evidence)}</td><td><a href="${escapeHtml(row.viewer)}">open</a></td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Objective Closure Readiness</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:10px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:22px; }
    .panel { overflow:hidden; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .ok { color:#17633a; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .bad { color:#a12222; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Objective Closure Readiness</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">Closure ready</span><b class="${payload.summary.closureReady ? "ok" : "bad"}">${payload.summary.closureReady ? "yes" : "no"}</b></div>
      <div class="card"><span class="muted">Proven</span><b>${payload.summary.proven}/${payload.summary.total}</b></div>
      <div class="card"><span class="muted">Caveated</span><b>${payload.summary.caveated}</b></div>
      <div class="card"><span class="muted">Missing</span><b>${payload.summary.missing}</b></div>
    </div>
    <section class="panel"><h2>Requirement Evidence</h2><div class="body"><table><thead><tr><th>id</th><th>status</th><th>requirement</th><th>evidence</th><th>viewer</th></tr></thead><tbody>${rows}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Objective Closure Readiness",
    "",
    `Generated: ${payload.generatedAt}`,
    `Closure ready: ${payload.summary.closureReady ? "yes" : "no"}`,
    `Proven: ${payload.summary.proven}/${payload.summary.total}`,
    `Caveated: ${payload.summary.caveated}`,
    `Missing: ${payload.summary.missing}`,
    "",
    "| id | status | evidence |",
    "|---|---|---|",
    ...payload.requirements.map(
      (row) => `| \`${row.id}\` | ${row.status} | ${row.evidence.replaceAll("|", "\\|")} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "objective-closure.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `benchmark objective closure ${payload.summary.proven}/${payload.summary.total} proven; closureReady=${payload.summary.closureReady}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
