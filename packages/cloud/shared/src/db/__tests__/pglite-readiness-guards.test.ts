/**
 * Regression guard for PGlite-backed cloud tests that must not green-pass when
 * their in-process database harness fails to initialize. A skipped setup is a
 * broken test environment, so suites may explicitly fail or explicitly skip,
 * but they must never return from every test body with zero assertions.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SHARED_SRC_DIR = join(import.meta.dirname, "..", "..");

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* walkFiles(path);
      continue;
    }
    if (path.endsWith(".test.ts") || path.endsWith(".integration.test.ts")) {
      yield path;
    }
  }
}

describe("PGlite readiness guards", () => {
  test("PGlite-gated cloud shared tests fail or skip observably", () => {
    const offenders: string[] = [];

    for (const path of walkFiles(SHARED_SRC_DIR)) {
      const source = readFileSync(path, "utf8");
      if (!source.includes("pgliteReady")) continue;

      const hasSilentReturn = /if\s*\(!pgliteReady\)\s*return\s*;/u.test(source);
      if (!hasSilentReturn) continue;

      const hasLoudFailure =
        /expect\s*\(\s*pgliteReady\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)/u.test(source) ||
        /if\s*\(!pgliteReady\)\s*throw\b/u.test(source);
      const hasExplicitSkip = /(?:test|it|describe)\.skipIf\s*\(/u.test(source);

      if (!hasLoudFailure && !hasExplicitSkip) {
        offenders.push(relative(SHARED_SRC_DIR, path));
      }
    }

    expect(offenders).toEqual([]);
  });
});
