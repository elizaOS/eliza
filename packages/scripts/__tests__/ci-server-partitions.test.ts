/**
 * Executes the real server test planner with CI's partition filters to prove
 * that the general partitions and dedicated OS job retain every task once.
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
        "packages/scripts/run-all-tests.ts",
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

test("CI owners run every selected server task once and keep the agent on its own runner", () => {
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
  const osWorkflow = Bun.YAML.parse(
    readFileSync(path.join(root, ".github/workflows/os.yml"), "utf8"),
  );
  const osScripts = JSON.parse(
    readFileSync(path.join(root, "packages/os/package.json"), "utf8"),
  ).scripts;
  // Count the installer only when its complete command chain is owned by CI.
  const osCommands = osWorkflow.jobs.verify.steps.flatMap((step) =>
    (step.run ?? "").split("\n").map((command) => command.trim()),
  );
  expect(osCommands).toContain("bun run verify:portable");
  expect(osScripts["verify:portable"].split(" && ")).toContain("bun run test");
  expect(osScripts.test.split(" && ")).toContain(
    "bun run --cwd linux/installer test",
  );
  const installerTasks = identities(
    plan(
      "^@elizaos/linux-installer-plan \\(packages/os/linux/installer\\)#test$",
    ),
  );
  expect(installerTasks).toHaveLength(1);
  const actual = [...groups.flat(), ...installerTasks];
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
