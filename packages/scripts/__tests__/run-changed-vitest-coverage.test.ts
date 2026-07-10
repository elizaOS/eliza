/**
 * Verifies changed Vitest files are grouped by their real package config while
 * root-level tests retain the root config and report namespace.
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
