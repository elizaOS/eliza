/**
 * Ensures the credentialed scenario workflow builds the scenario runner's full
 * workspace dependency closure before launching the CLI from a clean checkout.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/live-scenarios.yml", import.meta.url),
);

test("builds the scenario runner dependency closure before the scenario CLI starts", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const buildCommand =
    "node packages/scripts/run-turbo.mjs run build --filter=@elizaos/scenario-runner... --concurrency=8";
  const runStep = "- name: Run EA + connector live scenarios";

  expect(workflow).toContain(buildCommand);
  expect(workflow.indexOf(buildCommand)).toBeLessThan(
    workflow.indexOf(runStep),
  );
  expect(workflow).not.toMatch(
    /package_dirs=\([\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
});

test("runs every live scenario root against workspace source exports", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const sourceConditionEntries = [
    ...workflow.matchAll(/NODE_OPTIONS: "--conditions=eliza-source"/g),
  ];
  expect(sourceConditionEntries).toHaveLength(3);
});
