import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_CORE_ROOT = path.resolve(SCRIPT_DIR, "..");
const args = new Set(process.argv.slice(2));
const outputJson = args.has("--json");
const failOnViolations = args.has("--fail-on-violations");

const IGNORE_DIRS = new Set([
  ".claude",
  ".cursor",
  ".git",
  ".hg",
  ".next",
  ".turbo",
  ".vite",
  ".yarn",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const CONFIG_FILE_PATTERN =
  /(?:^|\/)(?:package\.json|vitest(?:\.[^/]+)?\.config\.[cm]?[jt]s|playwright(?:\.[^/]+)?\.config\.[cm]?[jt]s|bunfig\.toml|test\/setup\.[cm]?[jt]s)$/;
const MOCK_DIR_NAMES = new Set([
  "__mocks__",
  "__fixtures__",
  "fixtures",
  "mocks",
]);
const STUB_PATTERNS = [
  {
    id: "playwright-ui-smoke-api-stub",
    regex: /playwright-ui-smoke-api-stub\.mjs/g,
  },
  { id: "test/stubs", regex: /test\/stubs/g },
  { id: "__mocks__", regex: /__mocks__/g },
  { id: "plugin-stub", regex: /plugin-stub\.mjs/g },
  { id: "empty-module", regex: /empty-module\.mjs/g },
  { id: "page.route", regex: /\bpage\.route\s*\(/g },
  { id: "startMockApiServer", regex: /\bstartMockApiServer\b/g },
  { id: "installDefaultAppMocks", regex: /\binstallDefaultAppMocks\s*\(/g },
  { id: "fulfillJson", regex: /\bfulfillJson\s*\(/g },
  { id: "test.fixme", regex: /\btest\.fixme\s*\(/g },
];
const HARNESS_BLOCKER_PATTERNS = [
  { id: "ELIZA_LIVE_TEST=0", regex: /ELIZA_LIVE_TEST\s*=\s*["']0["']/g },
  {
    id: "ELIZA_SKIP_STEWARD_FI_LIVE_SMOKE=1",
    regex: /ELIZA_SKIP_STEWARD_FI_LIVE_SMOKE\s*=\s*["']1["']/g,
  },
];

function findRepoRoot(startDir) {
  let currentDir = startDir;
  let matchedRoot = null;

  while (true) {
    if (
      fs.existsSync(path.join(currentDir, "package.json")) &&
      fs.existsSync(path.join(currentDir, ".github", "workflows"))
    ) {
      matchedRoot = currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      if (matchedRoot) {
        return matchedRoot;
      }
      throw new Error(`Unable to resolve repository root from ${startDir}.`);
    }

    currentDir = parentDir;
  }
}

const repoRoot = findRepoRoot(APP_CORE_ROOT);

const ROOTS = [
  {
    id: "main",
    dir: repoRoot,
    ignoreDirs: new Set([...IGNORE_DIRS, "eliza"]),
    packageJson: path.join(repoRoot, "package.json"),
    requireSurfaceFiles: true,
    requireExplicitLiveFiles: false,
    requiredScriptKinds: ["e2e", "playwright"],
  },
  {
    id: "eliza",
    dir: path.join(repoRoot, "eliza"),
    ignoreDirs: new Set([...IGNORE_DIRS, "cloud", "examples", "steward-fi"]),
    packageJson: path.join(repoRoot, "eliza", "package.json"),
    requireSurfaceFiles: true,
    requireExplicitLiveFiles: true,
    requiredScriptKinds: [],
  },
  {
    id: "cloud",
    dir: path.join(repoRoot, "eliza", "cloud"),
    ignoreDirs: new Set([...IGNORE_DIRS, "examples"]),
    packageJson: path.join(repoRoot, "eliza", "cloud", "package.json"),
    requireSurfaceFiles: true,
    requireExplicitLiveFiles: false,
    requiredScriptKinds: ["e2e", "playwright"],
  },
  {
    id: "steward-fi",
    dir: path.join(repoRoot, "eliza", "steward-fi"),
    ignoreDirs: new Set([...IGNORE_DIRS, "examples"]),
    packageJson: path.join(repoRoot, "eliza", "steward-fi", "package.json"),
    requireSurfaceFiles: true,
    requireExplicitLiveFiles: false,
    requiredScriptKinds: ["e2e"],
  },
].filter((root) => fs.existsSync(root.dir));

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function isExplicitLiveFile(relPath) {
  const fileName = path.basename(relPath);
  return [
    ".live.test.",
    "-live.test.",
    ".live.e2e.test.",
    "-live.e2e.test.",
    ".real.test.",
    "-real.test.",
    ".real.e2e.test.",
    "-real.e2e.test.",
  ].some((marker) => fileName.includes(marker));
}

function isSurfaceFile(rootId, relPath) {
  if (isExplicitLiveFile(relPath)) {
    return true;
  }

  if (
    rootId === "main" &&
    relPath.startsWith("apps/app/test/ui-smoke/") &&
    TEST_FILE_PATTERN.test(relPath)
  ) {
    return true;
  }

  if (
    rootId === "main" &&
    relPath.startsWith("apps/app/test/electrobun-packaged/") &&
    TEST_FILE_PATTERN.test(relPath)
  ) {
    return true;
  }

  if (
    rootId === "main" &&
    relPath.startsWith("apps/homepage/test/e2e/") &&
    TEST_FILE_PATTERN.test(relPath)
  ) {
    return true;
  }

  if (
    rootId === "cloud" &&
    relPath.startsWith("eliza/cloud/packages/tests/e2e/") &&
    TEST_FILE_PATTERN.test(relPath)
  ) {
    return true;
  }

  if (
    rootId === "cloud" &&
    relPath.startsWith("eliza/cloud/packages/tests/playwright/") &&
    TEST_FILE_PATTERN.test(relPath)
  ) {
    return true;
  }

  return (
    rootId === "steward-fi" &&
    /^eliza\/steward-fi\/scripts\/e2e-.*\.ts$/i.test(relPath)
  );
}

function createCounter(patterns) {
  return Object.fromEntries(patterns.map((pattern) => [pattern.id, 0]));
}

function countMatches(text, patterns) {
  const counts = createCounter(patterns);
  for (const pattern of patterns) {
    const matches = text.match(pattern.regex);
    if (matches) {
      counts[pattern.id] = matches.length;
    }
  }
  return counts;
}

function hasAnyCount(counts) {
  return Object.values(counts).some((count) => count > 0);
}

function sumCounts(counts) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function applyFileAllowances(text, counts) {
  if (
    text.includes("@eliza-live-audit allow-route-fixtures") ||
    text.includes("@agent-live-audit allow-route-fixtures") ||
    text.includes("@eliza-live-audit allow-route-fixtures")
  ) {
    counts["page.route"] = 0;
    counts.fulfillJson = 0;
  }
  return counts;
}

function takeExamples(items, limit = 8) {
  return items.slice(0, limit);
}

function normaliseScriptKinds(name) {
  const kinds = new Set();

  if (!name.startsWith("test")) {
    return [];
  }

  if (/(?:^|:)live(?:$|:)/.test(name) || /(?:^|:)real(?:$|:)/.test(name)) {
    kinds.add("live");
  }
  if (/(?:^|:)e2e(?:$|:)/.test(name)) {
    kinds.add("e2e");
  }
  if (/(?:^|:)playwright(?:$|:)/.test(name)) {
    kinds.add("playwright");
  }

  return [...kinds];
}

async function walkDirectory(root) {
  const files = [];
  const mockDirs = [];
  const queue = [root.dir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }

    let entries = [];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absPath = path.join(currentDir, entry.name);
      const relPath = relativeToRepo(absPath);

      if (entry.isDirectory()) {
        if (root.ignoreDirs.has(entry.name)) {
          continue;
        }
        if (MOCK_DIR_NAMES.has(entry.name)) {
          mockDirs.push(relPath);
        }
        queue.push(absPath);
        continue;
      }

      if (entry.isFile()) {
        files.push({ absPath, relPath });
      }
    }
  }

  return { files, mockDirs: mockDirs.sort() };
}

async function readPackageScripts(packageJsonPath) {
  try {
    const text = await fsp.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(text);
    return Object.entries(pkg.scripts ?? {})
      .map(([name, command]) => ({
        name,
        command,
        kinds: normaliseScriptKinds(name),
      }))
      .filter((script) => script.kinds.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function analyzeRoot(root) {
  const { files, mockDirs } = await walkDirectory(root);
  const liveScripts = await readPackageScripts(root.packageJson);

  const testFiles = [];
  const surfaceFiles = [];
  const explicitLiveFiles = [];
  const stubReferences = [];
  const harnessBlockers = [];
  const scriptKindTotals = createCounter([
    { id: "live" },
    { id: "e2e" },
    { id: "playwright" },
  ]);
  const stubIndicatorTotals = createCounter(STUB_PATTERNS);
  const harnessBlockerTotals = createCounter(HARNESS_BLOCKER_PATTERNS);

  for (const script of liveScripts) {
    for (const kind of script.kinds) {
      scriptKindTotals[kind] += 1;
    }
  }

  for (const file of files) {
    const { absPath, relPath } = file;

    if (TEST_FILE_PATTERN.test(relPath)) {
      testFiles.push(relPath);
    }

    const surfaceFile = isSurfaceFile(root.id, relPath);
    if (surfaceFile) {
      surfaceFiles.push(relPath);
    }

    if (isExplicitLiveFile(relPath)) {
      explicitLiveFiles.push(relPath);
    }

    if (!CONFIG_FILE_PATTERN.test(relPath) && !surfaceFile) {
      continue;
    }

    const text = await fsp.readFile(absPath, "utf8");
    const stubCounts = applyFileAllowances(
      text,
      countMatches(text, STUB_PATTERNS),
    );
    if (hasAnyCount(stubCounts)) {
      stubReferences.push({
        file: relPath,
        counts: stubCounts,
        totalIndicators: sumCounts(stubCounts),
      });
      for (const [id, count] of Object.entries(stubCounts)) {
        stubIndicatorTotals[id] += count;
      }
    }

    const harnessCounts = countMatches(text, HARNESS_BLOCKER_PATTERNS);
    if (hasAnyCount(harnessCounts)) {
      harnessBlockers.push({
        file: relPath,
        counts: harnessCounts,
        totalIndicators: sumCounts(harnessCounts),
      });
      for (const [id, count] of Object.entries(harnessCounts)) {
        harnessBlockerTotals[id] += count;
      }
    }
  }

  surfaceFiles.sort((a, b) => a.localeCompare(b));
  explicitLiveFiles.sort((a, b) => a.localeCompare(b));
  stubReferences.sort((a, b) => {
    return (
      b.totalIndicators - a.totalIndicators || a.file.localeCompare(b.file)
    );
  });
  harnessBlockers.sort((a, b) => {
    return (
      b.totalIndicators - a.totalIndicators || a.file.localeCompare(b.file)
    );
  });

  const warnings = [];
  const violations = [];

  if (mockDirs.length > 0) {
    warnings.push(
      `${root.id}: ${mockDirs.length} mock/fixture directories remain in-tree`,
    );
  }
  if (stubReferences.length > 0) {
    violations.push(
      `${root.id}: ${stubReferences.length} live surface/config files reference stubs or mock helpers`,
    );
  }
  if (root.requireSurfaceFiles && surfaceFiles.length === 0) {
    violations.push(`${root.id}: no live/e2e/playwright surface files found`);
  }
  if (root.requireExplicitLiveFiles && explicitLiveFiles.length === 0) {
    violations.push(`${root.id}: no explicit *.live.* or *.real.* tests found`);
  }
  for (const kind of root.requiredScriptKinds) {
    if ((scriptKindTotals[kind] ?? 0) === 0) {
      violations.push(
        `${root.id}: no package.json test scripts tagged for ${kind}`,
      );
    }
  }
  if (harnessBlockers.length > 0) {
    violations.push(
      `${root.id}: ${harnessBlockers.length} config/setup files still force live harnesses off`,
    );
  }

  return {
    id: root.id,
    totalTestFiles: testFiles.length,
    surfaceFiles: surfaceFiles.length,
    explicitLiveFiles: explicitLiveFiles.length,
    mockDirectories: mockDirs,
    stubReferences,
    harnessBlockers,
    stubIndicatorTotals,
    harnessBlockerTotals,
    scriptKindTotals,
    liveScripts,
    exampleSurfaceFiles: takeExamples(surfaceFiles),
    exampleExplicitLiveFiles: takeExamples(explicitLiveFiles),
    warnings,
    violations,
  };
}

function renderHumanReport(report) {
  const lines = [];
  lines.push("Live Test Surface Audit");
  lines.push("");

  for (const root of report.roots) {
    lines.push(`[${root.id}]`);
    lines.push(
      `tests=${root.totalTestFiles} surface=${root.surfaceFiles} explicit_live=${root.explicitLiveFiles} scripts.live=${root.scriptKindTotals.live} scripts.e2e=${root.scriptKindTotals.e2e} scripts.playwright=${root.scriptKindTotals.playwright} stub_refs=${root.stubReferences.length} harness_blockers=${root.harnessBlockers.length}`,
    );

    if (root.liveScripts.length > 0) {
      lines.push(
        `surface scripts: ${root.liveScripts.map((script) => script.name).join(", ")}`,
      );
    } else {
      lines.push("surface scripts: none");
    }

    if (root.exampleSurfaceFiles.length > 0) {
      lines.push("sample surface files:");
      for (const file of root.exampleSurfaceFiles) {
        lines.push(`  - ${file}`);
      }
    }

    if (root.exampleExplicitLiveFiles.length > 0) {
      lines.push("sample explicit live files:");
      for (const file of root.exampleExplicitLiveFiles) {
        lines.push(`  - ${file}`);
      }
    }

    if (root.stubReferences.length > 0) {
      lines.push("sample stub refs:");
      for (const entry of takeExamples(root.stubReferences)) {
        const indicators = Object.entries(entry.counts)
          .filter(([, count]) => count > 0)
          .map(([id, count]) => `${id}:${count}`)
          .join(", ");
        lines.push(`  - ${entry.file} (${indicators})`);
      }
    }

    if (root.harnessBlockers.length > 0) {
      lines.push("harness blockers:");
      for (const entry of takeExamples(root.harnessBlockers)) {
        const indicators = Object.entries(entry.counts)
          .filter(([, count]) => count > 0)
          .map(([id, count]) => `${id}:${count}`)
          .join(", ");
        lines.push(`  - ${entry.file} (${indicators})`);
      }
    }

    if (root.mockDirectories.length > 0) {
      lines.push("sample mock/fixture dirs:");
      for (const directory of takeExamples(root.mockDirectories)) {
        lines.push(`  - ${directory}`);
      }
    }

    if (root.warnings.length > 0) {
      lines.push("warnings:");
      for (const warning of root.warnings) {
        lines.push(`  - ${warning}`);
      }
    }

    if (root.violations.length > 0) {
      lines.push("violations:");
      for (const violation of root.violations) {
        lines.push(`  - ${violation}`);
      }
    }

    lines.push("");
  }

  lines.push("[totals]");
  lines.push(
    `tests=${report.totals.totalTestFiles} surface=${report.totals.surfaceFiles} explicit_live=${report.totals.explicitLiveFiles} stub_refs=${report.totals.stubReferences} harness_blockers=${report.totals.harnessBlockers}`,
  );
  if (report.warnings.length > 0) {
    lines.push("repo warnings:");
    for (const warning of report.warnings) {
      lines.push(`  - ${warning}`);
    }
  }
  if (report.violations.length > 0) {
    lines.push("repo violations:");
    for (const violation of report.violations) {
      lines.push(`  - ${violation}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

const roots = [];
for (const root of ROOTS) {
  roots.push(await analyzeRoot(root));
}

const totals = roots.reduce(
  (accumulator, root) => {
    accumulator.totalTestFiles += root.totalTestFiles;
    accumulator.surfaceFiles += root.surfaceFiles;
    accumulator.explicitLiveFiles += root.explicitLiveFiles;
    accumulator.stubReferences += root.stubReferences.length;
    accumulator.harnessBlockers += root.harnessBlockers.length;
    return accumulator;
  },
  {
    totalTestFiles: 0,
    surfaceFiles: 0,
    explicitLiveFiles: 0,
    stubReferences: 0,
    harnessBlockers: 0,
  },
);

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot: relativeToRepo(repoRoot) || ".",
  roots,
  totals,
  warnings: roots.flatMap((root) => root.warnings),
  violations: roots.flatMap((root) => root.violations),
};

if (outputJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(renderHumanReport(report));
}

if (failOnViolations && report.violations.length > 0) {
  process.exitCode = 1;
}
