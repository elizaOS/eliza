#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "agent-benchmark-review");

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

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function pct(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "n/a";
}

function tokenFmt(value) {
  return Math.round(number(value)).toLocaleString("en-US");
}

function codeAgentVerdict(row) {
  if (row.disposition === "review-pass") {
    return {
      verdict: "review-pass",
      action: "Keep as current evidence; inspect playback when reviewing qualitative outputs.",
    };
  }
  if (row.disposition === "missing-live") {
    return {
      verdict: "blocked-live-runtime",
      action: "Replace smoke-only evidence with a live scored run when the runtime/provider is available.",
    };
  }
  if (row.status === "inferior") {
    return {
      verdict: "needs-benchmark-quality-fix",
      action: "Inspect target playback against baseline playback and prioritize behavior or tool-use fixes before rerun.",
    };
  }
  return {
    verdict: "needs-output-review",
    action: "Inspect the focused benchmark page and playback examples; decide whether this is weak task behavior, scoring rubric drift, or acceptable caveat.",
  };
}

function corpusVerdict(row) {
  if (row.disposition === "blocked") {
    return {
      verdict: "blocked-corpus-family",
      action: "Resolve the blocker recorded on the gap page, then rerun and regenerate canonical playback.",
    };
  }
  if (row.disposition === "review-pass") {
    return {
      verdict: "review-pass",
      action: "Keep as current corpus evidence; use canonical playback for qualitative sampling.",
    };
  }
  if (number(row.normalized_calls) === 0 || number(row.trajectory_like_files) === 0) {
    return {
      verdict: "needs-telemetry-rerun",
      action: "Rerun or repair artifact export so normalized calls and trajectory-like files are available.",
    };
  }
  if (number(row.previous_pairs) === 0) {
    return {
      verdict: "needs-version-baseline",
      action: "Keep current playback evidence but add a comparable rerun to make version deltas meaningful.",
    };
  }
  return {
    verdict: "needs-publication-review",
    action: "Inspect warnings and sample/task counts before treating this family as release-grade evidence.",
  };
}

function firstExisting(paths) {
  return paths.find((entry) => entry && existsSync(path.join(REPO_ROOT, entry))) || "";
}

function buildPayload() {
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const sampler = readJson(
    "reports/benchmark-analysis/benchmark-five-example-sampler/five-example-sampler.json",
  );
  const samplerByBenchmark = new Map(
    (sampler.rows || []).map((row) => [row.benchmark, row]),
  );

  const codeAgentRows = (review.rows || []).map((row) => {
    const rec = codeAgentVerdict(row);
    const sample = samplerByBenchmark.get(row.benchmark) || {};
    const focusedPage = `reports/benchmark-analysis/benchmark-review/${row.reviewLinks?.benchmarkReview || ""}`;
    const targetPlayback = (row.playbackLinks || []).find(
      (link) => link.side === "target" && number(link.totalTokens) > 0,
    );
    const baselinePlayback = (row.playbackLinks || []).find(
      (link) => link.side === "baseline" && number(link.totalTokens) > 0,
    );
    return {
      benchmark: row.benchmark,
      disposition: row.disposition,
      status: row.status,
      runMode: row.runMode,
      verdict: rec.verdict,
      recommendedAction: rec.action,
      targetAccuracy: row.target?.accuracy ?? null,
      baselineAccuracy: row.baseline?.accuracy ?? null,
      targetTotal: row.target?.total ?? null,
      tokenDelta: row.deltas?.totalTokens ?? null,
      targetTokens: row.target?.totalTokens ?? null,
      baselineTokens: row.baseline?.totalTokens ?? null,
      targetCachePercent: row.target?.cachePercent ?? null,
      baselineCachePercent: row.baseline?.cachePercent ?? null,
      trajectoryFiles: row.trajectory?.files ?? 0,
      trajectoryRecords: row.trajectory?.records ?? 0,
      trajectoryCachePercent: row.trajectory?.cachePercent ?? null,
      selectedExampleCount: sample.selectedCount ?? 0,
      selectedExamplesWithPlayback: sample.selectedWithPlayback ?? 0,
      selectedExamplesWithTaskId: sample.selectedWithTaskId ?? 0,
      selectedExampleTokens: sample.selectedTokenTotal ?? 0,
      selectedExampleCacheReadTokens: sample.selectedCacheReadTokens ?? 0,
      selectedExampleCachePercent:
        number(sample.selectedTokenTotal) > 0
          ? (number(sample.selectedCacheReadTokens) / number(sample.selectedTokenTotal)) * 100
          : null,
      selectedExamples: (sample.examples || []).map((example) => ({
        taskId: example.taskId || "",
        evidenceId: example.evidenceId || "",
        evidenceMode: example.evidenceMode || "",
        totalTokens: example.totalTokens ?? 0,
        cacheReadTokens: example.cacheReadTokens ?? 0,
        cachePercent: example.cachePercent ?? null,
        playbackHref: example.playbackHref
          ? rel(path.join("reports/benchmark-analysis/benchmark-five-example-sampler", example.playbackHref))
          : "",
        sourceHref: example.sourceHref
          ? rel(path.join("reports/benchmark-analysis/benchmark-five-example-sampler", example.sourceHref))
          : "",
        inputPreview: String(example.inputPreview || "").slice(0, 500),
        outputPreview: String(example.outputPreview || "").slice(0, 500),
      })),
      versionAvailable: row.version?.hasPrevious === true,
      evidence: [
        `${row.target?.right ?? "n/a"}/${row.target?.total ?? "n/a"} target correct vs ${row.baseline?.right ?? "n/a"}/${row.baseline?.total ?? "n/a"} baseline correct.`,
        `${row.trajectory?.files || 0} trajectory files, ${row.trajectory?.records || 0} records, ${pct(row.trajectory?.cachePercent)} trajectory cache.`,
        `${sample.selectedWithPlayback || 0}/${sample.selectedCount || 0} sampled examples have playback; ${sample.selectedWithTaskId || 0}/${sample.selectedCount || 0} have explicit task IDs.`,
        row.version?.hasPrevious ? `Previous run ${row.version.previousRunId}.` : "No previous indexed row.",
        ...(row.caveats || []),
      ],
      focusedReviewHref: rel(focusedPage),
      targetPlaybackHref: targetPlayback?.href
        ? rel(path.join("reports/benchmark-analysis/benchmark-review", targetPlayback.href))
        : "",
      baselinePlaybackHref: baselinePlayback?.href
        ? rel(path.join("reports/benchmark-analysis/benchmark-review", baselinePlayback.href))
        : "",
    };
  });

  const playbackByFamily = new Map();
  for (const entry of corpus.canonicalFiles || []) {
    if (!playbackByFamily.has(entry.benchmark_id) && entry.playback_file) {
      playbackByFamily.set(entry.benchmark_id, entry.playback_file);
    }
  }
  const gapByFamily = new Map(
    (corpus.noPlaybackGapPages || []).map((entry) => [entry.benchmark_id, entry.gap_page]),
  );
  const familyById = new Map(
    (corpus.benchmarkFamilies || []).map((entry) => [entry.benchmark_id, entry]),
  );
  const corpusRows = (corpus.reviewFindings || []).map((row) => {
    const family = familyById.get(row.benchmark_id) || {};
    const rec = corpusVerdict(row);
    const playback = playbackByFamily.get(row.benchmark_id) || "";
    const gap = gapByFamily.get(row.benchmark_id) || "";
    const viewer = firstExisting([playback, gap, "reports/benchmarks/benchmark-results-corpus-review/index.html"]);
    return {
      benchmarkId: row.benchmark_id,
      disposition: row.disposition,
      verdict: rec.verdict,
      recommendedAction: rec.action,
      latestRows: row.latest_rows,
      succeededRows: row.succeeded_rows,
      normalizedCalls: row.normalized_calls,
      trajectoryLikeFiles: row.trajectory_like_files,
      outputFiles: row.output_files,
      tokenTotal: row.token_total,
      cachedTokenTotal: row.cached_token_total,
      cachePercent: row.cache_percent,
      previousPairs: row.previous_pairs,
      regressionPairs: row.regression_pairs,
      matrixComplete: family.matrix_complete !== false,
      warnings: family.warnings || [],
      reasons: row.reasons || [],
      evidence: [
        `${row.succeeded_rows}/${row.latest_rows} latest rows succeeded; ${row.normalized_calls} normalized calls.`,
        `${tokenFmt(row.token_total)} tokens, ${tokenFmt(row.cached_token_total)} cached (${pct(row.cache_percent)}).`,
        `${row.previous_pairs} previous comparable pairs; ${row.regression_pairs} regression pairs.`,
        ...(row.reasons || []),
      ],
      viewerHref: rel(viewer),
      hasPlayback: Boolean(playback),
      hasGapPage: Boolean(gap),
    };
  });

  const allRows = [...codeAgentRows, ...corpusRows];
  const byVerdict = allRows.reduce((acc, row) => {
    acc[row.verdict] = (acc[row.verdict] || 0) + 1;
    return acc;
  }, {});
  return {
    schema: "eliza_agent_benchmark_review_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      codeAgentBenchmarkCount: codeAgentRows.length,
      codeAgentReviewed: codeAgentRows.filter((row) => row.verdict).length,
      codeAgentFocusedPages: codeAgentRows.filter((row) => row.focusedReviewHref).length,
      codeAgentTargetPlayback: codeAgentRows.filter((row) => row.targetPlaybackHref).length,
      codeAgentSampledExamples: codeAgentRows.reduce(
        (total, row) => total + number(row.selectedExampleCount),
        0,
      ),
      codeAgentSampledExamplesWithPlayback: codeAgentRows.reduce(
        (total, row) => total + number(row.selectedExamplesWithPlayback),
        0,
      ),
      codeAgentSampledExamplesWithTaskId: codeAgentRows.reduce(
        (total, row) => total + number(row.selectedExamplesWithTaskId),
        0,
      ),
      corpusFamilyCount: corpusRows.length,
      corpusReviewed: corpusRows.filter((row) => row.verdict).length,
      corpusFamiliesWithPlaybackOrGap: corpusRows.filter((row) => row.hasPlayback || row.hasGapPage).length,
      totalReviewed: allRows.filter((row) => row.verdict).length,
      byVerdict,
    },
    codeAgentRows,
    corpusRows,
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Agent Benchmark Review</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:10px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:11px; }
    .card b { display:block; margin-top:4px; font-size:21px; }
    .panel { margin-bottom:12px; overflow:hidden; }
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
  <header><h1>Agent Benchmark Review</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">Code-agent reviewed</span><b>${escapeHtml(payload.summary.codeAgentReviewed)}/${escapeHtml(payload.summary.codeAgentBenchmarkCount)}</b><span>latest benchmarks</span></div>
      <div class="card"><span class="muted">Corpus reviewed</span><b>${escapeHtml(payload.summary.corpusReviewed)}/${escapeHtml(payload.summary.corpusFamilyCount)}</b><span>benchmark families</span></div>
      <div class="card"><span class="muted">Code-agent playback</span><b>${escapeHtml(payload.summary.codeAgentTargetPlayback)}/${escapeHtml(payload.summary.codeAgentBenchmarkCount)}</b><span>target playback links</span></div>
      <div class="card"><span class="muted">Sampled examples</span><b>${escapeHtml(payload.summary.codeAgentSampledExamplesWithPlayback)}/${escapeHtml(payload.summary.codeAgentSampledExamples)}</b><span>${escapeHtml(payload.summary.codeAgentSampledExamplesWithTaskId)} with task IDs</span></div>
      <div class="card"><span class="muted">Corpus playback/gap</span><b>${escapeHtml(payload.summary.corpusFamiliesWithPlaybackOrGap)}/${escapeHtml(payload.summary.corpusFamilyCount)}</b><span>direct review targets</span></div>
    </div>
    <section class="panel"><h2>Code-Agent Benchmarks</h2><div class="body"><table><thead><tr><th>benchmark</th><th>verdict</th><th>success</th><th>sample evidence</th><th>cache</th><th>action</th><th>links</th></tr></thead><tbody>${payload.codeAgentRows
      .map((row) => `<tr><td><code>${escapeHtml(row.benchmark)}</code><br><span class="muted">${escapeHtml(row.disposition)} · ${escapeHtml(row.runMode)}</span></td><td class="${row.verdict === "review-pass" ? "ok" : "warn"}">${escapeHtml(row.verdict)}</td><td>${escapeHtml(row.evidence[0])}</td><td>${escapeHtml(row.selectedExamplesWithPlayback)}/${escapeHtml(row.selectedExampleCount)} playback<br>${escapeHtml(row.selectedExamplesWithTaskId)}/${escapeHtml(row.selectedExampleCount)} task IDs<br>${row.selectedExamples.slice(0, 5).map((example, index) => `<a href="${escapeHtml(example.playbackHref)}">${escapeHtml(example.taskId || example.evidenceId || `sample-${index + 1}`)}</a>`).join("<br>")}</td><td>${escapeHtml(pct(row.trajectoryCachePercent))}<br><span class="muted">sample cache ${escapeHtml(pct(row.selectedExampleCachePercent))}</span></td><td>${escapeHtml(row.recommendedAction)}</td><td><a href="${escapeHtml(row.focusedReviewHref)}">review</a>${row.targetPlaybackHref ? `<br><a href="${escapeHtml(row.targetPlaybackHref)}">target playback</a>` : ""}${row.baselinePlaybackHref ? `<br><a href="${escapeHtml(row.baselinePlaybackHref)}">baseline playback</a>` : ""}</td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Corpus Benchmark Families</h2><div class="body"><table><thead><tr><th>family</th><th>verdict</th><th>calls</th><th>cache</th><th>action</th><th>viewer</th></tr></thead><tbody>${payload.corpusRows
      .map((row) => `<tr><td><code>${escapeHtml(row.benchmarkId)}</code><br><span class="muted">${escapeHtml(row.disposition)}</span></td><td class="${row.verdict === "review-pass" ? "ok" : row.verdict.startsWith("blocked") ? "bad" : "warn"}">${escapeHtml(row.verdict)}</td><td>${escapeHtml(row.normalizedCalls)} calls; ${escapeHtml(row.succeededRows)}/${escapeHtml(row.latestRows)} succeeded</td><td>${escapeHtml(pct(row.cachePercent))}</td><td>${escapeHtml(row.recommendedAction)}</td><td><a href="${escapeHtml(row.viewerHref)}">${row.hasPlayback ? "playback" : row.hasGapPage ? "gap" : "viewer"}</a></td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Agent Benchmark Review",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Code-agent benchmarks reviewed: ${payload.summary.codeAgentReviewed}/${payload.summary.codeAgentBenchmarkCount}`,
    `- Corpus benchmark families reviewed: ${payload.summary.corpusReviewed}/${payload.summary.corpusFamilyCount}`,
    `- Code-agent target playback links: ${payload.summary.codeAgentTargetPlayback}/${payload.summary.codeAgentBenchmarkCount}`,
    `- Code-agent sampled examples with playback: ${payload.summary.codeAgentSampledExamplesWithPlayback}/${payload.summary.codeAgentSampledExamples}`,
    `- Code-agent sampled examples with task IDs: ${payload.summary.codeAgentSampledExamplesWithTaskId}/${payload.summary.codeAgentSampledExamples}`,
    `- Corpus playback/gap targets: ${payload.summary.corpusFamiliesWithPlaybackOrGap}/${payload.summary.corpusFamilyCount}`,
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
    path.join(REPORT_DIR, "agent-benchmark-review.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `agent benchmark review ${payload.summary.totalReviewed} benchmark surfaces at ${path.join(REPORT_DIR, "index.html")}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
