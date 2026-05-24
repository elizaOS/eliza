#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "live-test-agent-review");

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

function rel(target, from = REPORT_DIR) {
  return path.relative(from, path.join(REPO_ROOT, target)).replaceAll(path.sep, "/");
}

function keyFor(row) {
  return `${row.packageJson}\0${row.packageName}\0${row.script}`;
}

function verdictFor(finding) {
  if (
    finding.likelyLlm &&
    Number(finding.structuredLlmCallCount || 0) === 0 &&
    finding.structuredLlmCoverageReason &&
    finding.structuredLlmCoverageReason !== "structured-present"
  ) {
    return {
      verdict: "model-structured-sidecar-caveat",
      action: `Use wrapped playback as behavioral evidence; structured LLM sidecar is not recoverable for this row (${finding.structuredLlmCoverageReason}).`,
    };
  }
  switch (finding.disposition) {
    case "model-wrapper-pass":
      return {
        verdict: "model-artifact-pass",
        action: "Keep wrapped playback as current model-call evidence; use focused script page for review.",
      };
    case "model-wrapper-failed":
      return {
        verdict: Number(finding.latestWrappedExitCode) === 124
          ? "model-wrapper-timeout"
          : "model-wrapper-fix",
        action: Number(finding.latestWrappedExitCode) === 124
          ? "Rerun with a narrower quick path or longer timeout, then regenerate playback."
          : "Inspect wrapped playback/report, fix environment or assertion failure, then rerun through the artifact wrapper.",
      };
    case "model-artifact-hint":
      return {
        verdict: "model-artifact-hint",
        action: "Review the focused model-script page and built-in artifact path; wrap future runs when possible.",
      };
    case "non-model-excluded":
      return {
        verdict: "non-model-excluded",
        action: "No model-call trajectory required unless this script starts invoking an LLM.",
      };
    case "non-model-artifact-evidence":
      return {
        verdict: "non-model-artifact-evidence",
        action: "Keep built-in non-model artifact evidence linked from the inventory.",
      };
    case "non-model-wrapper-failed":
      return {
        verdict: "non-model-wrapper-failed",
        action: "Treat as a non-model wrapper failure; inspect playback/report only if this script becomes relevant to model-call coverage.",
      };
    default:
      return {
        verdict: "needs-live-test-review",
        action: "Inspect the inventory row and decide whether this script requires model-call artifacts.",
      };
  }
}

function resolveTarget(finding) {
  if (finding.latestWrappedPlayback) {
    return rel(path.join("reports/live-test-inventory", finding.latestWrappedPlayback));
  }
  if (finding.modelReviewHref) {
    return rel(path.join("reports/live-test-inventory", finding.modelReviewHref));
  }
  return rel("reports/live-test-inventory/index.html");
}

function buildPayload() {
  const live = readJson("reports/live-test-inventory/inventory.json");
  const rowByKey = new Map((live.rows || []).map((row) => [keyFor(row), row]));
  const rows = (live.scriptFindings || []).map((finding) => {
    const inventoryRow = rowByKey.get(keyFor(finding)) || {};
    const rec = verdictFor(finding);
    const targetHref = resolveTarget(finding);
    const modelReviewHref = finding.modelReviewHref
      ? rel(path.join("reports/live-test-inventory", finding.modelReviewHref))
      : "";
    const playbackHref = finding.latestWrappedPlayback
      ? rel(path.join("reports/live-test-inventory", finding.latestWrappedPlayback))
      : "";
    const viewerHref = finding.latestWrappedViewer
      ? rel(path.join("reports/live-test-inventory", finding.latestWrappedViewer))
      : "";
    return {
      packageJson: finding.packageJson,
      packageName: finding.packageName,
      script: finding.script,
      kind: finding.kind,
      likelyLlm: finding.likelyLlm,
      modelArtifactRequired: inventoryRow.modelArtifactRequired === true,
      artifactScope: finding.artifactScope,
      disposition: finding.disposition,
      verdict: rec.verdict,
      recommendedAction: rec.action,
      hasArtifactEvidence: finding.hasArtifactEvidence,
      knownArtifactPath: finding.knownArtifactPath,
      wrappedRunCount: finding.wrappedRunCount,
      structuredLlmRunCount: finding.structuredLlmRunCount || 0,
      structuredLlmCallCount: finding.structuredLlmCallCount || 0,
      latestStructuredLlmCallCount: finding.latestStructuredLlmCallCount || 0,
      latestLlmCallsJsonl: finding.latestLlmCallsJsonl || "",
      structuredLlmCoverageReason: finding.structuredLlmCoverageReason || "",
      structuredLlmCoverageDetail: finding.structuredLlmCoverageDetail || "",
      latestWrappedExitCode: finding.latestWrappedExitCode,
      targetHref,
      targetExists: existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-agent-review", targetHref)),
      playbackHref,
      viewerHref,
      modelReviewHref,
      reasons: finding.reasons || [],
      exclusionReason: inventoryRow.nonModelArtifactExclusionReason || "",
      command: inventoryRow.command || "",
    };
  });
  const byVerdict = rows.reduce((acc, row) => {
    acc[row.verdict] = (acc[row.verdict] || 0) + 1;
    return acc;
  }, {});
  const byDisposition = rows.reduce((acc, row) => {
    acc[row.disposition] = (acc[row.disposition] || 0) + 1;
    return acc;
  }, {});
  return {
    schema: "eliza_live_test_agent_review_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      scriptCount: rows.length,
      reviewed: rows.filter((row) => row.verdict).length,
      targetLinksExisting: rows.filter((row) => row.targetExists).length,
      modelCallScripts: rows.filter((row) => row.modelArtifactRequired || row.likelyLlm).length,
      modelCallScriptsReviewed: rows.filter((row) => (row.modelArtifactRequired || row.likelyLlm) && row.verdict).length,
      modelCallScriptsWithoutEvidence: rows.filter(
        (row) => (row.modelArtifactRequired || row.likelyLlm) && !row.hasArtifactEvidence,
      ).length,
      modelReviewPages: rows.filter((row) => row.modelReviewHref).length,
      wrappedPlaybackLinks: rows.filter((row) => row.playbackHref).length,
      structuredLlmRows: rows.filter((row) => row.structuredLlmCallCount > 0).length,
      structuredLlmCallCount: rows.reduce(
        (sum, row) => sum + Number(row.structuredLlmCallCount || 0),
        0,
      ),
      modelCallScriptsWithStructuredLlm: rows.filter(
        (row) =>
          (row.modelArtifactRequired || row.likelyLlm) &&
          Number(row.structuredLlmCallCount || 0) > 0,
      ).length,
      modelCallScriptsWithStructuredStatus: rows.filter(
        (row) =>
          (row.modelArtifactRequired || row.likelyLlm) &&
          Boolean(row.structuredLlmCoverageReason),
      ).length,
      nonModelExcluded: rows.filter((row) => row.verdict === "non-model-excluded").length,
      byDisposition,
      byVerdict,
    },
    rows,
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live Test Agent Review</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:11px; }
    .card b { display:block; margin-top:4px; font-size:21px; }
    .panel { overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Live Test Agent Review</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">Scripts reviewed</span><b>${escapeHtml(payload.summary.reviewed)}/${escapeHtml(payload.summary.scriptCount)}</b><span>inventory rows</span></div>
      <div class="card"><span class="muted">Model-call scripts</span><b>${escapeHtml(payload.summary.modelCallScriptsReviewed)}/${escapeHtml(payload.summary.modelCallScripts)}</b><span>${escapeHtml(payload.summary.modelCallScriptsWithoutEvidence)} evidence gaps</span></div>
      <div class="card"><span class="muted">Wrapped playback</span><b>${escapeHtml(payload.summary.wrappedPlaybackLinks)}</b><span>script rows with playback</span></div>
      <div class="card"><span class="muted">Structured LLM</span><b>${escapeHtml(payload.summary.structuredLlmRows)}</b><span>${escapeHtml(payload.summary.structuredLlmCallCount)} sidecar calls</span></div>
      <div class="card"><span class="muted">Structured status</span><b>${escapeHtml(payload.summary.modelCallScriptsWithStructuredStatus)}</b><span>model rows classified</span></div>
      <div class="card"><span class="muted">Non-model excluded</span><b>${escapeHtml(payload.summary.nonModelExcluded)}</b><span>explicit scope decisions</span></div>
    </div>
    <section class="panel"><div class="body"><table><thead><tr><th>script</th><th>verdict</th><th>artifact</th><th>action</th><th>links</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td><code>${escapeHtml(row.packageJson)}:${escapeHtml(row.script)}</code><br><span class="muted">${escapeHtml(row.packageName)} · ${escapeHtml(row.kind)} · ${escapeHtml(row.artifactScope)}</span></td><td class="${row.verdict.includes("pass") || row.verdict.includes("excluded") || row.verdict.includes("evidence") ? "ok" : row.verdict.includes("failed") || row.verdict.includes("fix") || row.verdict.includes("timeout") ? "bad" : "warn"}">${escapeHtml(row.verdict)}</td><td>${escapeHtml(row.hasArtifactEvidence ? "evidence" : "no evidence")}<br><span class="muted">wrapped=${escapeHtml(row.wrappedRunCount)} exit=${escapeHtml(row.latestWrappedExitCode ?? "")}</span><br><span class="muted">structured calls=${escapeHtml(row.structuredLlmCallCount || 0)}</span><br><span class="muted">${escapeHtml(row.structuredLlmCoverageReason || "")}</span></td><td>${escapeHtml(row.recommendedAction)}</td><td><a href="${escapeHtml(row.targetHref)}">target</a>${row.playbackHref ? `<br><a href="${escapeHtml(row.playbackHref)}">playback</a>` : ""}${row.modelReviewHref ? `<br><a href="${escapeHtml(row.modelReviewHref)}">model page</a>` : ""}${row.latestLlmCallsJsonl ? `<br><a href="${escapeHtml(row.latestLlmCallsJsonl)}">llm-calls sidecar</a>` : ""}</td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Live Test Agent Review",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Scripts reviewed: ${payload.summary.reviewed}/${payload.summary.scriptCount}`,
    `- Model-call scripts reviewed: ${payload.summary.modelCallScriptsReviewed}/${payload.summary.modelCallScripts}`,
    `- Model-call evidence gaps: ${payload.summary.modelCallScriptsWithoutEvidence}`,
    `- Target links existing: ${payload.summary.targetLinksExisting}/${payload.summary.scriptCount}`,
    `- Structured LLM sidecar rows: ${payload.summary.structuredLlmRows}`,
    `- Structured LLM sidecar calls: ${payload.summary.structuredLlmCallCount}`,
    `- Model-call scripts with structured LLM sidecar calls: ${payload.summary.modelCallScriptsWithStructuredLlm}/${payload.summary.modelCallScripts}`,
    `- Model-call scripts with structured LLM status/reason: ${payload.summary.modelCallScriptsWithStructuredStatus}/${payload.summary.modelCallScripts}`,
    "",
    "## Verdict Counts",
    "",
    ...Object.entries(payload.summary.byVerdict).map(([verdict, count]) => `- ${verdict}: ${count}`),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "live-test-agent-review.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `live test agent review ${payload.summary.reviewed}/${payload.summary.scriptCount} scripts at ${path.join(REPORT_DIR, "index.html")}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
