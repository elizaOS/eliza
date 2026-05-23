#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "review-queue");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relativePath), "utf8"));
}

function rel(target, from = REPORT_DIR) {
  return path.relative(from, path.join(REPO_ROOT, target)).replaceAll(path.sep, "/");
}

function rebaseReportLink(link, sourceReportDir) {
  if (!link || /^(?:https?:|file:|#|\/)/.test(String(link))) return link || "";
  return path
    .relative(REPORT_DIR, path.normalize(path.join(REPO_ROOT, sourceReportDir, link)))
    .replaceAll(path.sep, "/");
}

function priorityFor(kind, disposition) {
  if (disposition === "blocked" || disposition === "missing") return 100;
  if (kind === "scenario" && disposition === "failed-only") return 70;
  if (kind === "live-test" && /failed/.test(disposition)) return 80;
  if (kind === "benchmark" && disposition === "needs-review") return 75;
  if (kind === "goal" && disposition === "caveated") return 85;
  return 50;
}

function playbackByBenchmark(trajectoryCatalog) {
  const byBenchmark = new Map();
  for (const entry of trajectoryCatalog.entries || []) {
    if (!entry.playbackHref) continue;
    const current = byBenchmark.get(entry.benchmark);
    const currentScore =
      (current?.side === "target" ? 1_000_000 : 0) +
      Number(current?.totals?.records || 0) * 1000 +
      Number(current?.totals?.totalTokens || 0);
    const nextScore =
      (entry.side === "target" ? 1_000_000 : 0) +
      Number(entry?.totals?.records || 0) * 1000 +
      Number(entry?.totals?.totalTokens || 0);
    if (!current || nextScore > currentScore) {
      byBenchmark.set(entry.benchmark, entry);
    }
  }
  return byBenchmark;
}

function canonicalPlaybackByBenchmark(corpus) {
  const byBenchmark = new Map();
  for (const entry of corpus.canonicalFiles || []) {
    if (!entry.playback_file) continue;
    const current = byBenchmark.get(entry.benchmark_id);
    const currentScore =
      (current?.agent === "eliza" ? 1_000_000_000_000 : 0) +
      Number(current?.call_count || 0) * 1_000_000 +
      Number(current?.token_total || 0);
    const nextScore =
      (entry.agent === "eliza" ? 1_000_000_000_000 : 0) +
      Number(entry.call_count || 0) * 1_000_000 +
      Number(entry.token_total || 0);
    if (!current || nextScore > currentScore) {
      byBenchmark.set(entry.benchmark_id, entry);
    }
  }
  return byBenchmark;
}

function buildQueue() {
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const codeReview = readJson("reports/benchmark-analysis/benchmark-review/benchmark-review.json");
  const trajectoryCatalog = readJson("reports/benchmarks/code-agent-trajectory-catalog/trajectory-catalog.json");
  const scenarios = readJson("reports/scenarios/catalog-execution-union/coverage.json");
  const failures = readJson("reports/scenarios/failure-analysis/failure-analysis.json");
  const live = readJson("reports/live-test-inventory/inventory.json");
  const audit = readJson("reports/benchmark-analysis/goal-audit.json");
  const benchmarkPlayback = playbackByBenchmark(trajectoryCatalog);
  const familyPlayback = canonicalPlaybackByBenchmark(corpus);

  const items = [];
  for (const row of codeReview.rows || []) {
    if (row.disposition === "review-pass") continue;
    const playback = benchmarkPlayback.get(row.benchmark);
    items.push({
      kind: "code-agent-benchmark",
      id: row.benchmark,
      disposition: row.disposition,
      priority: priorityFor("benchmark", row.disposition),
      summary: `${row.status}; target ${row.target?.right}/${row.target?.total}, baseline ${row.baseline?.right}/${row.baseline?.total}; cache ${row.target?.cachePercent?.toFixed?.(1) ?? "n/a"}%`,
      reasons: [
        ...(row.releaseReadinessBlockingRequirements || []),
        ...(row.caveats || []),
      ].slice(0, 6),
      viewer: playback?.playbackHref
        ? rebaseReportLink(
            playback.playbackHref,
            "reports/benchmarks/code-agent-trajectory-catalog",
          )
        : rebaseReportLink(
            row.reviewLinks?.runViewer || row.viewerHref || "",
            "reports/benchmark-analysis/benchmark-review",
          ),
    });
  }

  for (const finding of corpus.reviewFindings || []) {
    if (finding.disposition === "review-pass") continue;
    const playback = familyPlayback.get(finding.benchmark_id);
    items.push({
      kind: "benchmark-family",
      id: finding.benchmark_id,
      disposition: finding.disposition,
      priority: priorityFor("benchmark", finding.disposition),
      summary: `${finding.succeeded_rows}/${finding.latest_rows} latest rows succeeded; ${finding.normalized_calls} calls; ${finding.token_total} tokens; cache ${finding.cache_percent == null ? "n/a" : `${finding.cache_percent.toFixed(1)}%`}`,
      reasons: finding.reasons || [],
      viewer: playback?.playback_file
        ? rel(playback.playback_file)
        : finding.gap_page
          ? rel(finding.gap_page)
          : rel("reports/benchmarks/benchmark-results-corpus-review/index.html"),
    });
  }

  for (const row of audit.rows || []) {
    if (row.status === "proven") continue;
    items.push({
      kind: "goal",
      id: row.id,
      disposition: row.status,
      priority: priorityFor("goal", row.status),
      summary: row.requirement,
      reasons: [row.evidence],
      viewer:
        row.id === "osworld-live"
          ? rel("reports/benchmark-analysis/gap-evidence/osworld-live-readiness.html")
          : rebaseReportLink(
              row.link || "goal-audit.html",
              "reports/benchmark-analysis",
            ),
    });
  }

  for (const finding of scenarios.scenarioFindings || []) {
    if (finding.disposition === "passed") continue;
    items.push({
      kind: "scenario",
      id: `${finding.scope}:${finding.id}`,
      disposition: finding.disposition,
      priority: priorityFor("scenario", finding.disposition),
      summary: `${finding.passed} passed, ${finding.failed} failed, ${finding.other} other across ${finding.attempts} attempt(s)`,
      reasons: finding.reasons || [],
      viewer: rebaseReportLink(
        finding.playbackHref || "index.html",
        "reports/scenarios/catalog-execution-union",
      ),
    });
  }

  for (const category of failures.categories || []) {
    items.push({
      kind: "scenario-failure-category",
      id: category.key,
      disposition: category.disposition,
      priority: 65,
      summary: `${category.count} failures`,
      reasons: [category.nextAction],
      viewer: category.pageHref
        ? rebaseReportLink(category.pageHref, "reports/scenarios/failure-analysis")
        : rel("reports/scenarios/failure-analysis/index.html"),
    });
  }

  for (const finding of live.scriptFindings || []) {
    if (!finding.likelyLlm || finding.disposition === "model-wrapper-pass") continue;
    items.push({
      kind: "live-test",
      id: `${finding.packageJson}:${finding.script}`,
      disposition: finding.disposition,
      priority: priorityFor("live-test", finding.disposition),
      summary: `artifact=${finding.hasArtifactEvidence ? "yes" : "no"}; wrapped=${finding.wrappedRunCount}; latest exit=${finding.latestWrappedExitCode ?? "n/a"}`,
      reasons: finding.reasons || [],
      viewer: rebaseReportLink(
        finding.latestWrappedPlayback ||
          finding.latestWrappedViewer ||
          finding.modelReviewHref ||
          "index.html",
        "reports/live-test-inventory",
      ),
    });
  }

  items.sort((a, b) => b.priority - a.priority || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const byKind = {};
  const byDisposition = {};
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    byDisposition[item.disposition] = (byDisposition[item.disposition] || 0) + 1;
  }
  return {
    schema: "eliza_benchmark_review_queue_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      itemCount: items.length,
      byKind,
      byDisposition,
      highPriority: items.filter((item) => item.priority >= 80).length,
      scenarioItems: items.filter((item) => item.kind === "scenario").length,
      benchmarkItems: items.filter((item) => /benchmark/.test(item.kind)).length,
      liveTestItems: items.filter((item) => item.kind === "live-test").length,
    },
    items,
  };
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark Review Queue</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:20px; }
    .controls { display:grid; grid-template-columns:2fr repeat(3,minmax(140px,1fr)); gap:8px; padding:10px; border-bottom:1px solid #d7ded1; }
    input,select { width:100%; border:1px solid #d7ded1; border-radius:6px; padding:7px 8px; background:#fff; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f8faf5; position:sticky; top:0; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
    .muted { color:#5f685d; }
    @media (max-width:900px) { .controls { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header><h1>Benchmark Review Queue</h1><div id="meta" class="muted"></div></header>
  <main>
    <div id="cards" class="cards"></div>
    <section class="panel">
      <div class="controls">
        <input id="q" type="search" placeholder="Search queue..." />
        <select id="kind"><option value="">all kinds</option></select>
        <select id="disposition"><option value="">all dispositions</option></select>
        <select id="priority"><option value="">all priorities</option><option value="80">80+</option><option value="70">70+</option></select>
      </div>
      <div id="table"></div>
    </section>
  </main>
  <script src="./review-queue-data.js"></script>
  <script>
    const data = window.BENCHMARK_REVIEW_QUEUE || { items: [], summary: {} };
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    document.getElementById("meta").textContent = data.generatedAt || "";
    const cards = [["Items", data.summary?.itemCount], ["High priority", data.summary?.highPriority], ["Benchmark", data.summary?.benchmarkItems], ["Scenarios", data.summary?.scenarioItems], ["Live/e2e", data.summary?.liveTestItems]];
    document.getElementById("cards").innerHTML = cards.map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? 0) + '</b></div>').join("");
    document.getElementById("kind").innerHTML += [...new Set(data.items.map(i => i.kind))].sort().map(v => '<option>' + esc(v) + '</option>').join("");
    document.getElementById("disposition").innerHTML += [...new Set(data.items.map(i => i.disposition))].sort().map(v => '<option>' + esc(v) + '</option>').join("");
    function cls(item) { return item.priority >= 80 ? "bad" : item.priority >= 70 ? "warn" : "ok"; }
    function render() {
      const q = document.getElementById("q").value.toLowerCase();
      const kind = document.getElementById("kind").value;
      const disposition = document.getElementById("disposition").value;
      const priority = Number(document.getElementById("priority").value || 0);
      const rows = data.items.filter(item => {
        const hay = [item.kind, item.id, item.disposition, item.summary, (item.reasons || []).join(" ")].join(" ").toLowerCase();
        return (!q || hay.includes(q)) && (!kind || item.kind === kind) && (!disposition || item.disposition === disposition) && (!priority || item.priority >= priority);
      });
      document.getElementById("table").innerHTML = '<table><thead><tr><th>priority</th><th>kind</th><th>item</th><th>disposition</th><th>summary</th><th>reasons</th><th>viewer</th></tr></thead><tbody>' + rows.map(item => '<tr><td class="' + cls(item) + '">' + esc(item.priority) + '</td><td>' + esc(item.kind) + '</td><td><code>' + esc(item.id) + '</code></td><td>' + esc(item.disposition) + '</td><td>' + esc(item.summary) + '</td><td>' + esc((item.reasons || []).join("; ")) + '</td><td><a href="' + esc(item.viewer) + '">open</a></td></tr>').join("") + '</tbody></table>';
    }
    for (const id of ["q","kind","disposition","priority"]) document.getElementById(id).addEventListener("input", render);
    for (const id of ["kind","disposition","priority"]) document.getElementById(id).addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Benchmark Review Queue",
    "",
    `Generated: ${payload.generatedAt}`,
    `Items: ${payload.summary.itemCount}`,
    `High priority: ${payload.summary.highPriority}`,
    "",
    "| priority | kind | id | disposition | summary | viewer |",
    "|---:|---|---|---|---|---|",
    ...payload.items.map((item) =>
      `| ${item.priority} | ${item.kind} | \`${item.id}\` | ${item.disposition} | ${item.summary.replaceAll("|", "\\|")} | ${item.viewer} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildQueue();
  writeFileSync(
    path.join(REPORT_DIR, "review-queue.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(REPORT_DIR, "review-queue-data.js"),
    `window.BENCHMARK_REVIEW_QUEUE = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(), "utf8");
  process.stdout.write(
    `benchmark review queue ${payload.summary.itemCount} items; high-priority=${payload.summary.highPriority}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
