#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  "scenario-outcome-matrix",
);
const AGENT_REVIEW_DIR = path.join(
  REPO_ROOT,
  "reports",
  "benchmark-analysis",
  "scenario-agent-review",
);
const REMEDIATION_DIR = path.join(
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

function rel(href, sourceDir) {
  if (!href) return "";
  const text = String(href);
  if (text.startsWith("/") || text.startsWith("file://")) return "";
  const absolute = text.startsWith("reports/")
    ? path.join(REPO_ROOT, text)
    : path.resolve(sourceDir, text);
  return path.relative(REPORT_DIR, absolute).replaceAll(path.sep, "/");
}

function buildPayload() {
  const coverage = readJson("reports/scenarios/catalog-execution-union/coverage.json");
  const agentReview = readJson(
    "reports/benchmark-analysis/scenario-agent-review/scenario-agent-review.json",
  );
  const remediation = readJson(
    "reports/benchmark-analysis/scenario-remediation-matrix/scenario-remediation.json",
  );

  const remediationByKey = new Map(
    (remediation.rows || []).map((row) => [`${row.scope}:${row.id}`, row]),
  );
  const coverageByKey = new Map(
    (coverage.scenarioFindings || []).map((row) => [`${row.scope}:${row.id}`, row]),
  );

  const rows = (agentReview.rows || []).map((row) => {
    const key = `${row.scope}:${row.id}`;
    const rem = remediationByKey.get(key);
    const cov = coverageByKey.get(key);
    const verdict = row.verdict || (row.disposition === "passed" ? "passed" : "uncategorized");
    const reviewClass =
      row.disposition === "passed"
        ? "passed"
        : verdict === "evidence-limited"
          ? "evidence-limited"
          : verdict === "non-passing-no-failure-category"
            ? "uncategorized-non-passing"
            : "actionable";
    return {
      id: row.id,
      scope: row.scope,
      key,
      disposition: row.disposition,
      verdict,
      reviewClass,
      recommendedAction: rem?.recommendedAction || row.recommendedAction || "",
      category: rem?.category || row.category || "",
      categoryDisposition: rem?.categoryDisposition || row.categoryDisposition || "",
      attempts: row.attempts,
      passed: row.passed,
      failed: row.failed,
      skipped: row.skipped,
      other: row.other,
      playbackHref: rel(row.playbackHref || cov?.playbackHref, AGENT_REVIEW_DIR),
      playbackExists: Boolean(row.playbackExists),
      primaryViewerHref: rel(row.primaryViewerHref, AGENT_REVIEW_DIR),
      categoryPageHref: rel(rem?.categoryPageHref || row.categoryPageHref, rem ? REMEDIATION_DIR : AGENT_REVIEW_DIR),
      rerunCommand: rem?.rerunCommand || "",
      reasons: row.reasons || cov?.reasons || [],
      runs: row.runs || cov?.runs || [],
    };
  });

  const summary = {
    scenarioCount: rows.length,
    executionScenarioCount: coverage.catalogScenarioCount,
    missingExecution: coverage.missingCount,
    playbackLinkedRows: rows.filter((row) => row.playbackHref).length,
    playbackExistingRows: rows.filter((row) => row.playbackExists).length,
    passed: rows.filter((row) => row.disposition === "passed").length,
    failedOnly: rows.filter((row) => row.disposition === "failed-only").length,
    nonPassing: rows.filter((row) => row.disposition === "non-passing").length,
    actionableRows: rows.filter((row) => row.reviewClass === "actionable").length,
    evidenceLimitedRows: rows.filter((row) => row.reviewClass === "evidence-limited").length,
    uncategorizedNonPassingRows: rows.filter((row) => row.reviewClass === "uncategorized-non-passing").length,
    rerunCommands: rows.filter((row) => row.rerunCommand).length,
    categoryLinkedRows: rows.filter((row) => row.categoryPageHref).length,
    byVerdict: rows.reduce((counts, row) => {
      counts[row.verdict] = (counts[row.verdict] || 0) + 1;
      return counts;
    }, {}),
    byScope: rows.reduce((counts, row) => {
      counts[row.scope] = (counts[row.scope] || 0) + 1;
      return counts;
    }, {}),
  };

  return {
    schema: "eliza_scenario_outcome_matrix_v1",
    generatedAt: new Date().toISOString(),
    summary,
    rows,
  };
}

function link(href, label) {
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : "";
}

function html(payload) {
  const rows = payload.rows
    .map(
      (row) => `<tr>
        <td><code>${escapeHtml(row.scope)}/${escapeHtml(row.id)}</code></td>
        <td><b>${escapeHtml(row.disposition)}</b><br><span class="muted">${escapeHtml(row.reviewClass)}</span></td>
        <td>${escapeHtml(row.verdict)}<br><span class="muted">${escapeHtml(row.category)}</span></td>
        <td>${row.passed}/${row.failed}/${row.skipped}/${row.other}<br><span class="muted">${row.attempts} attempts</span></td>
        <td>${link(row.playbackHref, "playback")} ${link(row.primaryViewerHref, "viewer")} ${link(row.categoryPageHref, "category")}</td>
        <td>${escapeHtml(row.recommendedAction || "No remediation action needed.")}</td>
      </tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Scenario Outcome Matrix</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin:14px 0; }
    .card { background:#fff; border:1px solid #d7ded1; border-radius:8px; padding:10px; }
    .card b { display:block; font-size:20px; }
    table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #d7ded1; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { background:#f2f5ef; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; margin-right:8px; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
  </style>
</head>
<body>
  <header><h1>Scenario Outcome Matrix</h1><div class="muted">Generated ${escapeHtml(payload.generatedAt)}</div></header>
  <main>
    <section class="cards">
      <div class="card"><span class="muted">Scenarios</span><b>${payload.summary.scenarioCount}</b></div>
      <div class="card"><span class="muted">Passed</span><b>${payload.summary.passed}</b></div>
      <div class="card"><span class="muted">Failed-only</span><b>${payload.summary.failedOnly}</b></div>
      <div class="card"><span class="muted">Evidence-limited</span><b>${payload.summary.evidenceLimitedRows}</b></div>
      <div class="card"><span class="muted">Actionable</span><b>${payload.summary.actionableRows}</b></div>
      <div class="card"><span class="muted">Playback</span><b>${payload.summary.playbackLinkedRows}</b></div>
    </section>
    <table>
      <thead><tr><th>Scenario</th><th>Disposition</th><th>Verdict</th><th>Pass/fail/skip/other</th><th>Links</th><th>Next action</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function readme(payload) {
  return [
    "# Scenario Outcome Matrix",
    "",
    `Generated: ${payload.generatedAt}`,
    "",
    `- Scenarios: ${payload.summary.scenarioCount}`,
    `- Execution missing: ${payload.summary.missingExecution}`,
    `- Playback linked: ${payload.summary.playbackLinkedRows}`,
    `- Passed: ${payload.summary.passed}`,
    `- Failed-only: ${payload.summary.failedOnly}`,
    `- Non-passing: ${payload.summary.nonPassing}`,
    `- Evidence-limited: ${payload.summary.evidenceLimitedRows}`,
    `- Actionable: ${payload.summary.actionableRows}`,
    `- Rerun commands: ${payload.summary.rerunCommands}`,
    "",
    "| scope | scenario | disposition | verdict | category |",
    "|---|---|---|---|---|",
    ...payload.rows.map(
      (row) =>
        `| ${row.scope} | \`${row.id}\` | ${row.disposition} | ${row.verdict} | ${row.category} |`,
    ),
    "",
  ].join("\n");
}

function main() {
  const payload = buildPayload();
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(
    path.join(REPORT_DIR, "scenario-outcome-matrix.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(REPORT_DIR, "index.html"), html(payload), "utf8");
  writeFileSync(path.join(REPORT_DIR, "README.md"), readme(payload), "utf8");
  process.stdout.write(`scenario outcome matrix ${path.join(REPORT_DIR, "index.html")}\n`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
