/**
 * Pins the credentialed scenario workflow's clean-checkout build prerequisites
 * to every dist-exported package imported before scenario selection, and the
 * source-export conditions each live lane runs under.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/live-scenarios.yml", import.meta.url),
);
const agentPackagePath = fileURLToPath(
  new URL("../../agent/package.json", import.meta.url),
);

test("builds the dist-exported runtime packages before the scenario CLI starts", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const runStep = "- name: Run EA + connector live scenarios";

  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-local-inference[\s\S]*plugins\/plugin-app-control[\s\S]*plugins\/plugin-health[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(workflow).toMatch(
    /package_dirs=\([\s\S]*plugins\/plugin-blocker[\s\S]*\)[\s\S]*for package_dir in "\$\{package_dirs\[@\]\}"/,
  );
  expect(workflow.indexOf("package_dirs=(")).toBeLessThan(
    workflow.indexOf(runStep),
  );
});

test("runs every live scenario root against workspace source exports", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const sourceConditionEntries = [
    ...workflow.matchAll(/NODE_OPTIONS: "--conditions=eliza-source"/g),
  ];
  expect(sourceConditionEntries).toHaveLength(3);
});

test("includes the dynamically loaded app manager in the agent build graph", () => {
  const packageJson = JSON.parse(readFileSync(agentPackagePath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  expect(packageJson.dependencies?.["@elizaos/plugin-app-manager"]).toBe(
    "workspace:*",
  );
});
