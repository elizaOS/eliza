import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");
const args = new Set(process.argv.slice(2));
const outputJson = args.has("--json");
const failOnViolations = args.has("--fail-on-violations");

const IGNORE_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);

const SERVER_TEST_PATTERNS = [
  { id: "vi.mock", regex: /\bvi\.mock\s*\(/g },
  { id: "jest.mock", regex: /\bjest\.mock\s*\(/g },
  { id: "mockReq", regex: /\bmockReq\s*\(/g },
  { id: "mockRes", regex: /\bmockRes\s*\(/g },
  { id: "stubGlobal", regex: /\bstubGlobal\s*\(/g },
];

const PACKAGED_TEST_PATTERNS = [
  { id: "startMockApiServer", regex: /\bstartMockApiServer\b/g },
  { id: "mock-api import", regex: /["']\.\/mock-api["']/g },
];

const SURFACES = [
  {
    id: "app-route-tests",
    include: (relPath) =>
      /^eliza\/apps\/[^/]+\/src\/.*routes\.test\.[cm]?[jt]sx?$/.test(relPath),
    patterns: SERVER_TEST_PATTERNS,
  },
  {
    id: "app-service-tests",
    include: (relPath) =>
      /^eliza\/apps\/[^/]+\/src\/services\/.*\.test\.[cm]?[jt]sx?$/.test(
        relPath,
      ),
    patterns: SERVER_TEST_PATTERNS,
  },
  {
    id: "app-core-api-tests",
    include: (relPath) =>
      /^eliza\/packages\/app-core\/src\/api\/.*\.test\.[cm]?[jt]sx?$/.test(
        relPath,
      ),
    patterns: SERVER_TEST_PATTERNS,
  },
  {
    id: "app-core-service-tests",
    include: (relPath) =>
      /^eliza\/packages\/app-core\/src\/services\/.*\.test\.[cm]?[jt]sx?$/.test(
        relPath,
      ),
    patterns: SERVER_TEST_PATTERNS,
  },
  {
    id: "packaged-desktop-specs",
    include: (relPath) =>
      /^apps\/app\/test\/electrobun-packaged\/.*\.e2e\.spec\.ts$/.test(relPath),
    patterns: PACKAGED_TEST_PATTERNS,
  },
];

async function walk(dir) {
  const files = [];
  const queue = [dir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }

    const entries = await fs
      .readdir(currentDir, { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) {
        continue;
      }

      const absPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absPath);
        continue;
      }

      if (entry.isFile()) {
        files.push(absPath);
      }
    }
  }

  return files;
}

function collectMatches(text, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    const found = text.match(pattern.regex);
    if (found?.length) {
      matches.push({ id: pattern.id, count: found.length });
    }
  }
  return matches;
}

const files = await walk(repoRoot);
const violations = [];

for (const absPath of files) {
  const relPath = path.relative(repoRoot, absPath).replaceAll(path.sep, "/");
  const surface = SURFACES.find((candidate) => candidate.include(relPath));
  if (!surface) {
    continue;
  }

  const text = await fs.readFile(absPath, "utf8").catch(() => null);
  if (text === null) {
    continue;
  }

  const matches = collectMatches(text, surface.patterns);
  if (matches.length === 0) {
    continue;
  }

  violations.push({
    file: relPath,
    surface: surface.id,
    matches,
  });
}

if (outputJson) {
  console.log(JSON.stringify({ violations }, null, 2));
} else if (violations.length === 0) {
  console.log("No mocked server/runtime test violations found.");
} else {
  console.log("Mocked server/runtime test violations:");
  for (const violation of violations) {
    const summary = violation.matches
      .map((match) => `${match.id} x${match.count}`)
      .join(", ");
    console.log(`- ${violation.file} [${violation.surface}] ${summary}`);
  }
}

if (failOnViolations && violations.length > 0) {
  process.exitCode = 1;
}
