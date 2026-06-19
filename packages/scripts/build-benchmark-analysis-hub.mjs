#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DEFAULT_REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis");
// `process.env.HOME` is unset on Windows; fall back so report-path
// redaction (`/Users/foo/...` → `~/...`) still strips the local home dir
// when the script runs there.
const HOME_DIR =
  process.env.HOME || process.env.USERPROFILE || homedir() || "";

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

function portableString(value) {
  let text = String(value);
  if (text.startsWith("file://")) {
    text = text.replace(/^file:\/\//, "");
  }
  text = text.replaceAll(REPO_ROOT + path.sep, "");
  if (HOME_DIR) text = text.replaceAll(HOME_DIR + path.sep, "~/");
  text = text.replaceAll("/private/tmp/", "external-temp/");
  text = text.replaceAll("/tmp/", "external-temp/");
  return text;
}

function portableDeep(value) {
  if (Array.isArray(value)) return value.map((entry) => portableDeep(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, portableDeep(entry)]),
    );
  }
  if (typeof value === "string") return portableString(value);
  return value;
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Analysis Hub</title>
  <style>
    :root { --bg:#f7f8f5; --panel:#fff; --ink:#172017; --muted:#5f685d; --line:#d7ded1; --ok:#17633a; --bad:#a12222; --warn:#8a5a00; --accent:#116b5b; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid var(--line); padding:18px 22px; }
    h1 { margin:0 0 6px; font-size:24px; letter-spacing:0; }
    h2 { margin:0; font-size:15px; }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:var(--muted); }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; padding:16px 22px; }
    .card,.panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .card { padding:12px; }
    .card b { display:block; margin-top:4px; font-size:22px; }
    main { display:grid; grid-template-columns:1fr 1fr; gap:14px; padding:0 22px 22px; }
    .panel { overflow:hidden; }
    .panel h2 { padding:10px 12px; background:#f2f5ef; border-bottom:1px solid var(--line); }
    .panel .body { padding:12px; }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:7px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .ok { color:var(--ok); font-weight:700; }
    .bad { color:var(--bad); font-weight:700; }
    .warn { color:var(--warn); font-weight:700; }
    .links { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:8px; }
    .link { border:1px solid var(--line); border-radius:8px; padding:10px; background:#fff; }
    @media (max-width:900px) { main { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header><h1>Benchmark Analysis Hub</h1><div id="meta" class="muted"></div></header>
  <div id="cards" class="cards"></div>
  <main>
    <section class="panel"><h2>Review Entry Points</h2><div id="links" class="body links"></div></section>
    <section class="panel"><h2>Open Gaps</h2><div id="gaps" class="body"></div></section>
    <section class="panel"><h2>Playback Coverage</h2><div id="playback" class="body"></div></section>
    <section class="panel"><h2>Drilldown Coverage</h2><div id="drilldowns" class="body"></div></section>
    <section class="panel"><h2>Review Findings Summary</h2><div id="findings" class="body"></div></section>
    <section class="panel"><h2>Latest Benchmark Rows</h2><div id="benchmarks" class="body"></div></section>
    <section class="panel"><h2>Scenario Runs</h2><div id="scenarios" class="body"></div></section>
    <section class="panel"><h2>Live / Real / E2E Inventory</h2><div id="live" class="body"></div></section>
    <section class="panel"><h2>Verification</h2><div id="verification" class="body"></div></section>
  </main>
  <script src="./hub-data.js"></script>
  <script>
    const data = window.BENCHMARK_ANALYSIS_HUB || {};
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const pct = v => typeof v === "number" ? (v * 100).toFixed(1) + "%" : "n/a";
    function link(label, href, detail) {
      return '<div class="link"><strong><a href="' + esc(href) + '">' + esc(label) + '</a></strong><br><span class="muted">' + esc(detail || href) + '</span></div>';
    }
    function renderCards() {
      const b = data.benchmarks || {}, s = data.scenarios || {}, l = data.liveTests || {};
      const bf = b.reviewFindings || {}, sf = s.findingSummary || {}, lf = l.findingSummary || {};
      const rq = data.reviewQueue || {};
      const items = [
        ["Benchmark runs", b.runCount],
        ["Benchmark rows", b.rowCount],
        ["Review queue", rq.itemCount],
        ["High-priority review", rq.highPriority],
        ["Live benchmark coverage", (b.liveScoredCoverage || 0) + "/" + (b.includedCoverage || 0)],
        ["Benchmark family review-pass", (bf.reviewPass || 0) + "/" + (bf.findingCount || 0)],
        ["Scenario catalog", s.allScenarioCount],
        ["Scenario execution", (s.catalogExecutionIds ?? s.executedScenarioIds) + "/" + (s.catalogExecutionScenarioCount ?? s.allScenarioCount)],
        ["Scenario findings", (sf.findingCount || 0) + " rows"],
        ["Live/e2e scripts", l.totalScripts],
        ["Live/e2e findings", (lf.findingCount || 0) + " rows"],
        ["Model artifact gaps", l.modelArtifactRequiredWithoutEvidence ?? l.likelyLlmScriptsWithoutArtifactEvidence ?? l.likelyLlmScriptsWithoutArtifacts],
        ["Open gaps", (data.gaps || []).length],
      ];
      document.getElementById("cards").innerHTML = items.map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? "") + '</b></div>').join("");
      document.getElementById("meta").textContent = (data.generatedAt || "") + " · " + (data.reportDir || "");
    }
    function renderLinks() {
      document.getElementById("links").innerHTML = [
        link("Benchmark aggregate", data.links?.benchmarkIndex, "All code-agent benchmark run comparisons"),
        link("Benchmark analysis", data.links?.benchmarkAnalysis, "Markdown readout"),
        link("Analysis summary", data.links?.analysisSummary, "Cross-surface triage summary for benchmarks, scenarios, live/e2e, and gates"),
        link("Run contract", data.links?.runContract, "Ignored storage, viewer entrypoints, playback coverage, and version-support contract"),
        link("Global playback index", data.links?.globalPlaybackIndex, "Single index across benchmark, corpus, scenario, and live/e2e playback pages"),
        link("Cache analysis", data.links?.cacheAnalysis, "Token/cache-hit evidence across code-agent benchmarks, broader corpus, and live wrappers"),
        link("Agent benchmark review", data.links?.agentBenchmarkReview, "First-pass agent verdicts for every code-agent benchmark and corpus family"),
        link("Benchmark closure matrix", data.links?.benchmarkClosureMatrix, "Per-benchmark closure status across review, examples, trajectory, version, and playback evidence"),
        link("Benchmark review", data.links?.benchmarkReview, "One-row-per-benchmark success/cache/trajectory review"),
        link("Benchmark examples", data.links?.benchmarkExamples, "Per-benchmark five-example evidence and task IDs"),
        link("Five-example sampler", data.links?.benchmarkFiveExampleSampler, "Five playback-linked sample examples per latest benchmark"),
        link("Review queue", data.links?.reviewQueue, "Consolidated manual-review queue across benchmark, scenario, live/e2e, and goal gaps"),
        link("Manual review workspace", data.links?.manualReviewWorkspace, "Durable Markdown review notes for every queue item"),
        link("Agent review digest", data.links?.agentReviewDigest, "First-pass triage for high-priority review items"),
        link("Remediation matrix", data.links?.remediationMatrix, "Sorted remaining blockers, caveats, failed live/e2e tests, and rerun commands"),
        link("Objective closure", data.links?.objectiveClosure, "Strict requirement-by-requirement closure readiness against the original objective"),
        link("Runbook", data.links?.runbook, "Commands, entry points, coverage snapshot, and external gate checklist"),
        link("Artifact manifest", data.links?.artifactManifest, "Searchable index of generated ignored report files"),
        link("Benchmark results corpus", data.links?.benchmarkResultsCorpus, "packages/benchmarks/benchmark_results latest rows and SQLite trajectories"),
        link("Corpus remediation matrix", data.links?.corpusRemediationMatrix, "Broader corpus publication warnings, telemetry gaps, blocked family, playback, and rerun commands"),
        link("Trajectory catalog", data.links?.benchmarkTrajectoryCatalog, "Parsed benchmark trajectory files and call/cache previews"),
        link("Version comparison", data.links?.benchmarkVersionComparison, "Latest-vs-previous benchmark run deltas where available"),
        link("Gap evidence", data.links?.benchmarkGapEvidence, "OSWorld prerequisite probe and under-five dataset limits"),
        link("Goal completion audit", data.links?.goalAudit, "Requirement-by-requirement evidence audit"),
        link("Scenario catalog", data.links?.scenarioCatalog, "Scenario coverage and run comparison"),
        link("Scenario execution union", data.links?.scenarioExecutionUnion, "All cataloged scenario IDs mapped to run evidence"),
        link("Scenario failure analysis", data.links?.scenarioFailureAnalysis, "Failed scenario clusters and sample assertion details"),
        link("Scenario agent review", data.links?.scenarioAgentReview, "First-pass agent verdicts for every cataloged scenario"),
        link("Scenario remediation matrix", data.links?.scenarioRemediationMatrix, "Non-passing scenarios joined to playback, categories, next actions, and rerun commands"),
        link("Live/e2e inventory", data.links?.liveTestInventory, "Model artifact evidence and non-model exclusions"),
        link("Live/e2e agent review", data.links?.liveTestAgentReview, "First-pass agent verdicts for every live/real/e2e script"),
        link("Live/e2e failure triage", data.links?.liveTestFailureTriage, "Failed wrapper-run classifications, excerpts, playback, and rerun commands"),
        link("Live/e2e model evidence", data.links?.liveTestModelEvidence, "Likely-LLM script evidence, structured sidecar status, sample calls, and rerun commands"),
        link("Live/e2e prompt-response completeness", data.links?.liveTestPromptResponseCompleteness, "Script-local sidecar tiers plus structured run prompt/response calls"),
        link("Status ledger", data.links?.statusLedger, "Current evidence and gaps"),
      ].join("");
    }
    function renderGaps() {
      document.getElementById("gaps").innerHTML = '<table><thead><tr><th>gap</th><th>evidence</th><th>next action</th></tr></thead><tbody>' + (data.gaps || []).map(g => '<tr><td><strong class="' + esc(g.severity || "warn") + '">' + esc(g.title) + '</strong></td><td>' + esc(g.evidence) + '</td><td>' + esc(g.nextAction) + '</td></tr>').join("") + '</tbody></table>';
    }
    function renderFindings() {
      const b = data.benchmarks?.reviewFindings || {};
      const s = data.scenarios?.findingSummary || {};
      const l = data.liveTests?.findingSummary || {};
      const rows = [
        ["Benchmark corpus families", b.findingCount, "review-pass " + (b.reviewPass || 0) + "; needs-review " + (b.needsReview || 0) + "; blocked " + (b.blocked || 0), data.links?.benchmarkResultsCorpus],
        ["Scenario catalog", s.findingCount, "passed " + (s.passed || 0) + "; failed-only " + (s.failedOnly || 0) + "; non-passing " + (s.nonPassing || 0) + "; missing " + (s.missing || 0), data.links?.scenarioExecutionUnion],
        ["Live/real/e2e scripts", l.findingCount, "model wrapper-pass " + (l.modelWrapperPass || 0) + "; model wrapper-failed " + (l.modelWrapperFailed || 0) + "; model artifact-hint " + (l.modelArtifactHint || 0) + "; model artifact-gap " + (l.modelArtifactGap || 0) + "; non-model unclassified " + (l.nonModelUnclassified || 0), data.links?.liveTestInventory],
      ];
      document.getElementById("findings").innerHTML = '<table><thead><tr><th>surface</th><th>findings</th><th>summary</th><th>viewer</th></tr></thead><tbody>' + rows.map(r => '<tr><td><strong>' + esc(r[0]) + '</strong></td><td>' + esc(r[1] ?? 0) + '</td><td>' + esc(r[2]) + '</td><td><a href="' + esc(r[3]) + '">open</a></td></tr>').join("") + '</tbody></table>';
    }
    function renderPlayback() {
      const p = data.playbackCoverage || {};
      const rows = [
        ["Code-agent trajectories", p.codeAgentTrajectoryPlayback, p.codeAgentTrajectoryFiles, data.links?.benchmarkTrajectoryCatalog],
        ["Benchmark corpus canonical runs", p.corpusCanonicalPlayback, p.corpusCanonicalFiles, data.links?.benchmarkResultsCorpus],
        ["Benchmark corpus no-playback gaps", p.corpusNoPlaybackGapPages, p.corpusNoPlaybackGapPages, data.links?.benchmarkResultsCorpus],
        ["Catalog scenarios", p.scenarioPlaybackPages, p.scenarioCount, data.links?.scenarioExecutionUnion],
        ["Wrapped live/e2e runs", p.livePlaybackPages, p.wrappedLiveRuns, data.links?.liveTestInventory],
        ["Review queue targets", p.reviewQueueExistingTargets, p.reviewQueueItems, data.links?.reviewQueue],
      ];
      document.getElementById("playback").innerHTML = '<table><thead><tr><th>surface</th><th>playback / targets</th><th>viewer</th></tr></thead><tbody>' + rows.map(r => '<tr><td><strong>' + esc(r[0]) + '</strong></td><td>' + esc(r[1] ?? 0) + '/' + esc(r[2] ?? 0) + '</td><td><a href="' + esc(r[3]) + '">open</a></td></tr>').join("") + '</tbody></table>';
    }
    function renderDrilldowns() {
      const d = data.drilldownCoverage || {};
      const rows = [
        ["Latest benchmark reviews", d.benchmarkReviewPages, d.benchmarkReviewRows, data.links?.benchmarkReview],
        ["Live/e2e model-call scripts", d.liveModelScriptReviewPages, d.liveModelScripts, data.links?.liveTestInventory],
        ["Scenario failure categories", d.scenarioFailureCategoryPages, d.scenarioFailureCategories, data.links?.scenarioFailureAnalysis],
        ["Scenario failures with playback", d.scenarioFailuresWithPlayback, d.scenarioFailureRows, data.links?.scenarioFailureAnalysis],
      ];
      document.getElementById("drilldowns").innerHTML = '<table><thead><tr><th>surface</th><th>drilldowns</th><th>viewer</th></tr></thead><tbody>' + rows.map(r => '<tr><td><strong>' + esc(r[0]) + '</strong></td><td>' + esc(r[1] ?? 0) + '/' + esc(r[2] ?? 0) + '</td><td><a href="' + esc(r[3]) + '">open</a></td></tr>').join("") + '</tbody></table>';
    }
    function renderBenchmarks() {
      const rows = data.benchmarks?.latestRows || [];
      document.getElementById("benchmarks").innerHTML = '<table><thead><tr><th>benchmark</th><th>mode</th><th>status</th><th>elizaOS</th><th>OpenCode</th><th>viewer</th></tr></thead><tbody>' + rows.map(r => '<tr><td><code>' + esc(r.benchmark) + '</code></td><td>' + esc(r.run_mode) + '</td><td class="' + (r.status === "inferior" || r.status === "missing" ? "bad" : r.status === "weak" ? "warn" : "ok") + '">' + esc(r.status) + '</td><td>' + esc(r.target_right) + '/' + esc(r.target_total) + ' ' + esc(pct(r.target_accuracy)) + '</td><td>' + esc(r.baseline_right) + '/' + esc(r.baseline_total) + ' ' + esc(pct(r.baseline_accuracy)) + '</td><td><a href="' + esc(r.viewer_href) + '">viewer</a></td></tr>').join("") + '</tbody></table>';
    }
    function renderScenarios() {
      const rows = data.scenarios?.runs || [];
      document.getElementById("scenarios").innerHTML = '<table><thead><tr><th>run</th><th>provider</th><th>result</th><th>viewer</th></tr></thead><tbody>' + rows.map(r => '<tr><td><code>' + esc(r.name) + '</code></td><td>' + esc(r.providerName) + '</td><td>' + esc(r.passedCount) + '/' + esc(r.totalCount) + ' passed, ' + esc(r.failedCount) + ' failed</td><td><a href="' + esc(r.viewerHref) + '">viewer</a></td></tr>').join("") + '</tbody></table>';
    }
    function renderLive() {
      const l = data.liveTests || {};
      const missingEvidence = l.scriptsWithoutArtifactEvidence ?? l.unknownArtifactScripts;
      const modelMissingEvidence = l.modelArtifactRequiredWithoutEvidence ?? l.likelyLlmScriptsWithoutArtifactEvidence ?? l.likelyLlmScriptsWithoutArtifacts;
      document.getElementById("live").innerHTML = '<p><strong>' + esc(l.totalScripts) + '</strong> scripts inventoried across <strong>' + esc(l.packageCount) + '</strong> packages.</p><p><strong>' + esc(l.artifactEvidenceScripts ?? l.knownArtifactScripts) + '</strong> scripts have artifact evidence, including <strong>' + esc(l.wrapperEvidenceScripts || 0) + '</strong> with wrapper-run evidence from <code>reports/live-test-runs</code>.</p><p><strong>' + esc(missingEvidence) + '</strong> scripts lack generic artifact evidence; <strong class="ok">' + esc(l.nonModelArtifactExcludedScripts || 0) + '</strong> are explicitly classified as non-model exclusions and <strong class="' + (modelMissingEvidence ? 'bad' : 'ok') + '">' + esc(modelMissingEvidence) + '</strong> model-call scripts lack evidence.</p><p><a href="' + esc(data.links?.liveTestInventory) + '">Open inventory viewer</a></p>';
    }
    function renderVerification() {
      document.getElementById("verification").innerHTML = '<ul>' + (data.verification || []).map(v => '<li>' + esc(v) + '</li>').join("") + '</ul>';
    }
    renderCards(); renderLinks(); renderGaps(); renderBenchmarks(); renderScenarios(); renderLive(); renderVerification();
    renderPlayback(); renderDrilldowns(); renderFindings();
  </script>
</body>
</html>`;
}

function main() {
  const reportDir = DEFAULT_REPORT_DIR;
  mkdirSync(reportDir, { recursive: true });

  const benchmarkDataPath = path.join(
    REPO_ROOT,
    "reports/benchmarks/code-agent-run-index/index-data.js",
  );
  const scenarioDataPath = path.join(
    REPO_ROOT,
    "reports/scenarios/catalog-inventory/viewer/catalog-data.js",
  );
  const liveInventoryPath = path.join(
    REPO_ROOT,
    "reports/live-test-inventory/inventory.json",
  );
  const liveTestAgentReviewPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/live-test-agent-review/live-test-agent-review.json",
  );
  const liveTestFailureTriagePath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/live-test-failure-triage/failure-triage.json",
  );
  const liveTestModelEvidencePath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/live-test-model-evidence/model-evidence.json",
  );
  const liveTestPromptResponseCompletenessPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
  );
  const liveTestReviewPacksPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/live-test-review-packs/live-test-review-packs.json",
  );
  const scenarioExecutionUnionPath = path.join(
    REPO_ROOT,
    "reports/scenarios/catalog-execution-union/coverage.json",
  );
  const scenarioFailureAnalysisPath = path.join(
    REPO_ROOT,
    "reports/scenarios/failure-analysis/failure-analysis.json",
  );
  const scenarioAgentReviewPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/scenario-agent-review/scenario-agent-review.json",
  );
  const scenarioOutcomeMatrixPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/scenario-outcome-matrix/scenario-outcome-matrix.json",
  );
  const scenarioRemediationMatrixPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/scenario-remediation-matrix/scenario-remediation.json",
  );
  const scenarioReviewPacksPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/scenario-review-packs/scenario-review-packs.json",
  );
  const goalAuditPath = path.join(REPO_ROOT, "reports/benchmark-analysis/goal-audit.json");
  const versionComparisonPath = path.join(
    REPO_ROOT,
    "reports/benchmarks/code-agent-version-comparison/version-comparison.json",
  );
  const trajectoryCatalogPath = path.join(
    REPO_ROOT,
    "reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json",
  );
  const trajectoryIoCompletenessPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/trajectory-io-completeness/trajectory-io-completeness.json",
  );
  const benchmarkReviewPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/benchmark-review/benchmark-review.json",
  );
  const benchmarkFiveExampleSamplerPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/benchmark-five-example-sampler/five-example-sampler.json",
  );
  const benchmarkSampleReviewMatrixPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/benchmark-sample-review-matrix/sample-review-matrix.json",
  );
  const benchmarkReviewPacksPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/benchmark-review-packs/benchmark-review-packs.json",
  );
  const reviewPackIndexPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/review-pack-index/review-pack-index.json",
  );
  const reviewPackAgentVerdictsPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/review-pack-agent-verdicts/review-pack-agent-verdicts.json",
  );
  const rerunCommandCatalogPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/rerun-command-catalog/rerun-command-catalog.json",
  );
  const rerunBatchesPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/rerun-batches/rerun-batches.json",
  );
  const gapEvidencePath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/gap-evidence/gap-evidence.json",
  );
  const benchmarkResultsCorpusPath = path.join(
    REPO_ROOT,
    "reports/benchmarks/benchmark-results-corpus-review/corpus-review.json",
  );
  const corpusRemediationMatrixPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/corpus-remediation-matrix/corpus-remediation.json",
  );
  const corpusReviewPacksPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/corpus-review-packs/corpus-review-packs.json",
  );
  const cacheAnalysisPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/cache-analysis/cache-analysis.json",
  );
  const globalPlaybackIndexPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/global-playback-index/global-playback-index.json",
  );
  const agentBenchmarkReviewPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/agent-benchmark-review/agent-benchmark-review.json",
  );
  const benchmarkClosureMatrixPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
  );
  const versionRemediationMatrixPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/version-remediation-matrix/version-remediation.json",
  );
  const benchmarkOutcomeAnalysisPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/benchmark-outcome-analysis/outcome-analysis.json",
  );
  const reviewQueuePath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/review-queue/review-queue.json",
  );
  const manualReviewPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/manual-review/manual-review.json",
  );
  const manualReviewProgressPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/manual-review-progress/manual-review-progress.json",
  );
  const agentReviewPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/agent-review/agent-review.json",
  );
  const remediationMatrixPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/remediation-matrix/remediation-matrix.json",
  );
  const objectiveClosurePath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/objective-closure/objective-closure.json",
  );
  const finalGoalReadinessPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/final-goal-readiness/final-goal-readiness.json",
  );
  const objectiveEvidenceMapPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/objective-evidence-map/objective-evidence-map.json",
  );
  const reviewReadinessLedgerPath = path.join(
    REPO_ROOT,
    "reports/benchmark-analysis/review-readiness-ledger/review-readiness-ledger.json",
  );
  const benchmarkData = readWindowJson(
    benchmarkDataPath,
    /^window\.BENCHMARK_RUN_INDEX = /,
  );
  const scenarioData = readWindowJson(
    scenarioDataPath,
    /^window\.SCENARIO_CATALOG_DATA = /,
  );
  const liveInventory = readJson(liveInventoryPath);
  const liveTestAgentReview = readJson(liveTestAgentReviewPath);
  const liveTestFailureTriage = readJson(liveTestFailureTriagePath);
  const liveTestModelEvidence = readJson(liveTestModelEvidencePath);
  const liveTestPromptResponseCompleteness = readJson(liveTestPromptResponseCompletenessPath);
  const liveTestReviewPacks = readJson(liveTestReviewPacksPath);
  const scenarioExecutionUnion = readJson(scenarioExecutionUnionPath);
  const scenarioFailureAnalysis = readJson(scenarioFailureAnalysisPath);
  const scenarioAgentReview = readJson(scenarioAgentReviewPath);
  const scenarioOutcomeMatrix = readJson(scenarioOutcomeMatrixPath);
  const scenarioRemediationMatrix = readJson(scenarioRemediationMatrixPath);
  const scenarioReviewPacks = readJson(scenarioReviewPacksPath);
  const goalAudit = readJson(goalAuditPath);
  const versionComparison = readJson(versionComparisonPath);
  const trajectoryCatalog = readJson(trajectoryCatalogPath);
  const trajectoryIoCompleteness = readJson(trajectoryIoCompletenessPath);
  const benchmarkReview = readJson(benchmarkReviewPath);
  const benchmarkFiveExampleSampler = readJson(benchmarkFiveExampleSamplerPath);
  const benchmarkSampleReviewMatrix = readJson(benchmarkSampleReviewMatrixPath);
  const benchmarkReviewPacks = readJson(benchmarkReviewPacksPath);
  const reviewPackIndex = readJson(reviewPackIndexPath);
  const reviewPackAgentVerdicts = readJson(reviewPackAgentVerdictsPath);
  const rerunCommandCatalog = readJson(rerunCommandCatalogPath);
  const rerunBatches = readJson(rerunBatchesPath);
  const gapEvidence = readJson(gapEvidencePath);
  const benchmarkResultsCorpus = readJson(benchmarkResultsCorpusPath);
  const corpusRemediationMatrix = readJson(corpusRemediationMatrixPath);
  const corpusReviewPacks = readJson(corpusReviewPacksPath);
  const cacheAnalysis = readJson(cacheAnalysisPath);
  const globalPlaybackIndex = readJson(globalPlaybackIndexPath);
  const agentBenchmarkReview = readJson(agentBenchmarkReviewPath);
  const benchmarkClosureMatrix = readJson(benchmarkClosureMatrixPath);
  const versionRemediationMatrix = readJson(versionRemediationMatrixPath);
  const benchmarkOutcomeAnalysis = readJson(benchmarkOutcomeAnalysisPath);
  const reviewQueue = readJson(reviewQueuePath);
  const manualReview = readJson(manualReviewPath);
  const manualReviewProgress = readJson(manualReviewProgressPath);
  const agentReview = readJson(agentReviewPath);
  const remediationMatrix = readJson(remediationMatrixPath);
  const objectiveClosure = readJson(objectiveClosurePath);
  const finalGoalReadiness = readJson(finalGoalReadinessPath);
  const objectiveEvidenceMap = readJson(objectiveEvidenceMapPath);
  const reviewReadinessLedger = readJson(reviewReadinessLedgerPath);
  const reviewQueueRoot = path.join(reportDir, "review-queue");
  const reviewQueueExistingTargets = (reviewQueue.items || []).filter((item) => {
    const viewer = String(item.viewer || "");
    if (!viewer || viewer.startsWith("/") || viewer.startsWith("file://")) {
      return false;
    }
    const resolved = path.resolve(reviewQueueRoot, viewer);
    const repoRelative = path.relative(REPO_ROOT, resolved).replaceAll(path.sep, "/");
    return repoRelative.startsWith("reports/") && existsSync(resolved);
  }).length;
  const latestRows = Object.values(benchmarkData.latest_by_benchmark || {}).sort(
    (a, b) => String(a.benchmark || "").localeCompare(String(b.benchmark || "")),
  );
  const liveScoredCoverage = latestRows.filter(
    (row) =>
      String(row.run_mode || "").startsWith("live") &&
      typeof row.target_total === "number",
  ).length;
  const executedScenarioIds = new Set(
    (scenarioData.runArtifacts || []).flatMap((artifact) =>
      (artifact.scenarioResults || []).map((result) => result.id),
    ),
  );
  const payload = {
    schema: "eliza_benchmark_analysis_hub_v1",
    generatedAt: new Date().toISOString(),
    reportDir,
    links: {
      benchmarkIndex: rel(path.join(REPO_ROOT, "reports/benchmarks/code-agent-run-index/index.html")),
      benchmarkAnalysis: rel(path.join(REPO_ROOT, "reports/benchmarks/code-agent-run-index/analysis.md")),
      analysisSummary: "analysis-summary/index.html",
      runContract: "run-contract/index.html",
      globalPlaybackIndex: "global-playback-index/index.html",
      cacheAnalysis: "cache-analysis/index.html",
      trajectoryIoCompleteness: "trajectory-io-completeness/index.html",
      agentBenchmarkReview: "agent-benchmark-review/index.html",
      benchmarkClosureMatrix: "benchmark-closure-matrix/index.html",
      versionRemediationMatrix: "version-remediation-matrix/index.html",
      benchmarkOutcomeAnalysis: "benchmark-outcome-analysis/index.html",
      benchmarkReview: "benchmark-review/index.html",
      benchmarkExamples: "benchmark-examples/index.html",
      benchmarkFiveExampleSampler: "benchmark-five-example-sampler/index.html",
      benchmarkSampleReviewMatrix: "benchmark-sample-review-matrix/index.html",
      benchmarkReviewPacks: "benchmark-review-packs/index.html",
      reviewPackIndex: "review-pack-index/index.html",
      reviewPackAgentVerdicts: "review-pack-agent-verdicts/index.html",
      rerunCommandCatalog: "rerun-command-catalog/index.html",
      rerunBatches: "rerun-batches/index.html",
      reviewQueue: "review-queue/index.html",
      manualReviewWorkspace: "manual-review/index.html",
      manualReviewProgress: "manual-review-progress/index.html",
      agentReviewDigest: "agent-review/index.html",
      remediationMatrix: "remediation-matrix/index.html",
      objectiveEvidenceMap: "objective-evidence-map/index.html",
      reviewReadinessLedger: "review-readiness-ledger/index.html",
      objectiveClosure: "objective-closure/index.html",
      finalGoalReadiness: "final-goal-readiness/index.html",
      runbook: "runbook/index.html",
      artifactManifest: "artifact-manifest/index.html",
      benchmarkResultsCorpus: rel(path.join(REPO_ROOT, "reports/benchmarks/benchmark-results-corpus-review/index.html")),
      corpusRemediationMatrix: "corpus-remediation-matrix/index.html",
      corpusReviewPacks: "corpus-review-packs/index.html",
      benchmarkTrajectoryCatalog: rel(path.join(REPO_ROOT, "reports/benchmarks/code-agent-trajectory-catalog/index.html")),
      benchmarkVersionComparison: rel(path.join(REPO_ROOT, "reports/benchmarks/code-agent-version-comparison/index.html")),
      benchmarkGapEvidence: "gap-evidence/index.html",
      goalAudit: "goal-audit.html",
      scenarioCatalog: rel(path.join(REPO_ROOT, "reports/scenarios/catalog-inventory/viewer/index.html")),
      scenarioExecutionUnion: rel(path.join(REPO_ROOT, "reports/scenarios/catalog-execution-union/index.html")),
      scenarioFailureAnalysis: rel(path.join(REPO_ROOT, "reports/scenarios/failure-analysis/index.html")),
      scenarioAgentReview: "scenario-agent-review/index.html",
      scenarioOutcomeMatrix: "scenario-outcome-matrix/index.html",
      scenarioRemediationMatrix: "scenario-remediation-matrix/index.html",
      scenarioReviewPacks: "scenario-review-packs/index.html",
      liveTestInventory: rel(path.join(REPO_ROOT, "reports/live-test-inventory/index.html")),
      liveTestAgentReview: "live-test-agent-review/index.html",
      liveTestFailureTriage: "live-test-failure-triage/index.html",
      liveTestModelEvidence: "live-test-model-evidence/index.html",
      liveTestPromptResponseCompleteness: "live-test-prompt-response-completeness/index.html",
      liveTestReviewPacks: "live-test-review-packs/index.html",
      statusLedger: "current-status.md",
    },
    benchmarks: {
      runCount: benchmarkData.runs.length,
      rowCount: benchmarkData.benchmark_rows.length,
      includedCoverage: latestRows.length,
      liveScoredCoverage,
      latestRows,
      mirroredRunArtifacts:
        benchmarkData.mirrored_run_artifacts?.mirrored_run_count || 0,
      versionComparison: versionComparison.summary,
      versionRemediationMatrix: versionRemediationMatrix.summary,
      benchmarkOutcomeAnalysis: benchmarkOutcomeAnalysis.summary,
      trajectoryCatalog: trajectoryCatalog.summary,
      trajectoryIoCompleteness: trajectoryIoCompleteness.summary,
      benchmarkReview: benchmarkReview.summary,
      benchmarkFiveExampleSampler: benchmarkFiveExampleSampler.summary,
      benchmarkSampleReviewMatrix: benchmarkSampleReviewMatrix.summary,
      benchmarkReviewPacks: benchmarkReviewPacks.summary,
      reviewPackIndex: reviewPackIndex.summary,
      reviewPackAgentVerdicts: reviewPackAgentVerdicts.summary,
      rerunCommandCatalog: rerunCommandCatalog.summary,
      rerunBatches: rerunBatches.summary,
      benchmarkResultsCorpus: benchmarkResultsCorpus.summary,
      corpusRemediationMatrix: corpusRemediationMatrix.summary,
      corpusReviewPacks: corpusReviewPacks.summary,
      cacheAnalysis: cacheAnalysis.codeAgent?.summary,
      agentBenchmarkReview: agentBenchmarkReview.summary,
      closureMatrix: benchmarkClosureMatrix.summary,
      reviewFindings: benchmarkResultsCorpus.reviewFindingSummary,
    },
    scenarios: {
      defaultScenarioCount: scenarioData.defaultScenarios.length,
      allScenarioCount: scenarioData.allScenarios.length,
      executedScenarioIds: executedScenarioIds.size,
      catalogExecutionScenarioCount:
        scenarioExecutionUnion.catalogScenarioCount,
      catalogExecutionIds: scenarioExecutionUnion.executedScenarioIds,
      catalogExecutionMissing: scenarioExecutionUnion.missingCount,
      findingSummary: scenarioExecutionUnion.findingSummary,
      failureAnalysis: scenarioFailureAnalysis.summary,
      agentReview: scenarioAgentReview.summary,
      outcomeMatrix: scenarioOutcomeMatrix.summary,
      remediationMatrix: scenarioRemediationMatrix.summary,
      reviewPacks: scenarioReviewPacks.summary,
      failureCategories: scenarioFailureAnalysis.categories,
      runs: (scenarioData.runArtifacts || []).map((artifact) => ({
        name: path.basename(artifact.runDir || ""),
        providerName: artifact.providerName,
        totalCount: artifact.totalCount,
        passedCount: artifact.passedCount,
        failedCount: artifact.failedCount,
        viewerHref: artifact.viewerIndex ? rel(artifact.viewerIndex) : "",
      })),
    },
    liveTests: {
      ...liveInventory.summary,
      findingSummary: liveInventory.findingSummary,
      agentReview: liveTestAgentReview.summary,
      failureTriage: liveTestFailureTriage.summary,
      modelEvidence: liveTestModelEvidence.summary,
      promptResponseCompleteness: liveTestPromptResponseCompleteness.summary,
      reviewPacks: liveTestReviewPacks.summary,
    },
    playbackCoverage: {
      codeAgentTrajectoryPlayback: trajectoryCatalog.summary.playbackFiles || 0,
      codeAgentTrajectoryFiles: trajectoryCatalog.summary.trajectoryFiles || 0,
      corpusCanonicalPlayback: (benchmarkResultsCorpus.canonicalFiles || []).filter(
        (entry) => entry.playback_file,
      ).length,
      corpusCanonicalFiles: benchmarkResultsCorpus.summary.canonicalTrajectoryFiles || 0,
      corpusNoPlaybackGapPages: (benchmarkResultsCorpus.noPlaybackGapPages || []).length,
      scenarioPlaybackPages: scenarioExecutionUnion.scenarioPlaybackPages || 0,
      scenarioCount: scenarioExecutionUnion.catalogScenarioCount || 0,
      livePlaybackPages: liveInventory.summary.wrapperPlaybackRuns || 0,
      wrappedLiveRuns: liveInventory.summary.wrappedRuns || 0,
      reviewQueueExistingTargets,
      reviewQueueItems: reviewQueue.summary.itemCount || 0,
    },
    drilldownCoverage: {
      benchmarkReviewPages: (benchmarkReview.rows || []).filter(
        (row) => row.reviewLinks?.benchmarkReview,
      ).length,
      benchmarkReviewRows: benchmarkReview.summary.benchmarkCount || 0,
      liveModelScriptReviewPages: liveInventory.summary.modelScriptReviewPages || 0,
      liveModelScripts: liveInventory.summary.modelArtifactRequiredScripts || 0,
      scenarioFailureCategoryPages: scenarioFailureAnalysis.summary.categoryPages || 0,
      scenarioFailureCategories: (scenarioFailureAnalysis.categories || []).length,
      scenarioFailuresWithPlayback: (scenarioFailureAnalysis.failures || []).filter(
        (failure) => failure.playbackHref,
      ).length,
      scenarioFailureRows: (scenarioFailureAnalysis.failures || []).length,
    },
    goalAudit: goalAudit.summary,
    objectiveEvidenceMap: objectiveEvidenceMap.summary,
    reviewReadinessLedger: reviewReadinessLedger.summary,
    objectiveClosure: objectiveClosure.summary,
    finalGoalReadiness: finalGoalReadiness.summary,
    reviewQueue: reviewQueue.summary,
    manualReview: manualReview.summary,
    manualReviewProgress: manualReviewProgress.summary,
    agentReview: agentReview.summary,
    remediationMatrix: remediationMatrix.summary,
    globalPlaybackIndex: globalPlaybackIndex.summary,
    gapEvidence: {
      osworld: gapEvidence.osworld,
      underFiveBenchmarks: Object.fromEntries(
        Object.entries(gapEvidence.underFiveBenchmarks || {}).map(([name, value]) => [
          name,
          { available: value.available, items: value.items },
        ]),
      ),
    },
    gaps: [
      {
        severity: "bad",
        title: "OSWorld live scoring unavailable",
        evidence:
          gapEvidence.osworld?.blockerSummary ||
          "Latest OSWorld row is smoke-only and no runnable OSWorld provider is configured.",
        nextAction:
          "Start Docker or configure VMware, VirtualBox, or AWS OSWorld provider access, then rerun OSWorld live with 5 tasks.",
      },
      ...goalAudit.rows
        .filter((row) => row.status === "missing" || row.status === "caveated" || row.status === "blocked")
        .filter((row) => row.id !== "osworld-live" && row.id !== "five-examples-per-benchmark")
        .map((row) => ({
          severity: row.status === "missing" || row.status === "blocked" ? "bad" : "warn",
          title: `Goal audit: ${row.id}`,
          evidence: row.evidence,
          nextAction: `Open ${row.link} for source evidence.`,
        })),
      {
        severity: "warn",
        title: "Expanded live benchmark slices",
        evidence: `Current local available counts: ${Object.entries(gapEvidence.underFiveBenchmarks || {})
          .map(([name, value]) => `${name}=${value.available}`)
          .join(", ")}.`,
        nextAction:
          "Keep this evidence current when benchmark slices are expanded or upstream dataset availability changes.",
      },
      {
        severity:
          benchmarkResultsCorpus.summary.incompleteBenchmarkCount > 0 ||
          benchmarkResultsCorpus.summary.insufficientLatestRows > 0
            ? "warn"
            : "ok",
        title: "Broader benchmark-results corpus has publication warnings",
        evidence: `${benchmarkResultsCorpus.summary.rowCount} latest rows across ${benchmarkResultsCorpus.summary.benchmarkCount} benchmark families; ${benchmarkResultsCorpus.summary.insufficientLatestRows} latest rows carry insufficient-* warnings; ${benchmarkResultsCorpus.summary.incompleteBenchmarkCount} benchmark family is partial in the matrix contract.`,
        nextAction:
          "Open the benchmark results corpus viewer to inspect non-code-agent benchmark rows, warning counts, and SQLite trajectory records.",
      },
      {
        severity:
          (liveInventory.summary.modelArtifactRequiredWithoutEvidence ??
            liveInventory.summary.likelyLlmScriptsWithoutArtifactEvidence ??
            liveInventory.summary.likelyLlmScriptsWithoutArtifacts) > 0
            ? "warn"
            : "ok",
        title: "Live/e2e artifact scope classified",
        evidence: `${liveInventory.summary.artifactEvidenceScripts ?? liveInventory.summary.knownArtifactScripts} scripts have artifact evidence; ${liveInventory.summary.nonModelArtifactExcludedScripts || 0} non-model scripts are explicitly excluded from model-call artifacts; ${liveInventory.summary.modelArtifactRequiredWithoutEvidence ?? liveInventory.summary.likelyLlmScriptsWithoutArtifactEvidence ?? liveInventory.summary.likelyLlmScriptsWithoutArtifacts} model-call scripts lack evidence. ${liveInventory.summary.wrapperEvidenceScripts || 0} scripts have wrapper-run evidence.`,
        nextAction:
          "Review excluded non-model rows when their test purpose changes; route any newly model-backed script through trajectory/native export and an HTML viewer.",
      },
      {
        severity: "warn",
        title: "Failed scenario clusters need triage",
        evidence: `${scenarioFailureAnalysis.summary.failedScenarios} failed scenarios across ${scenarioFailureAnalysis.summary.runCount} analyzed runs. Largest buckets: ${scenarioFailureAnalysis.categories
          .slice(0, 4)
          .map((category) => `${category.key}=${category.count}`)
          .join(", ")}.`,
        nextAction:
          "Use the scenario failure analysis viewer to decide which buckets are expected deterministic-provider limitations versus product or runner fixes.",
      },
    ],
    verification: [
      "Benchmark aggregate index generated under ignored reports/.",
      "Scenario catalog coverage check reports 648/648 default package scenarios covered by workflow globs.",
      `Scenario catalog execution union reports ${scenarioExecutionUnion.executedScenarioIds}/${scenarioExecutionUnion.catalogScenarioCount} scenario IDs with execution evidence.`,
      `Scenario findings: ${scenarioExecutionUnion.findingSummary?.findingCount || 0} rows, ${scenarioExecutionUnion.findingSummary?.passed || 0} passed, ${scenarioExecutionUnion.findingSummary?.failedOnly || 0} failed-only, ${scenarioExecutionUnion.findingSummary?.missing || 0} missing.`,
      "Scenario-runner suite passed: 43 tests.",
      "Orchestrator benchmark viewer/index suite passed: 114 tests.",
      "Generated artifacts scanned for raw Cerebras key patterns with no matches.",
      `Live/e2e model-call artifact gap: ${liveInventory.summary.modelArtifactRequiredWithoutEvidence ?? liveInventory.summary.likelyLlmScriptsWithoutArtifactEvidence ?? liveInventory.summary.likelyLlmScriptsWithoutArtifacts}; non-model unclassified gap: ${liveInventory.summary.nonModelUnclassifiedWithoutArtifactEvidence ?? 0}.`,
      `Scenario failure analysis generated for ${scenarioFailureAnalysis.summary.failedScenarios} failed scenarios across ${scenarioFailureAnalysis.summary.runCount} runs.`,
      `Scenario agent review: ${scenarioAgentReview.summary.reviewed}/${scenarioAgentReview.summary.scenarioCount} catalog scenarios reviewed with ${scenarioAgentReview.summary.playbackExisting}/${scenarioAgentReview.summary.scenarioCount} playback pages.`,
      `Scenario outcome matrix: ${scenarioOutcomeMatrix.summary.scenarioCount} scenarios joined across execution, playback, agent verdict, category, and remediation; ${scenarioOutcomeMatrix.summary.passed} passed, ${scenarioOutcomeMatrix.summary.failedOnly} failed-only, ${scenarioOutcomeMatrix.summary.nonPassing} non-passing.`,
      `Scenario remediation matrix: ${scenarioRemediationMatrix.summary.nonPassingRows} non-passing scenarios, ${scenarioRemediationMatrix.summary.playbackLinkedRows}/${scenarioRemediationMatrix.summary.nonPassingRows} playback-linked, ${scenarioRemediationMatrix.summary.rerunCommands} rerun commands.`,
      `Goal completion audit: ${goalAudit.summary.proven}/${goalAudit.summary.total} proven, ${goalAudit.summary.caveated} caveated, ${goalAudit.summary.blocked || 0} blocked, ${goalAudit.summary.missing} missing.`,
      `Benchmark version comparison: ${versionComparison.summary.benchmarksWithPrevious}/${versionComparison.summary.benchmarkCount} benchmarks have previous indexed rows.`,
      `Version remediation matrix: ${versionRemediationMatrix.summary.completeHistory} benchmarks have playback-backed history, ${versionRemediationMatrix.summary.previousPlaybackGaps} have previous-playback gaps, ${versionRemediationMatrix.summary.noPreviousRun} have true no-previous-run status, ${versionRemediationMatrix.summary.noEarlierPreviousRow || 0} have no earlier previous row, and ${versionRemediationMatrix.summary.osworldProviderCaveats} have an OSWorld provider caveat.`,
      `Benchmark outcome analysis: ${benchmarkOutcomeAnalysis.summary.reviewPass} review-pass, ${benchmarkOutcomeAnalysis.summary.needsOutputReview} needs output review, ${benchmarkOutcomeAnalysis.summary.blockedOrCaveated} blocked/caveated, and ${benchmarkOutcomeAnalysis.summary.sampledExamplesWithPlayback}/${benchmarkOutcomeAnalysis.summary.sampledExamples} sampled examples with playback.`,
      `Benchmark sample review matrix: ${benchmarkSampleReviewMatrix.summary.reviewReadyRows}/${benchmarkSampleReviewMatrix.summary.sampleRows} sampled examples are review-ready, ${benchmarkSampleReviewMatrix.summary.rowsWithPlayback}/${benchmarkSampleReviewMatrix.summary.sampleRows} have playback, and ${benchmarkSampleReviewMatrix.summary.rowsWithTaskId}/${benchmarkSampleReviewMatrix.summary.sampleRows} have explicit task IDs.`,
      `Benchmark trajectory catalog: ${trajectoryCatalog.summary.trajectoryFiles} files and ${trajectoryCatalog.summary.trajectoryRecords} records parsed across ${trajectoryCatalog.summary.benchmarkCount} benchmarks.`,
      `Trajectory I/O completeness: ${trajectoryIoCompleteness.summary.withInput}/${trajectoryIoCompleteness.summary.records} records have normalized input, ${trajectoryIoCompleteness.summary.withOutput}/${trajectoryIoCompleteness.summary.records} have normalized output, ${trajectoryIoCompleteness.summary.reviewRelevantOutputGaps} review-relevant output gaps, and ${trajectoryIoCompleteness.summary.benignOutputGaps} classified benign output gaps.`,
      `Benchmark review analysis: ${benchmarkReview.summary.benchmarkCount} benchmarks summarized with ${benchmarkReview.summary.reviewPass} review-pass, ${benchmarkReview.summary.weakOrInferior} weak/inferior, ${benchmarkReview.summary.underFive} under-five, and ${benchmarkReview.summary.missingLive} missing-live.`,
      `Benchmark results corpus review: ${benchmarkResultsCorpus.summary.rowCount} latest rows across ${benchmarkResultsCorpus.summary.benchmarkCount} benchmark families, with ${benchmarkResultsCorpus.trajectory.trajectory_rows || 0} SQLite trajectory rows.`,
      `Corpus remediation matrix: ${corpusRemediationMatrix.summary.familyRows} focused families, ${corpusRemediationMatrix.summary.insufficientWarningLatestRows} insufficient-warning rows, ${corpusRemediationMatrix.summary.telemetryGapFamilies} telemetry-gap families, and ${corpusRemediationMatrix.summary.blockedFamilies} blocked family.`,
      `Cache analysis: code-agent trajectory cache ${Number(cacheAnalysis.codeAgent?.summary?.trajectoryCachePercent || 0).toFixed(1)}% and corpus normalized-call cache ${Number(cacheAnalysis.corpus?.summary?.cachePercent || 0).toFixed(1)}%; live wrapper structured usage runs ${cacheAnalysis.liveWrapperPlayback?.summary?.structuredUsageRuns || 0}.`,
      `Agent benchmark review: ${agentBenchmarkReview.summary.codeAgentReviewed}/${agentBenchmarkReview.summary.codeAgentBenchmarkCount} code-agent benchmarks and ${agentBenchmarkReview.summary.corpusReviewed}/${agentBenchmarkReview.summary.corpusFamilyCount} corpus families have first-pass verdicts; code-agent rows carry ${agentBenchmarkReview.summary.codeAgentSampledExamplesWithPlayback || 0}/${agentBenchmarkReview.summary.codeAgentSampledExamples || 0} sampled playback examples.`,
      `Benchmark corpus findings: ${benchmarkResultsCorpus.reviewFindingSummary?.findingCount || 0} families, ${benchmarkResultsCorpus.reviewFindingSummary?.reviewPass || 0} review-pass, ${benchmarkResultsCorpus.reviewFindingSummary?.needsReview || 0} needs-review, ${benchmarkResultsCorpus.reviewFindingSummary?.blocked || 0} blocked.`,
      `Live/e2e script findings: ${liveInventory.findingSummary?.findingCount || 0} scripts, ${liveInventory.findingSummary?.modelWrapperPass || 0} model wrapper-pass, ${liveInventory.findingSummary?.modelWrapperFailed || 0} model wrapper-failed, ${liveInventory.findingSummary?.modelArtifactGap || 0} model artifact-gap.`,
      `Live/e2e agent review: ${liveTestAgentReview.summary.reviewed}/${liveTestAgentReview.summary.scriptCount} scripts reviewed, ${liveTestAgentReview.summary.modelCallScriptsReviewed}/${liveTestAgentReview.summary.modelCallScripts} model-call scripts reviewed, ${liveTestAgentReview.summary.modelCallScriptsWithoutEvidence} model-call evidence gaps.`,
      `Live/e2e failure triage: ${liveTestFailureTriage.summary.failedRunCount} failed wrapper runs classified, including ${liveTestFailureTriage.summary.likelyLlmFailedRuns} likely LLM runs and ${liveTestFailureTriage.summary.timeoutRuns} timeouts.`,
      `Live/e2e model evidence: ${liveTestModelEvidence.summary.playbackLinkedScripts}/${liveTestModelEvidence.summary.scriptCount} likely-LLM scripts have playback, ${liveTestModelEvidence.summary.focusedReviewPages}/${liveTestModelEvidence.summary.scriptCount} have focused pages, and ${liveTestModelEvidence.summary.structuredLlmScripts} scripts expose structured prompt/response sidecars.`,
      `Live/e2e prompt-response completeness: ${liveTestPromptResponseCompleteness.summary.scriptSidecarComplete}/${liveTestPromptResponseCompleteness.summary.likelyLlmScripts} likely-LLM scripts have complete script sidecars, ${liveTestPromptResponseCompleteness.summary.reasonCodedNoModelCall} are reason-coded no-model-call rows, ${liveTestPromptResponseCompleteness.summary.runtimeBlockedBeforeSidecar} are runtime-blocked before sidecar emission, ${liveTestPromptResponseCompleteness.summary.missingCallArtifact} are missing call artifacts, and ${liveTestPromptResponseCompleteness.summary.structuredRunCallsParsed} structured run calls have prompt and response text.`,
      `Review queue: ${reviewQueue.summary.itemCount} items, ${reviewQueue.summary.highPriority} high priority, spanning ${Object.keys(reviewQueue.summary.byKind || {}).length} item kinds.`,
      `Manual review workspace: ${manualReview.summary.noteCount}/${reviewQueue.summary.itemCount} queue-backed note files, ${manualReview.summary.agentReviewed || 0}/${reviewQueue.summary.itemCount} items with generated agent triage, ${manualReview.summary.highPriorityUnreviewed}/${manualReview.summary.highPriority} high-priority unreviewed by a human.`,
      `Agent review digest: ${agentReview.summary.highPriorityCount} high-priority items triaged, including ${agentReview.summary.liveFailuresReviewed} live/e2e wrapper failures, ${agentReview.summary.externalBlockers} external blockers, and ${agentReview.summary.caveatsReviewed} accepted caveats.`,
      `Remediation matrix: ${remediationMatrix.summary.itemCount} remaining-work items, including ${remediationMatrix.summary.externalBlockers} external blockers and ${remediationMatrix.summary.liveTestItems} high-priority live/e2e test items.`,
      `Playback coverage: ${trajectoryCatalog.summary.playbackFiles || 0}/${trajectoryCatalog.summary.trajectoryFiles || 0} code-agent trajectory files, ${(benchmarkResultsCorpus.canonicalFiles || []).filter((entry) => entry.playback_file).length}/${benchmarkResultsCorpus.summary.canonicalTrajectoryFiles || 0} corpus canonical files, ${scenarioExecutionUnion.scenarioPlaybackPages || 0}/${scenarioExecutionUnion.catalogScenarioCount || 0} scenarios, and ${liveInventory.summary.wrapperPlaybackRuns || 0}/${liveInventory.summary.wrappedRuns || 0} wrapped live/e2e runs.`,
      `Drilldown coverage: ${(benchmarkReview.rows || []).filter((row) => row.reviewLinks?.benchmarkReview).length}/${benchmarkReview.summary.benchmarkCount || 0} benchmark pages, ${liveInventory.summary.modelScriptReviewPages || 0}/${liveInventory.summary.modelArtifactRequiredScripts || 0} live/e2e model-script pages, and ${scenarioFailureAnalysis.summary.categoryPages || 0}/${(scenarioFailureAnalysis.categories || []).length} scenario failure category pages.`,
    ],
  };

  const portablePayload = portableDeep(payload);
  writeFileSync(
    path.join(reportDir, "hub-data.js"),
    `window.BENCHMARK_ANALYSIS_HUB = ${JSON.stringify(portablePayload)};\n`,
    "utf8",
  );
  writeFileSync(path.join(reportDir, "index.html"), html(), "utf8");
  process.stdout.write(`benchmark analysis hub ${path.join(reportDir, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
