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
  "scenario-remediation-matrix",
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

function slug(value) {
  return String(value || "scenario")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function rerunCommand(id) {
  const runDir = `reports/scenarios/manual-reruns/${slug(id)}`;
  return `SCENARIO_USE_LLM_PROXY=1 bun packages/scenario-runner/src/cli.ts run packages/test/scenarios --scenario ${id} --run-dir ${runDir} --report-dir ${runDir}`;
}

function existsFromReport(href) {
  if (!href || href.startsWith("/") || href.startsWith("file://")) return false;
  return existsSync(path.resolve(REPORT_DIR, href));
}

function buildPayload() {
  const scenarioAgent = readJson(
    "reports/benchmark-analysis/scenario-agent-review/scenario-agent-review.json",
  );
  const failures = readJson("reports/scenarios/failure-analysis/failure-analysis.json");
  const execution = readJson("reports/scenarios/catalog-execution-union/coverage.json");

  const failureById = new Map();
  for (const failure of failures.failures || []) {
    if (!failureById.has(failure.id)) failureById.set(failure.id, []);
    failureById.get(failure.id).push(failure);
  }
  const categoryByKey = new Map((failures.categories || []).map((category) => [category.key, category]));

  const rows = (scenarioAgent.rows || [])
    .filter((row) => row.disposition !== "passed" || row.category)
    .map((row) => {
      const matchingFailures = failureById.get(row.id) || [];
      const category = categoryByKey.get(row.category || "");
      const playbackHref = row.playbackHref || "";
      const categoryPageHref = row.categoryPageHref || "";
      return {
        id: row.id,
        scope: row.scope,
        disposition: row.disposition,
        verdict: row.verdict,
        recommendedAction: row.recommendedAction,
        attempts: row.attempts,
        passed: row.passed,
        failed: row.failed,
        skipped: row.skipped,
        other: row.other,
        category: row.category || "",
        categoryDisposition: row.categoryDisposition || "",
        categoryNextAction: category?.nextAction || row.recommendedAction || "",
        categoryPageHref,
        categoryPageExists: existsFromReport(categoryPageHref),
        playbackHref,
        playbackExists: existsFromReport(playbackHref),
        primaryViewerHref: row.primaryViewerHref || "",
        primaryViewerExists: existsFromReport(row.primaryViewerHref || ""),
        failureCount: matchingFailures.length,
        failureDetails: matchingFailures.slice(0, 3).map((failure) => ({
          run: failure.run,
          category: failure.category,
          detail: failure.detail,
          durationMs: failure.durationMs,
          viewerHref: failure.viewerHref,
          playbackHref: failure.playbackHref,
        })),
        reasons: row.reasons || [],
        runs: row.runs || [],
        rerunCommand: rerunCommand(row.id),
      };
    })
    .sort(
      (a, b) =>
        a.verdict.localeCompare(b.verdict) ||
        a.category.localeCompare(b.category) ||
        a.id.localeCompare(b.id),
    );

  const byVerdict = {};
  const byCategory = {};
  const byDisposition = {};
  for (const row of rows) {
    byVerdict[row.verdict] = (byVerdict[row.verdict] || 0) + 1;
    byCategory[row.category || "uncategorized"] =
      (byCategory[row.category || "uncategorized"] || 0) + 1;
    byDisposition[row.disposition] = (byDisposition[row.disposition] || 0) + 1;
  }

  return {
    schema: "eliza_scenario_remediation_matrix_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      scenarioCount: scenarioAgent.summary?.scenarioCount || 0,
      nonPassingRows: rows.length,
      failedOnlyRows: rows.filter((row) => row.disposition === "failed-only").length,
      passedWithHistoricalFailureRows: rows.filter((row) => row.disposition === "passed" && row.category).length,
      nonPassingWithoutCategory: rows.filter((row) => !row.category).length,
      playbackLinkedRows: rows.filter((row) => row.playbackExists).length,
      categoryLinkedRows: rows.filter((row) => row.categoryPageExists).length,
      rerunCommands: rows.filter((row) => row.rerunCommand).length,
      failureAttemptsJoined: rows.reduce((sum, row) => sum + row.failureCount, 0),
      executionCoverage: {
        catalogScenarioCount: execution.catalogScenarioCount,
        executedScenarioIds: execution.executedScenarioIds,
        missingCount: execution.missingCount,
        scenarioPlaybackPages: execution.scenarioPlaybackPages,
      },
      byVerdict,
      byCategory,
      byDisposition,
    },
    rows,
  };
}

function html(payload) {
  const cards = [
    ["Non-passing", payload.summary.nonPassingRows],
    ["Playback", `${payload.summary.playbackLinkedRows}/${payload.summary.nonPassingRows}`],
    ["Categories", `${payload.summary.categoryLinkedRows}/${payload.summary.nonPassingRows}`],
    ["Rerun commands", payload.summary.rerunCommands],
    ["Failure attempts", payload.summary.failureAttemptsJoined],
  ];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Scenario Remediation Matrix</title>
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
    pre { margin:0; max-height:190px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#101510; color:#eef7ea; padding:8px; border-radius:6px; }
    .bad { color:#a12222; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>Scenario Remediation Matrix</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">${cards
      .map(([label, value]) => `<div class="card"><div class="muted">${escapeHtml(label)}</div><div class="metric">${escapeHtml(value)}</div></div>`)
      .join("")}</section>
    <section class="panel"><h2>Non-Passing Scenarios</h2><div class="body"><table><thead><tr><th>scenario</th><th>verdict</th><th>category</th><th>evidence</th><th>details</th><th>next action</th><th>rerun</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td><code>${escapeHtml(row.id)}</code><br><span class="muted">${escapeHtml(row.scope)} ${escapeHtml(row.disposition)}</span></td><td class="bad">${escapeHtml(row.verdict)}</td><td><code>${escapeHtml(row.category || "uncategorized")}</code><br>${row.categoryPageHref ? `<a href="${escapeHtml(row.categoryPageHref)}">category page</a>` : ""}</td><td><a href="${escapeHtml(row.playbackHref)}">playback</a><br>${row.primaryViewerHref ? `<a href="${escapeHtml(row.primaryViewerHref)}">run viewer</a>` : ""}<br><span class="muted">${escapeHtml(row.failed)} failed / ${escapeHtml(row.passed)} passed</span></td><td>${row.failureDetails.length ? row.failureDetails.map((failure) => `<div><strong>${escapeHtml(failure.run)}</strong> ${escapeHtml(failure.durationMs)}ms<pre>${escapeHtml(failure.detail)}</pre></div>`).join("") : row.reasons.map((reason) => `<div>${escapeHtml(reason)}</div>`).join("")}</td><td>${escapeHtml(row.categoryNextAction || row.recommendedAction)}</td><td><code>${escapeHtml(row.rerunCommand)}</code><br><span class="muted">then <code>bun run bench:analysis:build</code></span></td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Scenario Remediation Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `Non-passing scenarios: ${payload.summary.nonPassingRows}`,
    `Playback-linked rows: ${payload.summary.playbackLinkedRows}/${payload.summary.nonPassingRows}`,
    `Category-linked rows: ${payload.summary.categoryLinkedRows}/${payload.summary.nonPassingRows}`,
    `Rerun commands: ${payload.summary.rerunCommands}`,
    "",
    "| scenario | verdict | category | playback |",
    "| --- | --- | --- | --- |",
    ...payload.rows.map(
      (row) =>
        `| ${row.id} | ${row.verdict} | ${row.category || "uncategorized"} | ${row.playbackHref} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const payload = buildPayload();
  writeFileSync(
    path.join(REPORT_DIR, "scenario-remediation.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `scenario remediation matrix ${payload.summary.nonPassingRows} rows at ${path.relative(REPO_ROOT, REPORT_DIR)}/index.html\n`,
  );
}

main();
