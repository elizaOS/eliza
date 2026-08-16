/**
 * Ensures real Scenario E2E API harnesses build the core package exports they
 * resolve before starting local chat or accounts servers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(
  readFileSync(
    new URL("../../../.github/workflows/scenario-pr.yml", import.meta.url),
    "utf8",
  ),
) as Workflow;

function expectCoreBuildBefore(jobName: string, harnessStepName: string): void {
  const steps = workflow.jobs?.[jobName]?.steps ?? [];
  const buildIndexes = steps.flatMap((step, index) =>
    step.name === "Build core exports for real API harness" ? [index] : [],
  );
  const harnessIndex = steps.findIndex((step) => step.name === harnessStepName);

  expect(buildIndexes).toHaveLength(1);
  expect(steps[buildIndexes[0]]?.run).toBe("bun run --cwd packages/core build");
  expect(harnessIndex).toBeGreaterThan(buildIndexes[0]);
}

describe("Scenario E2E real API build ordering (#20363)", () => {
  test("builds core exports before the real local chat pipeline", () => {
    expectCoreBuildBefore(
      "scenario-unit-coverage",
      "Real local chat pipeline (no model key, no llama)",
    );
  });

  test("builds core exports before the real accounts UI API server", () => {
    expectCoreBuildBefore(
      "app-accounts-ui",
      "Accounts UI browser e2e — real AccountList + real accounts routes + real AccountPool",
    );
  });
});
