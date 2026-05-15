/**
 * lint-no-vi-mocks.mjs
 *
 * Greps every *.test.ts*, *.spec.ts* file under packages/, plugins/, and cloud/
 * for forbidden mock patterns that bypass real mockoon-backed test infrastructure.
 *
 * Forbidden patterns:
 *   vi.mock(   vi.fn(   vi.spyOn(   vi.mocked(
 *   mock.module(
 *   jest.mock(  jest.fn(  jest.spyOn(
 *   as Mock   as MockedFunction
 *
 * Whitelist (never scanned):
 *   test/mocks (any subpath)
 *   node_modules (any depth)
 *   dist (any depth)
 *
 * Exit 1 if violations exceed the checked-in baseline; exit 0 otherwise.
 *
 * NOTE: This lint has a baseline because the repository already contains many
 * legacy mock-based tests. Keep the default lane useful by blocking new debt.
 * Set LINT_NO_VI_MOCKS_STRICT=1 to fail on any remaining baseline violation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const SCAN_DIRS = ["packages", "plugins", "cloud"];

const FORBIDDEN_PATTERNS = [
  /\bvi\.mock\s*\(/,
  /\bvi\.fn\s*\(/,
  /\bvi\.spyOn\s*\(/,
  /\bvi\.mocked\s*\(/,
  /\bmock\.module\s*\(/,
  /\bjest\.mock\s*\(/,
  /\bjest\.fn\s*\(/,
  /\bjest\.spyOn\s*\(/,
  /\bas\s+Mock\b/,
  /\bas\s+MockedFunction\b/,
];

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", "target"]);
const BASELINE_VIOLATIONS = 2918;
const strict = process.env.LINT_NO_VI_MOCKS_STRICT === "1";

// Files/directories to whitelist (relative to repo root, using path.sep)
const WHITELIST_SEGMENTS = [path.join("test", "mocks")];

function isWhitelisted(filePath) {
  const rel = path.relative(repoRoot, filePath);
  return WHITELIST_SEGMENTS.some((seg) => rel.startsWith(seg));
}

function isTestFile(name) {
  return /\.(?:test|spec)\.(?:c|m)?[tj]sx?$/.test(name);
}

/** Recursively walk dir and yield test file paths */
function* walkDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(fullPath);
    } else if (entry.isFile() && isTestFile(entry.name)) {
      yield fullPath;
    }
  }
}

let totalViolations = 0;

for (const scanDir of SCAN_DIRS) {
  const absDir = path.join(repoRoot, scanDir);
  if (!fs.existsSync(absDir)) continue;

  for (const filePath of walkDir(absDir)) {
    if (isWhitelisted(filePath)) continue;

    const relPath = path.relative(repoRoot, filePath);
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(line)) {
          console.log(`${relPath}:${i + 1}: ${line.trim()}`);
          totalViolations++;
          break; // only report one pattern match per line
        }
      }
    }
  }
}

if (strict && totalViolations > 0) {
  console.error(
    `\n[lint-no-vi-mocks] FAIL ${totalViolations} forbidden mock pattern(s) found in strict mode.`,
  );
  console.error(
    `[lint-no-vi-mocks] Replace vi.mock/jest.mock/vi.fn patterns with mockoon-backed real HTTP mocks.`,
  );
  process.exit(1);
} else if (totalViolations > BASELINE_VIOLATIONS) {
  console.error(
    `\n[lint-no-vi-mocks] FAIL ${totalViolations} forbidden mock pattern(s) found; baseline is ${BASELINE_VIOLATIONS}.`,
  );
  console.error(
    `[lint-no-vi-mocks] New mock debt is not allowed. Replace new vi.mock/jest.mock/vi.fn patterns with mockoon-backed real HTTP mocks.`,
  );
  process.exit(1);
} else if (totalViolations > 0) {
  console.log(
    `\n[lint-no-vi-mocks] PASS ${totalViolations}/${BASELINE_VIOLATIONS} baseline forbidden mock pattern(s) remain.`,
  );
  process.exit(0);
} else {
  console.log("[lint-no-vi-mocks] PASS No forbidden mock patterns found.");
  process.exit(0);
}
