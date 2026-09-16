/**
 * Deterministic, offline unit tests for the orphaned-plugin-test-file
 * detector in ensure-plugin-test-conventions.mjs: the pure orphan/exception
 * computation, coverage fallback, nested-repository ownership, and one real
 * subprocess run of the guard against this repository's actual plugin tree.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  findPackageJsonFiles,
  hasAutoDiscoveredDefaultConfig,
  inspectPluginTestCoverage,
  isBunTestFile,
  nativeTestFileIsRegistered,
  readGitSubmodulePaths,
  resolveConfigIncludedFiles,
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

  test("is true for a file importing test primitives from node:test", () => {
    const file = path.join(dir, "harness.test.mjs");
    writeFileSync(file, 'import test from "node:test";\n');
    expect(isBunTestFile(file)).toBe(true);
  });

  test("is false for a file importing from vitest, including .mjs suites", () => {
    const file = path.join(dir, "unit.test.mjs");
    writeFileSync(file, 'import { describe, test, expect } from "vitest";\n');
    expect(isBunTestFile(file)).toBe(false);
  });

  test("is false for a file relying on vitest globals with no test-framework import at all", () => {
    const file = path.join(dir, "globals.test.ts");
    writeFileSync(file, "describe('x', () => { test('y', () => {}); });\n");
    expect(isBunTestFile(file)).toBe(false);
  });
});

describe("effective runner coverage", () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "eliza-guard-effective-coverage-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("subtracts a config's effective excludes from its includes", async () => {
    const included = path.join(dir, "included.test.ts");
    const excluded = path.join(dir, "excluded.test.ts");
    writeFileSync(included, "export {};\n");
    writeFileSync(excluded, "export {};\n");
    const config = path.join(dir, "vitest.config.mjs");
    writeFileSync(
      config,
      'export default { test: { include: ["**/*.test.ts"], exclude: ["excluded.test.ts"] } };\n',
    );

    expect(await resolveConfigIncludedFiles(config)).toEqual([included]);
  });

  test("does not treat a native test import as coverage without a runner", () => {
    expect(
      nativeTestFileIsRegistered(
        "src/forgotten.test.ts",
        { scripts: { test: "vitest run" } },
        "plugins/plugin-fixture",
      ),
    ).toBe(false);
  });

  test("recognizes direct native runner roots and rejects sibling files", () => {
    const packageJson = { scripts: { test: "bun test __tests__/unit" } };
    expect(
      nativeTestFileIsRegistered(
        "__tests__/unit/covered.test.ts",
        packageJson,
        "plugins/plugin-fixture",
      ),
    ).toBe(true);
    expect(
      nativeTestFileIsRegistered(
        "src/forgotten.test.ts",
        packageJson,
        "plugins/plugin-fixture",
      ),
    ).toBe(false);
  });

  test("a configless plugin test stays orphaned until a real default runner is registered", async () => {
    const testFile = path.join(dir, "src", "forgotten.test.ts");
    mkdirSync(path.dirname(testFile), { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: {} }),
    );
    writeFileSync(testFile, 'import { test } from "vitest";\n');

    const before = await inspectPluginTestCoverage(dir);
    expect(before.testFiles).toEqual(["src/forgotten.test.ts"]);
    expect(before.coveredFiles.has("src/forgotten.test.ts")).toBe(false);

    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    const after = await inspectPluginTestCoverage(dir);
    expect(after.coveredFiles.has("src/forgotten.test.ts")).toBe(true);
  });

  test("an unconditional exclude remains orphaned in the integrated plugin scan", async () => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    writeFileSync(path.join(dir, "excluded.test.ts"), "export {};\n");
    writeFileSync(
      path.join(dir, "vitest.config.mjs"),
      'export default { test: { include: ["**/*.test.ts"], exclude: ["excluded.test.ts"] } };\n',
    );

    const inspection = await inspectPluginTestCoverage(dir);
    expect(inspection.coveredFiles.has("excluded.test.ts")).toBe(false);
  });

  test("does not inventory tests owned by a nested repository", async () => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    writeFileSync(path.join(dir, "owned.test.ts"), "export {};\n");
    const vendored = path.join(dir, "native", "upstream");
    mkdirSync(vendored, { recursive: true });
    writeFileSync(path.join(vendored, ".git"), "gitdir: elsewhere\n");
    writeFileSync(path.join(vendored, "upstream.test.ts"), "export {};\n");

    const inspection = await inspectPluginTestCoverage(dir, [vendored]);
    expect(inspection.testFiles).toEqual(["owned.test.ts"]);
    expect(inspection.coveredFiles).toEqual(new Set(["owned.test.ts"]));
  });

  test("does not rewrite package manifests owned by a nested repository", () => {
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({}));
    const vendored = path.join(dir, "native", "upstream");
    mkdirSync(vendored, { recursive: true });
    writeFileSync(path.join(vendored, ".git"), "gitdir: elsewhere\n");
    writeFileSync(path.join(vendored, "package.json"), JSON.stringify({}));

    expect(
      findPackageJsonFiles(dir, [], [vendored]).map((file) =>
        path.relative(dir, file),
      ),
    ).toEqual(["package.json"]);
  });

  test("reads nested repository ownership from .gitmodules", () => {
    writeFileSync(
      path.join(dir, ".gitmodules"),
      [
        '[submodule "native/upstream"]',
        "\tpath = native/upstream",
        "\turl = https://example.invalid/upstream.git",
        "",
      ].join("\n"),
    );

    expect(readGitSubmodulePaths(dir)).toEqual([
      path.join(dir, "native", "upstream"),
    ]);
  });

  test("does not count an unregistered named Vitest config", async () => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    writeFileSync(path.join(dir, "named-only.test.ts"), "export {};\n");
    writeFileSync(
      path.join(dir, "vitest.config.mjs"),
      'export default { test: { include: ["src/**/*.test.ts"] } };\n',
    );
    writeFileSync(
      path.join(dir, "vitest.audit.config.mjs"),
      'export default { test: { include: ["named-only.test.ts"] } };\n',
    );

    const inspection = await inspectPluginTestCoverage(dir);
    expect(inspection.coveredFiles.has("named-only.test.ts")).toBe(false);
  });

  test("counts a named Vitest config only after a package script registers it", async () => {
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        scripts: { audit: "vitest run --config vitest.audit.config.mjs" },
      }),
    );
    writeFileSync(path.join(dir, "audited.test.ts"), "export {};\n");
    writeFileSync(
      path.join(dir, "vitest.audit.config.mjs"),
      'export default { test: { include: ["audited.test.ts"] } };\n',
    );

    const inspection = await inspectPluginTestCoverage(dir);
    expect(inspection.coveredFiles.has("audited.test.ts")).toBe(true);
  });
});

describe("production orphan scan surface", () => {
  test("inventories JS suites and applies config excludes", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain("**/*.test.{ts,tsx,mts,cts,js,mjs,cjs}");
    expect(source).toContain("node:test");
    expect(source).toContain("...exclude");
    expect(source).not.toMatch(/if \(configPaths\.length === 0\) continue;/);
  });

  test("the library can be imported without launching the repository scan", () => {
    const result = spawnSync(
      process.execPath,
      ["-e", `await import(${JSON.stringify(SCRIPT_URL.href)})`],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
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
  }, 30_000);
});
