/**
 * Executes the real server test planner with CI's partition filters to prove
 * that splitting heavy runtime suites retains each package task exactly once.
 */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function plan(filter) {
  const env = { ...process.env, TEST_SCRIPT_FILTER: "^test$" };
  delete env.TEST_PACKAGE_FILTER;
  delete env.TEST_START_AT;
  if (filter !== undefined) env.TEST_PACKAGE_FILTER = filter;
  return JSON.parse(
    execFileSync(
      "node",
      [
        "packages/scripts/run-all-tests.mjs",
        "--lane=server",
        "--no-cloud",
        "--concurrency=3",
        "--require-work",
        "--plan=json",
      ],
      { cwd: root, env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    ),
  );
}

function identities(result) {
  return result.tasks.map(
    (task) => `${task.packageName} (${task.relativeDir})#${task.scriptName}`,
  );
}

test("CI partitions run every selected server task once and keep the agent on its own runner", () => {
  const workflow = Bun.YAML.parse(
    readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"),
  );
  const groups = workflow.jobs.tests_server.strategy.matrix.include.map(
    (partition) => {
      expect(typeof partition.filter).toBe("string");
      const tasks = identities(plan(partition.filter));
      expect(tasks.length).toBeGreaterThan(0);
      return tasks;
    },
  );
  const actual = groups.flat();
  const expected = identities(plan());
  expect(actual.toSorted()).toEqual(expected.toSorted());
  expect(new Set(actual).size).toBe(actual.length);
  const agentTask = expected.find((label) =>
    label.startsWith("@elizaos/agent "),
  );
  expect(agentTask).toBeDefined();
  expect(groups.find((group) => group.includes(agentTask))).toEqual([
    agentTask,
  ]);
});
