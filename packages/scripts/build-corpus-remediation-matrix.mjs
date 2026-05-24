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
  "corpus-remediation-matrix",
);
const CORPUS_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmarks",
  "benchmark-results-corpus-review",
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

function rel(target) {
  return path.relative(REPORT_DIR, path.join(REPO_ROOT, target)).replaceAll(path.sep, "/");
}

function relCorpus(target) {
  return path.relative(REPORT_DIR, path.join(CORPUS_DIR, target)).replaceAll(path.sep, "/");
}

function existsReportHref(href) {
  if (!href || href.startsWith("/") || href.startsWith("file://")) return false;
  return existsSync(path.resolve(REPORT_DIR, href));
}

function rerunCommand(benchmarkId) {
  return `PYTHONPATH=. python -m benchmarks.orchestrator run --benchmarks ${benchmarkId} --all-harnesses --provider cerebras --model gpt-oss-120b --force --show-incompatible`;
}

function buildPayload() {
  const corpus = readJson("reports/benchmarks/benchmark-results-corpus-review/corpus-review.json");
  const latestRows = corpus.latestRows || [];
  const findings = corpus.reviewFindings || [];
  const canonicalFiles = (corpus.canonicalFiles || []).filter(Boolean);
  const familyPages = new Map(
    (corpus.familyReviewPages || []).filter(Boolean).map((row) => [row.benchmark_id, row]),
  );
  const canonicalByFamily = new Map();
  for (const row of canonicalFiles) {
    if (!canonicalByFamily.has(row.benchmark_id)) canonicalByFamily.set(row.benchmark_id, []);
    canonicalByFamily.get(row.benchmark_id).push(row);
  }
  const latestByFamily = new Map();
  for (const row of latestRows) {
    if (!latestByFamily.has(row.benchmark_id)) latestByFamily.set(row.benchmark_id, []);
    latestByFamily.get(row.benchmark_id).push(row);
  }
  const tokenlessByFamily = new Map(
    (corpus.telemetryGapSummary?.tokenlessFamilies || []).map((row) => [row.benchmark_id, row]),
  );
  const findingByFamily = new Map(findings.map((row) => [row.benchmark_id, row]));
  const familyIds = new Set(
    findings
      .filter((finding) => finding.disposition !== "review-pass")
      .map((finding) => finding.benchmark_id),
  );
  for (const row of latestRows) {
    if ((row.publication_warnings || []).length > 0) familyIds.add(row.benchmark_id);
  }
  for (const row of corpus.telemetryGapSummary?.zeroMetricRows || []) {
    familyIds.add(row.benchmark_id);
  }
  for (const row of corpus.telemetryGapSummary?.tokenlessFamilies || []) {
    familyIds.add(row.benchmark_id);
  }

  const rows = [...familyIds]
    .map((benchmarkId) => {
      const finding = findingByFamily.get(benchmarkId) || {
        benchmark_id: benchmarkId,
        disposition: "review-pass",
        reasons: ["review-pass family included because row-level warnings or zero metrics remain"],
      };
      const familyRows = latestByFamily.get(benchmarkId) || [];
      const warningRows = familyRows.filter((row) => (row.publication_warnings || []).length > 0);
      const zeroMetricRows = familyRows.filter(
        (row) => Number(row.llm_call_count || 0) === 0 || Number(row.trajectory_turns || 0) === 0,
      );
      const canonical = canonicalByFamily.get(finding.benchmark_id) || [];
      const familyPage = familyPages.get(finding.benchmark_id)?.family_page || finding.family_page || "";
      const gapPage =
        finding.disposition === "blocked"
          ? `gap-pages/${finding.benchmark_id}.html`
          : "";
      return {
        benchmarkId,
        disposition: finding.disposition,
        reasons: finding.reasons || [],
        latestRows: Number(finding.latest_rows || familyRows.length || 0),
        succeededRows: Number(finding.succeeded_rows || 0),
        normalizedCalls: Number(finding.normalized_calls || 0),
        tokenTotal: Number(finding.token_total || 0),
        cachedTokenTotal: Number(finding.cached_token_total || 0),
        cachePercent: finding.cache_percent ?? null,
        trajectoryLikeFiles: Number(finding.trajectory_like_files || 0),
        outputFiles: Number(finding.output_files || 0),
        previousPairs: Number(finding.previous_pairs || 0),
        regressionPairs: Number(finding.regression_pairs || 0),
        familyPageHref: familyPage ? rel(familyPage) : "",
        familyPageExists: familyPage ? existsSync(path.join(REPO_ROOT, familyPage)) : false,
        gapPageHref: gapPage ? relCorpus(gapPage) : "",
        gapPageExists: gapPage ? existsSync(path.join(CORPUS_DIR, gapPage)) : false,
        canonicalPlaybackCount: canonical.filter((row) => row.playback_file).length,
        firstPlaybackHref: canonical.find((row) => row.playback_file)
          ? rel(canonical.find((row) => row.playback_file).playback_file)
          : "",
        warningRows: warningRows.map((row) => ({
          runId: row.run_id,
          agent: row.agent,
          status: row.status,
          warnings: row.publication_warnings || [],
          score: row.score,
          totalTasks: row.total_tasks,
          llmCallCount: row.llm_call_count,
          totalTokens: row.total_tokens,
          cachedTokens: row.cached_tokens,
          trajectoryFiles: row.trajectory_files,
          trajectoryTurns: row.trajectory_turns,
        })),
        zeroMetricRows: zeroMetricRows.map((row) => ({
          runId: row.run_id,
          agent: row.agent,
          llmCallCount: row.llm_call_count,
          trajectoryTurns: row.trajectory_turns,
          discoveredTrajectoryFiles: (row.discovered_trajectory_files || []).length,
          callPreviews: (row.call_previews || []).length,
          outputFiles: (row.output_files || []).length,
        })),
        tokenlessTelemetry: tokenlessByFamily.get(benchmarkId) || null,
        rerunCommand: rerunCommand(benchmarkId),
      };
    })
    .sort(
      (a, b) =>
        Number(b.disposition === "blocked") - Number(a.disposition === "blocked") ||
        Number(b.disposition === "telemetry-gap") - Number(a.disposition === "telemetry-gap") ||
        b.warningRows.length - a.warningRows.length ||
        a.benchmarkId.localeCompare(b.benchmarkId),
    );

  return {
    schema: "eliza_corpus_remediation_matrix_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      familyRows: rows.length,
      needsReviewFamilies: rows.filter((row) => row.disposition === "needs-review").length,
      reviewPassIncludedFamilies: rows.filter((row) => row.disposition === "review-pass").length,
      telemetryGapFamilies: rows.filter((row) => row.disposition === "telemetry-gap").length,
      blockedFamilies: rows.filter((row) => row.disposition === "blocked").length,
      publicationWarningLatestRows: rows.reduce((sum, row) => sum + row.warningRows.length, 0),
      insufficientWarningLatestRows: corpus.summary?.insufficientLatestRows || 0,
      zeroMetricRows: rows.reduce((sum, row) => sum + row.zeroMetricRows.length, 0),
      tokenlessFamilies: rows.filter((row) => row.tokenlessTelemetry).length,
      familyPagesLinked: rows.filter((row) => row.familyPageExists || row.gapPageExists).length,
      canonicalPlaybackFamilies: rows.filter((row) => row.canonicalPlaybackCount > 0).length,
      rerunCommands: rows.filter((row) => row.rerunCommand).length,
      normalizedCalls: rows.reduce((sum, row) => sum + row.normalizedCalls, 0),
      tokenTotal: rows.reduce((sum, row) => sum + row.tokenTotal, 0),
      cachedTokenTotal: rows.reduce((sum, row) => sum + row.cachedTokenTotal, 0),
      corpusSummary: corpus.summary,
      reviewFindingSummary: corpus.reviewFindingSummary,
      telemetryGapSummary: corpus.telemetryGapSummary,
    },
    rows,
  };
}

function pct(value) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "n/a";
}

function html(payload) {
  const cards = [
    ["Families", payload.summary.familyRows],
    ["Warnings", payload.summary.publicationWarningLatestRows],
    ["Telemetry gaps", payload.summary.telemetryGapFamilies],
    ["Blocked", payload.summary.blockedFamilies],
    ["Playback families", payload.summary.canonicalPlaybackFamilies],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Corpus Remediation Matrix</title>
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
    table { width:100%; border-collapse:collapse; min-width:1280px; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#fbfcfa; position:sticky; top:0; z-index:1; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    code,pre { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    pre { margin:0; max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:8px; border-radius:6px; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Corpus Remediation Matrix</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">${cards
      .map(([label, value]) => `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${escapeHtml(value)}</div></div>`)
      .join("")}</section>
    <section class="panel"><h2>Family Remediation</h2><div class="body"><table><thead><tr><th>family</th><th>disposition</th><th>evidence</th><th>warnings / zero metrics</th><th>links</th><th>rerun</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td><code>${escapeHtml(row.benchmarkId)}</code></td><td class="${row.disposition === "blocked" ? "bad" : "warn"}">${escapeHtml(row.disposition)}</td><td>${escapeHtml(row.latestRows)} rows, ${escapeHtml(row.normalizedCalls)} calls<br>${escapeHtml(row.tokenTotal)} tokens, cache ${escapeHtml(pct(row.cachePercent))}<br>${escapeHtml(row.trajectoryLikeFiles)} trajectory-like files, ${escapeHtml(row.canonicalPlaybackCount)} playback files<br>${(row.reasons || []).map((reason) => `<div>${escapeHtml(reason)}</div>`).join("")}</td><td><strong>${escapeHtml(row.warningRows.length)}</strong> warning rows, <strong>${escapeHtml(row.zeroMetricRows.length)}</strong> zero-metric rows${row.tokenlessTelemetry ? `<br><span class="bad">tokenless telemetry family</span>` : ""}<pre>${escapeHtml(JSON.stringify({ warnings: row.warningRows.slice(0, 5), zeroMetricRows: row.zeroMetricRows.slice(0, 5) }, null, 2))}</pre></td><td>${row.familyPageHref ? `<a href="${escapeHtml(row.familyPageHref)}">family page</a><br>` : ""}${row.gapPageHref ? `<a href="${escapeHtml(row.gapPageHref)}">gap page</a><br>` : ""}${row.firstPlaybackHref ? `<a href="${escapeHtml(row.firstPlaybackHref)}">first playback</a>` : ""}</td><td><code>${escapeHtml(row.rerunCommand)}</code><br><span class="muted">then <code>bun run bench:analysis:build</code></span></td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Corpus Remediation Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Families: ${payload.summary.familyRows}`,
    `Publication-warning latest rows: ${payload.summary.publicationWarningLatestRows}`,
    `Insufficient-warning latest rows: ${payload.summary.insufficientWarningLatestRows}`,
    `Telemetry-gap families: ${payload.summary.telemetryGapFamilies}`,
    `Blocked families: ${payload.summary.blockedFamilies}`,
    `Rerun commands: ${payload.summary.rerunCommands}`,
    "",
    "| family | disposition | warning rows | zero metrics | playback |",
    "| --- | --- | ---: | ---: | ---: |",
    ...payload.rows.map(
      (row) =>
        `| ${row.benchmarkId} | ${row.disposition} | ${row.warningRows.length} | ${row.zeroMetricRows.length} | ${row.canonicalPlaybackCount} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "corpus-remediation.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `corpus remediation matrix ${payload.summary.familyRows} families at ${path.relative(REPO_ROOT, REPORT_DIR)}/index.html\n`,
  );
}

main();
