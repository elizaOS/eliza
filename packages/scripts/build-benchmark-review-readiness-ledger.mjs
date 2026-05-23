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
  "review-readiness-ledger",
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

function percent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
}

function statusClass(status) {
  if (status === "ready") return "ok";
  if (status === "blocked") return "bad";
  return "warn";
}

function affordance(label, status, evidence) {
  return { label, status, evidence };
}

function buildPayload() {
  const outcome = readJson("reports/benchmark-analysis/benchmark-outcome-analysis/outcome-analysis.json");
  const closure = readJson(
    "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
  );
  const trajectoryIo = readJson(
    "reports/benchmark-analysis/trajectory-io-completeness/trajectory-io-completeness.json",
  );
  const sampleReview = readJson(
    "reports/benchmark-analysis/benchmark-sample-review-matrix/sample-review-matrix.json",
  );
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const corpusRemediation = readJson(
    "reports/benchmark-analysis/corpus-remediation-matrix/corpus-remediation.json",
  );
  const scenarioOutcome = readJson(
    "reports/benchmark-analysis/scenario-outcome-matrix/scenario-outcome-matrix.json",
  );
  const liveModelEvidence = readJson(
    "reports/benchmark-analysis/live-test-model-evidence/model-evidence.json",
  );
  const livePromptResponse = readJson(
    "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
  );
  const versionRemediation = readJson(
    "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
  );
  const globalPlayback = readJson(
    "reports/benchmark-analysis/global-playback-index/global-playback-index.json",
  );
  const manualReview = readJson("reports/benchmark-analysis/manual-review/manual-review.json");
  const reviewQueue = readJson("reports/benchmark-analysis/review-queue/review-queue.json");
  const gap = readJson("reports/benchmark-analysis/gap-evidence/gap-evidence.json");

  const rows = [
    {
      id: "code-agent-benchmarks",
      surface: "Code-agent benchmarks",
      status: "caveated",
      primaryViewer: "../benchmark-outcome-analysis/index.html",
      reviewTargetCount: outcome.summary.benchmarkCount,
      affordances: [
        affordance("success/outcome", "ready", `${outcome.summary.reviewPass} review-pass, ${outcome.summary.needsOutputReview} needs-output-review, ${outcome.summary.blockedOrCaveated} caveated.`),
        affordance("five examples", "caveated", `${sampleReview.summary.rowsWithPlayback}/${sampleReview.summary.sampleRows} sampled examples have playback; ${sampleReview.summary.reviewReadyRows} review-ready.`),
        affordance("trajectory playback", "ready", `${closure.summary.trajectoryFiles} trajectory files and ${closure.summary.trajectoryRecords} records; ${closure.summary.sampledExamplesWithPlayback}/${closure.summary.sampledExamples} sampled playback links.`),
        affordance("model input/output", "caveated", `${trajectoryIo.summary.withInput}/${trajectoryIo.summary.records} records with input, ${trajectoryIo.summary.withOutput}/${trajectoryIo.summary.records} with output, ${trajectoryIo.summary.missingOutputWithTokens} token-backed output gaps.`),
        affordance("tokens/cache", "ready", `${fmt(outcome.summary.trajectoryTokens)} tokens, ${fmt(outcome.summary.trajectoryCacheReadTokens)} cached-read, ${percent(outcome.summary.trajectoryCachePercent)} cache.`),
        affordance("manual notes", "ready", `${manualReview.summary.byKind?.["code-agent-benchmark"] || 0} code-agent benchmark note items.`),
      ],
      caveats: ["OSWorld remains smoke/provider-gated.", "Some trajectory rows are tool/action-only or empty-response token rows."],
    },
    {
      id: "benchmark-corpus",
      surface: "Broader benchmark corpus",
      status: "caveated",
      primaryViewer: "../corpus-remediation-matrix/index.html",
      reviewTargetCount: corpusRemediation.summary.familyRows,
      affordances: [
        affordance("success/outcome", "caveated", `${corpus.reviewFindingSummary?.reviewPass || 0} review-pass, ${corpus.reviewFindingSummary?.needsReview || 0} needs-review, ${corpus.reviewFindingSummary?.telemetryGap || 0} telemetry-gap, ${corpus.reviewFindingSummary?.blocked || 0} blocked.`),
        affordance("trajectory playback", "caveated", `${corpus.summary.canonicalTrajectoryFiles} canonical playback files; ${corpusRemediation.summary.canonicalPlaybackFamilies}/${corpusRemediation.summary.familyRows} linked families.`),
        affordance("tokens/cache", "caveated", `${fmt(corpusRemediation.summary.normalizedCalls)} normalized calls, ${fmt(corpusRemediation.summary.tokenTotal)} tokens, ${fmt(corpusRemediation.summary.cachedTokenTotal)} cached; ${corpusRemediation.summary.tokenlessFamilies} tokenless families.`),
        affordance("publication warnings", "caveated", `${corpusRemediation.summary.insufficientWarningLatestRows} insufficient-warning latest rows and ${corpusRemediation.summary.publicationWarningLatestRows} publication-warning latest rows.`),
        affordance("rerun commands", "ready", `${corpusRemediation.summary.rerunCommands} family rerun commands.`),
        affordance("manual notes", "ready", `${manualReview.summary.byKind?.["benchmark-family"] || 0} benchmark-family note items.`),
      ],
      caveats: ["Hyperliquid remains blocked without HL_PRIVATE_KEY.", "Publication warnings still require family-level review."],
    },
    {
      id: "scenarios",
      surface: "Scenarios",
      status: "ready",
      primaryViewer: "../scenario-outcome-matrix/index.html",
      reviewTargetCount: scenarioOutcome.summary.scenarioCount,
      affordances: [
        affordance("execution", "ready", `${scenarioOutcome.summary.executionScenarioCount}/${scenarioOutcome.summary.scenarioCount} scenarios executed; missing ${scenarioOutcome.summary.missingExecution}.`),
        affordance("playback", "ready", `${scenarioOutcome.summary.playbackExistingRows}/${scenarioOutcome.summary.scenarioCount} scenario playback pages.`),
        affordance("success/outcome", "ready", `${scenarioOutcome.summary.passed} passed, ${scenarioOutcome.summary.failedOnly} failed-only, ${scenarioOutcome.summary.nonPassing} non-passing.`),
        affordance("triage", "ready", `${scenarioOutcome.summary.actionableRows} actionable rows, ${scenarioOutcome.summary.evidenceLimitedRows} evidence-limited rows, ${scenarioOutcome.summary.categoryLinkedRows} category-linked rows.`),
        affordance("rerun commands", "ready", `${scenarioOutcome.summary.rerunCommands} scenario rerun commands.`),
        affordance("manual notes", "ready", `${manualReview.summary.byKind?.scenario || 0} scenario note items plus ${manualReview.summary.byKind?.["scenario-failure-category"] || 0} category note items.`),
      ],
      caveats: ["Many failures are review targets rather than fixed outcomes."],
    },
    {
      id: "live-e2e-tests",
      surface: "Live/e2e likely-LLM tests",
      status: "caveated",
      primaryViewer: "../live-test-model-evidence/index.html",
      reviewTargetCount: liveModelEvidence.summary.scriptCount,
      affordances: [
        affordance("artifact evidence", "ready", `${liveModelEvidence.summary.artifactEvidenceScripts}/${liveModelEvidence.summary.scriptCount} likely-LLM scripts have artifact evidence.`),
        affordance("playback", "ready", `${liveModelEvidence.summary.playbackLinkedScripts}/${liveModelEvidence.summary.scriptCount} scripts playback-linked.`),
        affordance("prompt/response", "caveated", `${livePromptResponse.summary.scriptsWithStructuredSidecar}/${livePromptResponse.summary.likelyLlmScripts} script-level sidecars; ${fmt(livePromptResponse.summary.structuredRunCallsParsed)} structured run calls parsed with prompt and response.`),
        affordance("success/outcome", "caveated", `${liveModelEvidence.summary.failedScripts} failed scripts and ${liveModelEvidence.summary.rowsWithFailureClassification} classified failed rows.`),
        affordance("rerun commands", "ready", `${liveModelEvidence.summary.rowsWithRerunCommand}/${liveModelEvidence.summary.scriptCount} rows include rerun commands.`),
        affordance("manual notes", "ready", `${manualReview.summary.byKind?.["live-test"] || 0} live-test note items.`),
      ],
      caveats: ["Script-local prompt/response sidecar breadth is limited; reason-coded status covers the rest."],
    },
    {
      id: "version-comparison",
      surface: "Version comparison",
      status: "caveated",
      primaryViewer: "../version-remediation-matrix/index.html",
      reviewTargetCount: versionRemediation.summary.benchmarkCount,
      affordances: [
        affordance("current playback", "ready", `${versionRemediation.summary.currentPlaybackLinks}/${versionRemediation.summary.benchmarkCount} current playback links.`),
        affordance("previous rows", "caveated", `${versionRemediation.summary.withPrevious}/${versionRemediation.summary.benchmarkCount} benchmarks have previous rows; ${versionRemediation.summary.withoutPrevious} without previous rows.`),
        affordance("playback pairs", "caveated", `${versionRemediation.summary.comparablePlaybackPairs} comparable playback pairs; ${versionRemediation.summary.previousPlaybackGaps} previous playback gaps.`),
        affordance("rerun commands", "ready", `${versionRemediation.summary.rerunCommands} version-history rerun commands.`),
      ],
      caveats: ["mind2web and nl2repo previous rows are aggregate-only; seven benchmarks have no previous run history."],
    },
    {
      id: "manual-review",
      surface: "Manual review workspace",
      status: "caveated",
      primaryViewer: "../manual-review/index.html",
      reviewTargetCount: reviewQueue.summary.itemCount,
      affordances: [
        affordance("queue coverage", "ready", `${reviewQueue.summary.itemCount} review queue items across benchmarks, scenarios, live/e2e, and goal caveats.`),
        affordance("durable notes", "ready", `${manualReview.summary.noteCount}/${reviewQueue.summary.itemCount} note files exist.`),
        affordance("agent triage", "ready", `${manualReview.summary.agentReviewed}/${manualReview.summary.itemCount} note items include generated agent triage.`),
        affordance("human verdicts", "caveated", `${manualReview.summary.reviewed} reviewed and ${manualReview.summary.unreviewed} unreviewed by a human; ${manualReview.summary.highPriorityUnreviewed} high-priority unreviewed.`),
      ],
      caveats: ["Human verdicts remain open by design for the reviewer."],
    },
    {
      id: "external-gates",
      surface: "External gated reruns",
      status: "blocked",
      primaryViewer: "../gap-evidence/index.html",
      reviewTargetCount: 2,
      affordances: [
        affordance("Cerebras key presence", "ready", `CEREBRAS_API_KEY present=${gap.credentials?.cerebrasApiKeyPresent ? "yes" : "no"}; value not persisted.`),
        affordance("OSWorld provider", "blocked", `Runnable OSWorld providers=${gap.osworld?.providerReadiness?.runnableProviderCount || 0}.`),
        affordance("Hyperliquid credential", "blocked", `HL_PRIVATE_KEY present=${gap.credentials?.hyperliquidPrivateKeyPresent ? "yes" : "no"}.`),
        affordance("rerun commands", "ready", `${(gap.remediationCommands?.osworld || []).length + (gap.remediationCommands?.hyperliquid || []).length} placeholder rerun commands.`),
      ],
      caveats: ["Progress is blocked on local/external provider state, not report generation."],
    },
    {
      id: "global-review-navigation",
      surface: "Global review navigation",
      status: "ready",
      primaryViewer: "../global-playback-index/index.html",
      reviewTargetCount: globalPlayback.summary.rowCount,
      affordances: [
        affordance("playback index", "ready", `${globalPlayback.summary.playbackExisting}/${globalPlayback.summary.rowCount} playback rows across ${globalPlayback.summary.groupCount} groups.`),
        affordance("call/event volume", "ready", `${fmt(globalPlayback.summary.totalCallOrEventCount)} calls/events; ${fmt(globalPlayback.summary.totalTokens)} tokens; ${fmt(globalPlayback.summary.cachedTokens)} cached tokens.`),
        affordance("runbook", "ready", "Runbook generation follows this ledger in the analysis build and is verified by runbook.coverage."),
      ],
      caveats: [],
    },
  ];

  const affordances = rows.flatMap((row) => row.affordances.map((item) => ({ ...item, rowId: row.id })));
  const summary = {
    surfaceCount: rows.length,
    ready: rows.filter((row) => row.status === "ready").length,
    caveated: rows.filter((row) => row.status === "caveated").length,
    blocked: rows.filter((row) => row.status === "blocked").length,
    affordanceCount: affordances.length,
    readyAffordances: affordances.filter((item) => item.status === "ready").length,
    caveatedAffordances: affordances.filter((item) => item.status === "caveated").length,
    blockedAffordances: affordances.filter((item) => item.status === "blocked").length,
    reviewTargets: rows.reduce((sum, row) => sum + (Number(row.reviewTargetCount) || 0), 0),
  };

  return {
    schema: "eliza_benchmark_review_readiness_ledger_v1",
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Review Readiness Ledger</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:8px; margin-bottom:12px; }
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
    .affordance { margin:0 0 5px; }
  </style>
</head>
<body>
  <header>
    <h1>Review Readiness Ledger</h1>
    <div class="muted">${escapeHtml(payload.generatedAt)}</div>
  </header>
  <main>
    <section class="summary">
      ${["surfaceCount", "ready", "caveated", "blocked", "affordanceCount", "reviewTargets"].map((key) => `<div class="metric"><span>${escapeHtml(key)}</span><strong>${escapeHtml(payload.summary[key])}</strong></div>`).join("")}
    </section>
    <section class="panel">
      <table>
        <thead><tr><th>surface</th><th>status</th><th>review targets</th><th>affordances</th><th>caveats</th><th>viewer</th></tr></thead>
        <tbody>
          ${payload.rows.map((row) => `<tr><td><code>${escapeHtml(row.id)}</code><br>${escapeHtml(row.surface)}</td><td class="status ${statusClass(row.status)}">${escapeHtml(row.status)}</td><td>${escapeHtml(row.reviewTargetCount)}</td><td>${row.affordances.map((item) => `<div class="affordance"><span class="status ${statusClass(item.status)}">${escapeHtml(item.status)}</span> ${escapeHtml(item.label)}: ${escapeHtml(item.evidence)}</div>`).join("")}</td><td>${(row.caveats || []).map(escapeHtml).join("<br>")}</td><td><a href="${escapeHtml(row.primaryViewer)}">open</a></td></tr>`).join("")}
        </tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Review Readiness Ledger",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Summary: ${payload.summary.ready} ready, ${payload.summary.caveated} caveated, ${payload.summary.blocked} blocked surfaces; ${payload.summary.readyAffordances}/${payload.summary.affordanceCount} affordances ready.`,
    "",
    "| Surface | Status | Targets | Affordances | Viewer |",
    "| --- | --- | ---: | --- | --- |",
    ...payload.rows.map((row) => {
      const affordanceText = row.affordances
        .map((item) => `${item.label}: ${item.status} (${item.evidence})`)
        .join("<br>")
        .replaceAll("|", "\\|");
      return `| \`${row.id}\` | ${row.status} | ${row.reviewTargetCount} | ${affordanceText} | \`${row.primaryViewer}\` |`;
    }),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "review-readiness-ledger.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`review readiness ledger ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
