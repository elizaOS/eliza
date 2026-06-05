#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const DEFAULT_SCENARIO_ROOT = "packages/test/scenarios";
const DEFAULT_REPORT_DIR = path.join(
  REPO_ROOT,
  "reports",
  "scenarios",
  "catalog-inventory",
);
const CORE_KEYWORD_DATA = path.join(
  REPO_ROOT,
  "packages",
  "core",
  "src",
  "i18n",
  "generated",
  "validation-keyword-data.ts",
);
const KEYWORD_GENERATOR = path.join(
  REPO_ROOT,
  "packages",
  "shared",
  "scripts",
  "generate-keywords.mjs",
);
const SCENARIO_LIST_ENV_BLOCKLIST = [
  "ELIZA_LIVE_SCENARIO_TEST",
  "ELIZA_LIVE_TEST",
  "ELIZA_SCENARIO_LLM_PROXY_STRICT",
  "ELIZA_SCENARIO_USE_LLM_PROXY",
  "LIFEOPS_LIVE_JUDGE_MIN_SCORE",
  "SCENARIO_EXPAND_EDGE_CASES",
  "SCENARIO_INCLUDE_PENDING",
  "SCENARIO_LLM_PROXY_STRICT",
  "SCENARIO_USE_LLM_PROXY",
  "SKIP_REASON",
  "TEST_LANE",
];

function scenarioListEnv(extraEnv = {}) {
  const env = { ...process.env };
  for (const key of SCENARIO_LIST_ENV_BLOCKLIST) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined || value === null) {
      delete env[key];
    } else {
      env[key] = String(value);
    }
  }
  return env;
}

function ensureGeneratedKeywordData() {
  if (existsSync(CORE_KEYWORD_DATA)) {
    return;
  }

  const completed = spawnSync("node", [KEYWORD_GENERATOR, "--target", "ts"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (completed.status !== 0) {
    throw new Error(
      `keyword data generation failed: ${completed.stderr || completed.stdout}`,
    );
  }
}

function parseArgs(argv) {
  const options = {
    reportDir: DEFAULT_REPORT_DIR,
    failOnMissing: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--report-dir") {
      const next = argv[i + 1];
      if (!next) throw new Error("--report-dir requires a value");
      options.reportDir = path.resolve(REPO_ROOT, next);
      i += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--fail-on-missing") {
      options.failOnMissing = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function runScenarioList(root, globs = [], extraEnv = {}) {
  const completed = spawnSync("bun", [SCENARIO_CLI, "list", root, ...globs], {
    cwd: REPO_ROOT,
    env: scenarioListEnv(extraEnv),
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

function workflowScenarioGlobs() {
  const workflowPath = path.join(
    REPO_ROOT,
    ".github",
    "workflows",
    "scenario-matrix.yml",
  );
  const text = readFileSync(workflowPath, "utf8");
  const matches = [...text.matchAll(/globs:\s*"([^"]+)"/g)].map(
    (match) => match[1],
  );
  return matches
    .flatMap((value) =>
      value
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .filter((item) => item !== "**/*.scenario.ts");
}

function writeList(reportDir, fileName, rows) {
  writeFileSync(path.join(reportDir, fileName), `${rows.join("\n")}\n`, "utf8");
}

function scopedScenarioRows(scope, ids) {
  return ids.map((id) => `${scope}\t${id}`);
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function summarizeScenarioMatrix(filePath) {
  const matrix = readJsonIfPresent(filePath);
  if (!matrix || typeof matrix !== "object") return {};
  const scenarios = Array.isArray(matrix.scenarios) ? matrix.scenarios : [];
  const statusCounts = {};
  for (const scenario of scenarios) {
    if (!scenario || typeof scenario !== "object") continue;
    const status = String(scenario.status || "unknown");
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  return {
    runId: typeof matrix.runId === "string" ? matrix.runId : undefined,
    providerName:
      typeof matrix.providerName === "string" ? matrix.providerName : undefined,
    startedAtIso:
      typeof matrix.startedAtIso === "string" ? matrix.startedAtIso : undefined,
    completedAtIso:
      typeof matrix.completedAtIso === "string"
        ? matrix.completedAtIso
        : undefined,
    totalCount:
      typeof matrix.totalCount === "number"
        ? matrix.totalCount
        : scenarios.length,
    passedCount:
      typeof matrix.passedCount === "number"
        ? matrix.passedCount
        : statusCounts.passed,
    failedCount:
      typeof matrix.failedCount === "number"
        ? matrix.failedCount
        : statusCounts.failed,
    skippedCount:
      typeof matrix.skippedCount === "number"
        ? matrix.skippedCount
        : statusCounts.skipped,
    statusCounts,
    scenarioResults: scenarios
      .filter((scenario) => scenario && typeof scenario === "object")
      .map((scenario) => ({
        id: String(scenario.id || ""),
        title: typeof scenario.title === "string" ? scenario.title : "",
        status: String(scenario.status || "unknown"),
        durationMs:
          typeof scenario.durationMs === "number"
            ? scenario.durationMs
            : undefined,
        failedAssertions: Array.isArray(scenario.failedAssertions)
          ? scenario.failedAssertions.map((item) => {
              if (typeof item === "string") return item;
              if (!item || typeof item !== "object") return String(item);
              return String(item.detail || item.label || "");
            })
          : [],
      })),
  };
}

function existingScenarioRunArtifacts(reportDir) {
  const scenariosRoot = path.resolve(reportDir, "..");
  const artifacts = [];
  let names = [];
  try {
    names = spawnSync("find", [scenariosRoot, "-maxdepth", "3", "-type", "f"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .stdout.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return artifacts;
  }
  const byRunDir = new Map();
  for (const filePath of names) {
    const normalized = path.resolve(filePath);
    if (normalized.startsWith(path.resolve(reportDir) + path.sep)) continue;
    const rel = path.relative(scenariosRoot, normalized);
    if (rel.startsWith("..")) continue;
    if (normalized === path.join(reportDir, "workflow-coverage.json")) continue;
    if (path.basename(normalized) === "matrix.json") {
      const runDir = path.dirname(normalized);
      const item = byRunDir.get(runDir) ?? { runDir };
      item.matrixJson = normalized;
      Object.assign(item, summarizeScenarioMatrix(normalized));
      byRunDir.set(runDir, item);
    } else if (normalized.endsWith(path.join("viewer", "index.html"))) {
      const runDir = path.dirname(path.dirname(normalized));
      const item = byRunDir.get(runDir) ?? { runDir };
      item.viewerIndex = normalized;
      byRunDir.set(runDir, item);
    } else if (normalized.endsWith(".jsonl")) {
      const runDir = path.dirname(normalized);
      const item = byRunDir.get(runDir) ?? { runDir };
      item.nativeJsonl = normalized;
      byRunDir.set(runDir, item);
    }
  }
  return [...byRunDir.values()].sort((a, b) =>
    a.runDir.localeCompare(b.runDir),
  );
}

function scenarioCatalogHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Eliza Scenario Catalog Coverage</title>
  <style>
    :root { --bg:#f7f8f5; --panel:#fff; --ink:#182018; --muted:#5f685d; --line:#d7ded1; --ok:#17633a; --bad:#a12222; --accent:#116b5b; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    header { position:sticky; top:0; z-index:3; background:#fff; border-bottom:1px solid var(--line); padding:16px 20px; }
    h1 { margin:0 0 5px; font-size:22px; letter-spacing:0; }
    .muted { color:var(--muted); }
    .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; padding:14px 20px; }
    .card,.panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; }
    .card { padding:10px; }
    .card b { display:block; margin-top:3px; font-size:20px; }
    main { display:grid; grid-template-columns:310px 1fr; gap:12px; padding:0 20px 20px; }
    .panel { overflow:hidden; }
    .panel h2 { margin:0; padding:10px 12px; font-size:14px; border-bottom:1px solid var(--line); background:#f2f5ef; }
    .controls { display:grid; gap:8px; padding:10px; }
    input,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:7px 8px; background:#fff; color:var(--ink); }
    .tabs { display:grid; gap:6px; padding:10px; }
    .tab { border:1px solid var(--line); border-radius:6px; padding:8px; background:#fff; text-align:left; cursor:pointer; }
    .tab.active,.tab:hover { background:#eef6f2; border-color:#acc8bd; }
    table { width:100%; border-collapse:collapse; }
    th,td { padding:7px 8px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { position:sticky; top:65px; background:#f7faf4; z-index:2; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }
    .ok { color:var(--ok); font-weight:600; }
    .bad { color:var(--bad); font-weight:600; }
    @media (max-width:900px) { main { grid-template-columns:1fr; } th { top:0; } }
  </style>
</head>
<body>
  <header><h1>Eliza Scenario Catalog Coverage</h1><div id="meta" class="muted"></div></header>
  <div id="cards" class="cards"></div>
  <main>
    <aside class="panel">
      <h2>Catalogs</h2>
      <div class="controls">
        <input id="search" type="search" placeholder="Search scenario id..." />
        <select id="coverage"><option value="">all coverage states</option><option value="covered">covered</option><option value="missing">missing</option><option value="cataloged">cataloged outside default workflow gate</option></select>
      </div>
      <div id="tabs" class="tabs"></div>
    </aside>
    <section class="panel">
      <h2 id="title">Scenarios</h2>
      <div id="content"></div>
    </section>
  </main>
  <script src="./catalog-data.js"></script>
  <script>
    const data = window.SCENARIO_CATALOG_DATA || {};
    let active = "defaultScenarios";
    const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const catalogs = [
      ["defaultScenarios", "Default package scenarios"],
      ["includePendingScenarios", "Including pending"],
      ["pluginLifeopsScenarios", "plugin-lifeops"],
      ["pluginAppControlScenarios", "plugin-app-control"],
      ["scenarioRunnerScenarios", "scenario-runner tests"],
      ["allScenarios", "Unified catalog"],
    ];
    function renderCards() {
      const s = data.summary || {};
      const items = [
        ["Default", s.defaultScenarioCount || 0],
        ["Include pending", s.includePendingScenarioCount || 0],
        ["plugin-lifeops", s.pluginLifeopsCount || 0],
        ["plugin-app-control", s.pluginAppControlCount || 0],
        ["runner tests", s.scenarioRunnerCount || 0],
        ["All catalog entries", s.allScenarioCount || 0],
        ["Covered default", (s.coveredDefaultCount || 0) + "/" + (s.defaultScenarioCount || 0)],
        ["Missing default", (s.missingDefaultIds || []).length],
        ["Run artifacts", (data.runArtifacts || []).length],
      ];
      document.getElementById("cards").innerHTML = items.map(([k,v]) => '<div class="card"><span class="muted">' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join("");
      document.getElementById("meta").textContent = (data.generatedAt || "") + " · " + (data.reportDir || "");
    }
    function renderTabs() {
      const scenarioRunCount = new Set((data.runArtifacts || []).flatMap(a => (a.scenarioResults || []).map(r => r.id))).size;
      document.getElementById("tabs").innerHTML = catalogs.map(([key,label]) => '<button class="tab ' + (key === active ? 'active' : '') + '" data-key="' + esc(key) + '"><strong>' + esc(label) + '</strong><br><span class="muted">' + esc((data[key] || []).length) + ' ids</span></button>').join("") + '<button class="tab ' + (active === 'runArtifacts' ? 'active' : '') + '" data-key="runArtifacts"><strong>Run artifacts</strong><br><span class="muted">' + esc((data.runArtifacts || []).length) + ' dirs</span></button><button class="tab ' + (active === 'runComparison' ? 'active' : '') + '" data-key="runComparison"><strong>Run comparison</strong><br><span class="muted">' + esc(scenarioRunCount) + ' executed ids</span></button>';
    }
    function isCovered(id) {
      return !(data.summary?.missingDefaultIds || []).includes(id);
    }
    function coverageState(item) {
      const defaultSet = new Set(data.defaultScenarios || []);
      if ((item.scope || "") && item.scope !== "packages/test/scenarios") return "cataloged";
      if (!defaultSet.has(item.id || "")) return "cataloged";
      return isCovered(item.id) ? "covered" : "missing";
    }
    function renderScenarioRows(key, label) {
      const q = document.getElementById("search").value.toLowerCase();
      const coverage = document.getElementById("coverage").value;
      const rows = (data[key] || []).map(item => typeof item === "string" ? { id:item, scope:"" } : item).filter(item => {
        const id = item.id || "";
        const state = coverageState(item);
        return (!q || id.toLowerCase().includes(q)) && (!coverage || state === coverage);
      });
      document.getElementById("title").textContent = label + " (" + rows.length + ")";
      document.getElementById("content").innerHTML = '<table><thead><tr><th>#</th><th>scope</th><th>scenario id</th><th>workflow/live coverage</th></tr></thead><tbody>' + rows.map((item,i) => { const state = coverageState(item); return '<tr><td>' + (i + 1) + '</td><td><code>' + esc(item.scope || "") + '</code></td><td><code>' + esc(item.id) + '</code></td><td class="' + (state === "missing" ? 'bad' : 'ok') + '">' + esc(state) + '</td></tr>'; }).join("") + '</tbody></table>';
    }
    function renderArtifacts() {
      document.getElementById("title").textContent = "Run artifacts";
      document.getElementById("content").innerHTML = '<table><thead><tr><th>run dir</th><th>provider</th><th>result</th><th>matrix</th><th>viewer</th><th>native jsonl</th></tr></thead><tbody>' + (data.runArtifacts || []).map(a => '<tr><td><code>' + esc(a.runDir) + '</code><br><span class="muted">' + esc(a.runId || "") + '</span></td><td>' + esc(a.providerName || "") + '</td><td>' + esc(a.passedCount ?? "") + '/' + esc(a.totalCount ?? "") + ' passed<br><span class="' + ((a.failedCount || 0) > 0 ? 'bad' : 'ok') + '">' + esc(a.failedCount ?? "") + ' failed</span></td><td>' + (a.matrixJson ? '<a href="file://' + esc(a.matrixJson) + '">matrix</a>' : '') + '</td><td>' + (a.viewerIndex ? '<a href="file://' + esc(a.viewerIndex) + '">viewer</a>' : '') + '</td><td>' + (a.nativeJsonl ? '<a href="file://' + esc(a.nativeJsonl) + '">jsonl</a>' : '') + '</td></tr>').join("") + '</tbody></table>';
    }
    function renderRunComparison() {
      const q = document.getElementById("search").value.toLowerCase();
      const artifacts = data.runArtifacts || [];
      const byScenario = new Map();
      for (const artifact of artifacts) {
        for (const result of artifact.scenarioResults || []) {
          if (!result.id) continue;
          if (!byScenario.has(result.id)) byScenario.set(result.id, []);
          byScenario.get(result.id).push({ artifact, result });
        }
      }
      const rows = [...byScenario.entries()].sort((a,b) => a[0].localeCompare(b[0])).filter(([id, entries]) => {
        const hay = [id, ...entries.flatMap(({ artifact, result }) => [artifact.runDir, artifact.providerName, result.status, (result.failedAssertions || []).join(" ")])].join(" ").toLowerCase();
        return !q || hay.includes(q);
      });
      document.getElementById("title").textContent = "Run comparison (" + rows.length + ")";
      document.getElementById("content").innerHTML = '<table><thead><tr><th>scenario id</th><th>runs</th></tr></thead><tbody>' + rows.map(([id, entries]) => '<tr><td><code>' + esc(id) + '</code></td><td>' + entries.map(({ artifact, result }) => '<div><strong class="' + (result.status === "passed" ? "ok" : result.status === "failed" ? "bad" : "") + '">' + esc(result.status) + '</strong> · ' + esc((artifact.runDir || "").split("/").pop()) + ' · ' + esc(artifact.providerName || "") + ' · ' + esc(result.durationMs ?? "") + 'ms' + (artifact.viewerIndex ? ' · <a href="file://' + esc(artifact.viewerIndex) + '">viewer</a>' : '') + '<br><span class="muted">' + esc((result.failedAssertions || []).filter(Boolean).join(" | ")) + '</span></div>').join("") + '</td></tr>').join("") + '</tbody></table>';
    }
    function renderContent() {
      if (active === "runArtifacts") return renderArtifacts();
      if (active === "runComparison") return renderRunComparison();
      const found = catalogs.find(([key]) => key === active) || catalogs[0];
      renderScenarioRows(found[0], found[1]);
    }
    document.addEventListener("click", e => { const tab = e.target.closest(".tab"); if (tab) { active = tab.dataset.key; renderTabs(); renderContent(); } });
    document.getElementById("search").addEventListener("input", renderContent);
    document.getElementById("coverage").addEventListener("change", renderContent);
    renderCards(); renderTabs(); renderContent();
  </script>
</body>
</html>`;
}

function writeCatalogViewer(reportDir, payload) {
  const viewerDir = path.join(reportDir, "viewer");
  mkdirSync(viewerDir, { recursive: true });
  const indexPath = path.join(viewerDir, "index.html");
  const dataPath = path.join(viewerDir, "catalog-data.js");
  writeFileSync(indexPath, scenarioCatalogHtml(), "utf8");
  writeFileSync(
    dataPath,
    `window.SCENARIO_CATALOG_DATA = ${JSON.stringify(payload)};\n`,
    "utf8",
  );
  return { indexPath, dataPath };
}

function renderMarkdown(summary, runArtifacts = []) {
  const lines = [
    "# Scenario Catalog Inventory",
    "",
    `Default packages/test scenarios: ${summary.defaultScenarioCount}`,
    `With pending included: ${summary.includePendingScenarioCount}`,
    `plugin-lifeops scenarios: ${summary.pluginLifeopsCount}`,
    `plugin-app-control scenarios: ${summary.pluginAppControlCount}`,
    `scenario-runner test scenarios: ${summary.scenarioRunnerCount}`,
    `Unified scenario catalog entries: ${summary.allScenarioCount}`,
    "",
    `Workflow/live covered default package scenarios: ${summary.coveredDefaultCount}/${summary.defaultScenarioCount}`,
    `Missing default package scenarios from current workflow/live globs: ${summary.missingDefaultIds.length}`,
    "",
    "## Missing IDs",
    "",
  ];
  if (summary.missingDefaultIds.length === 0) {
    lines.push("- none");
  } else {
    for (const id of summary.missingDefaultIds) {
      lines.push(`- \`${id}\``);
    }
  }
  lines.push("");
  if (summary.viewerIndex) {
    lines.push(`HTML catalog viewer: ${summary.viewerIndex}`);
    lines.push("");
  }
  lines.push("## Scenario Run Artifacts");
  lines.push("");
  if (runArtifacts.length === 0) {
    lines.push("- none discovered");
  } else {
    for (const artifact of runArtifacts) {
      const result =
        typeof artifact.totalCount === "number"
          ? `${artifact.passedCount ?? 0}/${artifact.totalCount} passed, ${artifact.failedCount ?? 0} failed`
          : "matrix summary unavailable";
      const provider = artifact.providerName
        ? `, provider=${artifact.providerName}`
        : "";
      const viewer = artifact.viewerIndex
        ? `, viewer=${artifact.viewerIndex}`
        : "";
      lines.push(`- ${artifact.runDir}: ${result}${provider}${viewer}`);
    }
  }
  lines.push("");
  lines.push(
    "Full lists are in this directory as `.txt` files; exact missing IDs are in `workflow-coverage.json`.",
  );
  lines.push("");
  return lines.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  ensureGeneratedKeywordData();
  mkdirSync(options.reportDir, { recursive: true });

  const defaultIds = runScenarioList(DEFAULT_SCENARIO_ROOT);
  const includePendingIds = runScenarioList(DEFAULT_SCENARIO_ROOT, [], {
    SCENARIO_INCLUDE_PENDING: "1",
  });
  const pluginLifeopsIds = runScenarioList(
    "plugins/plugin-lifeops/test/scenarios",
  );
  const pluginAppControlIds = runScenarioList(
    "plugins/plugin-app-control/test/scenarios",
  );
  const scenarioRunnerIds = runScenarioList(
    "packages/scenario-runner/test/scenarios",
  );
  const allScenarioRows = [
    ...scopedScenarioRows("packages/test/scenarios", defaultIds),
    ...scopedScenarioRows(
      "plugins/plugin-lifeops/test/scenarios",
      pluginLifeopsIds,
    ),
    ...scopedScenarioRows(
      "plugins/plugin-app-control/test/scenarios",
      pluginAppControlIds,
    ),
    ...scopedScenarioRows(
      "packages/scenario-runner/test/scenarios",
      scenarioRunnerIds,
    ),
  ].sort();

  const covered = new Set();
  const coverageGlobs = [
    ...workflowScenarioGlobs(),
    "packages/test/scenarios/executive-assistant/*.scenario.ts",
    "packages/test/scenarios/connector-certification/*.scenario.ts",
  ];
  for (const id of runScenarioList(DEFAULT_SCENARIO_ROOT, coverageGlobs)) {
    covered.add(id);
  }

  const defaultSet = new Set(defaultIds);
  const missingDefaultIds = [...defaultSet]
    .filter((id) => !covered.has(id))
    .sort();
  const summary = {
    defaultScenarioCount: defaultIds.length,
    includePendingScenarioCount: includePendingIds.length,
    pluginLifeopsCount: pluginLifeopsIds.length,
    pluginAppControlCount: pluginAppControlIds.length,
    scenarioRunnerCount: scenarioRunnerIds.length,
    allScenarioCount: allScenarioRows.length,
    coveredDefaultCount: defaultIds.filter((id) => covered.has(id)).length,
    missingDefaultIds,
  };

  writeList(options.reportDir, "packages-test-default.txt", defaultIds);
  writeList(
    options.reportDir,
    "packages-test-include-pending.txt",
    includePendingIds,
  );
  writeList(options.reportDir, "plugin-lifeops.txt", pluginLifeopsIds);
  writeList(options.reportDir, "plugin-app-control.txt", pluginAppControlIds);
  writeList(options.reportDir, "scenario-runner-test.txt", scenarioRunnerIds);
  writeList(options.reportDir, "all-scenarios.txt", allScenarioRows);
  writeFileSync(
    path.join(options.reportDir, "workflow-coverage.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  const runArtifacts = existingScenarioRunArtifacts(options.reportDir);
  const payload = {
    schema: "eliza_scenario_catalog_coverage_v1",
    generatedAt: new Date().toISOString(),
    reportDir: options.reportDir,
    summary,
    defaultScenarios: defaultIds,
    includePendingScenarios: includePendingIds,
    pluginLifeopsScenarios: pluginLifeopsIds,
    pluginAppControlScenarios: pluginAppControlIds,
    scenarioRunnerScenarios: scenarioRunnerIds,
    allScenarios: allScenarioRows.map((row) => {
      const [scope, ...idParts] = row.split("\t");
      return { scope, id: idParts.join("\t") };
    }),
    runArtifacts,
  };
  const viewer = writeCatalogViewer(options.reportDir, payload);
  writeFileSync(
    path.join(options.reportDir, "README.md"),
    renderMarkdown(
      {
        ...summary,
        viewerIndex: viewer.indexPath,
      },
      runArtifacts,
    ),
    "utf8",
  );

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      `scenario workflow coverage ${summary.coveredDefaultCount}/${summary.defaultScenarioCount}; missing ${summary.missingDefaultIds.length}\n`,
    );
  }
  return options.failOnMissing && summary.missingDefaultIds.length > 0 ? 1 : 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
