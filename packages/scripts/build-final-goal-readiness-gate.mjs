#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "final-goal-readiness");

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

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function compactList(values) {
  return values.filter((value) => value !== undefined && value !== null && value !== "");
}

function byId(rows, id) {
  return (rows || []).find((row) => row.id === id);
}

function osworldProviderDetails(providerReadiness) {
  return Object.entries(providerReadiness?.providers || {}).map(([provider, detail]) => ({
    provider,
    runnable: detail?.runnable === true,
    detail: detail?.detail || "",
  }));
}

function buildPayload() {
  const objectiveEvidence = readJson(
    "reports/benchmark-analysis/objective-evidence-map/objective-evidence-map.json",
  );
  const closure = readJson("reports/benchmark-analysis/objective-closure/objective-closure.json");
  const runContract = readJson("reports/benchmark-analysis/run-contract/run-contract.json");
  const artifactManifest = readJson("reports/benchmark-analysis/artifact-manifest/manifest.json");
  const reviewReadiness = readJson(
    "reports/benchmark-analysis/review-readiness-ledger/review-readiness-ledger.json",
  );
  const reviewPackVerdicts = readJson(
    "reports/benchmark-analysis/review-pack-agent-verdicts/review-pack-agent-verdicts.json",
  );
  const manualProgress = readJson(
    "reports/benchmark-analysis/manual-review-progress/manual-review-progress.json",
  );
  const rerunBatches = readJson("reports/benchmark-analysis/rerun-batches/rerun-batches.json");
  const gap = readJson("reports/benchmark-analysis/gap-evidence/gap-evidence.json");
  const remediation = readJson("reports/benchmark-analysis/remediation-matrix/remediation-matrix.json");

  const closureRequirements = closure.requirements || [];
  const remediationRows = remediation.rows || [];
  const fiveExamples = byId(closureRequirements, "five-examples-per-benchmark");
  const versionComparison = byId(closureRequirements, "version-comparison");
  const broaderCorpus = byId(closureRequirements, "broader-corpus-review");
  const realLlm = byId(closureRequirements, "real-llm-e2e-tests");
  const externalGates = byId(closureRequirements, "external-gates");
  const objectiveCaveatRows = [
    byId(remediationRows, "five-examples-per-benchmark"),
    byId(remediationRows, "version-comparison"),
    byId(remediationRows, "broader-corpus-review"),
    byId(remediationRows, "real-llm-e2e-tests"),
  ].filter(Boolean);
  const osworldProviders = osworldProviderDetails(gap.osworld?.providerReadiness);

  const gates = [
    {
      id: "viewer-and-playback-stack",
      status: runContract.summary?.ok && artifactManifest.summary?.playbackHtmlFiles >= 1100
        ? "proven"
        : "missing",
      evidence: `${artifactManifest.summary?.htmlFiles || 0} HTML files, ${artifactManifest.summary?.playbackHtmlFiles || 0} playback HTML files, ${artifactManifest.summary?.totalFiles || 0} ignored report files.`,
      href: "../artifact-manifest/index.html",
    },
    {
      id: "all-pack-agent-review",
      status: reviewPackVerdicts.summary?.reviewedRows === reviewPackVerdicts.summary?.rowCount
        ? "proven"
        : "missing",
      evidence: `${reviewPackVerdicts.summary?.reviewedRows || 0}/${reviewPackVerdicts.summary?.rowCount || 0} review-pack rows have agent verdicts.`,
      href: "../review-pack-agent-verdicts/index.html",
    },
    {
      id: "manual-review-verdicts",
      status: manualProgress.summary?.reviewed === manualProgress.summary?.itemCount
        ? "proven"
        : "blocked-human",
      evidence: `${manualProgress.summary?.reviewed || 0}/${manualProgress.summary?.itemCount || 0} manual notes have human verdicts; ${manualProgress.summary?.highPriorityUnreviewed || 0} high-priority items remain unreviewed.`,
      href: "../manual-review-progress/index.html",
    },
    {
      id: "external-osworld",
      status: gap.osworld?.providerReadiness?.runnableProviderCount > 0 ? "proven" : "blocked-external",
      evidence: `OSWorld runnable providers: ${gap.osworld?.providerReadiness?.runnableProviderCount || 0}.`,
      summary: "OSWorld live evidence is blocked until at least one local or cloud execution provider is runnable.",
      blockerKind: "external-runtime-provider",
      blockerDetails: osworldProviders,
      nextActions: compactList([
        "Start Docker or another OSWorld-compatible provider, or configure AWS credentials for the cloud provider path.",
        "Rerun the recorded OSWorld benchmark command once a provider is available.",
      ]),
      href: "../gap-evidence/osworld-live-readiness.html",
    },
    {
      id: "external-hyperliquid",
      status: gap.credentials?.hyperliquidPrivateKeyPresent ? "proven" : "blocked-external",
      evidence: `HL_PRIVATE_KEY present: ${gap.credentials?.hyperliquidPrivateKeyPresent ? "yes" : "no"}.`,
      summary: "Hyperliquid publication evidence is blocked by a missing local private-key credential.",
      blockerKind: "external-credential",
      credentialPresence: {
        hyperliquidPrivateKeyPresent: gap.credentials?.hyperliquidPrivateKeyPresent === true,
      },
      nextActions: [
        "Set HL_PRIVATE_KEY in the shell only, then rerun the recorded Hyperliquid benchmark command.",
      ],
      href: "../../benchmarks/benchmark-results-corpus-review/gap-pages/hyperliquid_bench.html",
    },
    {
      id: "rerunability",
      status: rerunBatches.summary?.runnableCommands >= 541 && rerunBatches.summary?.blockedCommands === 2
        ? "caveated"
        : "missing",
      evidence: `${rerunBatches.summary?.runnableCommands || 0} runnable commands in ${rerunBatches.summary?.batchCount || 0} batch scripts; ${rerunBatches.summary?.blockedCommands || 0} commands excluded due to external blockers.`,
      summary: "Rerun scripts are generated for all locally runnable coverage; only OSWorld and Hyperliquid are intentionally excluded until their external gates clear.",
      commandBreakdown: {
        benchmarkCommands: rerunBatches.summary?.benchmarkCommands || 0,
        corpusCommands: rerunBatches.summary?.corpusCommands || 0,
        scenarioCommands: rerunBatches.summary?.scenarioCommands || 0,
        liveE2eCommands: rerunBatches.summary?.liveE2eCommands || 0,
      },
      blockedBy: ["external-osworld", "external-hyperliquid"],
      href: "../rerun-batches/index.html",
    },
    {
      id: "objective-evidence",
      status: objectiveEvidence.summary?.missing === 0 ? "caveated" : "missing",
      evidence: `${objectiveEvidence.summary?.proven || 0} proven, ${objectiveEvidence.summary?.caveated || 0} caveated, ${objectiveEvidence.summary?.blocked || 0} blocked, ${objectiveEvidence.summary?.missing || 0} missing objective rows.`,
      summary: `${closure.summary?.proven || 0}/${closure.summary?.total || 0} objective-closure requirements are proven; ${closure.summary?.caveated || 0} are caveated and ${closure.summary?.missing || 0} are missing.`,
      closureSummary: closure.summary || {},
      caveatDetails: compactList([
        fiveExamples && { id: fiveExamples.id, evidence: fiveExamples.evidence },
        versionComparison && { id: versionComparison.id, evidence: versionComparison.evidence },
        broaderCorpus && { id: broaderCorpus.id, evidence: broaderCorpus.evidence },
        realLlm && { id: realLlm.id, evidence: realLlm.evidence },
        externalGates && { id: externalGates.id, evidence: externalGates.evidence },
      ]),
      localActionLanes: Object.fromEntries(
        objectiveCaveatRows.map((row) => [row.id, {
          actionLane: row.actionLane,
          localAction: row.localAction,
          credentialRequired: row.credentialRequired === true,
          href: row.targetHref,
        }]),
      ),
      href: "../objective-evidence-map/index.html",
    },
    {
      id: "review-readiness",
      status: reviewReadiness.summary?.blocked === 0 ? "proven" : "caveated",
      evidence: `${reviewReadiness.summary?.ready || 0} ready, ${reviewReadiness.summary?.caveated || 0} caveated, ${reviewReadiness.summary?.blocked || 0} blocked review surfaces.`,
      summary: `${reviewReadiness.summary?.readyAffordances || 0}/${reviewReadiness.summary?.affordanceCount || 0} review affordances are ready across ${reviewReadiness.summary?.reviewTargets || 0} targets.`,
      affordanceSummary: {
        ready: reviewReadiness.summary?.readyAffordances || 0,
        caveated: reviewReadiness.summary?.caveatedAffordances || 0,
        blocked: reviewReadiness.summary?.blockedAffordances || 0,
        total: reviewReadiness.summary?.affordanceCount || 0,
        reviewTargets: reviewReadiness.summary?.reviewTargets || 0,
      },
      blockedSurfaces: (reviewReadiness.rows || [])
        .filter((row) => row.status === "blocked")
        .map((row) => ({
          id: row.id,
          affordances: (row.affordances || []).filter((affordance) => affordance.status === "blocked"),
          caveats: row.caveats || [],
        })),
      href: "../review-readiness-ledger/index.html",
    },
  ];
  const openGates = gates.filter((gate) => gate.status !== "proven");
  const blockers = gates.filter((gate) => gate.status.startsWith("blocked"));
  return {
    schema: "eliza_final_goal_readiness_gate_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      closureReady: false,
      gateCount: gates.length,
      proven: gates.filter((gate) => gate.status === "proven").length,
      caveated: gates.filter((gate) => gate.status === "caveated").length,
      blocked: blockers.length,
      missing: gates.filter((gate) => gate.status === "missing").length,
      openGates: openGates.length,
      objectiveClosureReady: closure.summary?.closureReady === true,
      objectiveClosure: `${closure.summary?.proven || 0}/${closure.summary?.total || 0} proven, ${closure.summary?.caveated || 0} caveated, ${closure.summary?.missing || 0} missing`,
      remediationLocalActions: `${remediation.summary?.localActionItems || 0}/${remediation.summary?.itemCount || 0}`,
      remediationCredentialRequiredActions: remediation.summary?.localCredentialRequiredItems || 0,
      objectiveLocalActionItems: remediation.summary?.objectiveLocalActionItems || 0,
      liveLocalActionItems: remediation.summary?.liveLocalActionItems || 0,
      reviewAffordances: `${reviewReadiness.summary?.readyAffordances || 0}/${reviewReadiness.summary?.affordanceCount || 0} ready`,
      runContractOk: runContract.summary?.ok === true,
      artifactFiles: artifactManifest.summary?.totalFiles || 0,
    },
    finalDecision:
      "not-complete: generated viewers, evidence, rerun scripts, agent review, and manual review verdicts are present; OSWorld, Hyperliquid, and caveated evidence/readiness gates remain open.",
    gates,
  };
}

function renderHtml(payload) {
  const rows = payload.gates.map((gate) => `
    <tr>
      <td>${escapeHtml(gate.status)}</td>
      <td><code>${escapeHtml(gate.id)}</code></td>
      <td>
        ${gate.summary ? `<div><strong>${escapeHtml(gate.summary)}</strong></div>` : ""}
        <div>${escapeHtml(gate.evidence)}</div>
        ${gate.nextActions ? `<div class="muted">Next: ${escapeHtml(gate.nextActions.join(" "))}</div>` : ""}
        ${gate.blockerDetails ? `<ul>${gate.blockerDetails.map((detail) => `<li><code>${escapeHtml(detail.provider)}</code>: ${escapeHtml(detail.detail)}</li>`).join("")}</ul>` : ""}
        ${gate.localActionLanes ? `<ul>${Object.entries(gate.localActionLanes).map(([id, action]) => `<li><code>${escapeHtml(id)}</code>: ${escapeHtml(action.actionLane)} - ${escapeHtml(action.localAction)}</li>`).join("")}</ul>` : ""}
      </td>
      <td>${link(gate.href, "open")}</td>
    </tr>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Final Goal Readiness</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:18px 20px 32px; }
    h1 { margin:0 0 6px; font-size:24px; letter-spacing:0; }
    .decision { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:12px; margin:16px 0; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; }
    th, td { border-bottom:1px solid #e2e7de; padding:8px; text-align:left; vertical-align:top; }
    th { background:#eef2ea; }
    code { font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace; }
    a { color:#245b3d; font-weight:600; }
    .muted { color:#51614f; margin-top:4px; }
    ul { margin:6px 0 0 18px; padding:0; }
  </style>
</head>
<body>
  <header>
    <h1>Final Goal Readiness</h1>
    <div>Generated ${escapeHtml(payload.generatedAt)}</div>
  </header>
  <main>
    <section class="decision"><strong>${escapeHtml(payload.finalDecision)}</strong></section>
    <table>
      <thead><tr><th>Status</th><th>Gate</th><th>Evidence</th><th>Artifact</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function writeOutputs(payload) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(path.join(REPORT_DIR, "final-goal-readiness.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), renderHtml(payload), "utf8");
  writeFileSync(
    path.join(REPORT_DIR, "README.md"),
    `# Final Goal Readiness

Generated: ${payload.generatedAt}

Decision: ${payload.finalDecision}

- Gates: ${payload.summary.gateCount}
- Proven: ${payload.summary.proven}
- Caveated: ${payload.summary.caveated}
- Blocked: ${payload.summary.blocked}
- Missing: ${payload.summary.missing}
- Open gates: ${payload.summary.openGates}
- Objective closure: ${payload.summary.objectiveClosure}
- Remediation local actions: ${payload.summary.remediationLocalActions}
- Credential-required remediation actions: ${payload.summary.remediationCredentialRequiredActions}
- Objective local action items: ${payload.summary.objectiveLocalActionItems}
- Live/e2e local action items: ${payload.summary.liveLocalActionItems}
- Review affordances: ${payload.summary.reviewAffordances}
`,
    "utf8",
  );
}

const payload = buildPayload();
writeOutputs(payload);
console.log(`[final-goal-readiness] ${payload.summary.proven}/${payload.summary.gateCount} proven; open=${payload.summary.openGates}`);
