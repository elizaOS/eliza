/**
 * Pins the clean-checkout coverage lane to source workspace exports so changed
 * Bun and Vitest tests do not depend on prebuilt package artifacts.
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

test("changed Vitest coverage tests use package-aware source configuration", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toMatch(
    /node packages\/scripts\/run-changed-vitest-coverage[.]mjs "\$\{changed_tests\[@\]\}"/,
  );
});

test("Node is available before changed-source classification", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const setupNode = workflow.indexOf(
    "- name: Setup Node.js for source classification",
  );
  const determineChanged = workflow.indexOf("- name: Determine changed files");

  expect(setupNode).toBeGreaterThan(-1);
  expect(workflow).toContain(
    "uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  );
  expect(workflow).toContain("node-version: ${{ env.NODE_VERSION }}");
  expect(setupNode).toBeLessThan(determineChanged);
});
