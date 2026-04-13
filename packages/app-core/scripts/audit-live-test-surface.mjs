import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
const outputJson = args.has("--json");
const failOnViolations = args.has("--fail-on-violations");

const IGNORE_DIRS = new Set([
  ".git",
  ".hg",
  ".next",
  ".turbo",
  ".yarn",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "test-results",
]);

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_SUPPORT_FILE_NAMES = new Set([
  "test-utils.ts",
  "test-utils.tsx",
  "test-helpers.ts",
  "test-helpers.tsx",
  "route-test-helpers.ts",
  "route-test-helpers.tsx",
  "test-preload.ts",
  "test-preload.tsx",
  "preload.ts",
  "preload.tsx",
]);
const CONFIG_FILE_PATTERN =
  /(?:^|\/)(?:package\.json|vitest(?:\.[^/]+)?\.config\.[cm]?[jt]s|playwright(?:\.[^/]+)?\.config\.[cm]?[jt]s|bunfig\.toml|test\/setup\.[cm]?[jt]s)$/;
const MOCK_DIR_NAMES = new Set([
  "__mocks__",
  "__fixtures__",
  "fixtures",
  "mocks",
]);

const ROOTS = [
  {
    id: "main",
    dir: repoRoot,
    ignoreDirs: new Set([...IGNORE_DIRS, "eliza"]),
    packageJson: path.join(repoRoot, "package.json"),
  },
  {
    id: "cloud",
    dir: path.join(repoRoot, "eliza", "cloud"),
    ignoreDirs: new Set([...IGNORE_DIRS, "examples"]),
    packageJson: path.join(repoRoot, "eliza", "cloud", "package.json"),
  },
  {
    id: "eliza",
    dir: path.join(repoRoot, "eliza"),
    ignoreDirs: new Set([...IGNORE_DIRS, "examples"]),
    packageJson: path.join(repoRoot, "eliza", "package.json"),
  },
];

const MOCK_PATTERNS = [
  { id: "bun.mock", regex: /(?<![\w.])mock\s*\(/g },
  { id: "bun.mock.module", regex: /\bmock\.module\s*\(/g },
  { id: "bun.spyOn", regex: /\bspyOn\s*\(/g },
  { id: "vi.mock", regex: /\bvi\.mock\s*\(/g },
  { id: "jest.mock", regex: /\bjest\.mock\s*\(/g },
  { id: "vi.fn", regex: /\bvi\.fn\s*\(/g },
  { id: "jest.fn", regex: /\bjest\.fn\s*\(/g },
  { id: "vi.spyOn", regex: /\bvi\.spyOn\s*\(/g },
  { id: "jest.spyOn", regex: /\bjest\.spyOn\s*\(/g },
  { id: "vi.stubGlobal", regex: /\bvi\.stubGlobal\s*\(/g },
  { id: "vi.stubEnv", regex: /\bvi\.stubEnv\s*\(/g },
  { id: "sinon.stub", regex: /\bsinon\.stub\s*\(/g },
  { id: "nock", regex: /\bnock\s*\(/g },
  { id: "msw", regex: /\b(?:setupServer|setupWorker)\s*\(/g },
];

const STUB_PATTERNS = [
  { id: "test/stubs", regex: /test\/stubs/g },
  { id: "__mocks__", regex: /__mocks__/g },
  { id: "createMockStorage", regex: /\bcreateMockStorage\b/g },
  { id: "installCanvasMocks", regex: /\binstallCanvasMocks\b/g },
  { id: "installMediaElementMocks", regex: /\binstallMediaElementMocks\b/g },
  { id: "plugin-stub", regex: /plugin-stub\.mjs/g },
  { id: "empty-module", regex: /empty-module\.mjs/g },
  { id: "plugin-telegram-module", regex: /plugin-telegram-module\.ts/g },
];

const HARNESS_BLOCKER_PATTERNS = [
  { id: "MILADY_LIVE_TEST=0", regex: /MILADY_LIVE_TEST\s*=\s*["']0["']/g },
  { id: "ELIZA_LIVE_TEST=0", regex: /ELIZA_LIVE_TEST\s*=\s*["']0["']/g },
];

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

function isLiveTestFile(rootId, relPath) {
  const fileName = path.basename(relPath);
  if (
    [
      ".live.test.",
      "-live.test.",
      ".live.e2e.test.",
      "-live.e2e.test.",
      ".real.test.",
      "-real.test.",
      ".real.e2e.test.",
      "-real.e2e.test.",
    ].some((marker) => fileName.includes(marker))
  ) {
    return true;
  }

  if (
    rootId === "cloud" &&
    relPath.startsWith("eliza/cloud/packages/tests/e2e/")
  ) {
    return true;
  }

  return false;
}

function isTestSupportFile(relPath) {
  if (TEST_FILE_PATTERN.test(relPath)) {
    return false;
  }

  const fileName = path.basename(relPath);
  if (!TEST_SUPPORT_FILE_NAMES.has(fileName)) {
    return false;
  }

  return /(?:^|\/)(?:__tests__|tests?|test-support)\//.test(relPath);
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

function takeExamples(items, limit = 8) {
  return items.slice(0, limit);
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
      entries = await fs.readdir(currentDir, { withFileTypes: true });
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
    const text = await fs.readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(text);
    return Object.entries(pkg.scripts ?? {})
      .filter(
        ([name]) => name.includes("test:live") || name.includes("test:real"),
      )
      .map(([name, command]) => ({ name, command }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

async function analyzeRoot(root) {
  const { files, mockDirs } = await walkDirectory(root);
  const liveScripts = await readPackageScripts(root.packageJson);

  const testFiles = [];
  const liveFiles = [];
  const mockedFiles = [];
  const mockedSupportFiles = [];
  const configStubRefs = [];
  const harnessBlockers = [];
  const mockIndicatorTotals = createCounter(MOCK_PATTERNS);
  const supportMockIndicatorTotals = createCounter(MOCK_PATTERNS);
  const stubIndicatorTotals = createCounter(STUB_PATTERNS);
  const harnessBlockerTotals = createCounter(HARNESS_BLOCKER_PATTERNS);

  for (const file of files) {
    const { absPath, relPath } = file;
    if (TEST_FILE_PATTERN.test(relPath)) {
      testFiles.push(relPath);
      if (isLiveTestFile(root.id, relPath)) {
        liveFiles.push(relPath);
      }

      const text = await fs.readFile(absPath, "utf8");
      const counts = countMatches(text, MOCK_PATTERNS);
      if (hasAnyCount(counts)) {
        mockedFiles.push({
          file: relPath,
          counts,
          totalIndicators: sumCounts(counts),
        });
        for (const [id, count] of Object.entries(counts)) {
          mockIndicatorTotals[id] += count;
        }
      }
      continue;
    }

    if (isTestSupportFile(relPath)) {
      const text = await fs.readFile(absPath, "utf8");
      const counts = countMatches(text, MOCK_PATTERNS);
      if (hasAnyCount(counts)) {
        mockedSupportFiles.push({
          file: relPath,
          counts,
          totalIndicators: sumCounts(counts),
        });
        for (const [id, count] of Object.entries(counts)) {
          supportMockIndicatorTotals[id] += count;
        }
      }
      continue;
    }

    if (!CONFIG_FILE_PATTERN.test(relPath)) {
      continue;
    }

    const text = await fs.readFile(absPath, "utf8");
    const stubCounts = countMatches(text, STUB_PATTERNS);
    if (hasAnyCount(stubCounts)) {
      configStubRefs.push({
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

  mockedFiles.sort((a, b) => {
    return (
      b.totalIndicators - a.totalIndicators || a.file.localeCompare(b.file)
    );
  });
  mockedSupportFiles.sort((a, b) => {
    return (
      b.totalIndicators - a.totalIndicators || a.file.localeCompare(b.file)
    );
  });
  configStubRefs.sort((a, b) => {
    return (
      b.totalIndicators - a.totalIndicators || a.file.localeCompare(b.file)
    );
  });
  harnessBlockers.sort((a, b) => {
    return (
      b.totalIndicators - a.totalIndicators || a.file.localeCompare(b.file)
    );
  });

  const nonLiveTestCount = testFiles.length - liveFiles.length;
  const violations = [];

  if (mockedFiles.length > 0) {
    violations.push(
      `${root.id}: ${mockedFiles.length} test files use explicit mock APIs`,
    );
  }
  if (mockedSupportFiles.length > 0) {
    violations.push(
      `${root.id}: ${mockedSupportFiles.length} test support files use explicit mock APIs`,
    );
  }
  if (configStubRefs.length > 0) {
    violations.push(
      `${root.id}: ${configStubRefs.length} config/setup files reference stubs or mock helpers`,
    );
  }
  if (mockDirs.length > 0) {
    violations.push(
      `${root.id}: ${mockDirs.length} mock/fixture directories remain in-tree`,
    );
  }
  if (harnessBlockers.length > 0) {
    violations.push(
      `${root.id}: ${harnessBlockers.length} harness files still force live mode off`,
    );
  }
  if (liveFiles.length === 0) {
    violations.push(`${root.id}: no live/real test files found`);
  }

  return {
    id: root.id,
    totalTestFiles: testFiles.length,
    liveTestFiles: liveFiles.length,
    nonLiveTestFiles: nonLiveTestCount,
    mockedTestFiles: mockedFiles.length,
    mockedSupportFiles: mockedSupportFiles.length,
    mockDirectories: mockDirs,
    configStubReferences: configStubRefs,
    harnessBlockers,
    mockIndicatorTotals,
    supportMockIndicatorTotals,
    stubIndicatorTotals,
    harnessBlockerTotals,
    liveScripts,
    exampleLiveFiles: takeExamples(liveFiles),
    exampleMockedFiles: takeExamples(mockedFiles),
    exampleMockedSupportFiles: takeExamples(mockedSupportFiles),
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
      `tests=${root.totalTestFiles} live=${root.liveTestFiles} non_live=${root.nonLiveTestFiles} mocked=${root.mockedTestFiles} mock_dirs=${root.mockDirectories.length} stub_refs=${root.configStubReferences.length} harness_blockers=${root.harnessBlockers.length}`,
    );

    if (root.liveScripts.length > 0) {
      lines.push(
        `live scripts: ${root.liveScripts.map((script) => script.name).join(", ")}`,
      );
    } else {
      lines.push("live scripts: none");
    }

    if (root.exampleLiveFiles.length > 0) {
      lines.push("sample live files:");
      for (const file of root.exampleLiveFiles) {
        lines.push(`  - ${file}`);
      }
    }

    if (root.exampleMockedFiles.length > 0) {
      lines.push("sample mocked files:");
      for (const entry of root.exampleMockedFiles) {
        const indicators = Object.entries(entry.counts)
          .filter(([, count]) => count > 0)
          .map(([id, count]) => `${id}:${count}`)
          .join(", ");
        lines.push(`  - ${entry.file} (${indicators})`);
      }
    }

    if (root.exampleMockedSupportFiles.length > 0) {
      lines.push("sample mocked support files:");
      for (const entry of root.exampleMockedSupportFiles) {
        const indicators = Object.entries(entry.counts)
          .filter(([, count]) => count > 0)
          .map(([id, count]) => `${id}:${count}`)
          .join(", ");
        lines.push(`  - ${entry.file} (${indicators})`);
      }
    }

    if (root.configStubReferences.length > 0) {
      lines.push("sample stub/config refs:");
      for (const entry of takeExamples(root.configStubReferences)) {
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
    `tests=${report.totals.totalTestFiles} live=${report.totals.liveTestFiles} non_live=${report.totals.nonLiveTestFiles} mocked=${report.totals.mockedTestFiles} mocked_support=${report.totals.mockedSupportFiles} mock_dirs=${report.totals.mockDirectories} stub_refs=${report.totals.configStubReferences} harness_blockers=${report.totals.harnessBlockers}`,
  );
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
    accumulator.liveTestFiles += root.liveTestFiles;
    accumulator.nonLiveTestFiles += root.nonLiveTestFiles;
    accumulator.mockedTestFiles += root.mockedTestFiles;
    accumulator.mockedSupportFiles += root.mockedSupportFiles;
    accumulator.mockDirectories += root.mockDirectories.length;
    accumulator.configStubReferences += root.configStubReferences.length;
    accumulator.harnessBlockers += root.harnessBlockers.length;
    return accumulator;
  },
  {
    totalTestFiles: 0,
    liveTestFiles: 0,
    nonLiveTestFiles: 0,
    mockedTestFiles: 0,
    mockedSupportFiles: 0,
    mockDirectories: 0,
    configStubReferences: 0,
    harnessBlockers: 0,
  },
);

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot: relativeToRepo(repoRoot) || ".",
  roots,
  totals,
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
