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
