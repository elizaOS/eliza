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
  "live-test-prompt-response-completeness",
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

function rel(href, sourceDir = REPO_ROOT) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(sourceDir, text);
  return path.relative(REPORT_DIR, absolute).replaceAll(path.sep, "/");
}

function parseJsonl(relativePath) {
  const absolute = path.join(REPO_ROOT, relativePath);
  if (!existsSync(absolute)) return [];
  return readFileSync(absolute, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function promptText(call) {
  if (call.userPrompt) return String(call.userPrompt);
  if (Array.isArray(call.messages)) {
    return call.messages.map((message) => `${message.role || ""}: ${message.content || ""}`).join("\n");
  }
  if (call.prompt) return String(call.prompt);
  return "";
}

function responseText(call) {
  return String(call.response || call.responseText || call.output || "");
}

function usage(call) {
  return call.usage || call.tokenUsage || {};
}

function summarizeCalls(calls) {
  return {
    calls: calls.length,
    withPrompt: calls.filter((call) => promptText(call)).length,
    withResponse: calls.filter((call) => responseText(call)).length,
    totalTokens: calls.reduce((sum, call) => sum + Number(usage(call).totalTokens || 0), 0),
    cacheReadTokens: calls.reduce(
      (sum, call) => sum + Number(usage(call).cacheReadInputTokens || usage(call).cacheReadTokens || 0),
      0,
    ),
    sampleCalls: calls.slice(0, 3).map((call) => ({
      provider: call.provider || "",
      model: call.model || "",
      purpose: call.purpose || "",
      promptPreview: promptText(call).slice(0, 700),
      responsePreview: responseText(call).slice(0, 700),
      totalTokens: Number(usage(call).totalTokens || 0),
      cacheReadTokens: Number(usage(call).cacheReadInputTokens || usage(call).cacheReadTokens || 0),
    })),
  };
}

function buildPayload() {
  const modelEvidence = readJson(
    "reports/benchmark-analysis/live-test-model-evidence/model-evidence.json",
  );
  const livePlayback = readJson("reports/live-test-runs/playback-manifest.json");

  const structuredRuns = (livePlayback.manifest || [])
    .filter((row) => Number(row.structuredLlmCallCount || 0) > 0)
    .map((row) => {
      const llmCallsHref =
        (row.artifactLinks || []).find((artifact) => artifact.label === "llmCallsJsonl")?.href || "";
      const calls = llmCallsHref ? parseJsonl(llmCallsHref) : [];
      return {
        label: row.label,
        exitCode: row.exitCode,
        structuredLlmCallCount: Number(row.structuredLlmCallCount || 0),
        playbackHref: rel(row.playbackIndex),
        llmCallsHref: rel(llmCallsHref),
        ...summarizeCalls(calls),
      };
    });

  const rows = (modelEvidence.rows || []).map((row) => {
    const llmCallsRepoHref = String(row.llmCallsHref || "").replace(/^\.\.\//, "reports/");
    const calls = row.llmCallsHref
      ? parseJsonl(path.relative(REPO_ROOT, path.resolve(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence", row.llmCallsHref)).replaceAll(path.sep, "/"))
      : [];
    const callSummary = summarizeCalls(calls);
    return {
      id: row.id,
      packageJson: row.packageJson,
      script: row.script,
      disposition: row.disposition,
      latestWrappedExitCode: row.latestWrappedExitCode,
      structuredLlmCallCount: Number(row.structuredLlmCallCount || 0),
      structuredLlmCoverageReason: row.structuredLlmCoverageReason || "",
      structuredLlmCoverageDetail: row.structuredLlmCoverageDetail || "",
      playbackHref: rel(row.playbackHref, path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence")),
      modelReviewHref: rel(row.modelReviewHref, path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence")),
      llmCallsHref: rel(row.llmCallsHref, path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence")),
      llmCallsRepoHref,
      promptResponseCompleteness:
        row.structuredLlmCallCount > 0
          ? callSummary.withPrompt === callSummary.calls && callSummary.withResponse === callSummary.calls
            ? "complete"
            : "partial"
          : "reason-coded-no-sidecar",
      ...callSummary,
      rerunCommand: row.rerunCommand,
    };
  });

  const summary = {
    likelyLlmScripts: rows.length,
    scriptsWithPlayback: rows.filter((row) => row.playbackHref).length,
    scriptsWithStructuredSidecar: rows.filter((row) => row.structuredLlmCallCount > 0).length,
    scriptsWithStructuredStatus: rows.filter((row) => row.structuredLlmCoverageReason).length,
    reasonCodedNoSidecar: rows.filter((row) => row.promptResponseCompleteness === "reason-coded-no-sidecar").length,
    scriptStructuredCalls: rows.reduce((sum, row) => sum + row.structuredLlmCallCount, 0),
    scriptCallsParsed: rows.reduce((sum, row) => sum + row.calls, 0),
    scriptCallsWithPrompt: rows.reduce((sum, row) => sum + row.withPrompt, 0),
    scriptCallsWithResponse: rows.reduce((sum, row) => sum + row.withResponse, 0),
    structuredRunCount: structuredRuns.length,
    structuredRunCalls: structuredRuns.reduce((sum, row) => sum + row.structuredLlmCallCount, 0),
    structuredRunCallsParsed: structuredRuns.reduce((sum, row) => sum + row.calls, 0),
    structuredRunCallsWithPrompt: structuredRuns.reduce((sum, row) => sum + row.withPrompt, 0),
    structuredRunCallsWithResponse: structuredRuns.reduce((sum, row) => sum + row.withResponse, 0),
    structuredRunTotalTokens: structuredRuns.reduce((sum, row) => sum + row.totalTokens, 0),
    structuredRunCacheReadTokens: structuredRuns.reduce((sum, row) => sum + row.cacheReadTokens, 0),
    byStructuredReason: rows.reduce((counts, row) => {
      counts[row.structuredLlmCoverageReason] = (counts[row.structuredLlmCoverageReason] || 0) + 1;
      return counts;
    }, {}),
  };

  return {
    schema: "eliza_live_test_prompt_response_completeness_v1",
    generatedAt: new Date().toISOString(),
    summary,
    rows,
    structuredRuns,
  };
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function html(payload) {
  const rows = payload.rows
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.id)}</code><br><span class="muted">${escapeHtml(row.disposition)} exit=${escapeHtml(row.latestWrappedExitCode)}</span></td>
        <td><b>${escapeHtml(row.promptResponseCompleteness)}</b><br><span class="muted">${escapeHtml(row.structuredLlmCoverageReason)}</span></td>
        <td>${row.calls}/${row.structuredLlmCallCount}<br><span class="muted">prompt ${row.withPrompt}; response ${row.withResponse}</span></td>
        <td>${link(row.playbackHref, "playback")} ${link(row.modelReviewHref, "review")} ${link(row.llmCallsHref, "llm calls")}</td>
        <td>${escapeHtml(row.structuredLlmCoverageDetail)}</td>
      </tr>`,
    )
    .join("\n");
  const runRows = payload.structuredRuns
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.label)}</code></td>
        <td>${row.calls}/${row.structuredLlmCallCount}</td>
        <td>${row.withPrompt}/${row.calls}</td>
        <td>${row.withResponse}/${row.calls}</td>
        <td>${link(row.playbackHref, "playback")} ${link(row.llmCallsHref, "llm calls")}</td>
      </tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Live/E2E Prompt Response Completeness</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:18px 0 8px; font-size:16px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0; }
    .card { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:10px; }
    .card b { display:block; font-size:20px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; margin-bottom:14px; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; margin-right:8px; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Live/E2E Prompt Response Completeness</h1><div class="muted">Generated ${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      <div class="card"><span class="muted">Likely LLM scripts</span><b>${payload.summary.likelyLlmScripts}</b></div>
      <div class="card"><span class="muted">Script sidecars</span><b>${payload.summary.scriptsWithStructuredSidecar}</b></div>
      <div class="card"><span class="muted">Reason-coded</span><b>${payload.summary.reasonCodedNoSidecar}</b></div>
      <div class="card"><span class="muted">Script calls</span><b>${payload.summary.scriptCallsParsed}</b></div>
      <div class="card"><span class="muted">All structured runs</span><b>${payload.summary.structuredRunCount}</b></div>
      <div class="card"><span class="muted">All run calls</span><b>${payload.summary.structuredRunCallsParsed}</b></div>
    </section>
    <h2>Likely LLM Scripts</h2>
    <table>
      <thead><tr><th>Script</th><th>Completeness</th><th>Calls</th><th>Links</th><th>Detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <h2>Structured Run Sidecars</h2>
    <table>
      <thead><tr><th>Run</th><th>Parsed calls</th><th>Prompt</th><th>Response</th><th>Links</th></tr></thead>
      <tbody>${runRows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function readme(payload) {
  return [
    "# Live/E2E Prompt Response Completeness",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Likely LLM scripts: ${payload.summary.likelyLlmScripts}`,
    `- Scripts with structured sidecar calls: ${payload.summary.scriptsWithStructuredSidecar}`,
    `- Scripts with reason-coded no-sidecar status: ${payload.summary.reasonCodedNoSidecar}`,
    `- Script-level structured calls parsed: ${payload.summary.scriptCallsParsed}`,
    `- All structured live-run sidecar calls parsed: ${payload.summary.structuredRunCallsParsed}`,
    `- Structured reason split: ${JSON.stringify(payload.summary.byStructuredReason)}`,
    "",
    "| script | completeness | reason | calls |",
    "|---|---|---|---:|",
    ...payload.rows.map(
      (row) =>
        `| \`${row.id}\` | ${row.promptResponseCompleteness} | ${row.structuredLlmCoverageReason} | ${row.calls} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  const payload = buildPayload();
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    path.join(REPORT_DIR, "prompt-response-completeness.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), readme(payload), "utf8");
  process.stdout.write(`live/e2e prompt response completeness ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
