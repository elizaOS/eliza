/** Guards the split between the focused cloud stack gate and the full nightly suite. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

function readWorkflow(path: string): Workflow {
  const source = readFileSync(new URL(path, repoRoot), "utf8");
  return Bun.YAML.parse(source) as Workflow;
}

function runStep(workflow: Workflow, job: string, name: string): string {
  const run = workflow.jobs?.[job]?.steps?.find(
    (step) => step.name === name,
  )?.run;
  if (!run) throw new Error(`Missing ${job} workflow step: ${name}`);
  return run;
}

describe("cloud stack e2e workflow split", () => {
  test("the develop gate selects exactly named funnel files", () => {
    const run = runStep(
      readWorkflow(".github/workflows/cloud-tests.yml"),
      "stack-e2e-tests",
      "Run shared-to-dedicated funnel specs",
    );

    expect(run).toContain("'(^|/)provision\\.spec\\.ts$'");
    expect(run).not.toContain("\n          provision.spec.ts");
    expect(run.match(/\\\.spec\\\.ts\$/g)).toHaveLength(5);
  });

  test("the nightly lane runs the unfiltered suite", () => {
    const run = runStep(
      readWorkflow(".github/workflows/monetized-loop-nightly.yml"),
      "monetized-loop",
      "Run full cloud stack e2e suite",
    );

    expect(run.trim()).toBe("bun run cloud:e2e");
  });
});
