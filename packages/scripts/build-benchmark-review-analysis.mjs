#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DEFAULT_REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "benchmark-review");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readWindowJson(filePath, assignmentPrefix) {
  return JSON.parse(
    readFileSync(filePath, "utf8")
      .replace(assignmentPrefix, "")
      .replace(/;\n?$/, ""),
  );
}

function rel(target, from = DEFAULT_REPORT_DIR) {
  return path.relative(from, target).replaceAll(path.sep, "/");
}

function pct(value) {
  return typeof value === "number" && Number.isFinite(value) ? value * 100 : null;
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

function slugify(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "unknown";
}

function statusDisposition(row) {
  if (row.benchmark === "osworld" && row.run_mode === "smoke") return "missing-live";
  if (typeof row.target_total === "number" && row.target_total < 5) return "under-five";
  if (row.status === "superior" || row.status === "comparable") return "review-pass";
  if (row.status === "weak") return "weak-output";
  if (row.status === "inferior") return "inferior";
  return "review";
}

function buildPayload() {
  const indexData = readWindowJson(
    path.join(REPO_ROOT, "reports/benchmarks/code-agent-run-index/index-data.js"),
    /^window\.BENCHMARK_RUN_INDEX = /,
  );
  const trajectoryCatalog = readJson(
    path.join(REPO_ROOT, "reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json"),
  );
  const versionComparison = readJson(
    path.join(REPO_ROOT, "reports/benchmarks/code-agent-version-comparison/version-comparison.json"),
  );
  const gapEvidence = readJson(
    path.join(REPO_ROOT, "reports/benchmark-analysis/gap-evidence/gap-evidence.json"),
  );
  const versionByBenchmark = Object.fromEntries(
    (versionComparison.benchmarks || []).map((entry) => [entry.benchmark, entry]),
  );
  const trajectoryEntriesByBenchmark = new Map();
  for (const entry of trajectoryCatalog.entries || []) {
    if (!trajectoryEntriesByBenchmark.has(entry.benchmark)) {
      trajectoryEntriesByBenchmark.set(entry.benchmark, []);
    }
    trajectoryEntriesByBenchmark.get(entry.benchmark).push(entry);
  }
  const rows = Object.values(indexData.latest_by_benchmark || {})
    .sort((a, b) => String(a.benchmark || "").localeCompare(String(b.benchmark || "")))
    .map((row) => {
      const trajectory = trajectoryCatalog.byBenchmark?.[row.benchmark] || {};
      const trajectoryEntries = trajectoryEntriesByBenchmark.get(row.benchmark) || [];
      const selectedEntries = trajectoryEntries
        .slice()
        .sort((a, b) => {
          const aTarget = a.side === "target" && a.adapter === "elizaos" ? 1 : 0;
          const bTarget = b.side === "target" && b.adapter === "elizaos" ? 1 : 0;
          if (aTarget !== bTarget) return bTarget - aTarget;
          return (
            Number(b.totals?.totalTokens || 0) - Number(a.totals?.totalTokens || 0) ||
            Number(b.totals?.records || 0) - Number(a.totals?.records || 0)
          );
        });
      const representativeRecords = selectedEntries
        .flatMap((entry) =>
          (entry.records || []).slice(0, 5).map((record) => ({
            taskId: record.taskId || "",
            step: record.step ?? null,
            kind: record.kind || "",
            model: record.model || "",
            provider: record.provider || "",
            totalTokens: record.totalTokens ?? null,
            cacheReadTokens: record.cacheReadTokens ?? null,
            cachePercent: record.cachePercent ?? null,
            inputPreview: record.inputPreview || "",
            outputPreview: record.outputPreview || "",
            rawPreview: record.rawPreview || "",
            playbackHref: entry.playbackHref
              ? rel(
                  path.join(
                    REPO_ROOT,
                    "reports/benchmarks/code-agent-trajectory-catalog",
                    entry.playbackHref,
                  ),
                )
              : "",
          })),
        )
        .slice(0, 8);
      const playbackLinks = selectedEntries.slice(0, 6).map((entry) => ({
        side: entry.side,
        adapter: entry.adapter,
        records: entry.totals?.records || 0,
        totalTokens: entry.totals?.totalTokens || 0,
        cacheReadTokens: entry.totals?.cacheReadTokens || 0,
        cachePercent: entry.totals?.cachePercent ?? null,
        href: entry.playbackHref
          ? rel(
              path.join(
                REPO_ROOT,
                "reports/benchmarks/code-agent-trajectory-catalog",
                entry.playbackHref,
              ),
            )
          : "",
      }));
      const version = versionByBenchmark[row.benchmark]?.comparison || {};
      const caveats = [];
      const available = gapEvidence.underFiveBenchmarks?.[row.benchmark];
      if (available) {
        caveats.push(
          `local slice exposes ${available.available} item(s): ${(available.items || []).join(", ")}`,
        );
      }
      if (row.benchmark === "osworld" && row.run_mode === "smoke") {
        caveats.push(gapEvidence.osworld?.blockerSummary || "OSWorld live prerequisites unavailable");
      }
      const blockers = String(row.release_readiness_blocking_requirements || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      return {
        benchmark: row.benchmark,
        disposition: statusDisposition(row),
        runId: row.run_id,
        runMode: row.run_mode,
        status: row.status,
        viewerHref: rel(path.join(row.run_root || "", "viewer", "index.html")),
        target: {
          adapter: row.target_adapter,
          right: row.target_right,
          wrong: row.target_wrong,
          total: row.target_total,
          accuracy: row.target_accuracy,
          inputTokens: row.target_input_tokens,
          outputTokens: row.target_output_tokens,
          totalTokens: row.target_total_tokens,
          cachePercent: row.target_cached_token_percent,
          llmCallCount: row.target_llm_call_count,
        },
        baseline: {
          adapter: row.baseline_adapter,
          right: row.baseline_right,
          wrong: row.baseline_wrong,
          total: row.baseline_total,
          accuracy: row.baseline_accuracy,
          inputTokens: row.baseline_input_tokens,
          outputTokens: row.baseline_output_tokens,
          totalTokens: row.baseline_total_tokens,
          cachePercent: row.baseline_cached_token_percent,
          llmCallCount: row.baseline_llm_call_count,
        },
        deltas: {
          accuracy: row.accuracy_delta,
          totalTokens: row.total_token_delta,
          cachePercent: row.cached_token_percent_delta,
          llmCalls: row.llm_call_delta,
        },
        trajectory: {
          files: trajectory.files || 0,
          records: trajectory.records || 0,
          totalTokens: trajectory.totalTokens || 0,
          cacheReadTokens: trajectory.cacheReadTokens || 0,
          cachePercent: trajectory.cachePercent ?? null,
          adapters: trajectory.adapters || {},
        },
        version: {
          hasPrevious: Boolean(version.hasPrevious),
          currentRunId: version.current?.runId || "",
          previousRunId: version.previous?.runId || "",
          targetAccuracyDelta: version.deltas?.targetAccuracy ?? null,
          targetTokenDelta: version.deltas?.targetTotalTokens ?? null,
          notes: version.notes || [],
        },
        gates: row.gates || {},
        releaseReadinessBlockingRequirements: blockers,
        caveats,
        reviewLinks: {
          benchmarkReview: `benchmarks/${slugify(row.benchmark)}.html`,
          runViewer: row.viewer_href,
          trajectoryCatalog: "../benchmarks/code-agent-trajectory-catalog/index.html",
          versionComparison: "../benchmarks/code-agent-version-comparison/index.html",
        },
        playbackLinks,
        representativeRecords,
      };
    });
  const summary = {
    benchmarkCount: rows.length,
    reviewPass: rows.filter((row) => row.disposition === "review-pass").length,
    weakOrInferior: rows.filter((row) => row.disposition === "weak-output" || row.disposition === "inferior").length,
    underFive: rows.filter((row) => row.disposition === "under-five").length,
    missingLive: rows.filter((row) => row.disposition === "missing-live").length,
    totalTrajectoryFiles: rows.reduce((sum, row) => sum + row.trajectory.files, 0),
    totalTrajectoryRecords: rows.reduce((sum, row) => sum + row.trajectory.records, 0),
    totalTrajectoryTokens: rows.reduce((sum, row) => sum + row.trajectory.totalTokens, 0),
    totalCacheReadTokens: rows.reduce((sum, row) => sum + row.trajectory.cacheReadTokens, 0),
  };
  summary.cachePercent = summary.totalTrajectoryTokens
    ? (summary.totalCacheReadTokens / summary.totalTrajectoryTokens) * 100
    : null;
  return {
    schema: "eliza_benchmark_review_analysis_v1",
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  };
}

function benchmarkDrilldownHtml(row) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(row.benchmark)} Benchmark Review</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; max-height:260px; overflow:auto; background:#f8faf5; border:1px solid #d7ded1; border-radius:6px; padding:8px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
    .ok { color:#17633a; font-weight:700; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
  </style>
</head>
<body>
  <header><h1><code>${escapeHtml(row.benchmark)}</code></h1><div class="muted">${escapeHtml(row.runMode)} · ${escapeHtml(row.status)} · <code>${escapeHtml(row.runId)}</code></div></header>
  <main>
    <div class="grid">
      ${[
        ["Disposition", row.disposition],
        ["ElizaOS", `${row.target.right}/${row.target.total}`],
        ["OpenCode", `${row.baseline.right}/${row.baseline.total}`],
        ["Target tokens", row.target.totalTokens],
        ["Target cache", row.target.cachePercent == null ? "n/a" : `${row.target.cachePercent.toFixed(1)}%`],
        ["Trajectory records", row.trajectory.records],
        ["Catalog cache", row.trajectory.cachePercent == null ? "n/a" : `${row.trajectory.cachePercent.toFixed(1)}%`],
        ["Previous run", row.version.hasPrevious ? "yes" : "no"],
      ]
        .map(([key, value]) => `<div class="card"><span class="muted">${escapeHtml(key)}</span><b>${escapeHtml(value)}</b></div>`)
        .join("")}
    </div>
    <section class="panel"><h2>Review Notes</h2><div class="body">
      <p><strong>Blocking requirements:</strong> ${escapeHtml((row.releaseReadinessBlockingRequirements || []).join("; ") || "none")}</p>
      <p><strong>Caveats:</strong> ${escapeHtml((row.caveats || []).join("; ") || "none")}</p>
      <p><strong>Version notes:</strong> ${escapeHtml((row.version.notes || []).join("; ") || "none")}</p>
    </div></section>
    <section class="panel"><h2>Playback Links</h2><div class="body"><table><thead><tr><th>side</th><th>adapter</th><th>records</th><th>tokens</th><th>cache</th><th>playback</th></tr></thead><tbody>${(row.playbackLinks || [])
      .map(
        (link) =>
          `<tr><td>${escapeHtml(link.side)}</td><td>${escapeHtml(link.adapter)}</td><td>${escapeHtml(link.records)}</td><td>${escapeHtml(link.totalTokens)}</td><td>${escapeHtml(link.cachePercent == null ? "n/a" : `${link.cachePercent.toFixed(1)}%`)}</td><td>${link.href ? `<a href="${escapeHtml(link.href)}">open</a>` : ""}</td></tr>`,
      )
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Representative Trajectory Records</h2><div class="body">${(row.representativeRecords || [])
      .map(
        (record, index) =>
          `<section class="panel"><h2>Record ${index + 1}: ${escapeHtml(record.taskId || record.kind)}</h2><div class="body"><table><tbody><tr><th>tokens</th><td>${escapeHtml(record.totalTokens ?? "n/a")}</td></tr><tr><th>cache</th><td>${escapeHtml(record.cacheReadTokens ?? "n/a")} (${escapeHtml(record.cachePercent == null ? "n/a" : `${record.cachePercent.toFixed(1)}%`)})</td></tr><tr><th>model</th><td>${escapeHtml([record.provider, record.model].filter(Boolean).join(" / ") || "n/a")}</td></tr><tr><th>playback</th><td>${record.playbackHref ? `<a href="${escapeHtml(record.playbackHref)}">open call playback</a>` : ""}</td></tr></tbody></table><h3>Input</h3><pre>${escapeHtml(record.inputPreview)}</pre><h3>Output</h3><pre>${escapeHtml(record.outputPreview)}</pre><h3>Raw</h3><pre>${escapeHtml(record.rawPreview)}</pre></div></section>`,
      )
      .join("") || '<span class="muted">No representative trajectory records were parsed for this benchmark.</span>'}</div></section>
    <section class="panel"><h2>Source Viewers</h2><div class="body"><a href="${escapeHtml(row.reviewLinks.runViewer)}">Run viewer</a> · <a href="${escapeHtml(row.reviewLinks.trajectoryCatalog)}">Trajectory catalog</a> · <a href="${escapeHtml(row.reviewLinks.versionComparison)}">Version comparison</a> · <a href="../index.html">Benchmark review table</a></div></section>
  </main>
</body>
</html>`;
}

function writeBenchmarkDrilldownPages(payload) {
  const dir = path.join(DEFAULT_REPORT_DIR, "benchmarks");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const row of payload.rows || []) {
    writeFileSync(
      path.join(dir, `${slugify(row.benchmark)}.html`),
      benchmarkDrilldownHtml(row),
      "utf8",
    );
  }
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Review Analysis</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { position:sticky; top:0; z-index:3; background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:14px 20px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .muted { color:#5f685d; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    .controls { display:grid; grid-template-columns:2fr repeat(2,minmax(150px,1fr)); gap:8px; padding:10px; border-bottom:1px solid #d7ded1; }
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
  <header><h1>Benchmark Review Analysis</h1><div id="meta" class="muted"></div></header>
  <main>
    <div id="cards" class="cards"></div>
    <section class="panel">
      <div class="controls">
        <input id="q" type="search" placeholder="Search benchmark, status, caveat..." />
        <select id="disposition"><option value="">all dispositions</option></select>
        <select id="mode"><option value="">all modes</option></select>
      </div>
      <div id="table"></div>
    </section>
  </main>
  <script src="./benchmark-review-data.js"></script>
  <script>
    const data = window.BENCHMARK_REVIEW_ANALYSIS || { rows: [], summary: {} };
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const pct = v => typeof v === "number" ? (v * 100).toFixed(1) + "%" : "n/a";
    const num = v => typeof v === "number" ? Math.round(v * 100) / 100 : "";
    document.getElementById("meta").textContent = data.generatedAt || "";
    document.getElementById("cards").innerHTML = [["benchmarks",data.summary.benchmarkCount],["review pass",data.summary.reviewPass],["weak/inferior",data.summary.weakOrInferior],["under-five",data.summary.underFive],["missing live",data.summary.missingLive],["trajectory records",data.summary.totalTrajectoryRecords],["cache %",num(data.summary.cachePercent)]].map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? 0) + '</b></div>').join("");
    for (const [id, values] of [["disposition", [...new Set(data.rows.map(r => r.disposition))].sort()], ["mode", [...new Set(data.rows.map(r => r.runMode))].sort()]]) {
      document.getElementById(id).innerHTML += values.map(v => '<option>' + esc(v) + '</option>').join("");
    }
    function cls(row) { return row.disposition === "review-pass" ? "ok" : row.disposition === "under-five" || row.disposition === "missing-live" ? "warn" : "bad"; }
    function filtered() {
      const q = document.getElementById("q").value.toLowerCase();
      const disposition = document.getElementById("disposition").value;
      const mode = document.getElementById("mode").value;
      return data.rows.filter(r => {
        const hay = [r.benchmark, r.disposition, r.status, r.runMode, (r.caveats || []).join(" "), (r.releaseReadinessBlockingRequirements || []).join(" ")].join(" ").toLowerCase();
        return (!q || hay.includes(q)) && (!disposition || r.disposition === disposition) && (!mode || r.runMode === mode);
      });
    }
    function render() {
      const rows = filtered();
      document.getElementById("table").innerHTML = '<table><thead><tr><th>benchmark</th><th>success</th><th>tokens/cache/calls</th><th>trajectory review</th><th>version/caveats</th><th>links</th></tr></thead><tbody>' + rows.map(r => '<tr><td><code>' + esc(r.benchmark) + '</code><br><strong class="' + cls(r) + '">' + esc(r.disposition) + '</strong><br><span class="muted">' + esc(r.runMode) + ' · ' + esc(r.status) + '</span></td><td>ElizaOS ' + esc(r.target.right) + '/' + esc(r.target.total) + ' ' + esc(pct(r.target.accuracy)) + '<br>OpenCode ' + esc(r.baseline.right) + '/' + esc(r.baseline.total) + ' ' + esc(pct(r.baseline.accuracy)) + '<br>accuracy Δ ' + esc(num(r.deltas.accuracy)) + '</td><td>target tokens ' + esc(r.target.totalTokens) + '<br>baseline tokens ' + esc(r.baseline.totalTokens) + '<br>token Δ ' + esc(r.deltas.totalTokens) + '<br>target cache ' + esc(num(r.target.cachePercent)) + '%<br>catalog cache ' + esc(num(r.trajectory.cachePercent)) + '%<br>calls Δ ' + esc(r.deltas.llmCalls) + '</td><td>files ' + esc(r.trajectory.files) + '<br>records ' + esc(r.trajectory.records) + '<br>catalog tokens ' + esc(r.trajectory.totalTokens) + '<br>cache read ' + esc(r.trajectory.cacheReadTokens) + '</td><td>previous ' + (r.version.hasPrevious ? '<code>' + esc(r.version.previousRunId) + '</code>' : '<span class="muted">none</span>') + '<br>version acc Δ ' + esc(num(r.version.targetAccuracyDelta)) + '<br><span class="muted">' + esc((r.version.notes || []).join(" ")) + '</span><br><strong>' + esc((r.caveats || []).join(" ")) + '</strong></td><td><a href="' + esc(r.reviewLinks.benchmarkReview) + '">benchmark review</a><br><a href="' + esc(r.reviewLinks.runViewer) + '">run viewer</a><br><a href="' + esc(r.reviewLinks.trajectoryCatalog) + '">trajectory catalog</a><br><a href="' + esc(r.reviewLinks.versionComparison) + '">version comparison</a></td></tr>').join("") + '</tbody></table>';
    }
    for (const id of ["q","disposition","mode"]) document.getElementById(id).addEventListener("input", render);
    for (const id of ["disposition","mode"]) document.getElementById(id).addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

function renderMarkdown(payload) {
  const lines = [
    "# Benchmark Review Analysis",
    "",
    `Generated: ${payload.generatedAt}`,
    `Benchmarks: ${payload.summary.benchmarkCount}`,
    `Review pass: ${payload.summary.reviewPass}`,
    `Weak or inferior: ${payload.summary.weakOrInferior}`,
    `Under-five: ${payload.summary.underFive}`,
    `Missing live: ${payload.summary.missingLive}`,
    `Trajectory records: ${payload.summary.totalTrajectoryRecords}`,
    "",
    "| benchmark | disposition | mode/status | elizaOS | OpenCode | target cache % | trajectory records | caveats |",
    "|---|---|---|---:|---:|---:|---:|---|",
  ];
  for (const row of payload.rows) {
    lines.push(
      `| \`${row.benchmark}\` | ${row.disposition} | ${row.runMode}/${row.status} | ${row.target.right}/${row.target.total} (${pct(row.target.accuracy) ?? ""}%) | ${row.baseline.right}/${row.baseline.total} (${pct(row.baseline.accuracy) ?? ""}%) | ${row.target.cachePercent ?? ""} | ${row.trajectory.records} | ${(row.caveats || []).join("; ").replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  mkdirSync(DEFAULT_REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeBenchmarkDrilldownPages(payload);
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "benchmark-review-data.js"),
    `window.BENCHMARK_REVIEW_ANALYSIS = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(
    path.join(DEFAULT_REPORT_DIR, "benchmark-review.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(DEFAULT_REPORT_DIR, "README.md"), renderMarkdown(payload), "utf8");
  writeFileSync(path.join(DEFAULT_REPORT_DIR, "index.html"), html(), "utf8");
  process.stdout.write(
    `benchmark review analysis ${payload.summary.benchmarkCount} benchmarks; ${payload.summary.reviewPass} pass; ${payload.summary.weakOrInferior} weak/inferior\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
