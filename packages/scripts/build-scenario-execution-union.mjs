#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const SCENARIO_CLI = path.join(
  REPO_ROOT,
  "packages",
  "scenario-runner",
  "src",
  "cli.ts",
);
const DEFAULT_REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "scenarios",
  "catalog-execution-union",
);
const PLAYBACK_DIR_NAME = "playback";
const ROOTS = [
  {
    scope: "default",
    root: "packages/test/scenarios",
    runs: ["deterministic-all", "deterministic-remainder", "deterministic-remainder-2"],
  },
  {
    scope: "plugin-personal-assistant",
    root: "plugins/plugin-personal-assistant/test/scenarios",
    runs: ["plugin-personal-assistant-deterministic"],
  },
  {
    scope: "plugin-app-control",
    root: "plugins/plugin-app-control/test/scenarios",
    runs: ["plugin-app-control-deterministic"],
  },
  {
    scope: "scenario-runner",
    root: "packages/scenario-runner/test/scenarios",
    runs: ["scenario-runner-package-deterministic"],
  },
];

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

function listScenarioIds(root) {
  const completed = spawnSync("bun", [SCENARIO_CLI, "list", root], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (completed.status !== 0) {
    throw new Error(
      `scenario list failed for ${root}: ${completed.stderr || completed.stdout}`,
    );
  }
  return completed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function safeSegment(value) {
  return String(value || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140) || "unknown";
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

function listJsonFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(full);
    }
  }
  return files.sort();
}

function readWindowJson(filePath, assignmentPrefix) {
  return JSON.parse(
    readFileSync(filePath, "utf8")
      .replace(assignmentPrefix, "")
      .replace(/;\n?$/, ""),
  );
}

function catalogInventoryRows() {
  const catalogDataPath = path.join(
    REPO_ROOT,
    "reports",
    "scenarios",
    "catalog-inventory",
    "viewer",
    "catalog-data.js",
  );
  if (!existsSync(catalogDataPath)) return null;
  const catalog = readWindowJson(
    catalogDataPath,
    /^window\.SCENARIO_CATALOG_DATA = /,
  );
  return [
    ...(catalog.defaultScenarios || []).map((id) => ({
      scope: "default",
      id,
      root: "packages/test/scenarios",
    })),
    ...(catalog.pluginLifeopsScenarios || []).map((id) => ({
      scope: "plugin-personal-assistant",
      id,
      root: "plugins/plugin-personal-assistant/test/scenarios",
    })),
    ...(catalog.pluginAppControlScenarios || []).map((id) => ({
      scope: "plugin-app-control",
      id,
      root: "plugins/plugin-app-control/test/scenarios",
    })),
    ...(catalog.scenarioRunnerScenarios || []).map((id) => ({
      scope: "scenario-runner",
      id,
      root: "packages/scenario-runner/test/scenarios",
    })),
  ];
}

function cliCatalogRows() {
  const rows = [];
  for (const root of ROOTS) {
    for (const id of listScenarioIds(root.root)) {
      rows.push({ scope: root.scope, id, root: root.root });
    }
  }
  return rows;
}

function scenarioFindings(rows) {
  return rows.map((row) => {
    const statuses = row.attempts.map((attempt) => attempt.status);
    const passed = statuses.filter((status) => status === "passed").length;
    const failed = statuses.filter((status) => status === "failed").length;
    const skipped = statuses.filter((status) => status === "skipped").length;
    const other = statuses.length - passed - failed - skipped;
    const partialAttempts = row.attempts.filter((attempt) =>
      /deterministic-all|deterministic-remainder/.test(attempt.run),
    ).length;
    let disposition = "missing";
    if (row.attempts.length === 0) {
      disposition = "missing";
    } else if (passed > 0 && failed === 0 && other === 0) {
      disposition = "passed";
    } else if (passed > 0 && failed > 0) {
      disposition = "mixed";
    } else if (failed > 0) {
      disposition = "failed-only";
    } else {
      disposition = "non-passing";
    }
    const reasons = [];
    if (row.attempts.length === 0) reasons.push("no execution evidence");
    if (passed > 0) reasons.push(`${passed} passed attempt(s)`);
    if (failed > 0) reasons.push(`${failed} failed attempt(s)`);
    if (skipped > 0) reasons.push(`${skipped} skipped attempt(s)`);
    if (other > 0) reasons.push(`${other} unknown-status attempt(s)`);
    if (partialAttempts === row.attempts.length && row.attempts.length > 0) {
      reasons.push("evidence comes from default partial/remainder shards");
    }
    return {
      scope: row.scope,
      id: row.id,
      disposition,
      attempts: row.attempts.length,
      passed,
      failed,
      skipped,
      other,
      viewers: [...new Set(row.attempts.map((attempt) => attempt.viewer).filter(Boolean))],
      playbackHref: row.playbackHref || "",
      runs: row.attempts.map((attempt) => ({
        run: attempt.run,
        status: attempt.status,
        durationMs: attempt.durationMs,
        viewer: attempt.viewer,
      })),
      reasons,
    };
  });
}

function trajectoryFilesByRunAndScenario(runNames) {
  const byKey = new Map();
  for (const run of runNames) {
    const trajectoriesRoot = path.join(REPO_ROOT, "reports", "scenarios", run, "trajectories");
    for (const filePath of listJsonFiles(trajectoriesRoot)) {
      try {
        const parsed = readJson(filePath);
        const scenarioId = parsed?.scenarioId;
        if (!scenarioId) continue;
        const key = `${run}\t${scenarioId}`;
        const files = byKey.get(key) || [];
        files.push(path.relative(REPO_ROOT, filePath).replaceAll(path.sep, "/"));
        byKey.set(key, files);
      } catch {
        // Leave malformed trajectory files for the run-level viewer.
      }
    }
  }
  return byKey;
}

function scenarioPlaybackHtml({ row, finding, attempts }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(row.id)} Scenario Playback</title>
  <style>
    body { margin:0; background:#f7f8f5; color:#172017; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { background:#fff; border-bottom:1px solid #d7ded1; padding:14px 18px; }
    main { display:grid; grid-template-columns:300px 1fr; min-height:calc(100vh - 76px); }
    aside { border-right:1px solid #d7ded1; background:#fff; overflow:auto; }
    button { width:100%; text-align:left; border:0; border-bottom:1px solid #d7ded1; background:#fff; padding:9px 10px; cursor:pointer; color:#172017; }
    button:hover, button.active { background:#edf4ea; }
    .content { padding:16px; overflow:auto; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(145px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:19px; }
    .panel { margin-bottom:12px; overflow:hidden; }
    .panel h2 { margin:0; font-size:14px; padding:8px 10px; background:#f2f5ef; border-bottom:1px solid #d7ded1; }
    pre { margin:0; white-space:pre-wrap; word-break:break-word; padding:10px; max-height:58vh; overflow:auto; background:#fff; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    .muted { color:#5f685d; }
    .ok { color:#17633a; font-weight:700; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    @media (max-width:820px) { main { grid-template-columns:1fr; } aside { max-height:240px; border-right:0; border-bottom:1px solid #d7ded1; } }
  </style>
</head>
<body>
  <header>
    <strong>${escapeHtml(row.scope)} / ${escapeHtml(row.id)}</strong>
    <span class="muted"> · ${escapeHtml(finding.disposition)}</span>
  </header>
  <main>
    <aside id="nav"></aside>
    <section class="content">
      <div id="cards" class="cards"></div>
      <section class="panel"><h2>Turn Input</h2><pre id="input"></pre></section>
      <section class="panel"><h2>Turn Response</h2><pre id="response"></pre></section>
      <section class="panel"><h2>Actions / Failed Assertions</h2><pre id="actions"></pre></section>
      <section class="panel"><h2>Trajectory Files</h2><pre id="trajectories"></pre></section>
    </section>
  </main>
  <script type="application/json" id="attempts">${JSON.stringify(attempts).replaceAll("</script", "<\\/script")}</script>
  <script>
    const attempts = JSON.parse(document.getElementById("attempts").textContent || "[]");
    const nav = document.getElementById("nav");
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const flat = attempts.flatMap((attempt, attemptIndex) => {
      const turns = Array.isArray(attempt.scenario?.turns) ? attempt.scenario.turns : [];
      if (!turns.length) return [{ attemptIndex, attempt, turnIndex: -1, turn: null }];
      return turns.map((turn, turnIndex) => ({ attemptIndex, attempt, turnIndex, turn }));
    });
    function statusClass(status) { return status === "passed" ? "ok" : status === "failed" ? "bad" : "warn"; }
    function render(i) {
      const item = flat[i] || {};
      const attempt = item.attempt || {};
      const scenario = attempt.scenario || {};
      const turn = item.turn || {};
      for (const button of nav.querySelectorAll("button")) button.classList.toggle("active", Number(button.dataset.index) === i);
      document.getElementById("cards").innerHTML = [
        ["Step", (i + 1) + " / " + flat.length],
        ["Run", attempt.run],
        ["Status", scenario.status || attempt.status],
        ["Duration ms", turn.durationMs ?? scenario.durationMs ?? ""],
        ["Turn", turn.name || ""],
        ["Kind", turn.kind || ""],
        ["Trajectory files", (attempt.trajectoryFiles || []).length],
      ].map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b class="' + (k === "Status" ? statusClass(v) : "") + '">' + esc(v ?? "") + '</b></div>').join("");
      document.getElementById("input").textContent = turn.text || "";
      document.getElementById("response").textContent = turn.responseText || "";
      document.getElementById("actions").textContent = JSON.stringify({ actionsCalled: turn.actionsCalled || [], failedAssertions: turn.failedAssertions || scenario.failedAssertions || [], finalChecks: scenario.finalChecks || [] }, null, 2);
      document.getElementById("trajectories").textContent = (attempt.trajectoryFiles || []).join("\\n");
    }
    nav.innerHTML = flat.map((item, i) => {
      const attempt = item.attempt || {};
      const scenario = attempt.scenario || {};
      const turn = item.turn || {};
      return '<button data-index="' + i + '"><strong>' + esc(attempt.run) + '</strong><br><span class="' + statusClass(scenario.status || attempt.status) + '">' + esc(scenario.status || attempt.status) + '</span><span class="muted"> · ' + esc(turn.name || "summary") + '</span></button>';
    }).join("");
    nav.addEventListener("click", event => {
      const button = event.target.closest("button[data-index]");
      if (button) render(Number(button.dataset.index));
    });
    render(0);
  </script>
</body>
</html>`;
}

function writeScenarioPlaybackPages(rows, findings, scenarioByRun, trajectoryFiles, reportDir) {
  const playbackRoot = path.join(reportDir, PLAYBACK_DIR_NAME);
  rmSync(playbackRoot, { recursive: true, force: true });
  const findingByKey = new Map(findings.map((finding) => [`${finding.scope}\t${finding.id}`, finding]));
  let count = 0;
  for (const row of rows) {
    const finding = findingByKey.get(`${row.scope}\t${row.id}`);
    if (!finding) continue;
    const attempts = row.attempts.map((attempt) => {
      const scenario =
        scenarioByRun.get(`${attempt.run}\t${row.id}`) || {
          id: row.id,
          status: attempt.status,
          durationMs: attempt.durationMs,
          turns: [],
        };
      return {
        ...attempt,
        scenario,
        trajectoryFiles: trajectoryFiles.get(`${attempt.run}\t${row.id}`) || [],
      };
    });
    const filePath = path.join(
      playbackRoot,
      safeSegment(row.scope),
      `${safeSegment(row.id)}.html`,
    );
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, scenarioPlaybackHtml({ row, finding, attempts }), "utf8");
    const href = path.relative(reportDir, filePath).replaceAll(path.sep, "/");
    row.playbackHref = href;
    finding.playbackHref = href;
    count += 1;
  }
  return count;
}

function findingSummary(findings) {
  const byDisposition = {};
  for (const finding of findings) {
    byDisposition[finding.disposition] =
      (byDisposition[finding.disposition] || 0) + 1;
  }
  return {
    findingCount: findings.length,
    byDisposition,
    passed: byDisposition.passed || 0,
    mixed: byDisposition.mixed || 0,
    failedOnly: byDisposition["failed-only"] || 0,
    nonPassing: byDisposition["non-passing"] || 0,
    missing: byDisposition.missing || 0,
  };
}

function html() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Scenario Catalog Execution Union</title>
  <style>
    body { font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; margin:0; background:#f7f8f5; color:#172017; }
    header { position:sticky; top:0; background:#fff; border-bottom:1px solid #d7ded1; padding:16px 20px; }
    main { padding:16px 20px; }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; margin-bottom:12px; }
    .card,.panel { background:#fff; border:1px solid #d7ded1; border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; font-size:20px; }
    table { width:100%; border-collapse:collapse; }
    th,td { border-bottom:1px solid #d7ded1; padding:7px 8px; text-align:left; vertical-align:top; }
    th { position:sticky; top:62px; background:#f7faf4; }
    .ok { color:#17633a; font-weight:700; }
    .bad { color:#a12222; font-weight:700; }
    .warn { color:#8a5a00; font-weight:700; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    input,select { padding:7px 8px; border:1px solid #d7ded1; border-radius:6px; margin:10px 8px 10px 0; width:min(320px,100%); }
  </style>
</head>
<body>
  <header><h1>Scenario Catalog Execution Union</h1><div id="meta"></div></header>
  <main>
    <div class="cards" id="cards"></div>
    <section class="panel"><input id="q" type="search" placeholder="Search scenario id" /><select id="scope"><option value="">all scopes</option></select><select id="disposition"><option value="">all dispositions</option></select><div id="table"></div></section>
  </main>
  <script src="coverage-data.js"></script>
  <script>
    const data = window.SCENARIO_CATALOG_EXECUTION_UNION;
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    document.getElementById("meta").textContent = data.generatedAt;
    document.getElementById("cards").innerHTML = [["catalog scenarios",data.catalogScenarioCount],["with execution evidence",data.executedScenarioIds],["missing",data.missingCount],["runs",data.runSummaries.length],["passed scenarios",data.findingSummary?.passed],["mixed scenarios",data.findingSummary?.mixed],["failed-only",data.findingSummary?.failedOnly]].map(([k,v]) => '<div class="card"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join("");
    document.getElementById("scope").innerHTML += [...new Set(data.rows.map(r => r.scope))].sort().map(s => '<option>' + esc(s) + '</option>').join("");
    document.getElementById("disposition").innerHTML += [...new Set((data.scenarioFindings || []).map(r => r.disposition))].sort().map(s => '<option>' + esc(s) + '</option>').join("");
    function cls(s) { return s === "passed" ? "ok" : s === "failed" ? "bad" : "warn"; }
    function render() {
      const q = document.getElementById("q").value.toLowerCase();
      const scope = document.getElementById("scope").value;
      const disposition = document.getElementById("disposition").value;
      const rows = (data.scenarioFindings || []).filter(r => (!q || r.id.toLowerCase().includes(q)) && (!scope || r.scope === scope) && (!disposition || r.disposition === disposition));
      document.getElementById("table").innerHTML = '<table><thead><tr><th>scope</th><th>scenario</th><th>disposition</th><th>attempts</th><th>playback</th><th>reasons</th></tr></thead><tbody>' + rows.map(r => '<tr><td>' + esc(r.scope) + '</td><td><code>' + esc(r.id) + '</code></td><td class="' + (r.disposition === "passed" ? "ok" : r.disposition === "missing" || r.disposition === "failed-only" ? "bad" : "warn") + '">' + esc(r.disposition) + '</td><td>' + (r.runs.length ? r.runs.map(a => '<div><a href="../' + esc(a.run) + '/viewer/index.html">' + esc(a.run) + '</a> <span class="' + cls(a.status) + '">' + esc(a.status) + '</span> ' + esc(a.durationMs ?? '') + 'ms</div>').join('') : '<span class="bad">missing</span>') + '</td><td><a href="' + esc(r.playbackHref || "") + '">open</a></td><td>' + esc((r.reasons || []).join("; ")) + '</td></tr>').join('') + '</tbody></table>';
    }
    document.getElementById("q").addEventListener("input", render);
    document.getElementById("scope").addEventListener("change", render);
    document.getElementById("disposition").addEventListener("change", render);
    render();
  </script>
</body>
</html>`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inventoryRows = catalogInventoryRows();
  const cliRows = cliCatalogRows();
  const catalogRows =
    inventoryRows && inventoryRows.length >= cliRows.length ? inventoryRows : cliRows;
  const catalogSource =
    inventoryRows && inventoryRows.length >= cliRows.length
      ? "catalog-inventory"
      : "scenario-runner-list";

  const byKey = new Map();
  const scenarioByRun = new Map();
  const runSummaries = [];
  const runNames = [];
  for (const root of ROOTS) {
    for (const run of root.runs) {
      const matrixPath = path.join(REPO_ROOT, "reports", "scenarios", run, "matrix.json");
      if (!existsSync(matrixPath)) continue;
      runNames.push(run);
      const matrix = readJson(matrixPath);
      const scenarios = Array.isArray(matrix.scenarios) ? matrix.scenarios : [];
      let passed = 0;
      let failed = 0;
      let skipped = 0;
      let other = 0;
      for (const scenario of scenarios) {
        scenarioByRun.set(`${run}\t${scenario.id}`, scenario);
        const key = `${root.scope}\t${scenario.id}`;
        const attempts = byKey.get(key) || [];
        attempts.push({
          run,
          status: String(scenario.status || "unknown"),
          durationMs:
            typeof scenario.durationMs === "number"
              ? scenario.durationMs
              : undefined,
          viewer: `reports/scenarios/${run}/viewer/index.html`,
        });
        byKey.set(key, attempts);
        if (scenario.status === "passed") passed += 1;
        else if (scenario.status === "failed") failed += 1;
        else if (scenario.status === "skipped") skipped += 1;
        else other += 1;
      }
      runSummaries.push({
        scope: root.scope,
        name: run,
        matrixPath: path.relative(REPO_ROOT, matrixPath),
        viewer: `reports/scenarios/${run}/viewer/index.html`,
        partial: Boolean(matrix.partial),
        timedOut: Boolean(matrix.timedOut),
        total: scenarios.length,
        passed,
        failed,
        skipped,
        other,
        trajectories: matrix.totals?.trajectories,
      });
    }
  }

  const rows = catalogRows.map((row) => ({
    ...row,
    attempts: byKey.get(`${row.scope}\t${row.id}`) || [],
  }));
  const missing = rows.filter((row) => row.attempts.length === 0);
  const findings = scenarioFindings(rows);
  const trajectoryFiles = trajectoryFilesByRunAndScenario(runNames);
  const scenarioPlaybackPages = writeScenarioPlaybackPages(
    rows,
    findings,
    scenarioByRun,
    trajectoryFiles,
    options.reportDir,
  );
  const payload = {
    schema: "eliza_scenario_catalog_execution_union_v1",
    generatedAt: new Date().toISOString(),
    catalogSource,
    cliCatalogScenarioCount: cliRows.length,
    inventoryCatalogScenarioCount: inventoryRows?.length ?? null,
    catalogScenarioCount: rows.length,
    executedScenarioIds: rows.length - missing.length,
    missingCount: missing.length,
    missing: missing.map(({ scope, id, root }) => ({ scope, id, root })),
    runSummaries,
    rows,
    scenarioFindings: findings,
    findingSummary: findingSummary(findings),
    scenarioPlaybackPages,
  };

  mkdirSync(options.reportDir, { recursive: true });
  writeFileSync(
    path.join(options.reportDir, "coverage.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8",
  );
  writeFileSync(
    path.join(options.reportDir, "missing-scenarios.txt"),
    missing.map((row) => `${row.scope}\t${row.id}`).join("\n") +
      (missing.length ? "\n" : ""),
    "utf8",
  );
  writeFileSync(
    path.join(options.reportDir, "coverage-data.js"),
    `window.SCENARIO_CATALOG_EXECUTION_UNION = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  writeFileSync(path.join(options.reportDir, "index.html"), html(), "utf8");

  const summary = {
    catalogScenarioCount: payload.catalogScenarioCount,
    executedScenarioIds: payload.executedScenarioIds,
    missingCount: payload.missingCount,
  };
  process.stdout.write(
    options.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : `scenario catalog execution union ${summary.executedScenarioIds}/${summary.catalogScenarioCount}; missing ${summary.missingCount}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
