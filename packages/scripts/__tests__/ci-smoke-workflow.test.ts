/**
 * CI smoke routing contracts.
 *
 * The root zero-key lane is intentionally scoped to runtime/app/plugin E2E.
 * Homepage Linux visual baselines are still enforced by the homepage deploy
 * workflow, but keeping them out of the root smoke lane prevents unrelated
 * core changes from burning the two-hour smoke timeout on marketing diffs.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowSource = readFileSync(
  join(repoRoot, ".github/workflows/ci.yml"),
  "utf8",
);
const workflow = Bun.YAML.parse(workflowSource) as Workflow;

function requireStep(jobId: string, stepName: string): WorkflowStep {
  const step = workflow.jobs?.[jobId]?.steps?.find(
    (candidate) => candidate.name === stepName,
  );
  if (!step) throw new Error(`Missing workflow step: ${jobId}/${stepName}`);
  return step;
}

describe("CI smoke workflow", () => {
  test("keeps homepage visual baselines out of root zero-key smoke", () => {
    const step = requireStep("smoke", "Deterministic end-to-end smoke");

    expect(step.run).toBe("bun run test:e2e");
    expect(step.env?.TEST_PACKAGE_FILTER).toBe(
      "^(?!.*\\(packages/homepage\\)#).*",
    );
  });
});
