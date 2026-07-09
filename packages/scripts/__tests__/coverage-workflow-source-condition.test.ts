/**
 * Pins the clean-checkout coverage lane to source workspace exports so changed
 * Bun tests do not depend on prebuilt package artifacts.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/coverage-gate.yml", import.meta.url),
);

test("changed Bun coverage tests use eliza-source workspace exports", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toMatch(
    /bun test --conditions=eliza-source "\$\{changed_tests\[@\]\}" --coverage/,
  );
});
