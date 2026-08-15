/**
 * Deterministic, offline unit tests for the orphaned-plugin-test-file
 * detector in ensure-plugin-test-conventions.mjs: the pure orphan/exception
 * computation, the two coverage-fallback predicates (default-config
 * discovery, bun:test authorship), and one real subprocess run of the guard
 * against this repository's actual plugin tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const SCRIPT_URL = new URL(
  "../ensure-plugin-test-conventions.mjs",
  import.meta.url,
);
const SCRIPT = fileURLToPath(SCRIPT_URL);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..", "..");

const {
  computeOrphanedPluginTestFiles,
  hasAutoDiscoveredDefaultConfig,
  isBunTestFile,
} = await import(SCRIPT_URL.href);

describe("computeOrphanedPluginTestFiles", () => {
  test("a test file matched by no config's include and undocumented is reported as an orphan", () => {
    const { orphans, excused } = computeOrphanedPluginTestFiles({
      testFiles: ["plugins/plugin-x/src/forgotten.test.ts"],
      coveredFiles: new Set(),
      exceptions: new Map(),
    });
    expect(orphans).toEqual(["plugins/plugin-x/src/forgotten.test.ts"]);
    expect(excused).toEqual([]);
  });

  test("a file matched by some config's include is never an orphan", () => {
    const { orphans } = computeOrphanedPluginTestFiles({
      testFiles: ["plugins/plugin-x/src/covered.test.ts"],
      coveredFiles: new Set(["plugins/plugin-x/src/covered.test.ts"]),
      exceptions: new Map(),
    });
    expect(orphans).toEqual([]);
  });

  test("a currently-orphaned file with a documented, dated, reasoned exception passes and is excused, not reported", () => {
    const { orphans, excused } = computeOrphanedPluginTestFiles({
      testFiles: ["plugins/plugin-x/src/deferred.test.ts"],
      coveredFiles: new Set(),
      exceptions: new Map([
        [
          "plugins/plugin-x/src/deferred.test.ts",
          "2026-01-05: triaged in #12345, deferred pending sandbox support",
        ],
      ]),
    });
    expect(orphans).toEqual([]);
    expect(excused).toEqual(["plugins/plugin-x/src/deferred.test.ts"]);
  });

  test("an exception naming a file that no longer exists on disk is stale and throws", () => {
    expect(() =>
      computeOrphanedPluginTestFiles({
        testFiles: [],
        coveredFiles: new Set(),
        exceptions: new Map([
          [
            "plugins/plugin-x/src/deleted.test.ts",
            "no longer on disk, remove me",
          ],
        ]),
      }),
    ).toThrow(/stale orphan exception/);
  });

  test("an exception naming a file that is now covered by some config's include is stale and throws", () => {
    expect(() =>
      computeOrphanedPluginTestFiles({
        testFiles: ["plugins/plugin-x/src/now-covered.test.ts"],
        coveredFiles: new Set(["plugins/plugin-x/src/now-covered.test.ts"]),
        exceptions: new Map([
          [
            "plugins/plugin-x/src/now-covered.test.ts",
            "was orphaned, now fixed upstream",
          ],
        ]),
      }),
    ).toThrow(/stale orphan exception/);
  });

  test("an exception with a reason under 12 characters is rejected before the stale check even runs", () => {
    expect(() =>
      computeOrphanedPluginTestFiles({
        testFiles: ["plugins/plugin-x/src/forgotten.test.ts"],
        coveredFiles: new Set(),
        exceptions: new Map([
          ["plugins/plugin-x/src/forgotten.test.ts", "todo"],
        ]),
      }),
    ).toThrow(/durable reason/);
  });

  test("multiple undocumented orphans are all reported together, not just the first", () => {
    const { orphans } = computeOrphanedPluginTestFiles({
      testFiles: ["plugins/plugin-x/a.test.ts", "plugins/plugin-x/b.test.ts"],
      coveredFiles: new Set(),
      exceptions: new Map(),
    });
    expect(orphans.sort()).toEqual(
      ["plugins/plugin-x/a.test.ts", "plugins/plugin-x/b.test.ts"].sort(),
    );
  });
});

describe("hasAutoDiscoveredDefaultConfig", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "eliza-guard-default-config-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("is false for a plugin directory with no config file at all", () => {
    expect(hasAutoDiscoveredDefaultConfig(dir)).toBe(false);
  });

  test("is false when only a named/specialized config exists (plugin-browser's actual shape)", () => {
    writeFileSync(
      path.join(dir, "vitest.real.config.ts"),
      "export default {};\n",
    );
    expect(hasAutoDiscoveredDefaultConfig(dir)).toBe(false);
  });

  test("is true for a plain vitest.config.ts", () => {
    writeFileSync(path.join(dir, "vitest.config.ts"), "export default {};\n");
    expect(hasAutoDiscoveredDefaultConfig(dir)).toBe(true);
  });

  test("is true for a plain vite.config.mjs (vitest's own secondary auto-discovery name)", () => {
    writeFileSync(path.join(dir, "vite.config.mjs"), "export default {};\n");
    expect(hasAutoDiscoveredDefaultConfig(dir)).toBe(true);
  });
});

describe("isBunTestFile", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "eliza-guard-bun-test-file-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("is true for a file importing test primitives from bun:test", () => {
    const file = path.join(dir, "native.test.ts");
    writeFileSync(file, 'import { describe, test, expect } from "bun:test";\n');
    expect(isBunTestFile(file)).toBe(true);
  });

  test("is false for a file importing from vitest", () => {
    const file = path.join(dir, "unit.test.ts");
    writeFileSync(file, 'import { describe, test, expect } from "vitest";\n');
    expect(isBunTestFile(file)).toBe(false);
  });

  test("is false for a file relying on vitest globals with no test-framework import at all", () => {
    const file = path.join(dir, "globals.test.ts");
    writeFileSync(file, "describe('x', () => { test('y', () => {}); });\n");
    expect(isBunTestFile(file)).toBe(false);
  });
});

describe("ensure-plugin-test-conventions.mjs (real subprocess)", () => {
  // ROOT inside the script resolves from the script's own file location
  // (import.meta.dirname), not from cwd, so this suite cannot redirect the
  // CLI at a disposable fixture tree without adding a test-only seam to
  // production code. The CLI's error-formatting path for a real orphan is
  // exercised in effect by every plugin fixed in this change (the guard
  // failed loudly with the real file paths -- see the red/green transcripts)
  // and stays covered at the unit level by computeOrphanedPluginTestFiles
  // above; this test is the regression net that the wiring stays green.
  test("--check passes against this repository's actual plugin tree", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(
        `expected --check to pass; exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(result.status).toBe(0);
  });
});
