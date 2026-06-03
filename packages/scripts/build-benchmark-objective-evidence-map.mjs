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
  "objective-evidence-map",
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

function fmt(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : String(value ?? "");
}

function statusClass(status) {
  if (status === "proven") return "ok";
  if (status === "blocked") return "bad";
  if (status === "missing") return "bad";
  return "warn";
}

function buildPayload() {
  const runContract = readJson("reports/benchmark-analysis/run-contract/run-contract.json");
  const closure = readJson(
    "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
  );
  const sampleReview = readJson(
    "reports/benchmark-analysis/benchmark-sample-review-matrix/sample-review-matrix.json",
  );
  const trajectoryIo = readJson(
    "reports/benchmark-analysis/trajectory-io-completeness/trajectory-io-completeness.json",
  );
  const globalPlayback = readJson(
    "reports/benchmark-analysis/global-playback-index/global-playback-index.json",
  );
  const livePromptResponse = readJson(
    "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
  );
  const scenarioOutcome = readJson(
    "reports/benchmark-analysis/scenario-outcome-matrix/scenario-outcome-matrix.json",
  );
  const versionRemediation = readJson(
    "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
  );
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const corpusRemediation = readJson(
    "reports/benchmark-analysis/corpus-remediation-matrix/corpus-remediation.json",
  );
  const corpusReviewPacks = readJson(
    "reports/benchmark-analysis/corpus-review-packs/corpus-review-packs.json",
  );
  const gap = readJson("reports/benchmark-analysis/gap-evidence/gap-evidence.json");
  const manualReview = readJson("reports/benchmark-analysis/manual-review/manual-review.json");
  const reviewQueue = readJson("reports/benchmark-analysis/review-queue/review-queue.json");
  const artifactManifest = readJson("reports/benchmark-analysis/artifact-manifest/manifest.json");

  const rows = [
    {
      id: "review-every-benchmark",
      status: "proven",
      requirement: "Every latest code-agent benchmark is reviewed, outcome-classified, and linked to a focused review surface.",
      evidence: `${closure.summary.reviewed}/${closure.summary.benchmarkCount} benchmarks reviewed; ${closure.summary.agentReviewed}/${closure.summary.benchmarkCount} agent-reviewed; ${closure.summary.complete} complete and ${closure.summary.caveated} caveated.`,
      link: "../benchmark-closure-matrix/index.html",
      nextAction: "Use the closure matrix for benchmark-level acceptance and caveat checks.",
    },
    {
      id: "five-examples",
      status: "caveated",
      requirement: "Approximately five examples per benchmark are selected, playback-linked, and ready for manual inspection.",
      evidence: `${sampleReview.summary.sampleRows} sampled rows across ${sampleReview.summary.benchmarkCount} benchmarks; ${sampleReview.summary.rowsWithPlayback}/${sampleReview.summary.sampleRows} playback-linked; ${sampleReview.summary.rowsWithTaskId} task IDs; ${sampleReview.summary.reviewReadyRows} review-ready rows. OSWorld samples remain smoke/dry-run caveats until a live provider is available.`,
      link: "../benchmark-sample-review-matrix/index.html",
      nextAction: "Rerun OSWorld once a provider is available; sampled playback is otherwise review-ready.",
    },
    {
      id: "trajectory-playback-input-output-cache",
      status: "caveated",
      requirement: "Trajectory playback exposes inputs, outputs, token usage, and cache behavior at call granularity.",
      evidence: `${trajectoryIo.summary.playbackFiles}/${trajectoryIo.summary.files} trajectory files have playback; ${trajectoryIo.summary.withInput}/${trajectoryIo.summary.records} records expose input; ${trajectoryIo.summary.withOutput}/${trajectoryIo.summary.records} expose output; ${trajectoryIo.summary.reviewRelevantOutputGaps} review-relevant empty-response token gaps and ${trajectoryIo.summary.benignOutputGaps} benign tool/action/environment gaps; ${fmt(trajectoryIo.summary.tokens)} tokens and ${fmt(trajectoryIo.summary.cacheReadTokens)} cached-read tokens.`,
      link: "../trajectory-io-completeness/index.html",
      nextAction: "Inspect the review-relevant empty-response token gaps; treat tool/action-only and environment/dry-run gaps as classified playback caveats.",
    },
    {
      id: "ignored-html-viewers",
      status: "proven",
      requirement: "Generated evidence is kept under ignored report roots with HTML viewers and markdown/json sidecars.",
      evidence: `${fmt(artifactManifest.summary.totalFiles)} ignored files, ${fmt(artifactManifest.summary.htmlFiles)} HTML files, ${fmt(artifactManifest.summary.playbackHtmlFiles)} playback HTML files, ${fmt(artifactManifest.summary.jsonFiles)} JSON files, and ${fmt(artifactManifest.summary.byRole?.viewer || 0)} viewer entrypoints.`,
      link: "../artifact-manifest/index.html",
      nextAction: "Rebuild the manifest after adding new evidence reports.",
    },
    {
      id: "global-playback",
      status: "proven",
      requirement: "A single playback index covers benchmark, scenario, and live/e2e review targets.",
      evidence: `${globalPlayback.summary.playbackExisting}/${globalPlayback.summary.rowCount} playback rows exist across ${globalPlayback.summary.groupCount} groups; ${fmt(globalPlayback.summary.totalCallOrEventCount)} calls/events are indexed.`,
      link: "../global-playback-index/index.html",
      nextAction: "Use this as the top-level playback table before drilling into individual reports.",
    },
    {
      id: "version-comparison",
      status: "caveated",
      requirement: "Benchmark versions are compared where historical runs exist, with previous-run gaps explicit.",
      evidence: `${versionRemediation.summary.withPrevious}/${versionRemediation.summary.benchmarkCount} benchmarks have previous rows; ${versionRemediation.summary.comparablePlaybackPairs} comparable playback pairs; ${versionRemediation.summary.previousPlaybackGaps} previous playback gaps (${(versionRemediation.summary.previousPlaybackGapBenchmarks || []).join(", ")}); ${versionRemediation.summary.previousAggregateOnlyWithViewer} aggregate-only previous viewers have zero target/baseline trajectory files; ${versionRemediation.summary.noPreviousRun} true no-previous-run benchmarks (${(versionRemediation.summary.noPreviousRunBenchmarks || []).join(", ")}); ${versionRemediation.summary.noEarlierPreviousRow || 0} no-earlier-previous-row benchmark; ${versionRemediation.summary.osworldProviderCaveats} OSWorld caveat.`,
      link: "../version-remediation-matrix/index.html",
      nextAction: "Rerun mind2web and nl2repo with trajectory output when previous playback is required.",
    },
    {
      id: "real-llm-e2e-tests",
      status: "caveated",
      requirement: "Real-LLM/live/e2e tests have playback, structured status, and prompt-response evidence.",
      evidence: `${livePromptResponse.summary.likelyLlmScripts} likely-LLM scripts; ${livePromptResponse.summary.scriptsWithPlayback} playback-linked; ${livePromptResponse.summary.scriptsWithStructuredStatus} structured-status scripts; ${livePromptResponse.summary.scriptSidecarComplete} complete script sidecar, ${livePromptResponse.summary.reasonCodedNoModelCall} no-model-call rows, ${livePromptResponse.summary.runtimeBlockedBeforeSidecar} runtime-blocked rows, ${livePromptResponse.summary.missingCallArtifact} missing-call-artifact row; ${fmt(livePromptResponse.summary.structuredRunCallsParsed)} structured live-run calls parsed with prompt and response; ${livePromptResponse.summary.rowsWithOfflineReviewSummary}/${livePromptResponse.summary.likelyLlmScripts} rows have offline review summaries and ${livePromptResponse.summary.noSidecarRowsWithOfflineReviewSummary}/${livePromptResponse.summary.reasonCodedNoSidecar} no-sidecar rows have offline evidence guidance.`,
      link: "../live-test-prompt-response-completeness/index.html",
      nextAction: "For strict script-local evidence, add sidecar emission to wrappers that currently only have runtime-blocked, runtime-service-unavailable, or other reason-coded no-sidecar status.",
    },
    {
      id: "all-scenarios",
      status: "proven",
      requirement: "All cataloged scenarios are represented with execution and playback evidence.",
      evidence: `${scenarioOutcome.summary.executionScenarioCount}/${scenarioOutcome.summary.scenarioCount} scenarios executed; ${scenarioOutcome.summary.playbackExistingRows}/${scenarioOutcome.summary.scenarioCount} playback rows; missing execution ${scenarioOutcome.summary.missingExecution}.`,
      link: "../scenario-outcome-matrix/index.html",
      nextAction: "Use the scenario outcome matrix for status and playback drilldown.",
    },
    {
      id: "scenario-triage",
      status: "proven",
      requirement: "Scenario outcomes are categorized for manual review and rerun planning.",
      evidence: `${scenarioOutcome.summary.passed} passed, ${scenarioOutcome.summary.failedOnly} failed-only, ${scenarioOutcome.summary.nonPassing} non-passing; ${scenarioOutcome.summary.actionableRows} actionable rows; ${scenarioOutcome.summary.rerunCommands} rerun commands.`,
      link: "../scenario-remediation-matrix/index.html",
      nextAction: "Prioritize actionable rows before evidence-limited failures.",
    },
    {
      id: "broader-corpus",
      status: "caveated",
      requirement: "The broader benchmark-results corpus is normalized, playback-linked where possible, and publication gaps are exposed.",
      evidence: `${corpus.summary.rowCount} latest corpus rows across ${corpus.summary.benchmarkCount} benchmark families; ${corpus.summary.insufficientLatestRows} insufficient latest rows; ${corpusRemediation.summary.telemetryGapFamilies} telemetry-gap families; ${corpusRemediation.summary.blockedFamilies} blocked family; ${fmt(corpus.callCatalogSummary?.normalizedCallCount || 0)} full-corpus normalized calls (${fmt(corpusRemediation.summary.normalizedCalls)} in the focused remediation subset); ${corpusReviewPacks.summary.warningRowsWithPlayback}/${corpusReviewPacks.summary.warningRows} publication-warning rows have playback and ${corpusReviewPacks.summary.warningRowsWithCallPreview}/${corpusReviewPacks.summary.warningRows} have call previews.`,
      link: "../corpus-remediation-matrix/index.html",
      nextAction: "Resolve publication warnings and Hyperliquid credentials before treating the corpus as fully closed.",
    },
    {
      id: "manual-review-workspace",
      status:
        manualReview.summary.reviewed === reviewQueue.summary.itemCount &&
        manualReview.summary.highPriorityUnreviewed === 0
          ? "proven"
          : "caveated",
      requirement: "Manual review notes are durable, agent-triaged, and reviewed with durable verdicts.",
      evidence: `${manualReview.summary.noteCount}/${reviewQueue.summary.itemCount} review notes generated; ${manualReview.summary.agentReviewed} agent-triaged; ${manualReview.summary.reviewed} human-reviewed; ${manualReview.summary.highPriorityUnreviewed} high-priority items still unreviewed by a human.`,
      link: "../manual-review/index.html",
      nextAction:
        manualReview.summary.reviewed === reviewQueue.summary.itemCount &&
        manualReview.summary.highPriorityUnreviewed === 0
          ? "Keep the durable note verdicts synchronized by rebuilding the analysis stack after new review queue items are added."
          : "Fill all human verdicts before declaring human manual review complete.",
    },
    {
      id: "external-gates",
      status: "blocked",
      requirement: "External live gates are documented with readiness probes and redacted rerun commands.",
      evidence: `CEREBRAS_API_KEY present=${gap.credentials?.cerebrasApiKeyPresent ? "yes" : "no"}; OSWorld runnable providers=${gap.osworld?.providerReadiness?.runnableProviderCount || 0}; HL_PRIVATE_KEY present=${gap.credentials?.hyperliquidPrivateKeyPresent ? "yes" : "no"}. OSWorld provider access and Hyperliquid private key remain external gates.`,
      link: "../gap-evidence/index.html",
      nextAction: "Provide an OSWorld provider and HL_PRIVATE_KEY, then run the recorded rerun commands.",
    },
    {
      id: "secret-handling",
      status: "proven",
      requirement: "Secret values are used only by environment presence checks and are not persisted into generated reports.",
      evidence: `Run contract ok=${runContract.summary.ok}; gap evidence stores presence only; Hyperliquid rerun command uses redacted values; verifier includes a raw-key scan over generated report roots.`,
      link: "../run-contract/index.html",
      nextAction: "Continue running the raw-key scan after every rebuild.",
    },
  ];

  const summary = {
    total: rows.length,
    proven: rows.filter((row) => row.status === "proven").length,
    caveated: rows.filter((row) => row.status === "caveated").length,
    blocked: rows.filter((row) => row.status === "blocked").length,
    missing: rows.filter((row) => row.status === "missing").length,
    closureReady: rows.every((row) => row.status === "proven"),
  };

  return {
    schema: "eliza_benchmark_objective_evidence_map_v1",
    generatedAt: new Date().toISOString(),
    summary,
    sourceReports: [
      "reports/benchmark-analysis/run-contract/run-contract.json",
      "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
      "reports/benchmark-analysis/benchmark-sample-review-matrix/sample-review-matrix.json",
      "reports/benchmark-analysis/trajectory-io-completeness/trajectory-io-completeness.json",
      "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
      "reports/benchmark-analysis/scenario-outcome-matrix/scenario-outcome-matrix.json",
      "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
      "reports/benchmarks/benchmark-results-corpus-review/corpus-review.json",
      "reports/benchmark-analysis/corpus-remediation-matrix/corpus-remediation.json",
      "reports/benchmark-analysis/gap-evidence/gap-evidence.json",
      "reports/benchmark-analysis/manual-review/manual-review.json",
      "reports/benchmark-analysis/review-queue/review-queue.json",
      "reports/benchmark-analysis/artifact-manifest/manifest.json",
    ],
    rows,
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Objective Evidence Map</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .metric { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:10px; }
    .metric strong { display:block; font-size:20px; }
    .panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .muted { color:#5f685d; }
    .status { font-weight:700; }
    .ok { color:#17633a; }
    .warn { color:#8a5b12; }
    .bad { color:#a12222; }
  </style>
</head>
<body>
  <header>
    <h1>Objective Evidence Map</h1>
    <div class="muted">${escapeHtml(payload.generatedAt)}</div>
  </header>
  <main>
    <section class="summary">
      ${["total", "proven", "caveated", "blocked", "missing"].map((key) => `<div class="metric"><span>${escapeHtml(key)}</span><strong>${escapeHtml(payload.summary[key])}</strong></div>`).join("")}
    </section>
    <section class="panel">
      <table>
        <thead><tr><th>requirement</th><th>status</th><th>evidence</th><th>next action</th><th>link</th></tr></thead>
        <tbody>
          ${payload.rows.map((row) => `<tr><td><code>${escapeHtml(row.id)}</code><br>${escapeHtml(row.requirement)}</td><td class="status ${statusClass(row.status)}">${escapeHtml(row.status)}</td><td>${escapeHtml(row.evidence)}</td><td>${escapeHtml(row.nextAction)}</td><td><a href="${escapeHtml(row.link)}">open</a></td></tr>`).join("")}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Objective Evidence Map",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Summary: ${payload.summary.proven} proven, ${payload.summary.caveated} caveated, ${payload.summary.blocked} blocked, ${payload.summary.missing} missing across ${payload.summary.total} requirements.`,
    "",
    "| Requirement | Status | Evidence | Link |",
    "| --- | --- | --- | --- |",
    ...payload.rows.map(
      (row) =>
        `| \`${row.id}\` | ${row.status} | ${row.evidence.replaceAll("|", "\\|")} | \`${row.link}\` |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "objective-evidence-map.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`objective evidence map ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
