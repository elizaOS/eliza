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
      href: "../gap-evidence/osworld-live-readiness.html",
    },
    {
      id: "external-hyperliquid",
      status: gap.credentials?.hyperliquidPrivateKeyPresent ? "proven" : "blocked-external",
      evidence: `HL_PRIVATE_KEY present: ${gap.credentials?.hyperliquidPrivateKeyPresent ? "yes" : "no"}.`,
      href: "../../benchmarks/benchmark-results-corpus-review/gap-pages/hyperliquid_bench.html",
    },
    {
      id: "rerunability",
      status: rerunBatches.summary?.runnableCommands >= 541 && rerunBatches.summary?.blockedCommands === 2
        ? "caveated"
        : "missing",
      evidence: `${rerunBatches.summary?.runnableCommands || 0} runnable commands in ${rerunBatches.summary?.batchCount || 0} batch scripts; ${rerunBatches.summary?.blockedCommands || 0} commands excluded due to external blockers.`,
      href: "../rerun-batches/index.html",
    },
    {
      id: "objective-evidence",
      status: objectiveEvidence.summary?.missing === 0 ? "caveated" : "missing",
      evidence: `${objectiveEvidence.summary?.proven || 0} proven, ${objectiveEvidence.summary?.caveated || 0} caveated, ${objectiveEvidence.summary?.blocked || 0} blocked, ${objectiveEvidence.summary?.missing || 0} missing objective rows.`,
      href: "../objective-evidence-map/index.html",
    },
    {
      id: "review-readiness",
      status: reviewReadiness.summary?.blocked === 0 ? "proven" : "caveated",
      evidence: `${reviewReadiness.summary?.ready || 0} ready, ${reviewReadiness.summary?.caveated || 0} caveated, ${reviewReadiness.summary?.blocked || 0} blocked review surfaces.`,
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
      runContractOk: runContract.summary?.ok === true,
      artifactFiles: artifactManifest.summary?.totalFiles || 0,
    },
    finalDecision:
      "not-complete: generated viewers, evidence, rerun scripts, and agent review are present; OSWorld, Hyperliquid, and human verdict gates remain open.",
    gates,
  };
}

function renderHtml(payload) {
  const rows = payload.gates.map((gate) => `
    <tr>
      <td>${escapeHtml(gate.status)}</td>
      <td><code>${escapeHtml(gate.id)}</code></td>
      <td>${escapeHtml(gate.evidence)}</td>
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
`,
    "utf8",
  );
}

const payload = buildPayload();
writeOutputs(payload);
console.log(`[final-goal-readiness] ${payload.summary.proven}/${payload.summary.gateCount} proven; open=${payload.summary.openGates}`);
