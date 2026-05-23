#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "global-playback-index");

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

function pct(total, cached) {
  return total > 0 ? `${((cached / total) * 100).toFixed(1)}%` : "n/a";
}

function tokenFmt(value) {
  return Math.round(number(value)).toLocaleString("en-US");
}

function existsRelative(relativePath) {
  return existsSync(path.join(REPO_ROOT, relativePath));
}

function buildPayload() {
  const trajectory = readJson("reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json");
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const scenarios = readJson("reports/scenarios/catalog-execution-union/coverage.json");
  const live = readJson("reports/live-test-runs/playback-manifest.json");

  const rows = [];
  for (const entry of trajectory.entries || []) {
    const source = "reports/benchmarks/code-agent-trajectory-catalog";
    const playbackPath = path.join(source, entry.playbackHref || "").replaceAll(path.sep, "/");
    rows.push({
      surface: "code-agent",
      id: `${entry.benchmark}:${entry.side}:${entry.adapter}:${entry.relativePath}`,
      group: entry.benchmark,
      label: `${entry.benchmark} ${entry.side}/${entry.adapter}`,
      disposition: entry.status,
      callCount: number(entry.totals?.records),
      totalTokens: number(entry.totals?.totalTokens),
      cachedTokens: number(entry.totals?.cacheReadTokens),
      cachePercent: entry.totals?.cachePercent ?? null,
      playbackHref: rel(playbackPath),
      playbackExists: existsRelative(playbackPath),
      sourceHref: rel(entry.fileHref ? path.join(source, entry.fileHref) : playbackPath),
    });
  }
  for (const entry of corpus.canonicalFiles || []) {
    rows.push({
      surface: "benchmark-corpus",
      id: `${entry.benchmark_id}:${entry.agent}:${entry.run_id}`,
      group: entry.benchmark_id,
      label: `${entry.benchmark_id} ${entry.agent}`,
      disposition: "canonical-playback",
      callCount: number(entry.call_count),
      totalTokens: number(entry.token_total),
      cachedTokens: number(entry.cached_token_total),
      cachePercent: number(entry.token_total) > 0 ? (number(entry.cached_token_total) / number(entry.token_total)) * 100 : null,
      playbackHref: rel(entry.playback_file || ""),
      playbackExists: existsRelative(entry.playback_file || ""),
      sourceHref: rel(entry.file || ""),
    });
  }
  for (const finding of scenarios.scenarioFindings || []) {
    const playbackPath = `reports/scenarios/catalog-execution-union/${finding.playbackHref || ""}`;
    rows.push({
      surface: "scenario",
      id: finding.id,
      group: finding.scope,
      label: finding.id,
      disposition: finding.disposition,
      callCount: number(finding.attempts),
      totalTokens: 0,
      cachedTokens: 0,
      cachePercent: null,
      playbackHref: rel(playbackPath),
      playbackExists: existsRelative(playbackPath),
      sourceHref: rel((finding.viewers || [])[0] || "reports/scenarios/catalog-execution-union/index.html"),
    });
  }
  for (const entry of live.manifest || []) {
    rows.push({
      surface: "live-e2e",
      id: entry.label,
      group: entry.exitCode === 0 ? "passed-wrapper" : "failed-wrapper",
      label: entry.label,
      disposition: `exit-${entry.exitCode}`,
      callCount: number(entry.eventCount),
      totalTokens: 0,
      cachedTokens: 0,
      cachePercent: null,
      playbackHref: rel(entry.playbackIndex || ""),
      playbackExists: existsRelative(entry.playbackIndex || ""),
      sourceHref: rel(entry.reportJson || entry.viewerIndex || ""),
    });
  }

  const bySurface = rows.reduce((acc, row) => {
    acc[row.surface] ||= { count: 0, playbackExisting: 0, callCount: 0, totalTokens: 0, cachedTokens: 0 };
    acc[row.surface].count += 1;
    if (row.playbackExists) acc[row.surface].playbackExisting += 1;
    acc[row.surface].callCount += row.callCount;
    acc[row.surface].totalTokens += row.totalTokens;
    acc[row.surface].cachedTokens += row.cachedTokens;
    return acc;
  }, {});
  const groupRows = Object.values(
    rows.reduce((acc, row) => {
      const key = `${row.surface}\0${row.group}`;
      acc[key] ||= {
        surface: row.surface,
        group: row.group,
        rowCount: 0,
        playbackExisting: 0,
        callCount: 0,
        totalTokens: 0,
        cachedTokens: 0,
        dispositions: {},
        firstPlaybackHref: row.playbackHref,
        firstSourceHref: row.sourceHref,
      };
      acc[key].rowCount += 1;
      if (row.playbackExists) acc[key].playbackExisting += 1;
      acc[key].callCount += row.callCount;
      acc[key].totalTokens += row.totalTokens;
      acc[key].cachedTokens += row.cachedTokens;
      acc[key].dispositions[row.disposition] = (acc[key].dispositions[row.disposition] || 0) + 1;
      return acc;
    }, {}),
  ).sort((a, b) => {
    const surface = String(a.surface).localeCompare(String(b.surface));
    return surface || String(a.group).localeCompare(String(b.group));
  });
  const benchmarkSortedGroups = groupRows.filter((row) =>
    row.surface === "code-agent" || row.surface === "benchmark-corpus",
  );
  return {
    schema: "eliza_global_playback_index_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      rowCount: rows.length,
      playbackExisting: rows.filter((row) => row.playbackExists).length,
      surfaces: Object.keys(bySurface).length,
      totalCallOrEventCount: rows.reduce((sum, row) => sum + row.callCount, 0),
      totalTokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
      cachedTokens: rows.reduce((sum, row) => sum + row.cachedTokens, 0),
      groupCount: groupRows.length,
      benchmarkGroupCount: benchmarkSortedGroups.length,
      bySurface,
    },
    rows,
    groupRows,
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Global Playback Index</title>
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
    .panel { overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .ok { color:#17633a; font-weight:700; }
    .bad { color:#a12222; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Global Playback Index</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">Playback rows</span><b>${escapeHtml(payload.summary.playbackExisting)}/${escapeHtml(payload.summary.rowCount)}</b><span>existing links</span></div>
      <div class="card"><span class="muted">Surfaces</span><b>${escapeHtml(payload.summary.surfaces)}</b><span>code/corpus/scenario/live</span></div>
      <div class="card"><span class="muted">Review groups</span><b>${escapeHtml(payload.summary.groupCount)}</b><span>${escapeHtml(payload.summary.benchmarkGroupCount)} benchmark groups</span></div>
      <div class="card"><span class="muted">Calls/events</span><b>${escapeHtml(tokenFmt(payload.summary.totalCallOrEventCount))}</b><span>indexed records</span></div>
      <div class="card"><span class="muted">Token cache</span><b>${escapeHtml(pct(payload.summary.totalTokens, payload.summary.cachedTokens))}</b><span>${escapeHtml(tokenFmt(payload.summary.cachedTokens))} cached</span></div>
    </div>
    <section class="panel"><h2>By Surface</h2><div class="body"><table><thead><tr><th>surface</th><th>playback</th><th>calls/events</th><th>tokens</th><th>cache</th></tr></thead><tbody>${Object.entries(payload.summary.bySurface)
      .map(([surface, row]) => `<tr><td><code>${escapeHtml(surface)}</code></td><td>${escapeHtml(row.playbackExisting)}/${escapeHtml(row.count)}</td><td>${escapeHtml(tokenFmt(row.callCount))}</td><td>${escapeHtml(tokenFmt(row.totalTokens))}</td><td>${escapeHtml(pct(row.totalTokens, row.cachedTokens))}</td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Grouped Review Buckets</h2><div class="body"><table><thead><tr><th>surface</th><th>group</th><th>playback</th><th>calls/events</th><th>cache</th><th>dispositions</th><th>start</th></tr></thead><tbody>${payload.groupRows
      .map((row) => `<tr><td><code>${escapeHtml(row.surface)}</code></td><td><code>${escapeHtml(row.group)}</code></td><td>${escapeHtml(row.playbackExisting)}/${escapeHtml(row.rowCount)}</td><td>${escapeHtml(tokenFmt(row.callCount))}</td><td>${escapeHtml(pct(row.totalTokens, row.cachedTokens))}</td><td>${escapeHtml(Object.entries(row.dispositions).map(([key, count]) => `${key}:${count}`).join(", "))}</td><td><a href="${escapeHtml(row.firstPlaybackHref)}">first playback</a><br><a href="${escapeHtml(row.firstSourceHref)}">source</a></td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Playback Rows</h2><div class="body"><table><thead><tr><th>surface</th><th>item</th><th>status</th><th>calls/events</th><th>cache</th><th>links</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td><code>${escapeHtml(row.surface)}</code></td><td><code>${escapeHtml(row.label)}</code><br><span class="muted">${escapeHtml(row.group)}</span></td><td>${escapeHtml(row.disposition)}</td><td>${escapeHtml(row.callCount)}</td><td>${escapeHtml(pct(row.totalTokens, row.cachedTokens))}</td><td><a href="${escapeHtml(row.playbackHref)}">playback</a><br><a href="${escapeHtml(row.sourceHref)}">source</a></td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Global Playback Index",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Playback rows: ${payload.summary.playbackExisting}/${payload.summary.rowCount}`,
    `- Surfaces: ${payload.summary.surfaces}`,
    `- Review groups: ${payload.summary.groupCount}`,
    `- Benchmark review groups: ${payload.summary.benchmarkGroupCount}`,
    `- Calls/events indexed: ${payload.summary.totalCallOrEventCount}`,
    `- Token cache: ${pct(payload.summary.totalTokens, payload.summary.cachedTokens)}`,
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(path.join(REPORT_DIR, "global-playback-index.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(`global playback index ${payload.summary.playbackExisting}/${payload.summary.rowCount} rows at ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
