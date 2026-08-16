/**
 * Guards the Discord gateway workflow's package-build prerequisites using its
 * parsed job graph, so source-only workspace installs cannot mask missing dist.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface WorkflowStep {
  name?: string;
  run?: string;
  "working-directory"?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const repoRoot = new URL("../../../", import.meta.url);
const workflow = Bun.YAML.parse(
  readFileSync(
    new URL(".github/workflows/cloud-gateway-discord.yml", repoRoot),
    "utf8",
  ),
) as Workflow;

describe("Cloud Gateway Discord workflow", () => {
  test("builds shared exports before gateway service tests import them", () => {
    const steps = workflow.jobs?.test?.steps ?? [];
    const buildIndex = steps.findIndex(
      (step) => step.name === "Build shared runtime contract",
    );
    const serviceTestIndex = steps.findIndex(
      (step) => step.name === "Run service tests",
    );

    expect(buildIndex).toBeGreaterThan(-1);
    expect(serviceTestIndex).toBeGreaterThan(buildIndex);
    expect(steps[buildIndex]).toMatchObject({
      run: "bun run build",
      "working-directory": "packages/shared",
    });
  });
});
