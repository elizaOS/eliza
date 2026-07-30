/**
 * Static contracts keep the training smoke's cache work inside its CI budget.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface WorkflowStep {
  name?: string;
  with?: Record<string, string | boolean>;
}

interface Workflow {
  jobs?: {
    "cpu-smoke"?: {
      steps?: WorkflowStep[];
      "timeout-minutes"?: number;
    };
  };
}

const workflow = Bun.YAML.parse(
  readFileSync(
    new URL("../../../.github/workflows/training-stack.yml", import.meta.url),
    "utf8",
  ),
) as Workflow;

describe("training-stack workflow", () => {
  test("keeps PR image caching restore-only within the bounded smoke job", () => {
    const cpuSmoke = workflow.jobs?.["cpu-smoke"];
    const buildStep = cpuSmoke?.steps?.find(
      (step) => step.name === "Build CPU image",
    );

    expect(cpuSmoke?.["timeout-minutes"]).toBe(30);
    expect(buildStep?.with?.["cache-from"]).toBe("type=gha,scope=training-cpu");
    expect(buildStep?.with?.["cache-to"]).toBe(
      [
        "$",
        "{{ github.event_name != 'pull_request' && 'type=gha,scope=training-cpu,mode=max,timeout=12m,ignore-error=true' || '' }}",
      ].join(""),
    );
  });
});
