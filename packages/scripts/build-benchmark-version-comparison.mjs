#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const INDEX_DIR = path.join(REPO_ROOT, "reports", "benchmarks", "code-agent-run-index");
const INDEX_DATA_PATH = path.join(INDEX_DIR, "index-data.js");
const DEFAULT_REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmarks",
  "code-agent-version-comparison",
);

function readIndexData() {
  return JSON.parse(
    readFileSync(INDEX_DATA_PATH, "utf8")
      .replace(/^window\.BENCHMARK_RUN_INDEX = /, "")
      .replace(/;\n?$/, ""),
  );
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function rel(target, from = DEFAULT_REPORT_DIR) {
  return path.relative(from, target).replaceAll(path.sep, "/");
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function countTrajectoryFiles(root) {
  if (!root || !existsSync(root)) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /\.(jsonl|json)$/i.test(entry.name)) count += 1;
    }
  }
  return count;
}

function delta(current, previous) {
  const a = number(current);
  const b = number(previous);
  return a === null || b === null ? null : a - b;
}

function datasetVersion(row, prefix) {
  const data = row?.[`${prefix}_dataset_limit`];
  if (!data || typeof data !== "object") return "";
  return String(data.dataset_version || data.dataset || "");
}

function rowVersion(row) {
  return {
    runId: row.run_id || "",
    generatedAt: row.generated_at || "",
    mode: row.run_mode || "",
    status: row.status || "",
    viewerHref: row.viewer_href || "",
    targetDatasetVersion: datasetVersion(row, "target"),
    baselineDatasetVersion: datasetVersion(row, "baseline"),
    targetTotal: row.target_total,
    targetTrajectoryFiles: countTrajectoryFiles(row.target_trajectory_dir),
    targetAccuracy: row.target_accuracy,
    targetTotalTokens: row.target_total_tokens,
    targetCachedTokenPercent: row.target_cached_token_percent,
    targetLlmCallCount: row.target_llm_call_count,
    baselineTotal: row.baseline_total,
    baselineTrajectoryFiles: countTrajectoryFiles(row.baseline_trajectory_dir),
    baselineAccuracy: row.baseline_accuracy,
    baselineTotalTokens: row.baseline_total_tokens,
    baselineCachedTokenPercent: row.baseline_cached_token_percent,
    baselineLlmCallCount: row.baseline_llm_call_count,
  };
}

function playbackIndex(trajectoryCatalog) {
  const byKey = new Map();
  for (const entry of trajectoryCatalog.entries || []) {
    if (!entry.playbackHref) continue;
    const key = [
      entry.benchmark,
      entry.runId,
      entry.side,
      entry.adapter,
    ].join("\0");
    const current = byKey.get(key);
    if (!current || (entry.totals?.totalTokens || 0) > (current.totals?.totalTokens || 0)) {
      byKey.set(key, entry);
    }
  }
  return byKey;
}

function attachPlayback(version, row, playbackByKey) {
  const targetKey = [
    row.benchmark,
    row.run_id,
    "target",
    row.target_adapter || "target",
  ].join("\0");
  const baselineKey = [
    row.benchmark,
    row.run_id,
    "baseline",
    row.baseline_adapter || "baseline",
  ].join("\0");
  const target = playbackByKey.get(targetKey);
  const baseline = playbackByKey.get(baselineKey);
  return {
    ...version,
    targetPlaybackHref: target?.playbackHref
      ? rel(path.join("reports/benchmarks/code-agent-trajectory-catalog", target.playbackHref))
      : "",
    targetPlaybackRecords: target?.totals?.records || 0,
    targetPlaybackTokens: target?.totals?.totalTokens || 0,
    targetPlaybackCacheReadTokens: target?.totals?.cacheReadTokens || 0,
    baselinePlaybackHref: baseline?.playbackHref
      ? rel(path.join("reports/benchmarks/code-agent-trajectory-catalog", baseline.playbackHref))
      : "",
    baselinePlaybackRecords: baseline?.totals?.records || 0,
    baselinePlaybackTokens: baseline?.totals?.totalTokens || 0,
    baselinePlaybackCacheReadTokens: baseline?.totals?.cacheReadTokens || 0,
  };
}

function compareRows(current, previous, playbackByKey, rowCount = 1) {
  const currentVersion = attachPlayback(rowVersion(current), current, playbackByKey);
  if (!previous) {
    const notes =
      rowCount > 1
        ? [
            `${rowCount} indexed rows exist, but none are earlier than the selected current row.`,
          ]
        : ["Only one indexed row is available for this benchmark."];
    return {
      benchmark: current.benchmark,
      hasPrevious: false,
      noEarlierPreviousRow: rowCount > 1,
      current: currentVersion,
      previous: null,
      deltas: {},
      notes,
    };
  }
  const notes = [];
  if (datasetVersion(current, "target") !== datasetVersion(previous, "target")) {
    notes.push("Target dataset/version changed.");
  }
  if (datasetVersion(current, "baseline") !== datasetVersion(previous, "baseline")) {
    notes.push("Baseline dataset/version changed.");
  }
  if (current.run_mode !== previous.run_mode) {
    notes.push("Run mode changed.");
  }
  const previousVersion = attachPlayback(rowVersion(previous), previous, playbackByKey);
  if (currentVersion.targetPlaybackHref && !previousVersion.targetPlaybackHref) {
    notes.push("Previous target playback is unavailable; comparison is aggregate-only for prior run.");
  }
  return {
    benchmark: current.benchmark,
    hasPrevious: true,
    noEarlierPreviousRow: false,
    current: currentVersion,
    previous: previousVersion,
    deltas: {
      targetAccuracy: delta(current.target_accuracy, previous.target_accuracy),
      baselineAccuracy: delta(current.baseline_accuracy, previous.baseline_accuracy),
      accuracyGap: delta(current.accuracy_delta, previous.accuracy_delta),
      targetTotalTokens: delta(current.target_total_tokens, previous.target_total_tokens),
      targetCachedTokenPercent: delta(
        current.target_cached_token_percent,
        previous.target_cached_token_percent,
      ),
      targetLlmCallCount: delta(current.target_llm_call_count, previous.target_llm_call_count),
      targetTotal: delta(current.target_total, previous.target_total),
    },
    notes,
  };
}

function buildPayload() {
  const indexData = readIndexData();
  const trajectoryCatalog = readJson(
    "reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json",
  );
  const playbackByKey = playbackIndex(trajectoryCatalog);
  const grouped = new Map();
  for (const row of indexData.benchmark_rows || []) {
    const benchmark = String(row.benchmark || "");
    if (!benchmark) continue;
    const rows = grouped.get(benchmark) || [];
    rows.push(row);
    grouped.set(benchmark, rows);
  }
  const benchmarks = [];
  for (const [benchmark, rows] of grouped) {
    rows.sort((a, b) => String(a.generated_at || "").localeCompare(String(b.generated_at || "")));
    const current = indexData.latest_by_benchmark?.[benchmark] || rows.at(-1);
    const currentIndex = rows.findIndex((row) => row === current || row.run_id === current.run_id && row.generated_at === current.generated_at);
    const previous = rows
      .filter((row, index) => index !== currentIndex)
      .filter((row) => String(row.generated_at || "") <= String(current.generated_at || ""))
      .at(-1) || null;
    benchmarks.push({
      benchmark,
      rowCount: rows.length,
      history: rows.map((row) => attachPlayback(rowVersion(row), row, playbackByKey)),
      comparison: compareRows(current, previous, playbackByKey, rows.length),
    });
  }
  benchmarks.sort((a, b) => a.benchmark.localeCompare(b.benchmark));
  const previousPlaybackGapCount = benchmarks.filter(
    (entry) =>
      entry.comparison.hasPrevious &&
      entry.comparison.current?.targetPlaybackHref &&
      !entry.comparison.previous?.targetPlaybackHref,
  ).length;
  const recoveredPreviousPlaybackBenchmarks = benchmarks
    .filter((entry) => entry.comparison.hasPrevious && entry.comparison.previous?.targetPlaybackHref)
    .map((entry) => entry.benchmark)
    .sort();
  const previousPlaybackGapBenchmarks = benchmarks
    .filter(
      (entry) =>
        entry.comparison.hasPrevious &&
        entry.comparison.current?.targetPlaybackHref &&
        !entry.comparison.previous?.targetPlaybackHref,
    )
    .map((entry) => entry.benchmark)
    .sort();
  return {
    schema: "eliza_code_agent_benchmark_version_comparison_v1",
    generatedAt: new Date().toISOString(),
    sourceIndex: INDEX_DATA_PATH,
    summary: {
      benchmarkCount: benchmarks.length,
      benchmarkRows: (indexData.benchmark_rows || []).length,
      indexedRuns: (indexData.runs || []).length,
      benchmarksWithPrevious: benchmarks.filter((entry) => entry.comparison.hasPrevious).length,
      benchmarksWithoutPrevious: benchmarks.filter((entry) => !entry.comparison.hasPrevious).length,
      onlyOneIndexedRowBenchmarks: benchmarks.filter(
        (entry) => !entry.comparison.hasPrevious && entry.rowCount === 1,
      ).length,
      noEarlierPreviousRowBenchmarks: benchmarks.filter(
        (entry) => entry.comparison.noEarlierPreviousRow,
      ).length,
      currentTargetPlaybackLinks: benchmarks.filter(
        (entry) => entry.comparison.current?.targetPlaybackHref,
      ).length,
      previousTargetPlaybackLinks: benchmarks.filter(
        (entry) => entry.comparison.previous?.targetPlaybackHref,
      ).length,
      comparablePlaybackPairs: benchmarks.filter(
        (entry) =>
          entry.comparison.current?.targetPlaybackHref &&
          entry.comparison.previous?.targetPlaybackHref,
      ).length,
      previousPlaybackGapCount,
      recoveredPreviousPlaybackBenchmarks,
      previousPlaybackGapBenchmarks,
      playbackComparisonStatus:
        previousPlaybackGapCount > 0 ? "aggregate-previous-viewer-only" : "call-by-call-playback",
      previousViewerLinks: benchmarks.filter(
        (entry) => entry.comparison.previous?.viewerHref,
      ).length,
      comparableViewerPairs: benchmarks.filter(
        (entry) =>
          entry.comparison.current?.viewerHref &&
          entry.comparison.previous?.viewerHref,
      ).length,
    },
    benchmarks,
  };
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Version Comparison</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { position:sticky; top:0; z-index:3; background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:14px 20px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .muted { color:#5f685d; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    .controls { display:grid; grid-template-columns:2fr 180px; gap:8px; padding:10px; border-bottom:1px solid #d7ded1; }
    input,select { width:100%; border:1px solid #d7ded1; border-radius:6px; padding:7px 8px; background:#fff; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { position:sticky; top:61px; background:#f7faf4; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .ok { color:#17633a; font-weight:700; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    @media (max-width:900px) { .controls { grid-template-columns:1fr; } th { top:0; } }
  </style>
</head>
<body>
  <header><h1>Benchmark Version Comparison</h1><div id="meta" class="muted"></div></header>
  <main>
    <div id="cards" class="cards"></div>
    <section class="panel">
      <div class="controls">
        <input id="q" type="search" placeholder="Search benchmark, run, dataset..." />
        <select id="state"><option value="">all states</option><option value="previous">has previous</option><option value="single">single row</option></select>
      </div>
      <div id="table"></div>
    </section>
  </main>
  <script src="./version-comparison-data.js"></script>
  <script>
    const data = window.BENCHMARK_VERSION_COMPARISON || { benchmarks: [], summary: {} };
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const pct = v => typeof v === "number" ? (v * 100).toFixed(1) + "%" : "n/a";
    const num = v => typeof v === "number" ? (Math.round(v * 1000) / 1000).toString() : "";
    document.getElementById("meta").textContent = (data.generatedAt || "") + " · " + (data.sourceIndex || "");
    document.getElementById("cards").innerHTML = [["benchmarks",data.summary.benchmarkCount],["rows",data.summary.benchmarkRows],["runs",data.summary.indexedRuns],["with previous",data.summary.benchmarksWithPrevious],["without previous",data.summary.benchmarksWithoutPrevious],["only one indexed row",data.summary.onlyOneIndexedRowBenchmarks],["no earlier previous row",data.summary.noEarlierPreviousRowBenchmarks],["current playback",data.summary.currentTargetPlaybackLinks],["previous playback",data.summary.previousTargetPlaybackLinks],["comparable playback",data.summary.comparablePlaybackPairs],["previous viewers",data.summary.previousViewerLinks],["comparable viewers",data.summary.comparableViewerPairs],["previous playback gaps",data.summary.previousPlaybackGapCount],["comparison status",data.summary.playbackComparisonStatus]].map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? 0) + '</b></div>').join("");
    function filtered() {
      const q = document.getElementById("q").value.toLowerCase();
      const state = document.getElementById("state").value;
      return data.benchmarks.filter(b => {
        const c = b.comparison || {};
        const hay = [b.benchmark, c.current?.runId, c.previous?.runId, c.current?.targetDatasetVersion, c.previous?.targetDatasetVersion, (c.notes || []).join(" ")].join(" ").toLowerCase();
        return (!q || hay.includes(q)) && (!state || (state === "previous" ? c.hasPrevious : !c.hasPrevious));
      });
    }
    function deltaClass(v) { return typeof v !== "number" ? "" : v < 0 ? "bad" : v > 0 ? "ok" : ""; }
    function render() {
      const rows = filtered();
      document.getElementById("table").innerHTML = '<table><thead><tr><th>benchmark</th><th>current</th><th>previous</th><th>latest deltas</th><th>history</th></tr></thead><tbody>' + rows.map(b => {
        const c = b.comparison || {}, cur = c.current || {}, prev = c.previous || {}, d = c.deltas || {};
        return '<tr><td><code>' + esc(b.benchmark) + '</code><br><span class="muted">' + esc(b.rowCount) + ' indexed row(s)</span></td><td><code>' + esc(cur.runId) + '</code><br>' + esc(cur.mode) + ' · ' + esc(cur.status) + '<br>acc ' + esc(pct(cur.targetAccuracy)) + ' · tokens ' + esc(cur.targetTotalTokens ?? '') + '<br><span class="muted">' + esc(cur.targetDatasetVersion) + '</span><br><a href="' + esc(cur.viewerHref) + '">viewer</a>' + (cur.targetPlaybackHref ? ' · <a href="' + esc(cur.targetPlaybackHref) + '">target playback</a>' : '') + (cur.baselinePlaybackHref ? '<br><a href="' + esc(cur.baselinePlaybackHref) + '">baseline playback</a>' : '') + '</td><td>' + (c.hasPrevious ? '<code>' + esc(prev.runId) + '</code><br>' + esc(prev.mode) + ' · ' + esc(prev.status) + '<br>acc ' + esc(pct(prev.targetAccuracy)) + ' · tokens ' + esc(prev.targetTotalTokens ?? '') + '<br><span class="muted">' + esc(prev.targetDatasetVersion) + '</span><br><a href="' + esc(prev.viewerHref) + '">viewer</a>' + (prev.targetPlaybackHref ? ' · <a href="' + esc(prev.targetPlaybackHref) + '">target playback</a>' : '') + (prev.baselinePlaybackHref ? '<br><a href="' + esc(prev.baselinePlaybackHref) + '">baseline playback</a>' : '') : '<span class="muted">none</span>') + '</td><td><div class="' + deltaClass(d.targetAccuracy) + '">target acc Δ ' + esc(num(d.targetAccuracy)) + '</div><div class="' + deltaClass(d.accuracyGap) + '">gap Δ ' + esc(num(d.accuracyGap)) + '</div><div>tokens Δ ' + esc(num(d.targetTotalTokens)) + '</div><div>cache % Δ ' + esc(num(d.targetCachedTokenPercent)) + '</div><div>calls Δ ' + esc(num(d.targetLlmCallCount)) + '</div><div class="muted">' + esc((c.notes || []).join(" ")) + '</div></td><td>' + (b.history || []).map(h => '<div><code>' + esc(h.runId) + '</code> ' + esc(h.mode) + ' ' + esc(pct(h.targetAccuracy)) + (h.targetPlaybackHref ? ' <a href="' + esc(h.targetPlaybackHref) + '">playback</a>' : '') + '</div>').join("") + '</td></tr>';
      }).join("") + '</tbody></table>';
    }
    for (const id of ["q","state"]) document.getElementById(id).addEventListener("input", render);
    document.getElementById("state").addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

function renderMarkdown(payload) {
  const lines = [
    "# Benchmark Version Comparison",
    "",
    `Generated: ${payload.generatedAt}`,
    `Benchmarks: ${payload.summary.benchmarkCount}`,
    `Rows: ${payload.summary.benchmarkRows}`,
    `Runs: ${payload.summary.indexedRuns}`,
    `Benchmarks with previous row: ${payload.summary.benchmarksWithPrevious}`,
    `Benchmarks without previous row: ${payload.summary.benchmarksWithoutPrevious}`,
    `Benchmarks with only one indexed row: ${payload.summary.onlyOneIndexedRowBenchmarks}`,
    `Benchmarks with no earlier previous row: ${payload.summary.noEarlierPreviousRowBenchmarks}`,
    `Current target playback links: ${payload.summary.currentTargetPlaybackLinks}`,
    `Previous target playback links: ${payload.summary.previousTargetPlaybackLinks}`,
    `Comparable playback pairs: ${payload.summary.comparablePlaybackPairs}`,
    `Previous playback gaps: ${payload.summary.previousPlaybackGapCount}`,
    `Recovered previous playback benchmarks: ${(payload.summary.recoveredPreviousPlaybackBenchmarks || []).join(", ")}`,
    `Previous playback gap benchmarks: ${(payload.summary.previousPlaybackGapBenchmarks || []).join(", ")}`,
    `Playback comparison status: ${payload.summary.playbackComparisonStatus}`,
    `Previous viewer links: ${payload.summary.previousViewerLinks}`,
    `Comparable viewer pairs: ${payload.summary.comparableViewerPairs}`,
    "",
    "| benchmark | rows | current | previous | target accuracy delta | target token delta | notes |",
    "|---|---:|---|---|---:|---:|---|",
  ];
  for (const entry of payload.benchmarks) {
    const comparison = entry.comparison;
    lines.push(
      `| \`${entry.benchmark}\` | ${entry.rowCount} | \`${comparison.current.runId}\` ${comparison.current.mode} | ${comparison.previous ? `\`${comparison.previous.runId}\` ${comparison.previous.mode}` : ""} | ${comparison.deltas.targetAccuracy ?? ""} | ${comparison.deltas.targetTotalTokens ?? ""} | ${(comparison.notes || []).join("; ").replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  mkdirSync(DEFAULT_REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "version-comparison-data.js"),
    `window.BENCHMARK_VERSION_COMPARISON = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "version-comparison.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "README.md"),
    renderMarkdown(payload),
    "utf8",
  );
  writeFileSync(path.join(DEFAULT_REPORT_DIR, "index.html"), html(), "utf8");
  process.stdout.write(
    `benchmark version comparison ${payload.summary.benchmarksWithPrevious}/${payload.summary.benchmarkCount} with previous rows\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
