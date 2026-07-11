/**
 * Verifies changed Vitest files are grouped by their real package config while
 * root-level tests retain the root config and report namespace, harness tests
 * prefer the vitest.harness.config.ts convention, and groups run from the
 * owning package directory (nested configs declare cwd-relative includes).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  findNearestPackageDir,
  findNearestVitestConfig,
  groupChangedVitestTests,
  mergeLcovReports,
  normalizeLcovReport,
} from "../run-changed-vitest-coverage.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "changed-vitest-"));
  roots.push(root);
  const packageDir = path.join(root, "packages", "feature");
  const nestedDir = path.join(packageDir, "src", "nested");
  mkdirSync(nestedDir, { recursive: true });
  writeFileSync(path.join(root, "vitest.config.ts"), "export default {};");
  writeFileSync(
    path.join(packageDir, "vitest.config.ts"),
    "export default {};",
  );
  writeFileSync(path.join(root, "root.test.ts"), "");
  writeFileSync(path.join(nestedDir, "feature.test.ts"), "");
  return root;
}

describe("changed Vitest coverage grouping", () => {
  test("uses the nearest package config and an isolated report directory", () => {
    const root = fixture();
    const config = findNearestVitestConfig(
      root,
      "packages/feature/src/nested/feature.test.ts",
    );
    expect(config).toBe(path.join(root, "packages/feature/vitest.config.ts"));

    const groups = groupChangedVitestTests(root, [
      "packages/feature/src/nested/feature.test.ts",
      "root.test.ts",
    ]);
    expect(groups).toHaveLength(2);
    expect(
      groups.map((group) => path.relative(root, group.reportDir)).sort(),
    ).toEqual(["coverage/vitest/packages-feature", "coverage/vitest/root"]);
    expect(groups.flatMap((group) => group.tests)).toEqual(
      expect.arrayContaining([
        path.join(root, "root.test.ts"),
        path.join(root, "packages/feature/src/nested/feature.test.ts"),
      ]),
    );
  });

  test("prefers vitest.harness.config.ts for *.harness.test.ts files", () => {
    // The plain package config deliberately excludes harness tests (they need
    // the workspace source-alias set), so grouping one there exits "no test
    // files found" — the config preference is what keeps the lane green.
    const root = fixture();
    const packageDir = path.join(root, "packages", "feature");
    writeFileSync(
      path.join(packageDir, "vitest.harness.config.ts"),
      "export default {};",
    );
    const testsDir = path.join(packageDir, "__tests__");
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(path.join(testsDir, "loop.harness.test.ts"), "");
    writeFileSync(path.join(testsDir, "plain.test.ts"), "");

    const groups = groupChangedVitestTests(root, [
      "packages/feature/__tests__/loop.harness.test.ts",
      "packages/feature/__tests__/plain.test.ts",
    ]);
    expect(groups).toHaveLength(2);
    expect(
      groups.map((group) => path.relative(root, group.configPath)).sort(),
    ).toEqual([
      path.join("packages/feature", "vitest.config.ts"),
      path.join("packages/feature", "vitest.harness.config.ts"),
    ]);
    // Same directory, two configs: the harness group's report slug must not
    // clobber the default group's.
    expect(
      groups.map((group) => path.relative(root, group.reportDir)).sort(),
    ).toEqual([
      "coverage/vitest/packages-feature",
      "coverage/vitest/packages-feature-vitest.harness.config",
    ]);
  });

  test("runs a nested config from the owning package directory", () => {
    // Mirrors packages/test/harness/vitest.config.ts: the config sits below
    // the package root and its include patterns resolve against the package
    // script's cwd (the package root), not the config's directory.
    const root = fixture();
    const packageDir = path.join(root, "packages", "feature");
    const nestedConfigDir = path.join(packageDir, "harness");
    const nestedTestsDir = path.join(nestedConfigDir, "__tests__");
    mkdirSync(nestedTestsDir, { recursive: true });
    writeFileSync(path.join(packageDir, "package.json"), "{}");
    writeFileSync(
      path.join(nestedConfigDir, "vitest.config.ts"),
      "export default {};",
    );
    writeFileSync(path.join(nestedTestsDir, "loop.test.ts"), "");

    const groups = groupChangedVitestTests(root, [
      "packages/feature/harness/__tests__/loop.test.ts",
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].configDir).toBe(nestedConfigDir);
    expect(groups[0].packageDir).toBe(packageDir);
  });

  test("falls back to the repository root when no package.json owns the config", () => {
    const root = fixture();
    expect(findNearestPackageDir(root, path.join(root, "packages"))).toBe(root);
  });

  test("rejects a changed test outside the repository", () => {
    const root = fixture();
    expect(() => findNearestVitestConfig(root, "../outside.test.ts")).toThrow(
      "escapes the repository",
    );
  });

  test("union-merges per-group LCOV reports so any-group coverage counts once per file", () => {
    // The gate latches a failure on EVERY below-threshold occurrence of a
    // changed file; a group that merely LOADED a file must not mask the group
    // that exercised it.
    const root = fixture();
    const reportA = path.join(root, "coverage", "vitest", "a");
    const reportB = path.join(root, "coverage", "vitest", "b");
    mkdirSync(reportA, { recursive: true });
    mkdirSync(reportB, { recursive: true });
    writeFileSync(
      path.join(reportA, "lcov.info"),
      [
        "TN:",
        "SF:packages/feature/src/covered.ts",
        "DA:1,1",
        "DA:2,0",
        "DA:3,0",
        "LF:3",
        "LH:1",
        "end_of_record",
        "SF:packages/feature/src/only-a.ts",
        "DA:1,1",
        "LF:1",
        "LH:1",
        "end_of_record",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(reportB, "lcov.info"),
      [
        "TN:",
        "SF:packages/feature/src/covered.ts",
        "DA:1,0",
        "DA:2,5",
        "DA:4,2",
        "LF:3",
        "LH:2",
        "end_of_record",
        "",
      ].join("\n"),
    );

    const mergedPath = path.join(root, "coverage", "vitest", "lcov.info");
    mergeLcovReports(
      [
        path.join(reportA, "lcov.info"),
        path.join(reportB, "lcov.info"),
        path.join(root, "coverage", "vitest", "absent", "lcov.info"),
      ],
      mergedPath,
    );

    const merged = readFileSync(mergedPath, "utf8");
    // covered.ts: union of lines 1-4; hits are per-line maxima → 3 of 4 hit.
    expect(merged).toContain(
      [
        "SF:packages/feature/src/covered.ts",
        "DA:1,1",
        "DA:2,5",
        "DA:3,0",
        "DA:4,2",
        "LF:4",
        "LH:3",
        "end_of_record",
      ].join("\n"),
    );
    // A file present in only one group is preserved as-is.
    expect(merged).toContain(
      ["SF:packages/feature/src/only-a.ts", "DA:1,1", "LF:1", "LH:1"].join(
        "\n",
      ),
    );
  });

  test("normalizes package-relative LCOV source paths to repository paths", () => {
    const root = fixture();
    const packageDir = path.join(root, "packages", "feature");
    const reportDir = path.join(root, "coverage", "vitest", "feature");
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(packageDir, "src", "covered.ts"), "export {};\n");
    writeFileSync(
      path.join(reportDir, "lcov.info"),
      "TN:\nSF:src/covered.ts\nLF:1\nLH:1\nend_of_record\n",
    );

    normalizeLcovReport(root, packageDir, reportDir);

    expect(readFileSync(path.join(reportDir, "lcov.info"), "utf8")).toContain(
      "SF:packages/feature/src/covered.ts",
    );
  });
});
