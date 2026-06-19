#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const REPORT_DIR = path.join(REPO_ROOT, "reports", "benchmark-analysis", "scenario-agent-review");

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

function scenarioVerdict(finding, failureById, categoryByKey) {
  const failure = failureById.get(finding.id);
  const category = failure ? categoryByKey.get(failure.category) : null;
  if (category) {
    return {
      verdict: category.disposition || "needs-scenario-review",
      action: category.nextAction || "Inspect scenario playback and failure details.",
      category: category.key,
      categoryDisposition: category.disposition,
      categoryPageHref: category.pageHref ? rel(`reports/scenarios/failure-analysis/${category.pageHref}`) : "",
    };
  }
  if (finding.disposition === "passed") {
    return {
      verdict: "passed",
      action: "Keep as current execution evidence; use playback for spot-check review.",
      category: "",
      categoryDisposition: "",
      categoryPageHref: "",
    };
  }
  if (finding.disposition === "non-passing") {
    return {
      verdict: "non-passing-no-failure-category",
      action: "Inspect playback and runner status to decide whether this is skipped, timed out, or unsupported.",
      category: "",
      categoryDisposition: "",
      categoryPageHref: "",
    };
  }
  return {
    verdict: "needs-scenario-review",
    action: "Inspect playback and classify failure cause.",
    category: "",
    categoryDisposition: "",
    categoryPageHref: "",
  };
}

function buildPayload() {
  const coverage = readJson("reports/scenarios/catalog-execution-union/coverage.json");
  const failures = readJson("reports/scenarios/failure-analysis/failure-analysis.json");
  const failureById = new Map((failures.failures || []).map((failure) => [failure.id, failure]));
  const categoryByKey = new Map((failures.categories || []).map((category) => [category.key, category]));
  const rows = (coverage.scenarioFindings || []).map((finding) => {
    const rec = scenarioVerdict(finding, failureById, categoryByKey);
    const playbackHref = finding.playbackHref
      ? rel(`reports/scenarios/catalog-execution-union/${finding.playbackHref}`)
      : "";
    const primaryViewer = (finding.viewers || [])[0] || "";
    return {
      scope: finding.scope,
      id: finding.id,
      disposition: finding.disposition,
      verdict: rec.verdict,
      recommendedAction: rec.action,
      attempts: finding.attempts,
      passed: finding.passed,
      failed: finding.failed,
      skipped: finding.skipped,
      other: finding.other,
      category: rec.category,
      categoryDisposition: rec.categoryDisposition,
      categoryPageHref: rec.categoryPageHref,
      playbackHref,
      playbackExists: playbackHref
        ? existsSync(path.join(REPO_ROOT, "reports/benchmark-analysis/scenario-agent-review", playbackHref))
        : false,
      primaryViewerHref: primaryViewer ? rel(primaryViewer) : "",
      reasons: finding.reasons || [],
      runs: finding.runs || [],
    };
  });
  const byVerdict = rows.reduce((acc, row) => {
    acc[row.verdict] = (acc[row.verdict] || 0) + 1;
    return acc;
  }, {});
  const byDisposition = rows.reduce((acc, row) => {
    acc[row.disposition] = (acc[row.disposition] || 0) + 1;
    return acc;
  }, {});
  return {
    schema: "eliza_scenario_agent_review_v1",
    generatedAt: new Date().toISOString(),
    summary: {
      scenarioCount: rows.length,
      reviewed: rows.filter((row) => row.verdict).length,
      playbackLinks: rows.filter((row) => row.playbackHref).length,
      playbackExisting: rows.filter((row) => row.playbackExists).length,
      passed: rows.filter((row) => row.disposition === "passed").length,
      failedOnly: rows.filter((row) => row.disposition === "failed-only").length,
      nonPassing: rows.filter((row) => row.disposition === "non-passing").length,
      categorizedFailures: rows.filter((row) => row.category).length,
      failureCategoryPages: (failures.categories || []).length,
      byDisposition,
      byVerdict,
    },
    rows,
    categories: failures.categories || [],
  };
}

function html(payload) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Scenario Agent Review</title>
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
  <header><h1>Scenario Agent Review</h1><div class="muted">${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <div class="cards">
      <div class="card"><span class="muted">Scenarios reviewed</span><b>${escapeHtml(payload.summary.reviewed)}/${escapeHtml(payload.summary.scenarioCount)}</b><span>catalog findings</span></div>
      <div class="card"><span class="muted">Playback links</span><b>${escapeHtml(payload.summary.playbackExisting)}/${escapeHtml(payload.summary.scenarioCount)}</b><span>local playback pages</span></div>
      <div class="card"><span class="muted">Passed</span><b>${escapeHtml(payload.summary.passed)}</b><span>current execution</span></div>
      <div class="card"><span class="muted">Categorized failures</span><b>${escapeHtml(payload.summary.categorizedFailures)}</b><span>${escapeHtml(payload.summary.failureCategoryPages)} category pages</span></div>
    </div>
    <section class="panel"><h2>Failure Category Actions</h2><div class="body"><table><thead><tr><th>category</th><th>count</th><th>disposition</th><th>next action</th><th>page</th></tr></thead><tbody>${payload.categories
      .map((category) => `<tr><td><code>${escapeHtml(category.key)}</code></td><td>${escapeHtml(category.count)}</td><td>${escapeHtml(category.disposition)}</td><td>${escapeHtml(category.nextAction)}</td><td><a href="${escapeHtml(rel(`reports/scenarios/failure-analysis/${category.pageHref}`))}">open</a></td></tr>`)
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>All Scenarios</h2><div class="body"><table><thead><tr><th>scenario</th><th>verdict</th><th>attempts</th><th>action</th><th>links</th></tr></thead><tbody>${payload.rows
      .map((row) => `<tr><td><code>${escapeHtml(row.id)}</code><br><span class="muted">${escapeHtml(row.scope)} · ${escapeHtml(row.disposition)}${row.category ? ` · ${escapeHtml(row.category)}` : ""}</span></td><td class="${row.verdict === "passed" ? "ok" : "warn"}">${escapeHtml(row.verdict)}</td><td>${escapeHtml(row.passed)}/${escapeHtml(row.attempts)} passed; ${escapeHtml(row.failed)} failed</td><td>${escapeHtml(row.recommendedAction)}</td><td><a href="${escapeHtml(row.playbackHref)}">playback</a>${row.categoryPageHref ? `<br><a href="${escapeHtml(row.categoryPageHref)}">category</a>` : ""}${row.primaryViewerHref ? `<br><a href="${escapeHtml(row.primaryViewerHref)}">run</a>` : ""}</td></tr>`)
      .join("")}</tbody></table></div></section>
  </main>
</body>
</html>`;
}

function markdown(payload) {
  return [
    "# Scenario Agent Review",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Scenarios reviewed: ${payload.summary.reviewed}/${payload.summary.scenarioCount}`,
    `- Playback pages: ${payload.summary.playbackExisting}/${payload.summary.scenarioCount}`,
    `- Passed: ${payload.summary.passed}`,
    `- Failed-only: ${payload.summary.failedOnly}`,
    `- Non-passing: ${payload.summary.nonPassing}`,
    `- Categorized failures: ${payload.summary.categorizedFailures}`,
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
    path.join(REPORT_DIR, "scenario-agent-review.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), markdown(payload), "utf8");
  process.stdout.write(
    `scenario agent review ${payload.summary.reviewed}/${payload.summary.scenarioCount} scenarios at ${path.join(REPORT_DIR, "index.html")}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
