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
  "live-test-review-packs",
);
const PACK_DIR = path.join(REPORT_DIR, "scripts");
const MODEL_EVIDENCE_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "live-test-model-evidence");
const PROMPT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "live-test-prompt-response-completeness");

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

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "");
}

function relHref(href, fromDir = REPORT_DIR, sourceDir = MODEL_EVIDENCE_DIR) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(sourceDir, text);
  return path.relative(fromDir, absolute).replaceAll(path.sep, "/");
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function buildPayload() {
  const model = readJson("reports/benchmark-analysis/live-test-model-evidence/model-evidence.json");
  const prompt = readJson(
    "reports/benchmark-analysis/live-test-prompt-response-completeness/prompt-response-completeness.json",
  );
  const triage = readJson("reports/benchmark-analysis/live-test-failure-triage/failure-triage.json");
  const manual = readJson("reports/benchmark-analysis/manual-review/manual-review.json");

  const promptById = new Map((prompt.rows || []).map((row) => [row.id, row]));
  const triageById = new Map((triage.rows || []).map((row) => [row.id, row]));
  const manualById = new Map(
    (manual.items || []).filter((item) => item.kind === "live-test").map((item) => [item.id, item]),
  );

  const packs = (model.rows || [])
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((row) => {
      const promptRow = promptById.get(row.id) || {};
      const triageRow = triageById.get(row.id) || {};
      const manualItem = manualById.get(row.id) || null;
      const fileName = `${slug(row.id)}.html`;
      return {
        id: row.id,
        fileName,
        href: `scripts/${fileName}`,
        packageJson: row.packageJson,
        packageName: row.packageName,
        script: row.script,
        disposition: row.disposition,
        verdict: row.verdict,
        latestWrappedExitCode: row.latestWrappedExitCode,
        recommendedAction: row.recommendedAction,
        playbackHref: relHref(row.playbackHref, PACK_DIR),
        viewerHref: relHref(row.viewerHref, PACK_DIR),
        modelReviewHref: relHref(row.modelReviewHref, PACK_DIR),
        llmCallsHref: relHref(row.llmCallsHref, PACK_DIR),
        promptResponseHref: relHref("../live-test-prompt-response-completeness/index.html", PACK_DIR, MODEL_EVIDENCE_DIR),
        failureTriageHref: row.failureTriageHref
          ? relHref(row.failureTriageHref, PACK_DIR, MODEL_EVIDENCE_DIR)
          : "",
        hasArtifactEvidence: Boolean(row.hasArtifactEvidence),
        playbackExists: Boolean(row.playbackExists),
        modelReviewExists: Boolean(row.modelReviewExists),
        structured: {
          callCount: Number(row.structuredLlmCallCount || 0),
          runCount: Number(row.structuredLlmRunCount || 0),
          reason: row.structuredLlmCoverageReason || "",
          detail: row.structuredLlmCoverageDetail || "",
          completeness: promptRow.promptResponseCompleteness || "",
          parsedCalls: Number(promptRow.calls || 0),
          withPrompt: Number(promptRow.withPrompt || 0),
          withResponse: Number(promptRow.withResponse || 0),
          totalTokens: Number(promptRow.totalTokens || 0),
          cacheReadTokens: Number(promptRow.cacheReadTokens || 0),
        },
        failure: {
          classification: row.failureClassification || triageRow.classification || "",
          exitCode: row.failureExitCode ?? triageRow.exitCode ?? null,
          timedOut: Boolean(triageRow.timedOut),
          durationMs: triageRow.durationMs ?? null,
          stderrExcerpt: triageRow.stderrExcerpt || "",
          stdoutExcerpt: triageRow.stdoutExcerpt || "",
        },
        sampleCalls: row.sampleCalls || promptRow.sampleCalls || [],
        reasons: row.reasons || [],
        rerunCommand: row.rerunCommand || promptRow.rerunCommand || "",
        manualReview: manualItem
          ? {
              priority: manualItem.priority,
              disposition: manualItem.disposition,
              summary: manualItem.summary,
              agentVerdict: manualItem.agentVerdict,
              recommendedAction: manualItem.recommendedAction,
              noteHref: relHref(
                `reports/benchmark-analysis/manual-review/${manualItem.noteHref}`,
                PACK_DIR,
              ),
            }
          : null,
      };
    });

  const summary = {
    scriptCount: packs.length,
    packPages: packs.length,
    playbackLinkedScripts: packs.filter((pack) => pack.playbackHref).length,
    focusedReviewPages: packs.filter((pack) => pack.modelReviewHref).length,
    structuredSidecarScripts: packs.filter((pack) => pack.structured.callCount > 0).length,
    structuredStatusScripts: packs.filter((pack) => pack.structured.reason).length,
    scriptStructuredCalls: packs.reduce((sum, pack) => sum + pack.structured.callCount, 0),
    scriptCallsParsed: packs.reduce((sum, pack) => sum + pack.structured.parsedCalls, 0),
    scriptCallsWithPrompt: packs.reduce((sum, pack) => sum + pack.structured.withPrompt, 0),
    scriptCallsWithResponse: packs.reduce((sum, pack) => sum + pack.structured.withResponse, 0),
    failedScripts: packs.filter((pack) => pack.disposition === "model-wrapper-failed").length,
    rowsWithFailureClassification: packs.filter((pack) => pack.failure.classification).length,
    rowsWithRerunCommand: packs.filter((pack) => pack.rerunCommand).length,
    manualReviewNotes: packs.filter((pack) => pack.manualReview?.noteHref).length,
    sampleCallRows: packs.filter((pack) => pack.sampleCalls.length > 0).length,
    allStructuredRunCallsParsed: prompt.summary?.structuredRunCallsParsed || 0,
    allStructuredRunCallsWithPrompt: prompt.summary?.structuredRunCallsWithPrompt || 0,
    allStructuredRunCallsWithResponse: prompt.summary?.structuredRunCallsWithResponse || 0,
  };

  return {
    schema: "eliza_live_test_review_packs_v1",
    generatedAt: new Date().toISOString(),
    summary,
    packs,
  };
}

function packHtml(payload, pack) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pack.script)} Live Review Pack</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:8px; margin-bottom:12px; }
    .metric,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    .metric { padding:10px; }
    .metric strong { display:block; font-size:20px; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    th { background:#fbfcfa; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { white-space:pre-wrap; margin:0 0 8px; max-height:220px; overflow:auto; }
    a { color:#116b5b; text-decoration:none; margin-right:8px; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(pack.script)}</h1><div class="muted">${escapeHtml(pack.id)}</div></header>
  <main>
    <section class="grid">
      <div class="metric"><span>disposition</span><strong>${escapeHtml(pack.disposition)}</strong></div>
      <div class="metric"><span>exit</span><strong>${escapeHtml(pack.latestWrappedExitCode ?? "n/a")}</strong></div>
      <div class="metric"><span>structured calls</span><strong>${escapeHtml(pack.structured.callCount)}</strong></div>
      <div class="metric"><span>parsed prompt/response</span><strong>${pack.structured.withPrompt}/${pack.structured.withResponse}</strong></div>
      <div class="metric"><span>failure</span><strong>${escapeHtml(pack.failure.classification || "none")}</strong></div>
      <div class="metric"><span>manual note</span><strong>${pack.manualReview ? "yes" : "no"}</strong></div>
    </section>
    <section class="panel"><h2>Primary Links</h2><div class="body">
      ${link(pack.playbackHref, "playback")} ${link(pack.viewerHref, "run viewer")} ${link(pack.modelReviewHref, "focused review")} ${link(pack.llmCallsHref, "llm calls")} ${link(pack.promptResponseHref, "prompt/response matrix")} ${link(pack.failureTriageHref, "failure triage")} ${pack.manualReview ? link(pack.manualReview.noteHref, "manual note") : ""}
    </div></section>
    <section class="panel"><h2>Structured Status</h2><div class="body"><table><tbody>
      <tr><th>coverage</th><td>${escapeHtml(pack.structured.completeness || "structured-present")}</td></tr>
      <tr><th>reason</th><td><code>${escapeHtml(pack.structured.reason || "structured-present")}</code><br>${escapeHtml(pack.structured.detail)}</td></tr>
      <tr><th>calls</th><td>${pack.structured.parsedCalls}/${pack.structured.callCount} parsed; prompt ${pack.structured.withPrompt}; response ${pack.structured.withResponse}; tokens ${fmt(pack.structured.totalTokens)}; cache ${fmt(pack.structured.cacheReadTokens)}</td></tr>
      <tr><th>rerun</th><td><code>${escapeHtml(pack.rerunCommand)}</code><br><span class="muted">then <code>bun run bench:analysis:build</code></span></td></tr>
    </tbody></table></div></section>
    <section class="panel"><h2>Sample Calls</h2><div class="body">
      ${pack.sampleCalls.length ? pack.sampleCalls.map((call) => `<div><b>${escapeHtml(call.purpose || call.model || "call")}</b> ${escapeHtml(call.totalTokens || 0)} tokens cache ${escapeHtml(call.cacheReadInputTokens || 0)}<pre>${escapeHtml(call.promptPreview || "")}</pre><pre>${escapeHtml(call.responsePreview || "")}</pre></div>`).join("") : "<span class=\"muted\">No structured prompt/response sidecar rows for this script.</span>"}
    </div></section>
    <section class="panel"><h2>Failure And Manual Review</h2><div class="body"><table><tbody>
      <tr><th>failure</th><td>${escapeHtml(pack.failure.classification || "none")} exit ${escapeHtml(pack.failure.exitCode ?? "n/a")} duration ${escapeHtml(pack.failure.durationMs ?? "n/a")}ms</td></tr>
      <tr><th>stderr</th><td><pre>${escapeHtml(pack.failure.stderrExcerpt)}</pre></td></tr>
      <tr><th>manual</th><td>${pack.manualReview ? `${escapeHtml(pack.manualReview.agentVerdict)}; ${escapeHtml(pack.manualReview.recommendedAction)}` : "No live-test manual-review note; latest wrapper did not require high-priority live-test triage."}</td></tr>
      <tr><th>next action</th><td>${escapeHtml(pack.recommendedAction)}</td></tr>
    </tbody></table></div></section>
  </main>
</body>
</html>`;
}

function indexHtml(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live/E2E Review Packs</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:10px; }
    .card strong { display:block; font-size:20px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; }
    th,td { border-bottom:1px solid #d7ded1; padding:8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Live/E2E Review Packs</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      ${Object.entries(payload.summary).slice(0, 8).map(([key, value]) => `<div class="card"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`).join("")}
    </section>
    <table><thead><tr><th>script</th><th>status</th><th>structured</th><th>failure</th><th>links</th></tr></thead><tbody>
      ${payload.packs.map((pack) => `<tr><td><code>${escapeHtml(pack.id)}</code></td><td>${escapeHtml(pack.disposition)}<br>exit ${escapeHtml(pack.latestWrappedExitCode ?? "n/a")}</td><td>${pack.structured.parsedCalls}/${pack.structured.callCount} parsed<br><span class="muted">${escapeHtml(pack.structured.reason || "structured-present")}</span></td><td>${escapeHtml(pack.failure.classification || "")}</td><td><a href="${escapeHtml(pack.href)}">pack</a></td></tr>`).join("")}
    </tbody></table>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Live/E2E Review Packs",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Summary: ${payload.summary.packPages}/${payload.summary.scriptCount} pack pages, ${payload.summary.playbackLinkedScripts} playback-linked scripts, ${payload.summary.failedScripts} failed scripts, ${payload.summary.manualReviewNotes} manual notes.`,
    "",
    "| Script | Pack | Disposition | Structured | Failure |",
    "| --- | --- | --- | ---: | --- |",
    ...payload.packs.map(
      (pack) =>
        `| \`${pack.id}\` | \`${pack.href}\` | ${pack.disposition} | ${pack.structured.parsedCalls}/${pack.structured.callCount} | ${pack.failure.classification || ""} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(PACK_DIR, { recursive: true });
  const payload = buildPayload();
  for (const pack of payload.packs) {
    writeFileSync(path.join(PACK_DIR, pack.fileName), packHtml(payload, pack), "utf8");
  }
  writeFileSync(
    path.join(REPORT_DIR, "live-test-review-packs.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), indexHtml(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`live/e2e review packs ${payload.summary.packPages} pages at ${REPORT_DIR}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
