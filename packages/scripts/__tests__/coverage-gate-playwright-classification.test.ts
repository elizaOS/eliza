/**
 * Pins Android Playwright specs outside the coverage gate's unit-test lanes.
 * Those specs use a package-local fixture, so import-only Playwright detection
 * cannot distinguish them from Bun tests. The classification lives in
 * scripts/security/coverage-changed-files.sh (invoked by coverage-gate.yml),
 * whose shared is_excluded_test() must gate BOTH the bun and vitest lanes.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const classifier = readFileSync(
  resolve(repoRoot, "scripts/security/coverage-changed-files.sh"),
  "utf8",
);
const workflow = readFileSync(
  resolve(repoRoot, ".github/workflows/coverage-gate.yml"),
  "utf8",
);

test("changed-file classifier excludes Android Playwright specs", () => {
  const excludedCase = classifier.match(
    /is_excluded_test\(\)\s*\{[\s\S]*?\n\}/,
  );
  expect(excludedCase?.[0]).toContain(
    "packages/app/test/android/*.android.spec.*",
  );
});

test("both unit lanes apply the exclusion filter", () => {
  // One loop per lane (bun_tests, vitest_tests); each must consult
  // is_excluded_test before emitting a file, or an Android spec slips into
  // that lane's fast unit runner.
  expect(
    classifier.match(/is_excluded_test "\$file" && continue/g),
  ).toHaveLength(2);
});

test("coverage-gate workflow delegates classification to the script", () => {
  expect(workflow).toContain("scripts/security/coverage-changed-files.sh");
});
