/**
 * Pins the credentialed scenario workflow's clean-checkout build prerequisites
 * to every dist-exported package imported before scenario selection.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/live-scenarios.yml", import.meta.url),
);

test("builds the local-inference voice-workbench export before the scenario CLI starts", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-local-inference[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
});

test("builds the blocker engine imported by personal-assistant scenarios", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-blocker[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
});
