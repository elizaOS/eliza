/**
 * Pins Android Playwright specs outside the unit-coverage runners. Those specs
 * use a package-local fixture, so import-only Playwright detection cannot
 * distinguish them from Bun tests.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(
  resolve(import.meta.dir, "../../../.github/workflows/coverage-gate.yml"),
  "utf8",
);

test("coverage gate excludes Android Playwright specs from both unit runners", () => {
  expect(
    workflow.match(/packages\/app\/test\/android\/\*\.android\.spec\.\*/g),
  ).toHaveLength(2);
});
