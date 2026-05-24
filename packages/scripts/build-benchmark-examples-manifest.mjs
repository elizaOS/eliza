#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "benchmark-examples");

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

function buildPayload() {
  const review = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const trajectory = readJson("reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json");
  const targetEntriesByBenchmark = new Map();
  for (const entry of trajectory.entries || []) {
    if (entry.side !== "target") continue;
    if (!targetEntriesByBenchmark.has(entry.benchmark)) {
      targetEntriesByBenchmark.set(entry.benchmark, []);
    }
    targetEntriesByBenchmark.get(entry.benchmark).push(entry);
  }
  const rows = (review.rows || []).map((row) => {
    const entries = targetEntriesByBenchmark.get(row.benchmark) || [];
    const examples = [];
    const seen = new Set();
    for (const entry of entries) {
      for (const taskId of entry.taskIds || []) {
        const id = String(taskId || "").trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        examples.push({
          id,
          playbackHref: entry.playbackHref
            ? rel(`reports/benchmarks/code-agent-trajectory-catalog/${entry.playbackHref}`)
            : "",
          fileHref: entry.fileHref
            ? rel(`reports/benchmarks/code-agent-trajectory-catalog/${entry.fileHref}`)
            : "",
        });
      }
    }
    const sampleCount = Number(row.target?.total || 0);
    const explicitExampleCount = examples.length;
    const evidenceCount = Math.max(sampleCount, explicitExampleCount);
    return {
      benchmark: row.benchmark,
      runId: row.runId,
      runMode: row.runMode,
      disposition: row.disposition,
      status: row.status,
      sampleCount,
      explicitExampleCount,
      evidenceCount,
      hasFiveExamples: evidenceCount >= 5,
      caveat:
        explicitExampleCount >= 5
          ? ""
          : sampleCount >= 5
            ? "sample count is proven by benchmark result totals; explicit task IDs were not recovered from target trajectories"
            : "fewer than five examples are proven",
      reviewHref: rel(`reports/benchmark-analysis/benchmark-review/${row.reviewLinks?.benchmarkReview || "index.html"}`),
      runViewerHref: row.reviewLinks?.runViewer
        ? rel(`reports/benchmark-analysis/benchmark-review/${row.reviewLinks.runViewer}`)
        : "",
      examples: examples.slice(0, 12),
    };
  });
  return {
    schema: "eliza_benchmark_examples_manifest_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      benchmarkCount: rows.length,
      withFiveExamples: rows.filter((row) => row.hasFiveExamples).length,
      withExplicitFiveTaskIds: rows.filter((row) => row.explicitExampleCount >= 5).length,
      withSampleCountOnly: rows.filter(
        (row) => row.explicitExampleCount < 5 && row.sampleCount >= 5,
      ).length,
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
  <title>Benchmark Examples Manifest</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; overflow:hidden; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f7faf4; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .ok { color:#17633a; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Benchmark Examples Manifest</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main class="panel">
    <table><thead><tr><th>benchmark</th><th>examples</th><th>explicit IDs</th><th>sample IDs</th><th>review</th></tr></thead><tbody>${payload.rows
      .map(
        (row) =>
          `<tr><td><code>${escapeHtml(row.benchmark)}</code><br><span class="${row.hasFiveExamples ? "ok" : "warn"}">${escapeHtml(row.disposition)}</span><br><span class="muted">${escapeHtml(row.runMode)} · ${escapeHtml(row.status)}</span></td><td>${escapeHtml(row.evidenceCount)}/5 proven<br><span class="muted">result total ${escapeHtml(row.sampleCount)}; explicit IDs ${escapeHtml(row.explicitExampleCount)}</span><br><span class="warn">${escapeHtml(row.caveat)}</span></td><td>${row.examples
            .map((example) => `<div><code>${escapeHtml(example.id)}</code>${example.playbackHref ? ` · <a href="${escapeHtml(example.playbackHref)}">playback</a>` : ""}</div>`)
            .join("")}</td><td>${escapeHtml(row.examples.map((example) => example.id).join(", "))}</td><td><a href="${escapeHtml(row.reviewHref)}">benchmark review</a>${row.runViewerHref ? `<br><a href="${escapeHtml(row.runViewerHref)}">run viewer</a>` : ""}</td></tr>`,
      )
      .join("")}</tbody></table>
  </main>
</body>
</html>`;
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "examples.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(REPORT_DIR, "examples-data.js"),
    `window.BENCHMARK_EXAMPLES_MANIFEST = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(
    path.join(REPORT_DIR, "README.md"),
    [
      "# Benchmark Examples Manifest",
      "",
      `Generated: ${payload.generatedAt}`,
      `Benchmarks: ${payload.summary.benchmarkCount}`,
      `Five-example evidence: ${payload.summary.withFiveExamples}/${payload.summary.benchmarkCount}`,
      `Explicit five task IDs: ${payload.summary.withExplicitFiveTaskIds}/${payload.summary.benchmarkCount}`,
      `Sample-count-only rows: ${payload.summary.withSampleCountOnly}`,
      "",
      "HTML viewer: `index.html`",
      "",
    ].join("\n"),
    "utf8",
  );
  process.stdout.write(
    `benchmark examples manifest ${payload.summary.withFiveExamples}/${payload.summary.benchmarkCount} with five-example evidence\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
