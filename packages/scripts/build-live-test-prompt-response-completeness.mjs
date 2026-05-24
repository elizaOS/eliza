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
const FAILURE_TRIAGE_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmark-analysis",
  "live-test-failure-triage",
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

function evidenceTier(row, callSummary) {
  if (Number(row.latestStructuredLlmCallCount ?? row.structuredLlmCallCount ?? 0) > 0) {
    return callSummary.withPrompt === callSummary.calls && callSummary.withResponse === callSummary.calls
      ? "script-sidecar-complete"
      : "script-sidecar-partial";
  }
  const reason = String(row.structuredLlmCoverageReason || "");
  if (reason === "validation-or-self-test-no-model-call") return "reason-coded-no-model-call";
  if (
    reason === "external-runtime-no-sidecar" ||
    reason === "timeout-before-sidecar" ||
    reason === "wrapper-failed-before-sidecar" ||
    reason === "runtime-service-unavailable-no-sidecar"
  ) {
    return "runtime-blocked-before-sidecar";
  }
  if (reason === "no-call-artifact-emitted") return "missing-call-artifact";
  return "reason-coded-no-sidecar";
}

function offlineReviewSummary(row, failure, tier, links) {
  const reason = String(row.structuredLlmCoverageReason || "");
  const stderr = failure?.stderrExcerpt || row.latestStderrExcerpt || "";
  const stdout = failure?.stdoutExcerpt || row.latestStdoutExcerpt || "";
  const excerpt = String(stderr || stdout || row.structuredLlmCoverageDetail || "").slice(0, 1200);
  const supportingEvidenceHrefs = [
    links.playbackHref,
    links.modelReviewHref,
    links.failureTriageHref,
    links.failureReportHref,
    links.failureViewerHref,
    links.latestReportHref,
  ].filter(Boolean);
  const base = {
    canReviewOffline: tier !== "missing-call-artifact",
    evidenceTier: tier,
    blockerKind: reason || tier,
    reviewSurface: "playback-report-and-logs",
    primaryEvidenceHref: links.failureReportHref || links.latestReportHref || links.playbackHref || "",
    supportingEvidenceHrefs: Array.from(new Set(supportingEvidenceHrefs)),
    excerpt,
    manualReviewPrompt: "Open the local playback/report links and inspect the captured stdout/stderr or structured sidecar status before rerunning.",
  };
  if (tier === "script-sidecar-complete") {
    return {
      ...base,
      reviewSurface: "script-local-llm-sidecar",
      blockerKind: "none",
      manualReviewPrompt: "Review the parsed prompt/response sidecar rows, playback, and report output.",
    };
  }
  if (reason === "validation-or-self-test-no-model-call") {
    return {
      ...base,
      reviewSurface: "empty-sidecar-report-output",
      manualReviewPrompt: "No model call is expected; review the empty sidecar status plus report/stdout output.",
    };
  }
  if (reason === "external-runtime-no-sidecar") {
    return {
      ...base,
      reviewSurface: "external-runtime-playback-report-output",
      manualReviewPrompt: "External/mobile/voice/runtime surface; review playback, report, and check output captured locally.",
    };
  }
  if (reason === "timeout-before-sidecar") {
    return {
      ...base,
      reviewSurface: "timeout-last-progress",
      manualReviewPrompt: "Timed out before sidecar emission; review the last captured stdout/stderr progress.",
    };
  }
  if (reason === "wrapper-failed-before-sidecar") {
    return {
      ...base,
      reviewSurface: "failure-classification-and-excerpt",
      manualReviewPrompt: "Wrapper failed before sidecar emission; review failure classification, report, and stderr excerpt.",
    };
  }
  if (reason === "runtime-service-unavailable-no-sidecar") {
    return {
      ...base,
      reviewSurface: "service-unavailable-report-stderr",
      manualReviewPrompt: "Service was unavailable before sidecar emission; review report and stderr.",
    };
  }
  return base;
}

function buildPayload() {
  const modelEvidence = readJson(
    "reports/benchmark-analysis/live-test-model-evidence/model-evidence.json",
  );
  const livePlayback = readJson("reports/live-test-runs/playback-manifest.json");
  const failureTriage = readJson(
    "reports/benchmark-analysis/live-test-failure-triage/failure-triage.json",
  );
  const failureById = new Map((failureTriage.rows || []).map((row) => [row.id, row]));

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
    const failure = failureById.get(row.id);
    const llmCallsRepoHref = String(row.llmCallsHref || "").replace(/^\.\.\//, "reports/");
    const calls = row.llmCallsHref
      ? parseJsonl(path.relative(REPO_ROOT, path.resolve(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence", row.llmCallsHref)).replaceAll(path.sep, "/"))
      : [];
    const callSummary = summarizeCalls(calls);
    const tier = evidenceTier(row, callSummary);
    const playbackHref = rel(row.playbackHref, path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence"));
    const modelReviewHref = rel(row.modelReviewHref, path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence"));
    const llmCallsHref = rel(row.llmCallsHref, path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence"));
    const latestReportHref = rel(row.latestReportHref, path.join(REPO_ROOT, "reports/benchmark-analysis/live-test-model-evidence"));
    const failureTriageHref = failure ? "../live-test-failure-triage/index.html" : "";
    const failurePlaybackHref = failure ? rel(failure.playbackHref, FAILURE_TRIAGE_DIR) : "";
    const failureViewerHref = failure ? rel(failure.viewerHref, FAILURE_TRIAGE_DIR) : "";
    const failureReportHref = failure ? rel(failure.reportHref, FAILURE_TRIAGE_DIR) : "";
    return {
      id: row.id,
      packageJson: row.packageJson,
      script: row.script,
      disposition: row.disposition,
      latestWrappedExitCode: row.latestWrappedExitCode,
      structuredLlmCallCount: Number(row.structuredLlmCallCount || 0),
      latestStructuredLlmCallCount: Number(row.latestStructuredLlmCallCount ?? row.structuredLlmCallCount ?? 0),
      structuredLlmCoverageReason: row.structuredLlmCoverageReason || "",
      structuredLlmCoverageDetail: row.structuredLlmCoverageDetail || "",
      playbackHref,
      modelReviewHref,
      llmCallsHref,
      llmCallsRepoHref,
      llmCallsExists: Boolean(row.llmCallsExists),
      llmCallsStatus: row.llmCallsStatus || "",
      llmCallsLines: Number(row.llmCallsLines || 0),
      llmCallsBytes: Number(row.llmCallsBytes || 0),
      latestReportHref,
      latestStdoutExcerpt: row.latestStdoutExcerpt || "",
      latestStderrExcerpt: row.latestStderrExcerpt || "",
      failureClassification: failure?.classification || "",
      failureDisposition: failure?.disposition || "",
      failureExitCode: failure?.exitCode ?? null,
      failureTriageHref,
      failurePlaybackHref,
      failureViewerHref,
      failureReportHref,
      stdoutExcerpt: failure?.stdoutExcerpt || "",
      stderrExcerpt: failure?.stderrExcerpt || "",
      promptResponseCompleteness:
        Number(row.latestStructuredLlmCallCount ?? row.structuredLlmCallCount ?? 0) > 0
          ? callSummary.withPrompt === callSummary.calls && callSummary.withResponse === callSummary.calls
            ? "complete"
            : "partial"
          : "reason-coded-no-sidecar",
      evidenceTier: tier,
      offlineReviewSummary: offlineReviewSummary(row, failure, tier, {
        playbackHref,
        modelReviewHref,
        latestReportHref,
        failureTriageHref,
        failureReportHref,
        failureViewerHref,
      }),
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
    scriptSidecarComplete: rows.filter((row) => row.evidenceTier === "script-sidecar-complete").length,
    scriptSidecarPartial: rows.filter((row) => row.evidenceTier === "script-sidecar-partial").length,
    reasonCodedNoModelCall: rows.filter((row) => row.evidenceTier === "reason-coded-no-model-call").length,
    runtimeBlockedBeforeSidecar: rows.filter((row) => row.evidenceTier === "runtime-blocked-before-sidecar").length,
    missingCallArtifact: rows.filter((row) => row.evidenceTier === "missing-call-artifact").length,
    scriptStructuredCalls: rows.reduce((sum, row) => sum + row.structuredLlmCallCount, 0),
    scriptLatestStructuredCalls: rows.reduce((sum, row) => sum + row.latestStructuredLlmCallCount, 0),
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
    rowsWithFailureClassification: rows.filter((row) => row.failureClassification).length,
    runtimeBlockedWithFailureClassification: rows.filter(
      (row) => row.evidenceTier === "runtime-blocked-before-sidecar" && row.failureClassification,
    ).length,
    rowsWithFailureExcerpts: rows.filter((row) => row.stdoutExcerpt || row.stderrExcerpt).length,
    rowsWithEmptyLlmCallSidecar: rows.filter((row) => row.llmCallsStatus === "empty-sidecar-zero-calls").length,
    rowsWithNoLlmCallSidecar: rows.filter((row) => row.llmCallsStatus === "no-sidecar-file").length,
    rowsWithLatestRunExcerpt: rows.filter((row) => row.latestStdoutExcerpt || row.latestStderrExcerpt).length,
    rowsWithOfflineReviewSummary: rows.filter((row) => row.offlineReviewSummary?.canReviewOffline).length,
    noSidecarRowsWithOfflineReviewSummary: rows.filter(
      (row) =>
        row.evidenceTier !== "script-sidecar-complete" &&
        row.offlineReviewSummary?.canReviewOffline &&
        row.offlineReviewSummary?.primaryEvidenceHref,
    ).length,
    byStructuredReason: rows.reduce((counts, row) => {
      counts[row.structuredLlmCoverageReason] = (counts[row.structuredLlmCoverageReason] || 0) + 1;
      return counts;
    }, {}),
    byEvidenceTier: rows.reduce((counts, row) => {
      counts[row.evidenceTier] = (counts[row.evidenceTier] || 0) + 1;
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
        <td><b>${escapeHtml(row.evidenceTier)}</b><br><span class="muted">${escapeHtml(row.structuredLlmCoverageReason)}</span></td>
        <td>${row.calls}/${row.latestStructuredLlmCallCount} latest sidecar calls<br><span class="muted">${row.structuredLlmCallCount} aggregate script calls; prompt ${row.withPrompt}; response ${row.withResponse}</span><br><span class="muted">${escapeHtml(row.llmCallsStatus)}; ${escapeHtml(row.llmCallsLines)} rows; ${escapeHtml(row.llmCallsBytes)} bytes</span></td>
        <td>${link(row.playbackHref, "playback")} ${link(row.modelReviewHref, "review")} ${link(row.llmCallsHref, "llm calls")} ${link(row.latestReportHref, "report")}</td>
        <td>${row.failureClassification ? `<b>${escapeHtml(row.failureClassification)}</b><br><span class="muted">exit=${escapeHtml(row.failureExitCode)} ${escapeHtml(row.failureDisposition)}</span><br>${link(row.failureTriageHref, "triage")} ${link(row.failureReportHref, "report")} ${link(row.failureViewerHref, "viewer")}<pre>${escapeHtml(row.stderrExcerpt || row.stdoutExcerpt)}</pre>` : ""}</td>
        <td><b>${escapeHtml(row.offlineReviewSummary?.reviewSurface || "")}</b><br>${escapeHtml(row.offlineReviewSummary?.manualReviewPrompt || row.structuredLlmCoverageDetail)}<br>${link(row.offlineReviewSummary?.primaryEvidenceHref, "primary evidence")}${row.offlineReviewSummary?.excerpt ? `<pre>${escapeHtml(row.offlineReviewSummary.excerpt)}</pre>` : ""}</td>
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
    pre { max-width:520px; max-height:180px; overflow:auto; white-space:pre-wrap; background:#f8faf6; border:1px solid #d7ded1; padding:7px; }
  </style>
</head>
<body>
  <header><h1>Live/E2E Prompt Response Completeness</h1><div class="muted">Generated ${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      <div class="card"><span class="muted">Likely LLM scripts</span><b>${payload.summary.likelyLlmScripts}</b></div>
      <div class="card"><span class="muted">Script sidecars</span><b>${payload.summary.scriptsWithStructuredSidecar}</b></div>
      <div class="card"><span class="muted">Reason-coded</span><b>${payload.summary.reasonCodedNoSidecar}</b></div>
      <div class="card"><span class="muted">Runtime-blocked</span><b>${payload.summary.runtimeBlockedBeforeSidecar}</b></div>
      <div class="card"><span class="muted">No model call</span><b>${payload.summary.reasonCodedNoModelCall}</b></div>
      <div class="card"><span class="muted">Latest sidecar calls</span><b>${payload.summary.scriptCallsParsed}/${payload.summary.scriptLatestStructuredCalls}</b></div>
      <div class="card"><span class="muted">Aggregate script calls</span><b>${payload.summary.scriptStructuredCalls}</b></div>
      <div class="card"><span class="muted">Classified failures</span><b>${payload.summary.rowsWithFailureClassification}</b></div>
      <div class="card"><span class="muted">Offline summaries</span><b>${payload.summary.rowsWithOfflineReviewSummary}</b></div>
      <div class="card"><span class="muted">Empty sidecars</span><b>${payload.summary.rowsWithEmptyLlmCallSidecar}</b></div>
      <div class="card"><span class="muted">All structured runs</span><b>${payload.summary.structuredRunCount}</b></div>
      <div class="card"><span class="muted">All run calls</span><b>${payload.summary.structuredRunCallsParsed}</b></div>
    </section>
    <h2>Likely LLM Scripts</h2>
    <table>
      <thead><tr><th>Script</th><th>Completeness</th><th>Calls</th><th>Links</th><th>Failure triage</th><th>Detail</th></tr></thead>
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
    `- Evidence tiers: ${JSON.stringify(payload.summary.byEvidenceTier)}`,
    `- Classified failed scripts joined from failure triage: ${payload.summary.rowsWithFailureClassification}`,
    `- Failed scripts with stdout/stderr excerpts: ${payload.summary.rowsWithFailureExcerpts}`,
    `- Empty llm-calls sidecars confirming zero calls: ${payload.summary.rowsWithEmptyLlmCallSidecar}`,
    `- Rows without llm-calls sidecar files: ${payload.summary.rowsWithNoLlmCallSidecar}`,
    `- Offline review summaries: ${payload.summary.rowsWithOfflineReviewSummary}`,
    `- Script-level structured calls parsed: ${payload.summary.scriptCallsParsed}`,
    `- All structured live-run sidecar calls parsed: ${payload.summary.structuredRunCallsParsed}`,
    `- Structured reason split: ${JSON.stringify(payload.summary.byStructuredReason)}`,
    "",
    "| script | completeness | reason | failure classification | calls |",
    "|---|---|---|---|---:|",
    ...payload.rows.map(
      (row) =>
        `| \`${row.id}\` | ${row.evidenceTier} | ${row.structuredLlmCoverageReason} | ${row.failureClassification || ""} | ${row.calls} |`,
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
