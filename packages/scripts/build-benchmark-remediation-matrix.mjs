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
  "remediation-matrix",
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

function slug(value) {
  return String(value || "item")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function liveScriptId(row) {
  return `${row.packageJson}:${row.script}`;
}

function liveRerunCommand(row) {
  const packageDir = path.dirname(row.packageJson || ".");
  const cwd = packageDir === "." ? "." : packageDir;
  return [
    "node packages/scripts/run-live-test-with-artifacts.mjs",
    "--label",
    slug(`${row.packageName || cwd}-${row.script}`),
    "--",
    "bun run",
    cwd === "." ? "" : `--cwd ${cwd}`,
    row.script,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildPayload() {
  const audit = readJson("reports/benchmark-analysis/goal-audit.json");
  const closure = readJson(
    "reports/benchmark-analysis/benchmark-closure-matrix/benchmark-closure-matrix.json",
  );
  const objective = readJson("reports/benchmark-analysis/objective-closure/objective-closure.json");
  const agentReview = readJson("reports/benchmark-analysis/agent-review/agent-review.json");
  const live = readJson("reports/live-test-inventory/inventory.json");
  const liveFailureTriage = readJson(
    "reports/benchmark-analysis/live-test-failure-triage/failure-triage.json",
  );
  const liveModelEvidence = readJson(
    "reports/benchmark-analysis/live-test-model-evidence/model-evidence.json",
  );
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const version = readJson(
    "reports/benchmarks/code-agent-version-comparison/version-comparison.json",
  );
  const gap = readJson("reports/benchmark-analysis/gap-evidence/gap-evidence.json");

  const liveById = new Map((live.scriptFindings || []).map((row) => [liveScriptId(row), row]));
  const failureById = new Map((liveFailureTriage.rows || []).map((row) => [row.id, row]));
  const modelEvidenceById = new Map((liveModelEvidence.rows || []).map((row) => [row.id, row]));
  const failureByPlayback = new Map(
    (liveFailureTriage.rows || []).map((row) => [row.playbackHref, row]),
  );
  const rows = [];

  for (const gate of ["osworld", "hyperliquid"]) {
    const command = gap.remediationCommands?.[gate]?.[0];
    if (command) {
      const id = gate === "osworld" ? "osworld-live" : "hyperliquid_bench";
      rows.push({
        id,
        surface: gate === "osworld" ? "code-agent-benchmark" : "benchmark-corpus",
        priority: 100,
        status: "blocked",
        blockerType: gate === "osworld" ? "external-runtime" : "external-credential",
        evidence:
          gate === "osworld"
            ? gap.osworld?.blockerSummary || "No runnable OSWorld provider is configured."
            : `HL_PRIVATE_KEY present=${gap.credentials?.hyperliquidPrivateKeyPresent ? "yes" : "no"}`,
        targetHref:
          gate === "osworld"
            ? "../gap-evidence/osworld-live-readiness.html"
            : "../../benchmarks/benchmark-results-corpus-review/gap-pages/hyperliquid_bench.html",
        nextAction:
          gate === "osworld"
            ? "Configure a runnable OSWorld provider, rerun OSWorld live scoring, then rebuild analysis."
            : "Set HL_PRIVATE_KEY in the shell, rerun Hyperliquid, then rebuild analysis.",
        command: command.command,
        followedBy: command.followedBy || "bun run bench:analysis:build",
        source: "gap-evidence",
      });
    }
  }

  for (const row of closure.rows || []) {
    if (row.readiness !== "complete") {
      rows.push({
        id: row.benchmark,
        surface: "code-agent-benchmark",
        priority: row.agentVerdict === "blocked-live-runtime" ? 95 : 80,
        status: row.readiness,
        blockerType: row.agentVerdict || "benchmark-caveat",
        evidence: (row.caveats || []).join(" "),
        targetHref: row.focusedReviewHref,
        nextAction: row.recommendedAction,
        command: row.benchmark === "osworld" ? gap.remediationCommands?.osworld?.[0]?.command || "" : "",
        followedBy: row.benchmark === "osworld" ? "bun run bench:analysis:build" : "",
        source: "benchmark-closure-matrix",
      });
    }
  }

  const objectiveCaveats = (objective.requirements || []).filter((row) => row.status !== "proven");
  for (const row of objectiveCaveats) {
    if (row.id === "external-gates") continue;
    rows.push({
      id: row.id,
      surface: "objective",
      priority: row.status === "missing" ? 90 : 75,
      status: row.status,
      blockerType: "objective-caveat",
      evidence: row.evidence,
      targetHref: row.viewer,
      nextAction: "Use the linked report to clear or explicitly accept the remaining caveat.",
      command: "",
      followedBy: "",
      source: "objective-closure",
    });
  }

  const liveHighPriority = (agentReview.items || []).filter(
    (row) => row.kind === "live-test" && Number(row.priority) >= 80,
  );
  for (const item of liveHighPriority) {
    const script = liveById.get(item.id);
    const failure = failureById.get(item.id) || failureByPlayback.get(item.targetHref);
    const modelEvidence = modelEvidenceById.get(item.id);
    rows.push({
      id: item.id,
      surface: "live-e2e-test",
      priority: Number(item.priority),
      status: item.agentVerdict,
      blockerType: item.agentVerdict,
      evidence: script ? (script.reasons || []).join("; ") : item.agentEvidence || "",
      targetHref: item.targetHref,
      nextAction: item.recommendedAction,
      command: script ? liveRerunCommand(script) : "",
      followedBy: "bun run bench:analysis:build",
      source: "agent-review",
      failureClassification: failure?.classification || "",
      failureTriageHref: failure ? "../live-test-failure-triage/index.html" : "",
      modelEvidenceHref: modelEvidence ? "../live-test-model-evidence/index.html" : "",
      exitCode: script?.latestWrappedExitCode ?? null,
      structuredReason: script?.structuredLlmCoverageReason || "",
    });
  }

  rows.push({
    id: "corpus-publication-gaps",
    surface: "benchmark-corpus",
    priority: 70,
    status: "caveated",
    blockerType: "publication-and-telemetry-caveats",
    evidence: `${corpus.reviewFindingSummary?.telemetryGap || 0} telemetry-gap families, ${corpus.reviewFindingSummary?.blocked || 0} blocked family, ${corpus.telemetryGapSummary?.insufficientWarningLatestRows || 0} insufficient-warning latest rows, ${corpus.callCatalogSummary?.normalizedCallCount || 0} normalized records.`,
    targetHref: "../../benchmarks/benchmark-results-corpus-review/index.html",
    nextAction: "Use focused family pages and rerun weak families to clear publication warnings and tokenless telemetry caveats.",
    command: "",
    followedBy: "",
    source: "corpus-review",
  });

  rows.push({
    id: "version-comparison-gaps",
    surface: "code-agent-benchmark",
    priority: 65,
    status: "caveated",
    blockerType: "partial-version-history",
    evidence: `${version.summary?.benchmarksWithPrevious || 0}/${version.summary?.benchmarkCount || 0} benchmarks have previous rows; ${version.summary?.comparablePlaybackPairs || 0}/${version.summary?.benchmarksWithPrevious || 0} have comparable previous playback; ${version.summary?.previousPlaybackGapCount || 0} aggregate-only previous playback gaps.`,
    targetHref: "../../benchmarks/code-agent-version-comparison/index.html",
    nextAction: "Keep historical rows; rerun benchmarks with trajectory output when older baselines lack playback.",
    command: "",
    followedBy: "",
    source: "version-comparison",
  });

  const unique = new Map();
  for (const row of rows) {
    const existing = unique.get(row.id);
    if (!existing || Number(row.priority) > Number(existing.priority)) unique.set(row.id, row);
  }
  const sortedRows = [...unique.values()].sort(
    (a, b) => Number(b.priority) - Number(a.priority) || a.id.localeCompare(b.id),
  );

  return {
    schema: "eliza_benchmark_remediation_matrix_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      itemCount: sortedRows.length,
      externalBlockers: sortedRows.filter((row) => String(row.blockerType).startsWith("external")).length,
      liveTestItems: sortedRows.filter((row) => row.surface === "live-e2e-test").length,
      objectiveCaveats: sortedRows.filter((row) => row.surface === "objective").length,
      codeAgentItems: sortedRows.filter((row) => row.surface === "code-agent-benchmark").length,
      corpusItems: sortedRows.filter((row) => row.surface === "benchmark-corpus").length,
      runnableCommands: sortedRows.filter((row) => row.command).length,
      goalAudit: audit.summary || {},
      benchmarkClosure: closure.summary || {},
      liveReview: agentReview.summary || {},
      liveFailureTriage: liveFailureTriage.summary || {},
      liveModelEvidence: liveModelEvidence.summary || {},
    },
    rows: sortedRows,
  };
}

function html(payload) {
  const cards = [
    ["Items", payload.summary.itemCount],
    ["External blockers", payload.summary.externalBlockers],
    ["Live/e2e", payload.summary.liveTestItems],
    ["Objective caveats", payload.summary.objectiveCaveats],
    ["Commands", payload.summary.runnableCommands],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Remediation Matrix</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .muted { color:#5f685d; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    .card { padding:10px 12px; }
    .metric { font-size:22px; font-weight:700; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; min-width:1150px; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#fbfcfa; position:sticky; top:0; z-index:1; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Benchmark Remediation Matrix</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">${cards
      .map(([label, value]) => `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${escapeHtml(value)}</div></div>`)
      .join("")}</section>
    <section class="panel"><h2>Remaining Work</h2><div class="body"><table><thead><tr><th>priority</th><th>id</th><th>surface</th><th>status</th><th>evidence</th><th>next action</th><th>target</th><th>rerun</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td>${escapeHtml(row.priority)}</td><td><code>${escapeHtml(row.id)}</code></td><td>${escapeHtml(row.surface)}</td><td class="${String(row.status).includes("blocked") || String(row.status).includes("fix") ? "bad" : "warn"}">${escapeHtml(row.status)}</td><td>${escapeHtml(row.evidence)}${row.exitCode !== null && row.exitCode !== undefined ? `<br><span class="muted">exit=${escapeHtml(row.exitCode)} structured=${escapeHtml(row.structuredReason)}${row.failureClassification ? ` class=${escapeHtml(row.failureClassification)}` : ""}</span>` : ""}</td><td>${escapeHtml(row.nextAction)}</td><td>${row.targetHref ? `<a href="${escapeHtml(row.targetHref)}">open</a>` : ""}${row.failureTriageHref ? `<br><a href="${escapeHtml(row.failureTriageHref)}">failure triage</a>` : ""}${row.modelEvidenceHref ? `<br><a href="${escapeHtml(row.modelEvidenceHref)}">model evidence</a>` : ""}</td><td>${row.command ? `<code>${escapeHtml(row.command)}</code>${row.followedBy ? `<br><span class="muted">then <code>${escapeHtml(row.followedBy)}</code></span>` : ""}` : ""}</td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Remediation Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Items: ${payload.summary.itemCount}`,
    `External blockers: ${payload.summary.externalBlockers}`,
    `Live/e2e items: ${payload.summary.liveTestItems}`,
    `Runnable command templates: ${payload.summary.runnableCommands}`,
    "",
    "| priority | id | surface | status | target |",
    "| ---: | --- | --- | --- | --- |",
    ...payload.rows.map(
      (row) =>
        `| ${row.priority} | ${row.id} | ${row.surface} | ${row.status} | ${row.targetHref || ""} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "remediation-matrix.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `benchmark remediation matrix ${payload.summary.itemCount} items at ${path.relative(REPO_ROOT, REPORT_DIR)}/index.html\n`,
  );
}

main();
