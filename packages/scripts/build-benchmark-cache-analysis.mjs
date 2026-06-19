#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "cache-analysis");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function rel(target, from = REPORT_DIR) {
  return path.relative(from, path.join(REPO_ROOT, target)).replaceAll(path.sep, "/");
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

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pct(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toFixed(1)}%`
    : "n/a";
}

function tokenFmt(value) {
  return Math.round(number(value)).toLocaleString("en-US");
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + number(selector(row)), 0);
}

function structuredUsageEvent(event) {
  if (!event || typeof event !== "object") return false;
  const usage = event.usage || event.tokenUsage || event.tokens;
  if (usage && typeof usage === "object") return true;
  return [
    "promptTokens",
    "completionTokens",
    "totalTokens",
    "cachedTokens",
    "cacheReadTokens",
    "inputTokens",
    "outputTokens",
  ].some((key) => typeof event[key] === "number");
}

function buildPayload() {
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const trajectory = readJson("reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json");
  const livePlayback = readJson("reports/live-test-runs/playback-manifest.json");
  const liveInventory = readJson("reports/live-test-inventory/inventory.json");

  const codeAgentRows = (review.rows || []).map((row) => {
    const targetTokens = number(row.target?.totalTokens);
    const baselineTokens = number(row.baseline?.totalTokens);
    const targetCachePercent = row.target?.cachePercent ?? null;
    const baselineCachePercent = row.baseline?.cachePercent ?? null;
    const trajectoryTokens = number(row.trajectory?.totalTokens);
    const trajectoryCacheReadTokens = number(row.trajectory?.cacheReadTokens);
    return {
      benchmark: row.benchmark,
      disposition: row.disposition,
      runMode: row.runMode,
      status: row.status,
      targetTokens,
      baselineTokens,
      tokenDelta: number(row.deltas?.totalTokens),
      targetCachePercent,
      baselineCachePercent,
      cachePercentDelta: row.deltas?.cachePercent ?? null,
      trajectoryFiles: number(row.trajectory?.files),
      trajectoryRecords: number(row.trajectory?.records),
      trajectoryTokens,
      trajectoryCacheReadTokens,
      trajectoryCachePercent: row.trajectory?.cachePercent ?? null,
      targetPlaybackFiles: (row.playbackLinks || []).filter(
        (link) => link.side === "target" && number(link.totalTokens) > 0,
      ).length,
      baselinePlaybackFiles: (row.playbackLinks || []).filter(
        (link) => link.side === "baseline" && number(link.totalTokens) > 0,
      ).length,
      benchmarkReviewHref: rel(`reports/benchmark-analysis/benchmark-review/${row.reviewLinks?.benchmarkReview || ""}`),
      trajectoryCatalogHref: rel("reports/benchmarks/code-agent-trajectory-catalog/index.html"),
      playbackHrefs: (row.playbackLinks || [])
        .filter((link) => link.href)
        .map((link) => ({
          side: link.side,
          adapter: link.adapter,
          totalTokens: number(link.totalTokens),
          cacheReadTokens: number(link.cacheReadTokens),
          cachePercent: link.cachePercent ?? null,
          href: rel(path.join("reports/benchmark-analysis/benchmark-review", link.href)),
        })),
    };
  });

  const corpusRows = (corpus.reviewFindings || []).map((row) => ({
    benchmarkId: row.benchmark_id,
    disposition: row.disposition,
    normalizedCalls: number(row.normalized_calls),
    latestRows: number(row.latest_rows),
    tokenTotal: number(row.token_total),
    cachedTokenTotal: number(row.cached_token_total),
    cachePercent: row.cache_percent ?? null,
    trajectoryLikeFiles: number(row.trajectory_like_files),
    outputFiles: number(row.output_files),
    historyPairs: number(row.history_pairs),
    previousPairs: number(row.previous_pairs),
    viewerHref: rel("reports/benchmarks/benchmark-results-corpus-review/index.html"),
  }));

  const normalizedCalls = corpus.normalizedCalls || [];
  const callsWithUsage = normalizedCalls.filter((call) => call.usage && typeof call.usage === "object");
  const callsWithCachedTokens = callsWithUsage.filter((call) => number(call.usage.cached_tokens) > 0);
  const corpusProviderRows = Object.values(
    normalizedCalls.reduce((acc, call) => {
      const provider = call.provider || "unknown";
      acc[provider] ||= {
        provider,
        callCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
      };
      acc[provider].callCount += 1;
      acc[provider].promptTokens += number(call.usage?.prompt_tokens);
      acc[provider].completionTokens += number(call.usage?.completion_tokens);
      acc[provider].totalTokens += number(call.usage?.total_tokens);
      acc[provider].cachedTokens += number(call.usage?.cached_tokens);
      return acc;
    }, {}),
  )
    .map((row) => ({
      ...row,
      cachePercent: row.totalTokens > 0 ? (row.cachedTokens / row.totalTokens) * 100 : null,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const liveRows = (livePlayback.manifest || []).map((row) => {
    const reportPath = path.join(REPO_ROOT, row.reportJson || "");
    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : {};
    const events = report.events || [];
    const eventText = JSON.stringify(events);
    const structuredUsageEvents = events.filter(structuredUsageEvent).length;
    const modelTelemetry = row.modelTelemetry || {};
    return {
      label: row.label,
      exitCode: row.exitCode,
      eventCount: events.length,
      tokenLikeText: Boolean(modelTelemetry.tokenLikeText) || /token|cache/i.test(eventText),
      realLlmMode: Boolean(modelTelemetry.realLlmMode),
      provider: modelTelemetry.provider || "",
      modelTotalMsSum: number(modelTelemetry.modelTotalMsSum),
      pipelineModelMsAvg: modelTelemetry.pipelineModelMsAvg ?? null,
      structuredUsageEvents,
      playbackHref: rel(row.playbackIndex || ""),
      reportHref: rel(row.reportJson || ""),
    };
  });

  const liveStructuredUsageRuns = liveRows.filter((row) => row.structuredUsageEvents > 0).length;
  const targetTotalTokens = sum(codeAgentRows, (row) => row.targetTokens);
  const baselineTotalTokens = sum(codeAgentRows, (row) => row.baselineTokens);
  const targetWeightedCachePercent =
    targetTotalTokens > 0
      ? (sum(codeAgentRows, (row) => row.targetTokens * number(row.targetCachePercent)) /
          targetTotalTokens)
      : null;
  const baselineWeightedCachePercent =
    baselineTotalTokens > 0
      ? (sum(codeAgentRows, (row) => row.baselineTokens * number(row.baselineCachePercent)) /
          baselineTotalTokens)
      : null;

  return {
    schema: "eliza_benchmark_cache_analysis_v1",
    generatedAt: new Date().toISOString(),
    codeAgent: {
      summary: {
        benchmarkCount: review.summary.benchmarkCount,
        targetTotalTokens,
        baselineTotalTokens,
        targetWeightedCachePercent,
        baselineWeightedCachePercent,
        trajectoryFiles: trajectory.summary.trajectoryFiles,
        playbackFiles: trajectory.summary.playbackFiles,
        trajectoryRecords: trajectory.summary.trajectoryRecords,
        llmLikeRecords: trajectory.summary.llmLikeRecords,
        trajectoryTotalTokens: trajectory.summary.totalTokens,
        trajectoryCacheReadTokens: trajectory.summary.cacheReadTokens,
        trajectoryCachePercent: review.summary.cachePercent,
      },
      rows: codeAgentRows,
    },
    corpus: {
      summary: {
        benchmarkFamilies: corpus.reviewFindingSummary?.findingCount || 0,
        normalizedCallCount: corpus.callCatalogSummary?.normalizedCallCount || 0,
        rowsWithNormalizedCalls: corpus.callCatalogSummary?.rowsWithNormalizedCalls || 0,
        benchmarksWithNormalizedCalls: corpus.callCatalogSummary?.benchmarksWithNormalizedCalls || 0,
        callsWithUsage: callsWithUsage.length,
        callsWithCachedTokens: callsWithCachedTokens.length,
        promptTokens: corpus.callCatalogSummary?.promptTokens || 0,
        completionTokens: corpus.callCatalogSummary?.completionTokens || 0,
        totalTokens: corpus.callCatalogSummary?.totalTokens || 0,
        cachedTokens: corpus.callCatalogSummary?.cachedTokens || 0,
        cachePercent:
          number(corpus.callCatalogSummary?.totalTokens) > 0
            ? (number(corpus.callCatalogSummary?.cachedTokens) /
                number(corpus.callCatalogSummary?.totalTokens)) *
              100
            : null,
      },
      providerRows: corpusProviderRows,
      rows: corpusRows,
    },
    liveWrapperPlayback: {
      summary: {
        wrappedRuns: livePlayback.runCount,
        playbackPages: livePlayback.playbackCount,
        modelScripts: liveInventory.summary.modelArtifactRequiredScripts,
        wrapperEvidenceScripts: liveInventory.summary.wrapperEvidenceScripts,
        tokenLikeTextRuns: liveRows.filter((row) => row.tokenLikeText).length,
        modelTelemetryRuns: liveRows.filter((row) => row.realLlmMode).length,
        modelTotalMsSum: sum(liveRows, (row) => row.modelTotalMsSum),
        structuredUsageRuns: liveStructuredUsageRuns,
        structuredUsageEvents: sum(liveRows, (row) => row.structuredUsageEvents),
        telemetryStatus:
          liveStructuredUsageRuns > 0
            ? "wrapper playback exists; real-LLM timing is normalized where present, and structured token/cache sidecar ingestion is proven for wrapped runs that emit LLM-call JSONL"
            : "wrapper playback exists; real-LLM timing is normalized where present, but wrapped reports do not expose normalized token/cache usage fields",
      },
      rows: liveRows,
    },
  };
}

function html(payload) {
  const topCodeAgentRows = payload.codeAgent.rows
    .slice()
    .sort((a, b) => b.trajectoryTokens - a.trajectoryTokens)
    .slice(0, 16);
  const topCorpusRows = payload.corpus.rows
    .slice()
    .sort((a, b) => b.tokenTotal - a.tokenTotal)
    .slice(0, 24);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Cache Analysis</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:11px; }
    .card b { display:block; margin-top:4px; font-size:21px; }
    .body { padding:12px; overflow:auto; }
    .panel { margin-bottom:12px; overflow:hidden; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
    .ok { color:#17633a; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Benchmark Cache Analysis</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">Code-agent trajectory cache</span><b>${escapeHtml(pct(payload.codeAgent.summary.trajectoryCachePercent))}</b><span>${escapeHtml(tokenFmt(payload.codeAgent.summary.trajectoryCacheReadTokens))} cached / ${escapeHtml(tokenFmt(payload.codeAgent.summary.trajectoryTotalTokens))} total</span></div>
      <div class="card"><span class="muted">Code-agent playback files</span><b>${escapeHtml(payload.codeAgent.summary.playbackFiles)}/${escapeHtml(payload.codeAgent.summary.trajectoryFiles)}</b><span>trajectory HTML playback</span></div>
      <div class="card"><span class="muted">Corpus normalized calls</span><b>${escapeHtml(payload.corpus.summary.normalizedCallCount)}</b><span>${escapeHtml(payload.corpus.summary.benchmarksWithNormalizedCalls)} benchmark families</span></div>
      <div class="card"><span class="muted">Corpus cache</span><b>${escapeHtml(pct(payload.corpus.summary.cachePercent))}</b><span>${escapeHtml(tokenFmt(payload.corpus.summary.cachedTokens))} cached / ${escapeHtml(tokenFmt(payload.corpus.summary.totalTokens))} total</span></div>
      <div class="card"><span class="muted">Live wrapper usage telemetry</span><b>${escapeHtml(payload.liveWrapperPlayback.summary.structuredUsageRuns)}</b><span>structured usage runs out of ${escapeHtml(payload.liveWrapperPlayback.summary.wrappedRuns)}</span></div>
    </div>
    <section class="panel"><h2>Interpretation</h2><div class="body">
      <p>The code-agent and broader benchmark corpus reports include normalized token and cache counters. Wrapped live/e2e playback pages preserve command/event playback and normalize real-LLM timing lines where present, but their wrapper reports currently do not expose normalized token/cache usage fields, so cache-rate claims are intentionally limited to benchmark telemetry surfaces.</p>
      <p><a href="../benchmark-review/index.html">Open benchmark review</a> · <a href="${escapeHtml(rel("reports/benchmarks/benchmark-results-corpus-review/index.html"))}">Open corpus review</a> · <a href="${escapeHtml(rel("reports/live-test-inventory/index.html"))}">Open live/e2e inventory</a></p>
    </div></section>
    <section class="panel"><h2>Code-Agent Benchmarks</h2><div class="body"><table><thead><tr><th>benchmark</th><th>disposition</th><th>target cache</th><th>baseline cache</th><th>trajectory cache</th><th>tokens</th><th>playback</th></tr></thead><tbody>${topCodeAgentRows
      .map((row) => `<tr><td><code>${escapeHtml(row.benchmark)}</code></td><td>${escapeHtml(row.disposition)}</td><td>${escapeHtml(pct(row.targetCachePercent))}</td><td>${escapeHtml(pct(row.baselineCachePercent))}</td><td>${escapeHtml(pct(row.trajectoryCachePercent))}</td><td>${escapeHtml(tokenFmt(row.trajectoryTokens))}</td><td><a href="${escapeHtml(row.benchmarkReviewHref)}">review</a></td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Corpus Families By Token Volume</h2><div class="body"><table><thead><tr><th>benchmark family</th><th>disposition</th><th>calls</th><th>cache</th><th>tokens</th><th>cached</th></tr></thead><tbody>${topCorpusRows
      .map((row) => `<tr><td><code>${escapeHtml(row.benchmarkId)}</code></td><td>${escapeHtml(row.disposition)}</td><td>${escapeHtml(row.normalizedCalls)}</td><td>${escapeHtml(pct(row.cachePercent))}</td><td>${escapeHtml(tokenFmt(row.tokenTotal))}</td><td>${escapeHtml(tokenFmt(row.cachedTokenTotal))}</td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Corpus Providers</h2><div class="body"><table><thead><tr><th>provider</th><th>calls</th><th>cache</th><th>tokens</th><th>cached</th></tr></thead><tbody>${payload.corpus.providerRows
      .map((row) => `<tr><td><code>${escapeHtml(row.provider)}</code></td><td>${escapeHtml(row.callCount)}</td><td>${escapeHtml(pct(row.cachePercent))}</td><td>${escapeHtml(tokenFmt(row.totalTokens))}</td><td>${escapeHtml(tokenFmt(row.cachedTokens))}</td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Live Wrapper Playback Telemetry Status</h2><div class="body"><table><thead><tr><th>status</th><th>wrapped runs</th><th>playback pages</th><th>real LLM timing</th><th>model total</th><th>token/cache text</th><th>structured usage</th></tr></thead><tbody><tr><td class="warn">${escapeHtml(payload.liveWrapperPlayback.summary.telemetryStatus)}</td><td>${escapeHtml(payload.liveWrapperPlayback.summary.wrappedRuns)}</td><td>${escapeHtml(payload.liveWrapperPlayback.summary.playbackPages)}</td><td>${escapeHtml(payload.liveWrapperPlayback.summary.modelTelemetryRuns)}</td><td>${escapeHtml(tokenFmt(payload.liveWrapperPlayback.summary.modelTotalMsSum))}ms</td><td>${escapeHtml(payload.liveWrapperPlayback.summary.tokenLikeTextRuns)}</td><td>${escapeHtml(payload.liveWrapperPlayback.summary.structuredUsageRuns)}</td></tr></tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Cache Analysis",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Code-agent trajectory cache: ${pct(payload.codeAgent.summary.trajectoryCachePercent)} (${tokenFmt(payload.codeAgent.summary.trajectoryCacheReadTokens)} cached / ${tokenFmt(payload.codeAgent.summary.trajectoryTotalTokens)} total tokens).`,
    `- Broader corpus cache: ${pct(payload.corpus.summary.cachePercent)} (${tokenFmt(payload.corpus.summary.cachedTokens)} cached / ${tokenFmt(payload.corpus.summary.totalTokens)} total tokens).`,
    `- Live wrapper playback: ${payload.liveWrapperPlayback.summary.playbackPages}/${payload.liveWrapperPlayback.summary.wrappedRuns} playback pages; ${payload.liveWrapperPlayback.summary.modelTelemetryRuns} runs expose real-LLM timing telemetry; ${payload.liveWrapperPlayback.summary.structuredUsageRuns} runs expose structured token/cache usage telemetry.`,
    "",
    "Wrapped live/e2e playback reports currently preserve event playback and real-LLM timing where present, but do not expose normalized token/cache usage fields.",
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "cache-analysis.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`benchmark cache analysis ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
