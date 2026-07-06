#!/usr/bin/env node
// Drives repo automation check scenario workflow coverage with explicit CLI and CI behavior.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
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
    failOnMissing: true,
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
    } else if (arg === "--allow-missing") {
      options.failOnMissing = false;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function walkScenarioFiles(dir, out = []) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry.startsWith("_")) continue;
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "build" ||
      entry === ".turbo" ||
      entry === ".git"
    ) {
      continue;
    }
    const full = path.join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      walkScenarioFiles(full, out);
    } else if (entry.endsWith(".scenario.ts")) {
      out.push(full);
    }
  }
  return out;
}

function discoverScenarioFiles(root) {
  const absoluteRoot = path.resolve(REPO_ROOT, root);
  const files = [];
  const st = statSync(absoluteRoot);
  if (st.isFile()) {
    if (absoluteRoot.endsWith(".scenario.ts")) files.push(absoluteRoot);
  } else {
    walkScenarioFiles(absoluteRoot, files);
  }
  files.sort();
  return files;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
    return name.text;
  }
  return null;
}

function staticStringValue(expression) {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return expression.text;
  }
  return undefined;
}

function getStaticStringProperty(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property.name);
    if (name !== propertyName) continue;
    return staticStringValue(property.initializer);
  }
  return undefined;
}

/** Return the object-literal initializer of a nested object property, or null. */
function getStaticObjectProperty(objectLiteral, propertyName) {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (propertyNameText(property.name) !== propertyName) continue;
    if (ts.isObjectLiteralExpression(property.initializer)) {
      return property.initializer;
    }
    return null;
  }
  return null;
}

// OS values for which a self-hosted CI runner currently exists. A scenario that
// requires an OS NOT in this set is platform-gated and cannot run in any lane
// until that runner is provisioned — it is reported as "deferred platform-gated"
// so the inventory stays honest instead of conflating it with live-only. When an
// `eliza-e2e-macos` runner lands, add "macos" here and the shard un-defers. (#10757)
const AVAILABLE_OS_RUNNERS = new Set();

/** Human-readable deferral for a required-but-unavailable OS. */
function deferralForOs(os) {
  if (os === "macos") {
    return {
      reason:
        "requires a macOS host for native integrations (SelfControl/Screen Time, iMessage/BlueBubbles, mac remote-control); no self-hosted macOS runner yet",
      runner: "eliza-e2e-macos",
    };
  }
  return { reason: `requires OS "${os}"; no self-hosted runner yet` };
}

/**
 * Classify a scenario's coverage lane into the three inventory classes the
 * #10757 acceptance criteria call for: keyless PR-deterministic, deferred
 * platform-gated, or credentialed live-only. Derives platform-gating from the
 * existing `requires.os` gate (authoritative) plus any explicit `deferred`
 * annotation. Returns { class, os?, deferral? }.
 */
function classifyScenarioLane(meta) {
  if (meta.lane === "pr-deterministic") {
    return { class: "pr-deterministic" };
  }
  if (meta.deferred) {
    return { class: "deferred-platform", deferral: meta.deferred };
  }
  if (meta.platformOs && !AVAILABLE_OS_RUNNERS.has(meta.platformOs)) {
    return {
      class: "deferred-platform",
      os: meta.platformOs,
      deferral: deferralForOs(meta.platformOs),
    };
  }
  return { class: "live-only" };
}

function scenarioObjectFromExpression(expression) {
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (ts.isCallExpression(expression)) {
    const [firstArg] = expression.arguments;
    if (firstArg && ts.isObjectLiteralExpression(firstArg)) {
      return firstArg;
    }
  }
  return null;
}

function findExportedScenarioObject(sourceFile) {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) {
      const objectLiteral = scenarioObjectFromExpression(statement.expression);
      if (objectLiteral) return objectLiteral;
    }

    if (!ts.isVariableStatement(statement)) continue;
    const isExported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) continue;

    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== "scenario") continue;
      if (!declaration.initializer) continue;
      const objectLiteral = scenarioObjectFromExpression(
        declaration.initializer,
      );
      if (objectLiteral) return objectLiteral;
    }
  }

  return null;
}

function loadScenarioMetadataFile(file) {
  const sourceText = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const objectLiteral = findExportedScenarioObject(sourceFile);
  if (!objectLiteral) {
    throw new Error(
      `[scenario-catalog] ${file}: no statically readable scenario object in default export or exported 'scenario' value.`,
    );
  }
  const id = getStaticStringProperty(objectLiteral, "id");
  if (!id) {
    throw new Error(
      `[scenario-catalog] ${file}: no statically readable scenario id in default export or exported 'scenario' value.`,
    );
  }
  const requiresObj = getStaticObjectProperty(objectLiteral, "requires");
  const platformOs = requiresObj
    ? getStaticStringProperty(requiresObj, "os")
    : undefined;
  const deferredObj = getStaticObjectProperty(objectLiteral, "deferred");
  const deferred = deferredObj
    ? {
        reason: getStaticStringProperty(deferredObj, "reason"),
        ...(getStaticStringProperty(deferredObj, "runner")
          ? { runner: getStaticStringProperty(deferredObj, "runner") }
          : {}),
      }
    : undefined;
  const meta = {
    file,
    id,
    title: getStaticStringProperty(objectLiteral, "title"),
    status: getStaticStringProperty(objectLiteral, "status"),
    tier: getStaticStringProperty(objectLiteral, "tier"),
    lane: getStaticStringProperty(objectLiteral, "lane"),
    platformOs,
    deferred,
  };
  meta.laneClass = classifyScenarioLane(meta);
  return meta;
}

function listScenarioMetadata(root, { includePending = false } = {}) {
  return discoverScenarioFiles(root)
    .map(loadScenarioMetadataFile)
    .filter((metadata) => includePending || metadata.status !== "pending");
}

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

function scenarioFileGlobAlternatives(normalizedGlob) {
  const alternatives = [normalizedGlob];
  if (normalizedGlob.includes("/**/")) {
    alternatives.push(normalizedGlob.replace(/\/\*\*\//g, "/"));
  }
  return [...new Set(alternatives)];
}

function globToRegExpSource(glob) {
  let source = "^";
  for (let i = 0; i < glob.length; ) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }
    source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    i += 1;
  }
  return `${source}$`;
}

function matchesPosixGlob(value, glob) {
  return new RegExp(globToRegExpSource(glob)).test(value);
}

function scenarioFileMatchesGlob(file, fileGlob) {
  const resolvedFile = path.isAbsolute(file)
    ? path.resolve(file)
    : path.resolve(REPO_ROOT, file);
  const absoluteFile = toPosixPath(resolvedFile);
  const cwdRelativeFile = toPosixPath(path.relative(REPO_ROOT, resolvedFile));
  const globIsAbsolute = path.isAbsolute(fileGlob);
  const normalizedGlob = toPosixPath(
    globIsAbsolute ? path.resolve(fileGlob) : fileGlob,
  );
  const target = globIsAbsolute ? absoluteFile : cwdRelativeFile;

  return scenarioFileGlobAlternatives(normalizedGlob).some((candidateGlob) =>
    matchesPosixGlob(target, candidateGlob),
  );
}

function matchesScenarioFileGlobs(file, fileGlobs) {
  return fileGlobs.some((fileGlob) => scenarioFileMatchesGlob(file, fileGlob));
}

function workflowScenarioGlobs() {
  const workflowPath = path.join(
    REPO_ROOT,
    ".github",
    "workflows",
    "scenario-matrix.yml",
  );
  const text = readFileSync(workflowPath, "utf8");
  const matches = text
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*globs:\s*(.+?)\s*$/);
      if (!match) return "";
      const value = match[1].trim();
      const quote = value[0];
      if (
        (quote === '"' || quote === "'") &&
        value.length > 1 &&
        value.at(-1) === quote
      ) {
        return value.slice(1, -1);
      }
      return value;
    })
    .filter(Boolean);
  return matches
    .flatMap((value) =>
      value
        .split(/\s+/)
        .map((item) => item.trim())
        .filter(Boolean),
    )
    .filter((item) => item !== "**/*.scenario.ts");
}

function scenarioMatrixCoverage() {
  const globs = workflowScenarioGlobs();
  const enabled = process.env.ELIZA_SCENARIO_MATRIX_ENABLED === "true";
  if (enabled) {
    return {
      enabled,
      coveredGlobs: globs,
      deferredGlobs: [],
    };
  }
  return {
    enabled,
    coveredGlobs: [],
    deferredGlobs: globs.map((glob) => ({
      glob,
      issue: "#14695",
      reason:
        "tracked in #14695; scenario-matrix.yml is disabled unless ELIZA_SCENARIO_MATRIX_ENABLED=true or a manual dispatch enables it",
    })),
  };
}

const KNOWN_DEFERRED_DEFAULT_SCENARIO_COVERAGE = [
  {
    glob: "packages/test/scenarios/activity/**/*.scenario.ts",
    issue: "#10757",
  },
  {
    glob: "packages/test/scenarios/selfcontrol/**/*.scenario.ts",
    issue: "#10757",
  },
  {
    glob: "packages/test/scenarios/backup/**/*.scenario.ts",
    issue: "#10757",
  },
  {
    glob: "packages/test/scenarios/security/**/*.scenario.ts",
    issue: "#10757",
  },
];

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
        <select id="coverage"><option value="">all coverage states</option><option value="covered">covered</option><option value="deferred">deferred with follow-up</option><option value="missing">missing</option><option value="cataloged">cataloged outside default workflow gate</option></select>
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
      ["pluginLifeopsScenarios", "plugin-personal-assistant"],
      ["pluginAppControlScenarios", "plugin-app-control"],
      ["pluginAgentOrchestratorScenarios", "plugin-agent-orchestrator"],
      ["scenarioRunnerScenarios", "scenario-runner tests"],
      ["allScenarios", "Unified catalog"],
    ];
    function renderCards() {
      const s = data.summary || {};
      const items = [
        ["Default", s.defaultScenarioCount || 0],
        ["Include pending", s.includePendingScenarioCount || 0],
        ["plugin-personal-assistant", s.pluginLifeopsCount || 0],
        ["plugin-app-control", s.pluginAppControlCount || 0],
        ["plugin-agent-orchestrator", s.pluginAgentOrchestratorCount || 0],
        ["runner tests", s.scenarioRunnerCount || 0],
        ["All catalog entries", s.allScenarioCount || 0],
        ["Default pr-deterministic", s.prDeterministicDefaultCount || 0],
        ["Covered default", (s.coveredDefaultCount || 0) + "/" + (s.defaultScenarioCount || 0)],
        ["Deferred default", (s.deferredDefaultIds || []).length],
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
      const deferredSet = new Set(data.summary?.deferredDefaultIds || []);
      if ((item.scope || "") && item.scope !== "packages/test/scenarios") return "cataloged";
      if (!defaultSet.has(item.id || "")) return "cataloged";
      if (deferredSet.has(item.id || "")) return "deferred";
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
      document.getElementById("content").innerHTML = '<table><thead><tr><th>#</th><th>scope</th><th>scenario id</th><th>workflow coverage</th></tr></thead><tbody>' + rows.map((item,i) => { const state = coverageState(item); return '<tr><td>' + (i + 1) + '</td><td><code>' + esc(item.scope || "") + '</code></td><td><code>' + esc(item.id) + '</code></td><td class="' + (state === "missing" ? 'bad' : 'ok') + '">' + esc(state) + '</td></tr>'; }).join("") + '</tbody></table>';
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
    `plugin-personal-assistant scenarios: ${summary.pluginLifeopsCount}`,
    `plugin-app-control scenarios: ${summary.pluginAppControlCount}`,
    `plugin-agent-orchestrator scenarios: ${summary.pluginAgentOrchestratorCount}`,
    `scenario-runner test scenarios: ${summary.scenarioRunnerCount}`,
    `Unified scenario catalog entries: ${summary.allScenarioCount}`,
    "",
    "## Corpus coverage split (#10757)",
    "",
    "Honest three-way split across the full scenario corpus, so deterministic PR",
    "coverage, credentialed live-matrix coverage, and platform-gated coverage that",
    "is deferred (no runner yet) are counted separately rather than lumped together:",
    "",
    `- keyless PR-deterministic: ${summary.corpusLaneSplit.prDeterministicCount}`,
    `- credentialed live-only (live matrix): ${summary.corpusLaneSplit.liveOnlyCount}`,
    `- deferred platform-gated (no runner yet): ${summary.corpusLaneSplit.deferredPlatformCount}`,
    `- total corpus: ${summary.corpusLaneSplit.total}`,
    "",
    "### Deferred platform-gated scenarios",
    "",
    ...(summary.deferredPlatformScenarios.length === 0
      ? ["- none"]
      : summary.deferredPlatformScenarios.map(
          (s) =>
            `- \`${s.id}\`${s.os ? ` (os: ${s.os})` : ""} — ${s.reason ?? "platform-gated"}${s.runner ? ` [runner: ${s.runner}]` : ""}`,
        )),
    "",
    `Default package pr-deterministic scenarios: ${summary.prDeterministicDefaultCount}`,
    `Workflow covered default package scenarios: ${summary.coveredDefaultCount}/${summary.defaultScenarioCount}`,
    `Deferred default package scenarios tracked by follow-up: ${summary.deferredDefaultIds.length}`,
    `Missing default package scenarios from current workflow coverage: ${summary.missingDefaultIds.length}`,
    "",
    "## Deferred IDs",
    "",
  ];
  if (summary.deferredDefaultIds.length === 0) {
    lines.push("- none");
  } else {
    for (const id of summary.deferredDefaultIds) {
      const reason =
        summary.deferredDefaultReasons?.[id] ??
        "known deferred coverage tracked separately";
      lines.push(`- \`${id}\` - ${reason}`);
    }
  }
  lines.push("", "## Missing IDs", "");
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

  // This inventory is a workflow contract, not a runtime execution test. Keep
  // it Node-native so CI does not depend on Bun's TS loader/glob behavior while
  // deciding whether the workflow matrix covers the scenario catalog.
  const defaultScenarios = listScenarioMetadata(DEFAULT_SCENARIO_ROOT);
  const defaultIds = defaultScenarios.map((metadata) => metadata.id);
  const includePendingIds = listScenarioMetadata(DEFAULT_SCENARIO_ROOT, {
    includePending: true,
  }).map((metadata) => metadata.id);
  const pluginLifeopsIds = listScenarioMetadata(
    "plugins/plugin-personal-assistant/test/scenarios",
  ).map((metadata) => metadata.id);
  const pluginAppControlIds = listScenarioMetadata(
    "plugins/plugin-app-control/test/scenarios",
  ).map((metadata) => metadata.id);
  const pluginAgentOrchestratorIds = listScenarioMetadata(
    "plugins/plugin-agent-orchestrator/test/scenarios",
  ).map((metadata) => metadata.id);
  const scenarioRunnerIds = listScenarioMetadata(
    "packages/scenario-runner/test/scenarios",
  ).map((metadata) => metadata.id);
  const allScenarioRows = [
    ...scopedScenarioRows("packages/test/scenarios", defaultIds),
    ...scopedScenarioRows(
      "plugins/plugin-personal-assistant/test/scenarios",
      pluginLifeopsIds,
    ),
    ...scopedScenarioRows(
      "plugins/plugin-app-control/test/scenarios",
      pluginAppControlIds,
    ),
    ...scopedScenarioRows(
      "plugins/plugin-agent-orchestrator/test/scenarios",
      pluginAgentOrchestratorIds,
    ),
    ...scopedScenarioRows(
      "packages/scenario-runner/test/scenarios",
      scenarioRunnerIds,
    ),
  ].sort();

  // Every scenario must declare a `lane` ("pr-deterministic" | "live-only") so
  // the deterministic PR lane selects by tag, not a hand-maintained list. (#8801)
  const VALID_LANES = new Set(["pr-deterministic", "live-only"]);
  const laneScanRoots = [
    "packages/test/scenarios",
    "plugins/plugin-personal-assistant/test/scenarios",
    "plugins/plugin-app-control/test/scenarios",
    "plugins/plugin-agent-orchestrator/test/scenarios",
    "packages/scenario-runner/test/scenarios",
  ];
  const untaggedLaneScenarios = laneScanRoots
    .flatMap((root) => listScenarioMetadata(root, { includePending: true }))
    .filter((metadata) => !VALID_LANES.has(metadata.lane))
    .map((metadata) => toPosixPath(path.relative(REPO_ROOT, metadata.file)))
    .sort();

  const covered = new Set();
  const matrixCoverage = scenarioMatrixCoverage();
  const coverageGlobs = [
    ...matrixCoverage.coveredGlobs,
    "packages/test/scenarios/executive-assistant/*.scenario.ts",
    "packages/test/scenarios/connector-certification/*.scenario.ts",
  ];
  const prDeterministicDefaultIds = defaultScenarios
    .filter((scenario) => scenario.lane === "pr-deterministic")
    .map((scenario) => scenario.id)
    .sort();
  const deferred = new Map();
  const deferredCoverageGlobs = [
    ...KNOWN_DEFERRED_DEFAULT_SCENARIO_COVERAGE,
    ...matrixCoverage.deferredGlobs,
  ];
  for (const scenario of defaultScenarios) {
    const match = deferredCoverageGlobs.find((entry) =>
      matchesScenarioFileGlobs(scenario.file, [entry.glob]),
    );
    if (match) {
      deferred.set(
        scenario.id,
        match.reason ??
          `tracked in ${match.issue}; not currently part of the PR/live matrix`,
      );
    }
  }
  for (const scenario of defaultScenarios) {
    if (
      scenario.lane === "pr-deterministic" ||
      matchesScenarioFileGlobs(scenario.file, coverageGlobs)
    ) {
      covered.add(scenario.id);
    }
  }

  const defaultSet = new Set(defaultIds);
  const missingDefaultIds = [...defaultSet]
    .filter((id) => !covered.has(id) && !deferred.has(id))
    .sort();
  const deferredDefaultIds = [...deferred.keys()].sort();
  const deferredDefaultReasons = Object.fromEntries(
    deferredDefaultIds.map((id) => [id, deferred.get(id)]),
  );
  // #10757: honest three-way corpus split — keyless PR-deterministic vs
  // credentialed live-only vs deferred platform-gated (needs an OS/runner that
  // does not exist yet). Derived from `lane` + `requires.os` + explicit
  // `deferred`, so the checked-in counts cannot drift from the actual gates.
  const corpusMeta = laneScanRoots.flatMap((root) =>
    listScenarioMetadata(root, { includePending: true }),
  );
  const laneClassBuckets = {
    "pr-deterministic": [],
    "live-only": [],
    "deferred-platform": [],
  };
  const deferredPlatformScenarios = [];
  for (const meta of corpusMeta) {
    const cls = meta.laneClass?.class ?? "live-only";
    (laneClassBuckets[cls] ?? laneClassBuckets["live-only"]).push(meta.id);
    if (cls === "deferred-platform") {
      deferredPlatformScenarios.push({
        id: meta.id,
        file: toPosixPath(path.relative(REPO_ROOT, meta.file)),
        os: meta.platformOs ?? null,
        reason: meta.laneClass?.deferral?.reason ?? null,
        runner: meta.laneClass?.deferral?.runner ?? null,
      });
    }
  }
  deferredPlatformScenarios.sort((a, b) => a.id.localeCompare(b.id));
  const corpusLaneSplit = {
    total: corpusMeta.length,
    prDeterministicCount: laneClassBuckets["pr-deterministic"].length,
    liveOnlyCount: laneClassBuckets["live-only"].length,
    deferredPlatformCount: laneClassBuckets["deferred-platform"].length,
  };

  const summary = {
    corpusLaneSplit,
    deferredPlatformScenarios,
    defaultScenarioCount: defaultIds.length,
    includePendingScenarioCount: includePendingIds.length,
    pluginLifeopsCount: pluginLifeopsIds.length,
    pluginAppControlCount: pluginAppControlIds.length,
    pluginAgentOrchestratorCount: pluginAgentOrchestratorIds.length,
    scenarioRunnerCount: scenarioRunnerIds.length,
    allScenarioCount: allScenarioRows.length,
    scenarioMatrixCoverageEnabled: matrixCoverage.enabled,
    scenarioMatrixCoveredGlobCount: matrixCoverage.coveredGlobs.length,
    scenarioMatrixDeferredGlobCount: matrixCoverage.deferredGlobs.length,
    prDeterministicDefaultCount: prDeterministicDefaultIds.length,
    prDeterministicDefaultIds,
    coveredDefaultCount: defaultIds.filter((id) => covered.has(id)).length,
    deferredDefaultCount: deferredDefaultIds.length,
    deferredDefaultIds,
    deferredDefaultReasons,
    missingDefaultIds,
    untaggedLaneScenarios,
  };

  writeList(options.reportDir, "packages-test-default.txt", defaultIds);
  writeList(
    options.reportDir,
    "packages-test-include-pending.txt",
    includePendingIds,
  );
  writeList(
    options.reportDir,
    "plugin-personal-assistant.txt",
    pluginLifeopsIds,
  );
  writeList(options.reportDir, "plugin-app-control.txt", pluginAppControlIds);
  writeList(
    options.reportDir,
    "plugin-agent-orchestrator.txt",
    pluginAgentOrchestratorIds,
  );
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
    pluginAgentOrchestratorScenarios: pluginAgentOrchestratorIds,
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
      `scenario workflow coverage ${summary.coveredDefaultCount}/${summary.defaultScenarioCount}; deferred ${summary.deferredDefaultIds.length}; missing ${summary.missingDefaultIds.length}; untagged-lane ${summary.untaggedLaneScenarios.length}\n`,
    );
    if (summary.untaggedLaneScenarios.length > 0) {
      process.stderr.write(
        `[scenario-catalog] ${summary.untaggedLaneScenarios.length} scenario(s) missing a 'lane' tag (pr-deterministic | live-only):\n  ${summary.untaggedLaneScenarios.join("\n  ")}\n`,
      );
    }
  }
  const hasFailures =
    summary.missingDefaultIds.length > 0 ||
    summary.untaggedLaneScenarios.length > 0;
  return options.failOnMissing && hasFailures ? 1 : 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
