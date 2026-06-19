#!/usr/bin/env node
/**
 * lint-lane-coverage.mjs
 *
 * Static coverage gate for the deterministic PR lanes. It inventories plugins,
 * action surfaces, view/app surfaces, deterministic E2E/scenario coverage, and
 * real/live E2E env documentation. Default mode is a CI gate: unsuppressed
 * coverage gaps exit 1. Use --dry-run for local inventory without failing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(here, "..", "..");
const DEFAULT_ALLOWLIST_PATH = path.join(
  here,
  "lint-lane-coverage.allowlist.json",
);

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "native",
  "node_modules",
  "target",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);

export const ISSUE_CODES = Object.freeze({
  MISSING_TESTS: "missing-tests",
  MISSING_DETERMINISTIC_E2E: "missing-deterministic-e2e",
  MISSING_ACTION_TESTS: "missing-action-tests",
  MISSING_ACTION_E2E: "missing-action-e2e",
  MISSING_VIEW_TESTS: "missing-view-tests",
  MISSING_VIEW_E2E: "missing-view-e2e",
  DETERMINISTIC_E2E_REQUIRES_ENV: "deterministic-e2e-requires-env",
  UNDOCUMENTED_ENV_VAR: "undocumented-env-var",
});

const VALID_ISSUE_CODES = new Set(Object.values(ISSUE_CODES));

function normalizeRepoPath(value) {
  return value.split(path.sep).join("/");
}

function repoRelative(repoRoot, filePath) {
  return normalizeRepoPath(path.relative(repoRoot, filePath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTextIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function walkFiles(dir, visitor) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visitor);
      continue;
    }
    if (entry.isFile()) {
      visitor(fullPath);
    }
  }
}

function loadEnvTestExampleKeys(repoRoot) {
  const envPath = path.join(repoRoot, ".env.test.example");
  if (!fs.existsSync(envPath)) {
    return new Set();
  }
  const content = fs.readFileSync(envPath, "utf8");
  const keys = new Set();
  for (const line of content.split("\n")) {
    const trimmed = line.replace(/#.*$/, "").trim();
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match) {
      keys.add(match[1]);
    }
  }
  return keys;
}

function parseRequiresComment(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").slice(0, 20);
  for (const line of lines) {
    const match = line.match(/\/\/\s*requires?:\s*(.+)/i);
    if (match) {
      return match[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function isTestFile(filePath) {
  const name = path.basename(filePath);
  return /\.(?:test|spec)\.[cm]?[tj]sx?$/.test(name);
}

function isScenarioFile(filePath) {
  return /\.scenario\.[cm]?[tj]sx?$/.test(path.basename(filePath));
}

function isLiveOrRealE2E(filePath) {
  const name = path.basename(filePath);
  return /(?:^|[.-])(?:live|real)\.e2e\.(?:test|spec)\.[cm]?[tj]sx?$/.test(
    name,
  );
}

function isDeterministicE2EFile(filePath) {
  const normalized = normalizeRepoPath(filePath);
  const name = path.basename(filePath);
  if (isLiveOrRealE2E(filePath)) {
    return false;
  }
  if (/\.e2e\.(?:test|spec)\.[cm]?[tj]sx?$/.test(name)) {
    return true;
  }
  if (isScenarioFile(filePath)) {
    return true;
  }
  return /(?:^|\/)(?:e2e|ui-smoke|playwright)(?:\/|$)/.test(normalized);
}

function isIntegrationFile(filePath) {
  return /\.(?:integration|int)\.test\.[cm]?[tj]sx?$/.test(
    path.basename(filePath),
  );
}

function isUnitLikeTestFile(filePath) {
  return (
    isTestFile(filePath) &&
    !isDeterministicE2EFile(filePath) &&
    !isLiveOrRealE2E(filePath) &&
    !isIntegrationFile(filePath)
  );
}

function collectPluginFiles(pluginDir) {
  const files = {
    allTests: [],
    unitTests: [],
    integrationTests: [],
    deterministicE2E: [],
    liveOrRealE2E: [],
    scenarios: [],
    actionTests: [],
    viewTests: [],
    sourceFiles: [],
    actionSourceFiles: [],
    viewSourceFiles: [],
  };

  walkFiles(pluginDir, (filePath) => {
    const rel = normalizeRepoPath(path.relative(pluginDir, filePath));
    const ext = path.extname(filePath);
    const isSource = SOURCE_EXTENSIONS.has(ext);
    const testLike = isTestFile(filePath) || isScenarioFile(filePath);

    if (isSource && !testLike && rel.startsWith("src/")) {
      files.sourceFiles.push(filePath);
      if (/(?:^|\/)actions?\//.test(rel)) {
        files.actionSourceFiles.push(filePath);
      }
      if (
        /(?:^|\/)views?\//.test(rel) ||
        /(?:View|Page|Panel|Dashboard|Screen)\.tsx$/.test(rel)
      ) {
        files.viewSourceFiles.push(filePath);
      }
    }

    if (!testLike) {
      return;
    }

    files.allTests.push(filePath);
    if (isScenarioFile(filePath)) {
      files.scenarios.push(filePath);
    }
    if (isLiveOrRealE2E(filePath)) {
      files.liveOrRealE2E.push(filePath);
    } else if (isDeterministicE2EFile(filePath)) {
      files.deterministicE2E.push(filePath);
    } else if (isIntegrationFile(filePath)) {
      files.integrationTests.push(filePath);
    } else if (isUnitLikeTestFile(filePath)) {
      files.unitTests.push(filePath);
    }

    if (/(?:^|\/)actions?\//.test(rel) || /actions?/i.test(rel)) {
      files.actionTests.push(filePath);
    }
    if (
      /(?:^|\/)views?\//.test(rel) ||
      /(?:view|page|panel|dashboard|screen)/i.test(rel)
    ) {
      files.viewTests.push(filePath);
    }
  });

  return files;
}

function collectScenarioFiles(repoRoot) {
  const scenarioRoots = [
    path.join(repoRoot, "packages", "test", "scenarios"),
    path.join(repoRoot, "plugins"),
  ];
  const scenarios = [];
  for (const scenarioRoot of scenarioRoots) {
    if (!fs.existsSync(scenarioRoot)) {
      continue;
    }
    walkFiles(scenarioRoot, (filePath) => {
      if (isScenarioFile(filePath)) {
        scenarios.push(filePath);
      }
    });
  }
  return scenarios.sort((left, right) => left.localeCompare(right));
}

function scenarioMentionsPlugin(repoRoot, scenarioPath, plugin) {
  const rel = repoRelative(repoRoot, scenarioPath);
  if (rel.startsWith(`plugins/${plugin.name}/`)) {
    return true;
  }
  const text = readTextIfExists(scenarioPath);
  return plugin.matchTerms.some((term) => term && text.includes(term));
}

function sourceDeclaresNonEmptyArray(sourceText, propertyName) {
  const pattern = new RegExp(`${propertyName}\\s*:\\s*\\[`, "m");
  if (!pattern.test(sourceText)) {
    return false;
  }
  const emptyPattern = new RegExp(`${propertyName}\\s*:\\s*\\[\\s*\\]`, "m");
  return !emptyPattern.test(sourceText);
}

function detectSurfaces(pluginDir, packageJson, files) {
  const sourceText = files.sourceFiles
    .map((filePath) => readTextIfExists(filePath))
    .join("\n");

  const declaresActions =
    sourceDeclaresNonEmptyArray(sourceText, "actions") ||
    files.actionSourceFiles.length > 0;
  const declaresViews =
    sourceDeclaresNonEmptyArray(sourceText, "views") ||
    files.viewSourceFiles.length > 0 ||
    Boolean(packageJson?.elizaos?.app) ||
    Boolean(packageJson?.scripts?.["build:views"]);

  return {
    hasActions: declaresActions,
    hasViews: declaresViews,
    actionSourceFiles: files.actionSourceFiles.length,
    viewSourceFiles: files.viewSourceFiles.length,
    hasAppManifest: Boolean(packageJson?.elizaos?.app),
    hasBuildViewsScript: Boolean(packageJson?.scripts?.["build:views"]),
  };
}

function loadAllowlist(allowlistPath, pluginNames) {
  if (!allowlistPath || !fs.existsSync(allowlistPath)) {
    return {
      path: allowlistPath,
      entries: [],
      errors: [],
      usedKeys: new Set(),
    };
  }

  let parsed;
  try {
    parsed = readJson(allowlistPath);
  } catch (error) {
    return {
      path: allowlistPath,
      entries: [],
      errors: [
        `allowlist:${allowlistPath}: failed to parse JSON (${error.message})`,
      ],
      usedKeys: new Set(),
    };
  }

  const rawEntries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.entries)
      ? parsed.entries
      : [];
  const entries = [];
  const errors = [];

  if (!Array.isArray(rawEntries)) {
    errors.push(`allowlist:${allowlistPath}: expected array or { entries: [] }`);
  }

  rawEntries.forEach((entry, index) => {
    const label = `allowlist:${allowlistPath}: entry ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    const plugin = entry.plugin;
    const issues = entry.issues;
    const reason = entry.reason;
    if (typeof plugin !== "string" || !plugin.trim()) {
      errors.push(`${label} must include a plugin`);
      return;
    }
    if (!pluginNames.has(plugin)) {
      errors.push(`${label} references unknown plugin ${plugin}`);
    }
    if (!Array.isArray(issues) || issues.length === 0) {
      errors.push(`${label} must include non-empty issues array`);
      return;
    }
    if (typeof reason !== "string" || !reason.trim()) {
      errors.push(`${label} must include a non-empty reason`);
    }
    for (const issue of issues) {
      if (!VALID_ISSUE_CODES.has(issue)) {
        errors.push(`${label} has unknown issue code ${issue}`);
        continue;
      }
      entries.push({
        key: `${plugin}:${issue}`,
        plugin,
        issue,
        reason,
      });
    }
  });

  return {
    path: allowlistPath,
    entries,
    errors,
    usedKeys: new Set(),
  };
}

function applyAllowlist(issues, allowlist) {
  const entryByKey = new Map(
    allowlist.entries.map((entry) => [entry.key, entry]),
  );
  const unsuppressed = [];
  const suppressed = [];

  for (const issue of issues) {
    const key = `${issue.plugin}:${issue.code}`;
    const entry = entryByKey.get(key);
    if (entry) {
      allowlist.usedKeys.add(key);
      suppressed.push({ ...issue, allowlistReason: entry.reason });
    } else {
      unsuppressed.push(issue);
    }
  }

  const unused = allowlist.entries.filter(
    (entry) => !allowlist.usedKeys.has(entry.key),
  );
  return { unsuppressed, suppressed, unused };
}

function issue(plugin, code, message, extra = {}) {
  return { plugin: plugin.name, code, message, ...extra };
}

function analyzePlugin({
  repoRoot,
  envTestKeys,
  plugin,
  scenarioFiles,
}) {
  const files = collectPluginFiles(plugin.dir);
  const externalScenarios = scenarioFiles.filter((scenarioPath) =>
    scenarioMentionsPlugin(repoRoot, scenarioPath, plugin),
  );

  for (const scenarioPath of externalScenarios) {
    if (!files.scenarios.includes(scenarioPath)) {
      files.scenarios.push(scenarioPath);
    }
    if (!files.deterministicE2E.includes(scenarioPath)) {
      files.deterministicE2E.push(scenarioPath);
    }
    if (!files.allTests.includes(scenarioPath)) {
      files.allTests.push(scenarioPath);
    }
  }

  const surfaces = detectSurfaces(plugin.dir, plugin.packageJson, files);
  const issues = [];

  if (files.allTests.length === 0) {
    issues.push(
      issue(
        plugin,
        ISSUE_CODES.MISSING_TESTS,
        "plugin has no test, spec, or scenario files",
      ),
    );
  }

  if (files.deterministicE2E.length === 0) {
    issues.push(
      issue(
        plugin,
        ISSUE_CODES.MISSING_DETERMINISTIC_E2E,
        "plugin has no deterministic E2E or scenario coverage",
      ),
    );
  }

  if (surfaces.hasActions && files.actionTests.length === 0) {
    issues.push(
      issue(
        plugin,
        ISSUE_CODES.MISSING_ACTION_TESTS,
        "plugin exposes action surfaces but has no action-focused tests",
      ),
    );
  }

  if (surfaces.hasActions && files.deterministicE2E.length === 0) {
    issues.push(
      issue(
        plugin,
        ISSUE_CODES.MISSING_ACTION_E2E,
        "plugin exposes action surfaces but has no deterministic action E2E/scenario coverage",
      ),
    );
  }

  if (surfaces.hasViews && files.viewTests.length === 0) {
    issues.push(
      issue(
        plugin,
        ISSUE_CODES.MISSING_VIEW_TESTS,
        "plugin exposes view/app surfaces but has no view-focused tests",
      ),
    );
  }

  if (surfaces.hasViews && files.deterministicE2E.length === 0) {
    issues.push(
      issue(
        plugin,
        ISSUE_CODES.MISSING_VIEW_E2E,
        "plugin exposes view/app surfaces but has no deterministic view E2E/scenario coverage",
      ),
    );
  }

  for (const e2eFile of files.deterministicE2E) {
    const required = parseRequiresComment(e2eFile);
    if (required.length > 0) {
      issues.push(
        issue(
          plugin,
          ISSUE_CODES.DETERMINISTIC_E2E_REQUIRES_ENV,
          "deterministic E2E/scenario coverage declares required env vars",
          {
            file: repoRelative(repoRoot, e2eFile),
            envVars: required,
          },
        ),
      );
    }
  }

  for (const realFile of files.liveOrRealE2E) {
    const required = parseRequiresComment(realFile);
    for (const key of required) {
      if (!envTestKeys.has(key)) {
        issues.push(
          issue(
            plugin,
            ISSUE_CODES.UNDOCUMENTED_ENV_VAR,
            `${repoRelative(repoRoot, realFile)} requires ${key}, but ${repoRelative(
              repoRoot,
              path.join(repoRoot, ".env.test.example"),
            )} does not document it`,
            {
              file: repoRelative(repoRoot, realFile),
              envVar: key,
            },
          ),
        );
      }
    }
  }

  return {
    pluginName: plugin.name,
    packageName: plugin.packageName,
    dir: repoRelative(repoRoot, plugin.dir),
    files,
    surfaces,
    counts: {
      tests: files.allTests.length,
      unit: files.unitTests.length,
      integration: files.integrationTests.length,
      deterministicE2E: files.deterministicE2E.length,
      liveOrRealE2E: files.liveOrRealE2E.length,
      scenarios: files.scenarios.length,
      actionTests: files.actionTests.length,
      viewTests: files.viewTests.length,
      actionSources: surfaces.actionSourceFiles,
      viewSources: surfaces.viewSourceFiles,
    },
    issues,
  };
}

function discoverPlugins(repoRoot) {
  const pluginsDir = path.join(repoRoot, "plugins");
  if (!fs.existsSync(pluginsDir)) {
    throw new Error(
      `[lint-lane-coverage] plugins/ directory not found at ${pluginsDir}`,
    );
  }

  const plugins = fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(pluginsDir, entry.name);
      const packageJsonPath = path.join(dir, "package.json");
      if (!fs.existsSync(packageJsonPath)) {
        return null;
      }
      const packageJson = readJson(packageJsonPath);
      const packageName =
        typeof packageJson.name === "string" ? packageJson.name : entry.name;
      return {
        name: entry.name,
        packageName,
        dir,
        packageJson,
        matchTerms: [
          entry.name,
          packageName,
        ].filter(Boolean),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));

  if (plugins.length === 0) {
    throw new Error(
      `[lint-lane-coverage] no plugin package.json files found under ${pluginsDir}`,
    );
  }

  return plugins;
}

export function analyzeLaneCoverage(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT);
  const allowlistPath =
    options.allowlistPath === null
      ? null
      : path.resolve(options.allowlistPath ?? DEFAULT_ALLOWLIST_PATH);

  const plugins = discoverPlugins(repoRoot);
  const pluginNames = new Set(plugins.map((plugin) => plugin.name));
  const envTestKeys = loadEnvTestExampleKeys(repoRoot);
  const scenarioFiles = collectScenarioFiles(repoRoot);
  const allowlist = loadAllowlist(allowlistPath, pluginNames);

  const pluginResults = plugins.map((plugin) =>
    analyzePlugin({
      repoRoot,
      envTestKeys,
      plugin,
      scenarioFiles,
    }),
  );
  const allIssues = pluginResults.flatMap((row) => row.issues);
  const allowlistResult = applyAllowlist(allIssues, allowlist);
  const allowlistErrors = [
    ...allowlist.errors,
    ...allowlistResult.unused.map(
      (entry) =>
        `allowlist:${allowlist.path}: unused entry ${entry.plugin}:${entry.issue}`,
    ),
  ];

  return {
    repoRoot,
    allowlistPath,
    plugins: pluginResults,
    issues: allIssues,
    unsuppressedIssues: allowlistResult.unsuppressed,
    suppressedIssues: allowlistResult.suppressed,
    allowlistErrors,
    summary: {
      pluginCount: pluginResults.length,
      pluginsWithNoTests: pluginResults.filter(
        (row) =>
          row.issues.some((entry) => entry.code === ISSUE_CODES.MISSING_TESTS),
      ).length,
      pluginsWithNoDeterministicE2E: pluginResults.filter((row) =>
        row.issues.some(
          (entry) =>
            entry.code === ISSUE_CODES.MISSING_DETERMINISTIC_E2E,
        ),
      ).length,
      pluginsWithActions: pluginResults.filter((row) => row.surfaces.hasActions)
        .length,
      pluginsWithViews: pluginResults.filter((row) => row.surfaces.hasViews)
        .length,
      issueCount: allIssues.length,
      unsuppressedIssueCount: allowlistResult.unsuppressed.length,
      suppressedIssueCount: allowlistResult.suppressed.length,
      allowlistErrorCount: allowlistErrors.length,
    },
  };
}

function formatCount(value) {
  return String(value).padStart(5);
}

export function formatCoverageReport(result, options = {}) {
  const lines = [];
  const dryRun = Boolean(options.dryRun);
  const statusLabel =
    result.unsuppressedIssues.length === 0 && result.allowlistErrors.length === 0
      ? "PASS"
      : dryRun
        ? "DRY-RUN"
        : "FAIL";

  lines.push("");
  lines.push(
    `[lint-lane-coverage] ${statusLabel} plugin lane coverage inventory`,
  );
  lines.push(`[lint-lane-coverage] repo root: ${result.repoRoot}`);
  if (result.allowlistPath && fs.existsSync(result.allowlistPath)) {
    lines.push(`[lint-lane-coverage] allowlist: ${result.allowlistPath}`);
  }
  lines.push("");

  const header = [
    "Plugin".padEnd(38),
    "Tests",
    "Unit",
    "Int",
    "E2E",
    "Live",
    "Scen",
    "Act",
    "View",
    "Issues",
  ].join("  ");
  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const row of result.plugins) {
    const unsuppressedForPlugin = result.unsuppressedIssues.filter(
      (entry) => entry.plugin === row.pluginName,
    ).length;
    const suppressedForPlugin = result.suppressedIssues.filter(
      (entry) => entry.plugin === row.pluginName,
    ).length;
    const issueText =
      suppressedForPlugin > 0
        ? `${unsuppressedForPlugin}/${suppressedForPlugin}s`
        : String(unsuppressedForPlugin);
    lines.push(
      [
        row.pluginName.slice(0, 38).padEnd(38),
        formatCount(row.counts.tests),
        formatCount(row.counts.unit),
        formatCount(row.counts.integration),
        formatCount(row.counts.deterministicE2E),
        formatCount(row.counts.liveOrRealE2E),
        formatCount(row.counts.scenarios),
        formatCount(row.counts.actionSources),
        formatCount(row.counts.viewSources),
        issueText.padStart(6),
      ].join("  "),
    );
  }

  if (result.unsuppressedIssues.length > 0) {
    lines.push("");
    lines.push("[lint-lane-coverage] Blocking issues:");
    for (const entry of result.unsuppressedIssues) {
      const location = entry.file ? ` (${entry.file})` : "";
      lines.push(
        `  - ${entry.plugin}: ${entry.code}${location}: ${entry.message}`,
      );
    }
  }

  if (result.suppressedIssues.length > 0) {
    lines.push("");
    lines.push("[lint-lane-coverage] Suppressed issues:");
    for (const entry of result.suppressedIssues) {
      lines.push(
        `  - ${entry.plugin}: ${entry.code}: ${entry.allowlistReason}`,
      );
    }
  }

  if (result.allowlistErrors.length > 0) {
    lines.push("");
    lines.push("[lint-lane-coverage] Allowlist errors:");
    for (const entry of result.allowlistErrors) {
      lines.push(`  - ${entry}`);
    }
  }

  lines.push("");
  lines.push(
    `[lint-lane-coverage] ${result.summary.pluginCount} plugins scanned; ` +
      `${result.summary.pluginsWithNoTests} missing tests; ` +
      `${result.summary.pluginsWithNoDeterministicE2E} missing deterministic E2E/scenario coverage; ` +
      `${result.summary.unsuppressedIssueCount} blocking issue(s); ` +
      `${result.summary.suppressedIssueCount} suppressed issue(s).`,
  );
  if (dryRun) {
    lines.push(
      "[lint-lane-coverage] --dry-run was set, so findings did not affect the exit code.",
    );
  }

  return `${lines.join("\n")}\n`;
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node packages/scripts/lint-lane-coverage.mjs [options]",
      "",
      "Options:",
      "  --dry-run                 Print inventory and findings but exit 0.",
      "  --repo-root <path>        Scan a repo root other than the current checkout.",
      "  --allowlist <path>        Load explicit suppressions from JSON.",
      "  --no-allowlist            Ignore the default allowlist file.",
      "  --json                    Print the raw JSON result instead of the table.",
      "  --help                    Show this help.",
      "",
      "Allowlist format:",
      "  { \"entries\": [{ \"plugin\": \"plugin-name\", \"issues\": [\"missing-deterministic-e2e\"], \"reason\": \"tracked in ISSUE-123\" }] }",
      "",
    ].join("\n"),
  );
}

function parseCliArgs(argv) {
  const args = [...argv];
  const options = {
    dryRun: false,
    json: false,
    repoRoot: DEFAULT_REPO_ROOT,
    allowlistPath: DEFAULT_ALLOWLIST_PATH,
  };

  function readValue(flag, index) {
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    args.splice(index, 2);
    return next;
  }

  for (let i = 0; i < args.length; ) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      args.splice(i, 1);
      continue;
    }
    if (arg === "--dry-run" || arg === "--report-only") {
      options.dryRun = true;
      args.splice(i, 1);
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      args.splice(i, 1);
      continue;
    }
    if (arg === "--no-allowlist") {
      options.allowlistPath = null;
      args.splice(i, 1);
      continue;
    }
    if (arg === "--repo-root") {
      options.repoRoot = readValue(arg, i);
      continue;
    }
    if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
      args.splice(i, 1);
      continue;
    }
    if (arg === "--allowlist") {
      options.allowlistPath = readValue(arg, i);
      continue;
    }
    if (arg.startsWith("--allowlist=")) {
      options.allowlistPath = arg.slice("--allowlist=".length);
      args.splice(i, 1);
      continue;
    }
    i++;
  }

  if (args.length > 0) {
    throw new Error(`unknown argument(s): ${args.join(" ")}`);
  }

  return options;
}

export function runCli(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(`[lint-lane-coverage] ${error.message}`);
    console.error("Run with --help for usage.");
    return 2;
  }

  if (options.help) {
    printHelp();
    return 0;
  }

  let result;
  try {
    result = analyzeLaneCoverage(options);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(formatCoverageReport(result, options));
  }

  if (options.dryRun) {
    return 0;
  }
  return result.unsuppressedIssues.length === 0 &&
    result.allowlistErrors.length === 0
    ? 0
    : 1;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
