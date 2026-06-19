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

function liveLocalAction(classification) {
  const actions = {
    "bad-command-or-missing-args": {
      actionLane: "fix-command-invocation",
      credentialRequired: false,
      localAction:
        "Fix the package script or wrapper arguments so the command receives the required run JSON/input flags, then rerun through the artifact wrapper.",
    },
    "missing-android-emulator": {
      actionLane: "provision-local-emulator",
      credentialRequired: false,
      localAction:
        "Start or configure the local Android emulator/simulator expected by the mobile chat test, then rerun through the artifact wrapper.",
    },
    timeout: {
      actionLane: "narrow-timeout-scope",
      credentialRequired: false,
      localAction:
        "Narrow the live benchmark scope or raise the wrapper timeout so the run reaches a conclusive pass/fail before sidecar collection ends.",
    },
    "missing-test-preload": {
      actionLane: "fix-test-preload",
      credentialRequired: false,
      localAction:
        "Restore the missing test preload/bootstrap file or config for the E2E runner, then rerun through the artifact wrapper.",
    },
    "missing-model-provider": {
      actionLane: "configure-local-model-provider",
      credentialRequired: false,
      localAction:
        "Configure the local model-provider/test-provider environment expected by the example E2E test, then rerun through the artifact wrapper.",
    },
    "missing-database-url": {
      actionLane: "configure-local-database-url",
      credentialRequired: false,
      localAction:
        "Set a local test database URL or test service fixture for the integration run, then rerun through the artifact wrapper.",
    },
    "test-assertion-failure": {
      actionLane: "fix-test-or-fixture-assertion",
      credentialRequired: false,
      localAction:
        "Inspect the captured assertion failure and update the test fixture or expected behavior, then rerun through the artifact wrapper.",
    },
  };
  return (
    actions[classification] || {
      actionLane: "inspect-local-failure",
      credentialRequired: false,
      localAction:
        "Inspect the captured playback/report excerpts and map the failure to a local test, fixture, environment, or timeout fix.",
    }
  );
}

function objectiveLocalAction(id) {
  const actions = {
    "five-examples-per-benchmark": {
      actionLane: "osworld-live-provider-needed",
      localAction:
        "Review the 80/80 sampled playback rows now; OSWorld remains the only five-example caveat and needs a runnable OSWorld provider before live task IDs can replace smoke-only evidence.",
      credentialRequired: false,
    },
    "version-comparison": {
      actionLane: "restore-previous-trajectory-history",
      localAction:
        "Use the version remediation matrix to inspect mind2web and nl2repo aggregate previous viewers; rerun those benchmarks with trajectory output when call-by-call previous playback is required.",
      credentialRequired: false,
    },
    "broader-corpus-review": {
      actionLane: "review-corpus-warning-families",
      localAction:
        "Review corpus warning rows through the corpus review packs; each publication-warning row has local playback and call previews, while Hyperliquid remains separately credential-gated.",
      credentialRequired: false,
    },
    "real-llm-e2e-tests": {
      actionLane: "resolve-live-sidecar-breadth",
      localAction:
        "Use live/e2e review packs and offline summaries to inspect no-sidecar rows; add script-local sidecar emission or fix local wrapper failures where strict script-local evidence is required.",
      credentialRequired: false,
    },
  };
  return (
    actions[id] || {
      actionLane: "review-objective-caveat",
      localAction: "Use the linked objective-closure evidence to decide whether to fix, rerun, or explicitly accept the caveat.",
      credentialRequired: false,
    }
  );
}

function remediationLocalAction(row) {
  if (row.localAction && row.actionLane) {
    return {
      localAction: row.localAction,
      actionLane: row.actionLane,
      credentialRequired: row.credentialRequired === true,
    };
  }
  const actions = {
    "external-runtime": {
      actionLane: "provision-external-runtime",
      credentialRequired: false,
      localAction:
        "Configure a runnable OSWorld provider such as Docker, VMware, VirtualBox, or AWS, then rerun the recorded OSWorld command and rebuild the analysis.",
    },
    "external-credential": {
      actionLane: "provide-external-credential",
      credentialRequired: true,
      localAction:
        "Set the required external credential in the shell only, rerun the recorded benchmark command, then rebuild the analysis.",
    },
    "blocked-live-runtime": {
      actionLane: "replace-smoke-with-live-run",
      credentialRequired: false,
      localAction:
        "Replace smoke-only OSWorld evidence with a live scored run after an OSWorld provider is available, then regenerate benchmark playback and review pages.",
    },
    "publication-and-telemetry-caveats": {
      actionLane: "review-corpus-publication-warnings",
      credentialRequired: false,
      localAction:
        "Review the focused corpus family pages, inspect publication-warning playback/call previews, and rerun weak non-credential-gated families to clear telemetry caveats.",
    },
    "partial-version-history": {
      actionLane: "restore-version-trajectory-history",
      credentialRequired: false,
      localAction:
        "Inspect aggregate-only previous benchmark viewers and rerun older baselines with trajectory output where call-by-call version comparison is required.",
    },
  };
  return (
    actions[row.blockerType] || {
      actionLane: "inspect-remediation-row",
      credentialRequired: false,
      localAction:
        row.nextAction || "Inspect the linked evidence, rerun command, and review pack to decide the next local remediation step.",
    }
  );
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
    const localAction = objectiveLocalAction(row.id);
    rows.push({
      id: row.id,
      surface: "objective",
      priority: row.status === "missing" ? 90 : 75,
      status: row.status,
      blockerType: "objective-caveat",
      evidence: row.evidence,
      targetHref: row.viewer,
      nextAction: localAction.localAction,
      localAction: localAction.localAction,
      actionLane: localAction.actionLane,
      credentialRequired: localAction.credentialRequired,
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
    const localAction = liveLocalAction(failure?.classification || "");
    rows.push({
      id: item.id,
      surface: "live-e2e-test",
      priority: Number(item.priority),
      status: item.agentVerdict,
      blockerType: item.agentVerdict,
      evidence: script ? (script.reasons || []).join("; ") : item.agentEvidence || "",
      targetHref: item.targetHref,
      nextAction: item.recommendedAction,
      localAction: localAction.localAction,
      actionLane: localAction.actionLane,
      credentialRequired: localAction.credentialRequired,
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
    evidence: `${corpus.reviewFindingSummary?.telemetryGap || 0} telemetry-gap families, ${corpus.reviewFindingSummary?.blocked || 0} blocked family, ${corpus.summary?.insufficientLatestRows || 0} insufficient-warning latest rows, ${corpus.callCatalogSummary?.normalizedCallCount || 0} normalized records.`,
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
    const localAction = remediationLocalAction(row);
    row.localAction = localAction.localAction;
    row.actionLane = localAction.actionLane;
    row.credentialRequired = localAction.credentialRequired;
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
      localActionItems: sortedRows.filter((row) => row.localAction && row.actionLane).length,
      localCredentialRequiredItems: sortedRows.filter((row) => row.credentialRequired === true).length,
      localActionByLane: sortedRows.reduce((counts, row) => {
        const key = row.actionLane || "unclassified";
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {}),
      externalBlockers: sortedRows.filter((row) => String(row.blockerType).startsWith("external")).length,
      liveTestItems: sortedRows.filter((row) => row.surface === "live-e2e-test").length,
      liveLocalActionItems: sortedRows.filter(
        (row) => row.surface === "live-e2e-test" && row.localAction && row.credentialRequired === false,
      ).length,
      liveLocalActionByClassification: sortedRows
        .filter((row) => row.surface === "live-e2e-test")
        .reduce((counts, row) => {
          const key = row.failureClassification || "unclassified";
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}),
      liveLocalActionByLane: sortedRows
        .filter((row) => row.surface === "live-e2e-test")
        .reduce((counts, row) => {
          const key = row.actionLane || "unclassified";
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}),
      objectiveCaveats: sortedRows.filter((row) => row.surface === "objective").length,
      objectiveLocalActionItems: sortedRows.filter(
        (row) => row.surface === "objective" && row.localAction && row.credentialRequired === false,
      ).length,
      objectiveLocalActionByLane: sortedRows
        .filter((row) => row.surface === "objective")
        .reduce((counts, row) => {
          const key = row.actionLane || "unclassified";
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}),
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
    ["Local actions", payload.summary.localActionItems],
    ["Credentials", payload.summary.localCredentialRequiredItems],
    ["External blockers", payload.summary.externalBlockers],
    ["Live/e2e", payload.summary.liveTestItems],
    ["Local live actions", payload.summary.liveLocalActionItems],
    ["Objective caveats", payload.summary.objectiveCaveats],
    ["Objective local actions", payload.summary.objectiveLocalActionItems],
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
    <section class="panel"><h2>Remaining Work</h2><div class="body"><table><thead><tr><th>priority</th><th>id</th><th>surface</th><th>status</th><th>evidence</th><th>next action</th><th>local action</th><th>target</th><th>rerun</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td>${escapeHtml(row.priority)}</td><td><code>${escapeHtml(row.id)}</code></td><td>${escapeHtml(row.surface)}</td><td class="${String(row.status).includes("blocked") || String(row.status).includes("fix") ? "bad" : "warn"}">${escapeHtml(row.status)}</td><td>${escapeHtml(row.evidence)}${row.exitCode !== null && row.exitCode !== undefined ? `<br><span class="muted">exit=${escapeHtml(row.exitCode)} structured=${escapeHtml(row.structuredReason)}${row.failureClassification ? ` class=${escapeHtml(row.failureClassification)}` : ""}</span>` : ""}</td><td>${escapeHtml(row.nextAction)}</td><td>${row.localAction ? `<b>${escapeHtml(row.actionLane)}</b><br>${escapeHtml(row.localAction)}<br><span class="muted">credential required: ${escapeHtml(row.credentialRequired ? "yes" : "no")}</span>` : ""}</td><td>${row.targetHref ? `<a href="${escapeHtml(row.targetHref)}">open</a>` : ""}${row.failureTriageHref ? `<br><a href="${escapeHtml(row.failureTriageHref)}">failure triage</a>` : ""}${row.modelEvidenceHref ? `<br><a href="${escapeHtml(row.modelEvidenceHref)}">model evidence</a>` : ""}</td><td>${row.command ? `<code>${escapeHtml(row.command)}</code>${row.followedBy ? `<br><span class="muted">then <code>${escapeHtml(row.followedBy)}</code></span>` : ""}` : ""}</td></tr>`)
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
    `Local action rows: ${payload.summary.localActionItems}`,
    `Credential-required action rows: ${payload.summary.localCredentialRequiredItems}`,
    `External blockers: ${payload.summary.externalBlockers}`,
    `Live/e2e items: ${payload.summary.liveTestItems}`,
    `Local live/e2e actions: ${payload.summary.liveLocalActionItems}`,
    `Objective local actions: ${payload.summary.objectiveLocalActionItems}`,
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
