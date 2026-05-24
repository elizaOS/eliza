#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  "live-test-model-evidence",
);
const INVENTORY_DIR = path.join(REPO_ROOT, "reports", "live-test-inventory");

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

function redact(value) {
  return String(value ?? "")
    .replace(/csk-[A-Za-z0-9_-]+/g, "csk-<redacted>")
    .replace(/\b(CEREBRAS_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|HL_PRIVATE_KEY)=\S+/g, "$1=<redacted>");
}

function truncate(value, limit = 700) {
  const text = redact(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function relFromReport(target) {
  return path.relative(REPORT_DIR, target).replaceAll(path.sep, "/");
}

function resolveInventoryHref(href) {
  if (!href) return "";
  return path.resolve(INVENTORY_DIR, href);
}

function scriptId(row) {
  return `${row.packageJson}:${row.script}`;
}

function slug(value) {
  return String(value || "live-test")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function rerunCommand(row) {
  const packageDir = path.dirname(row.packageJson || ".");
  const cwd = packageDir === "." ? "" : `--cwd ${packageDir} `;
  return `node packages/scripts/run-live-test-with-artifacts.mjs --label ${slug(`${row.packageName || packageDir}-${row.script}`)} -- bun run ${cwd}${row.script}`;
}

function parseJsonl(filePath, limit = 3) {
  if (!filePath || !existsSync(filePath)) return [];
  const records = [];
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      continue;
    }
    if (records.length >= limit) break;
  }
  return records;
}

function messageText(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) => `${message.role || "message"}: ${message.content || ""}`)
    .join("\n");
}

function callPreview(record) {
  const usage = record.usage || {};
  return {
    provider: record.provider || "",
    model: record.model || "",
    purpose: record.purpose || "",
    promptPreview: truncate(record.userPrompt || record.systemPrompt || messageText(record.messages), 900),
    responsePreview: truncate(record.response || record.text || "", 900),
    totalTokens: Number(usage.totalTokens || 0),
    cacheReadInputTokens: Number(usage.cacheReadInputTokens || 0),
  };
}

function buildPayload() {
  const inventory = readJson("reports/live-test-inventory/inventory.json");
  const agentReview = readJson(
    "reports/benchmark-analysis/live-test-agent-review/live-test-agent-review.json",
  );
  const failureTriage = readJson(
    "reports/benchmark-analysis/live-test-failure-triage/failure-triage.json",
  );

  const agentById = new Map((agentReview.rows || []).map((row) => [scriptId(row), row]));
  const failureById = new Map((failureTriage.rows || []).map((row) => [row.id, row]));

  const rows = (inventory.scriptFindings || [])
    .filter((row) => row.likelyLlm)
    .map((row) => {
      const id = scriptId(row);
      const agent = agentById.get(id) || {};
      const failure = failureById.get(id);
      const playbackPath = resolveInventoryHref(row.latestWrappedPlayback);
      const viewerPath = resolveInventoryHref(row.latestWrappedViewer);
      const llmCallsPath = resolveInventoryHref(row.latestLlmCallsJsonl);
      const modelReviewPath = path.join(INVENTORY_DIR, row.modelReviewHref || "");
      const samples = parseJsonl(llmCallsPath).map(callPreview);
      return {
        id,
        packageJson: row.packageJson,
        script: row.script,
        packageName: row.packageName,
        disposition: row.disposition,
        verdict: agent.verdict || "",
        recommendedAction: agent.recommendedAction || "",
        hasArtifactEvidence: Boolean(row.hasArtifactEvidence),
        latestWrappedExitCode: row.latestWrappedExitCode ?? null,
        playbackHref: playbackPath ? relFromReport(playbackPath) : "",
        playbackExists: playbackPath ? existsSync(playbackPath) : false,
        viewerHref: viewerPath ? relFromReport(viewerPath) : "",
        viewerExists: viewerPath ? existsSync(viewerPath) : false,
        modelReviewHref: modelReviewPath ? relFromReport(modelReviewPath) : "",
        modelReviewExists: row.modelReviewHref ? existsSync(modelReviewPath) : false,
        llmCallsHref: llmCallsPath ? relFromReport(llmCallsPath) : "",
        llmCallsExists: llmCallsPath ? existsSync(llmCallsPath) : false,
        structuredLlmCallCount: Number(row.structuredLlmCallCount || 0),
        structuredLlmRunCount: Number(row.structuredLlmRunCount || 0),
        structuredLlmCoverageReason: row.structuredLlmCoverageReason || "",
        structuredLlmCoverageDetail: row.structuredLlmCoverageDetail || "",
        failureClassification: failure?.classification || "",
        failureExitCode: failure?.exitCode ?? null,
        failureTriageHref: failure ? "../live-test-failure-triage/index.html" : "",
        reasons: row.reasons || [],
        rerunCommand: rerunCommand(row),
        sampleCalls: samples,
      };
    })
    .sort((a, b) => {
      const aFail = Number(a.latestWrappedExitCode || 0) !== 0;
      const bFail = Number(b.latestWrappedExitCode || 0) !== 0;
      return Number(bFail) - Number(aFail) ||
        b.structuredLlmCallCount - a.structuredLlmCallCount ||
        a.id.localeCompare(b.id);
    });

  const byDisposition = {};
  const byStructuredReason = {};
  for (const row of rows) {
    byDisposition[row.disposition] = (byDisposition[row.disposition] || 0) + 1;
    byStructuredReason[row.structuredLlmCoverageReason || "structured-present"] =
      (byStructuredReason[row.structuredLlmCoverageReason || "structured-present"] || 0) + 1;
  }

  return {
    schema: "eliza_live_test_model_evidence_matrix_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      scriptCount: rows.length,
      artifactEvidenceScripts: rows.filter((row) => row.hasArtifactEvidence).length,
      playbackLinkedScripts: rows.filter((row) => row.playbackExists).length,
      focusedReviewPages: rows.filter((row) => row.modelReviewExists).length,
      structuredLlmScripts: rows.filter((row) => row.structuredLlmCallCount > 0).length,
      structuredLlmCallCount: rows.reduce((sum, row) => sum + row.structuredLlmCallCount, 0),
      structuredStatusScripts: rows.filter((row) => row.structuredLlmCoverageReason).length,
      failedScripts: rows.filter((row) => Number(row.latestWrappedExitCode || 0) !== 0).length,
      rowsWithFailureClassification: rows.filter((row) => row.failureClassification).length,
      rowsWithRerunCommand: rows.filter((row) => row.rerunCommand).length,
      sampleCallRows: rows.filter((row) => row.sampleCalls.length > 0).length,
      byDisposition,
      byStructuredReason,
    },
    rows,
  };
}

function html(payload) {
  const cards = [
    ["Scripts", payload.summary.scriptCount],
    ["Playback", `${payload.summary.playbackLinkedScripts}/${payload.summary.scriptCount}`],
    ["Focused pages", `${payload.summary.focusedReviewPages}/${payload.summary.scriptCount}`],
    ["Structured calls", payload.summary.structuredLlmCallCount],
    ["Failed", payload.summary.failedScripts],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live/e2e Model Evidence Matrix</title>
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
    table { width:100%; border-collapse:collapse; min-width:1250px; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#fbfcfa; position:sticky; top:0; z-index:1; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { margin:0; max-height:180px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:8px; border-radius:6px; }
    .bad { color:#a12222; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Live/e2e Model Evidence Matrix</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">${cards
      .map(([label, value]) => `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${escapeHtml(value)}</div></div>`)
      .join("")}</section>
    <section class="panel"><h2>Likely-LLM Scripts</h2><div class="body"><table><thead><tr><th>script</th><th>status</th><th>evidence links</th><th>structured status</th><th>sample calls</th><th>failure</th><th>rerun</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td><code>${escapeHtml(row.id)}</code></td><td class="${Number(row.latestWrappedExitCode || 0) === 0 ? "ok" : "bad"}">${escapeHtml(row.disposition)}<br>exit ${escapeHtml(row.latestWrappedExitCode ?? "n/a")}</td><td><a href="${escapeHtml(row.playbackHref)}">playback</a><br><a href="${escapeHtml(row.modelReviewHref)}">focused review</a>${row.llmCallsExists ? `<br><a href="${escapeHtml(row.llmCallsHref)}">llm calls</a>` : ""}</td><td>${escapeHtml(row.structuredLlmCallCount)} calls in ${escapeHtml(row.structuredLlmRunCount)} runs<br><code>${escapeHtml(row.structuredLlmCoverageReason || "structured-present")}</code><br><span class="muted">${escapeHtml(row.structuredLlmCoverageDetail)}</span></td><td>${row.sampleCalls.length ? row.sampleCalls.map((call) => `<div><strong>${escapeHtml(call.purpose || call.model || "call")}</strong> ${escapeHtml(call.totalTokens)} tokens cache ${escapeHtml(call.cacheReadInputTokens)}<pre>${escapeHtml(call.promptPreview)}</pre><pre>${escapeHtml(call.responsePreview)}</pre></div>`).join("") : "<span class=\"muted\">no structured prompt/response sidecar rows</span>"}</td><td>${row.failureClassification ? `<span class="bad">${escapeHtml(row.failureClassification)}</span><br><a href="${escapeHtml(row.failureTriageHref)}">failure triage</a>` : ""}</td><td><code>${escapeHtml(row.rerunCommand)}</code><br><span class="muted">then <code>bun run bench:analysis:build</code></span></td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Live/e2e Model Evidence Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Scripts: ${payload.summary.scriptCount}`,
    `Playback-linked scripts: ${payload.summary.playbackLinkedScripts}/${payload.summary.scriptCount}`,
    `Focused review pages: ${payload.summary.focusedReviewPages}/${payload.summary.scriptCount}`,
    `Structured LLM scripts: ${payload.summary.structuredLlmScripts}`,
    `Structured LLM calls: ${payload.summary.structuredLlmCallCount}`,
    `Failed scripts: ${payload.summary.failedScripts}`,
    "",
    "| script | disposition | structured calls | structured reason | failure |",
    "| --- | --- | ---: | --- | --- |",
    ...payload.rows.map(
      (row) =>
        `| ${row.id} | ${row.disposition} | ${row.structuredLlmCallCount} | ${row.structuredLlmCoverageReason || "structured-present"} | ${row.failureClassification || ""} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "model-evidence.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `live/e2e model evidence matrix ${payload.summary.scriptCount} scripts at ${path.relative(REPO_ROOT, REPORT_DIR)}/index.html\n`,
  );
}

main();
