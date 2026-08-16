/**
 * Pins the Scenario E2E jobs that execute real application source to a built
 * core runtime so clean `--ignore-scripts` installs cannot resolve missing
 * package exports at test time.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const workflowPath = join(repoRoot, ".github", "workflows", "scenario-pr.yml");

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

function stepIndex(steps: WorkflowStep[], name: string): number {
  return steps.findIndex((step) => step.name === name);
}

describe("Scenario E2E core build contract", () => {
  test("builds core before real local chat and accounts UI consumers", () => {
    const workflow = Bun.YAML.parse(readFileSync(workflowPath, "utf8")) as {
      jobs?: Record<string, WorkflowJob>;
    };

    for (const [jobId, consumerStep] of [
      [
        "scenario-unit-coverage",
        "Real local chat pipeline (no model key, no llama)",
      ],
      [
        "app-accounts-ui",
        "Accounts UI browser e2e — real AccountList + real accounts routes + real AccountPool",
      ],
    ] as const) {
      const steps = workflow.jobs?.[jobId]?.steps ?? [];
      const generatedData = stepIndex(
        steps,
        "Ensure generated shared i18n data",
      );
      const coreBuild = stepIndex(steps, "Build core runtime contract");
      const consumer = stepIndex(steps, consumerStep);

      expect(
        generatedData,
        `${jobId} must generate source prerequisites`,
      ).toBeGreaterThan(-1);
      expect(
        coreBuild,
        `${jobId} must build @elizaos/core exports`,
      ).toBeGreaterThan(generatedData);
      expect(steps[coreBuild]?.run).toBe("bun run build:core");
      expect(
        consumer,
        `${jobId} must retain its real consumer`,
      ).toBeGreaterThan(coreBuild);
    }
  });
});
