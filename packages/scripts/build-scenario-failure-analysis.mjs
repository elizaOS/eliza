#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const DEFAULT_REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "scenarios",
  "failure-analysis",
);
const RUNS = [
  "deterministic-all",
  "deterministic-remainder",
  "deterministic-remainder-2",
  "plugin-lifeops-deterministic",
  "plugin-app-control-deterministic",
  "scenario-runner-package-deterministic",
  "live-cerebras-5",
  "live-cerebras-connectors-5",
  "live-cerebras-native-2",
  "pr-deterministic",
];
const CATEGORY_DISPOSITIONS = {
  "partial-run-reconstructed": {
    disposition: "evidence-limited",
    nextAction:
      "Rerun timed-out shards with a longer timeout or smaller shard size before treating these as product failures.",
  },
  "wrong-or-missing-action": {
    disposition: "product-or-routing-fix",
    nextAction:
      "Inspect expected action registrations and routing prompts; most samples show REPLY where a tool/action was asserted.",
  },
  "failed-without-structured-detail": {
    disposition: "reporter-improvement",
    nextAction:
      "Improve scenario assertions or partial reconstruction so failures carry actionable details.",
  },
  "scenario-runner-coverage": {
    disposition: "runner-fix",
    nextAction:
      "Implement or intentionally retire unsupported final-check and turn kinds referenced by scenarios.",
  },
  "connector-behavior": {
    disposition: "connector-certification-fix",
    nextAction:
      "Compare expected connector actions/results with actual calls and update connector routing or scenario expectations.",
  },
  "http-or-route-missing": {
    disposition: "environment-or-route-fix",
    nextAction:
      "Confirm required test server routes are mounted for deterministic runs, especially 404 setup paths.",
  },
  "seed-data-setup": {
    disposition: "fixture-or-store-fix",
    nextAction:
      "Inspect seed fixtures and persistence schema; failures happen before behavior evaluation starts.",
  },
  "response-rubric": {
    disposition: "behavior-or-rubric-fix",
    nextAction:
      "Review response text against rubric; either tighten behavior or update overly broad assertions.",
  },
  "auth-or-environment": {
    disposition: "environment-fix",
    nextAction:
      "Refresh test credentials/tokens or replace live auth dependency with deterministic fixtures.",
  },
  timeout: {
    disposition: "runtime-fix",
    nextAction: "Rerun with a bounded smaller shard or inspect the specific long-running scenario.",
  },
  other: {
    disposition: "needs-manual-triage",
    nextAction:
      "Inspect sample details and add a more precise category once the failure mode is understood.",
  },
};

function parseArgs(argv) {
  const options = { reportDir: DEFAULT_REPORT_DIR, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report-dir") {
      const next = argv[++i];
      if (!next) throw new Error("--report-dir requires a value");
      options.reportDir = path.resolve(REPO_ROOT, next);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function rel(target, from) {
  return path.relative(from, target).replaceAll(path.sep, "/");
}

function compact(value, max = 260) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
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

function pathSegment(value) {
  return String(value || "unknown")
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140) || "unknown";
}

function detailsForScenario(scenario) {
  const details = [];
  for (const turn of scenario.turns || []) {
    for (const assertion of turn.failedAssertions || []) {
      details.push(String(assertion));
    }
  }
  for (const check of scenario.finalChecks || []) {
    if (check?.status === "failed") {
      details.push(
        [check.label || check.type || "finalCheck", check.detail]
          .filter(Boolean)
          .join(": "),
      );
    }
  }
  if (scenario.error) details.push(String(scenario.error));
  if (scenario.failure) details.push(String(scenario.failure));
  if (scenario.status === "failed" && details.length === 0) {
    const actionNames = new Set();
    for (const turn of scenario.turns || []) {
      for (const action of turn.actionsCalled || []) {
        if (action?.actionName) actionNames.add(action.actionName);
      }
    }
    if (actionNames.size > 0) {
      details.push(`Failed with actions called: ${[...actionNames].join(", ")}`);
    }
  }
  if (details.length === 0 && Array.isArray(scenario.trajectories)) {
    const first = scenario.trajectories[0];
    if (first?.rootMessage) {
      details.push(`Reconstructed partial failure; root message: ${first.rootMessage}`);
    }
  }
  return details;
}

function categoryFor(details, scenario) {
  const text = `${scenario.id} ${scenario.domain || ""} ${details.join(" ")}`;
  if (/Expected .* via|selectedAction|instead of expected|no selected action|Expected action|actionCalled|expected .* result data|Expected .* to fire|Expected .* payload|result payload missing|saw 0\. Called: REPLY/i.test(text)) {
    return "wrong-or-missing-action";
  }
  if (/responseJudge|rubric|score\s+0|expected .*mentioned|No .*mentioned|responseIncludesAny|response missing|expected responseText|saw ".*"/i.test(text)) {
    return "response-rubric";
  }
  if (/no handler registered|turn kind .* not supported/i.test(text)) {
    return "scenario-runner-coverage";
  }
  if (/expectedStatus: expected \d+, saw \d+|saw 404|route|endpoint/i.test(text)) {
    return "http-or-route-missing";
  }
  if (/seed .* threw|Failed query: INSERT|fixture|setup/i.test(text)) {
    return "seed-data-setup";
  }
  if (/expired|token|auth|credential|unauthorized|forbidden/i.test(text)) {
    return "auth-or-environment";
  }
  if (/timeout|timed out/i.test(text)) {
    return "timeout";
  }
  if (/Reconstructed partial failure/i.test(text)) {
    return "partial-run-reconstructed";
  }
  if (/connector|draft|calendar|discord|gmail|notification|inbox/i.test(text)) {
    return "connector-behavior";
  }
  if (details.length === 0 || /failed without structured assertion detail/i.test(text)) {
    return "failed-without-structured-detail";
  }
  return "other";
}

function collectRun(runName) {
  const matrixPath = path.join(
    REPO_ROOT,
    "reports",
    "scenarios",
    runName,
    "matrix.json",
  );
  if (!existsSync(matrixPath)) return null;
  const matrix = readJson(matrixPath);
  const scenarios = Array.isArray(matrix.scenarios) ? matrix.scenarios : [];
  const failed = scenarios.filter((scenario) => scenario.status === "failed");
  const failures = failed.map((scenario) => {
    const details = detailsForScenario(scenario);
    return {
      id: scenario.id,
      title: scenario.title || "",
      domain: scenario.domain || "",
      tags: Array.isArray(scenario.tags) ? scenario.tags : [],
      durationMs: scenario.durationMs,
      category: categoryFor(details, scenario),
      detail: compact(details[0] || "failed without structured assertion detail"),
      detailCount: details.length,
    };
  });
  return {
    name: runName,
    matrixPath,
    viewer: path.join(REPO_ROOT, "reports", "scenarios", runName, "viewer", "index.html"),
    partial: Boolean(matrix.partial),
    timedOut: Boolean(matrix.timedOut),
    totalCount: matrix.totalCount ?? scenarios.length,
    passedCount: matrix.passedCount ?? scenarios.filter((scenario) => scenario.status === "passed").length,
    failedCount: matrix.failedCount ?? failed.length,
    skippedCount: matrix.skippedCount ?? scenarios.filter((scenario) => scenario.status === "skipped").length,
    providerName: matrix.providerName || "",
    failures,
  };
}

function countBy(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row) || "unknown";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      count,
      ...(CATEGORY_DISPOSITIONS[key] || CATEGORY_DISPOSITIONS.other),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function scenarioPlaybackMap(reportDir) {
  const coveragePath = path.join(
    REPO_ROOT,
    "reports",
    "scenarios",
    "catalog-execution-union",
    "coverage.json",
  );
  if (!existsSync(coveragePath)) return new Map();
  const coverage = readJson(coveragePath);
  const map = new Map();
  for (const finding of coverage.scenarioFindings || []) {
    if (!finding.playbackHref) continue;
    const href = rel(
      path.join(
        REPO_ROOT,
        "reports",
        "scenarios",
        "catalog-execution-union",
        finding.playbackHref,
      ),
      reportDir,
    );
    if (!map.has(finding.id)) map.set(finding.id, href);
  }
  return map;
}

function categoryPageHtml(category, failures) {
  const sampleRows = failures.slice(0, 60);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(category.key)} Scenario Failures</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    h2 { margin:0; padding:10px 12px; background:#f2f5ef; border-bottom:1px solid #d7ded1; font-size:15px; }
    .panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; margin-bottom:12px; overflow:hidden; }
    .body { padding:12px; overflow:auto; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:#116b5b; text-decoration:none; }
    a:hover { text-decoration:underline; }
    .muted { color:#5f685d; }
    .bad { color:#a12222; font-weight:700; }
  </style>
</head>
<body>
  <header><h1>${escapeHtml(category.key)}</h1><div class="muted">${escapeHtml(category.disposition)} · ${escapeHtml(category.count)} failure(s)</div></header>
  <main>
    <section class="panel"><h2>Next Action</h2><div class="body">${escapeHtml(category.nextAction)}</div></section>
    <section class="panel"><h2>Samples</h2><div class="body"><table><thead><tr><th>run</th><th>scenario</th><th>detail</th><th>review</th></tr></thead><tbody>${sampleRows
      .map(
        (failure) =>
          `<tr><td><code>${escapeHtml(failure.run)}</code></td><td><code>${escapeHtml(failure.id)}</code><br><span class="muted">${escapeHtml(failure.title || failure.domain || "")}</span></td><td>${escapeHtml(failure.detail)}</td><td><a href="${escapeHtml(failure.viewerHref)}">run viewer</a>${failure.playbackHref ? ` · <a href="${escapeHtml(failure.playbackHref)}">scenario playback</a>` : ""}</td></tr>`,
      )
      .join("")}</tbody></table></div></section>
    <section class="panel"><h2>Coverage</h2><div class="body">${escapeHtml(sampleRows.length)} shown from ${escapeHtml(failures.length)} categorized failures. Use the aggregate failure analysis table for filtering across all rows.</div></section>
    <section class="panel"><h2>Navigation</h2><div class="body"><a href="../index.html">Back to failure analysis</a></div></section>
  </main>
</body>
</html>`;
}

function writeCategoryPages(payload, reportDir) {
  const dir = path.join(reportDir, "categories");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const category of payload.categories || []) {
    const pageHref = `categories/${pathSegment(category.key)}.html`;
    const failures = (payload.failures || []).filter(
      (failure) => failure.category === category.key,
    );
    writeFileSync(
      path.join(reportDir, pageHref),
      categoryPageHtml(category, failures),
      "utf8",
    );
    category.pageHref = pageHref;
  }
  payload.summary.categoryPages = (payload.categories || []).length;
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Scenario Failure Analysis</title>
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
    .panel { overflow:hidden; }
    .controls { display:grid; grid-template-columns:2fr repeat(3,minmax(150px,1fr)); gap:8px; padding:10px; border-bottom:1px solid #d7ded1; }
    input,select { width:100%; border:1px solid #d7ded1; border-radius:6px; padding:7px 8px; background:#fff; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { position:sticky; top:61px; background:#f7faf4; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .bad { color:#a12222; font-weight:700; }
    .ok { color:#17633a; font-weight:700; }
    @media (max-width:900px) { .controls { grid-template-columns:1fr; } th { top:0; } }
  </style>
</head>
<body>
  <header><h1>Scenario Failure Analysis</h1><div id="meta" class="muted"></div></header>
  <main>
    <div id="cards" class="cards"></div>
    <section class="panel" style="margin-bottom:12px">
      <div id="categorySummary"></div>
    </section>
    <section class="panel">
      <div class="controls">
        <input id="q" type="search" placeholder="Search scenario, run, detail..." />
        <select id="run"><option value="">all runs</option></select>
        <select id="category"><option value="">all categories</option></select>
        <select id="domain"><option value="">all domains</option></select>
      </div>
      <div id="table"></div>
    </section>
  </main>
  <script src="./failure-data.js"></script>
  <script>
    const data = window.SCENARIO_FAILURE_ANALYSIS || { failures: [], summary: {} };
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    document.getElementById("meta").textContent = (data.generatedAt || "") + " · " + (data.reportDir || "");
    document.getElementById("cards").innerHTML = [["runs",data.summary.runCount],["scenarios",data.summary.totalScenarios],["passed",data.summary.passedScenarios],["failed",data.summary.failedScenarios],["partial/timed out",data.summary.partialOrTimedOutRuns]].map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v ?? 0) + '</b></div>').join("");
    document.getElementById("categorySummary").innerHTML = '<table><thead><tr><th>category</th><th>failures</th><th>disposition</th><th>next action</th></tr></thead><tbody>' + (data.categories || []).map(c => '<tr><td><strong class="bad">' + esc(c.key) + '</strong>' + (c.pageHref ? '<br><a href="' + esc(c.pageHref) + '">review category</a>' : '') + '</td><td>' + esc(c.count) + '</td><td>' + esc(c.disposition) + '</td><td>' + esc(c.nextAction) + '</td></tr>').join("") + '</tbody></table>';
    for (const [id, values] of [["run", data.runs.map(r => r.name)], ["category", data.categories.map(c => c.key)], ["domain", data.domains.map(d => d.key)]]) {
      document.getElementById(id).innerHTML += values.map(v => '<option>' + esc(v) + '</option>').join("");
    }
    function filtered() {
      const q = document.getElementById("q").value.toLowerCase();
      const run = document.getElementById("run").value;
      const category = document.getElementById("category").value;
      const domain = document.getElementById("domain").value;
      return data.failures.filter(f => {
        const hay = [f.run, f.id, f.title, f.domain, f.category, f.detail, (f.tags || []).join(" ")].join(" ").toLowerCase();
        return (!q || hay.includes(q)) && (!run || f.run === run) && (!category || f.category === category) && (!domain || f.domain === domain);
      });
    }
    function render() {
      const rows = filtered();
      document.getElementById("table").innerHTML = '<table><thead><tr><th>run</th><th>scenario</th><th>category</th><th>detail</th><th>viewer</th></tr></thead><tbody>' + rows.map(f => '<tr><td><code>' + esc(f.run) + '</code></td><td><code>' + esc(f.id) + '</code><br><span class="muted">' + esc(f.title || f.domain) + '</span></td><td><strong class="bad">' + esc(f.category) + '</strong></td><td>' + esc(f.detail) + '</td><td><a href="' + esc(f.viewerHref) + '">run viewer</a>' + (f.playbackHref ? '<br><a href="' + esc(f.playbackHref) + '">scenario playback</a>' : '') + '</td></tr>').join("") + '</tbody></table>';
    }
    for (const id of ["q","run","category","domain"]) document.getElementById(id).addEventListener("input", render);
    for (const id of ["run","category","domain"]) document.getElementById(id).addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

function renderMarkdown(payload) {
  const lines = [
    "# Scenario Failure Analysis",
    "",
    `Generated: ${payload.generatedAt}`,
    `Runs: ${payload.summary.runCount}`,
    `Scenarios observed: ${payload.summary.totalScenarios}`,
    `Passed: ${payload.summary.passedScenarios}`,
    `Failed: ${payload.summary.failedScenarios}`,
    `Partial or timed-out runs: ${payload.summary.partialOrTimedOutRuns}`,
    "",
    `HTML viewer: ${payload.viewerIndex}`,
    "",
    "## Failure Categories",
    "",
    "| category | failures | disposition | next action | page |",
    "|---|---:|---|---|---|",
  ];
  for (const category of payload.categories) {
    lines.push(
      `| ${category.key} | ${category.count} | ${category.disposition} | ${category.nextAction.replaceAll("|", "\\|")} | ${category.pageHref || ""} |`,
    );
  }
  lines.push("", "## Runs", "", "| run | provider | result | partial/timed out |", "|---|---|---:|---:|");
  for (const run of payload.runs) {
    lines.push(
      `| \`${run.name}\` | ${run.providerName || ""} | ${run.passedCount}/${run.totalCount} passed, ${run.failedCount} failed | ${run.partial || run.timedOut ? "yes" : "no"} |`,
    );
  }
  lines.push("", "## Sample Failures", "", "| run | scenario | category | detail |", "|---|---|---|---|");
  for (const failure of payload.failures.slice(0, 80)) {
    lines.push(
      `| \`${failure.run}\` | \`${failure.id}\` | ${failure.category} | ${failure.detail.replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const runs = RUNS.map(collectRun).filter(Boolean);
  const playbackByScenario = scenarioPlaybackMap(options.reportDir);
  const failures = runs.flatMap((run) =>
    run.failures.map((failure) => ({
      ...failure,
      run: run.name,
      viewerHref: rel(run.viewer, options.reportDir),
      playbackHref: playbackByScenario.get(failure.id) || "",
    })),
  );
  const payload = {
    schema: "eliza_scenario_failure_analysis_v1",
    generatedAt: new Date().toISOString(),
    reportDir: options.reportDir,
    viewerIndex: path.join(options.reportDir, "index.html"),
    summary: {
      runCount: runs.length,
      totalScenarios: runs.reduce((sum, run) => sum + run.totalCount, 0),
      passedScenarios: runs.reduce((sum, run) => sum + run.passedCount, 0),
      failedScenarios: runs.reduce((sum, run) => sum + run.failedCount, 0),
      skippedScenarios: runs.reduce((sum, run) => sum + run.skippedCount, 0),
      partialOrTimedOutRuns: runs.filter((run) => run.partial || run.timedOut).length,
    },
    categories: countBy(failures, (failure) => failure.category),
    domains: countBy(failures, (failure) => failure.domain),
    runs: runs.map(({ failures: _failures, matrixPath, viewer, ...run }) => ({
      ...run,
      matrixPath: rel(matrixPath, options.reportDir),
      viewerHref: rel(viewer, options.reportDir),
    })),
    failures,
  };
  writeCategoryPages(payload, options.reportDir);
  mkdirSync(options.reportDir, { recursive: true });
  writeFileSync(
    path.join(options.reportDir, "failure-data.js"),
    `window.SCENARIO_FAILURE_ANALYSIS = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(
    path.join(options.reportDir, "failure-analysis.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(path.join(options.reportDir, "README.md"), renderMarkdown(payload), "utf8");
  writeFileSync(path.join(options.reportDir, "index.html"), html(), "utf8");
  if (options.json) {
    process.stdout.write(JSON.stringify(payload.summary, null, 2) + "\n");
  } else {
    process.stdout.write(`scenario failure analysis ${payload.viewerIndex}\n`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
