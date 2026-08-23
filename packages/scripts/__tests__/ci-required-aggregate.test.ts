/** Proves the canonical CI aggregate reports the exact failed dependency without masking it under strict shell mode. */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = Bun.YAML.parse(
  readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8"),
) as Workflow;
const aggregateSource = workflow.jobs?.required?.steps?.find(
  (step) => step.name === "Require every CI job to succeed",
)?.run;

if (!aggregateSource) {
  throw new Error("CI required aggregate has no executable body");
}

function executeAggregate(results: string) {
  return spawnSync("bash", ["-c", aggregateSource], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, RESULTS: results },
  });
}

describe("CI required aggregate", () => {
  test("accepts successful dependencies", () => {
    const result = executeAggregate(
      "quality=success tests-client=success browser-bridge-windows-security=success",
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
  });

  test("names the first failed dependency under strict shell mode", () => {
    const result = executeAggregate(
      "quality=success tests-client=failure browser-bridge-windows-security=success",
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      "::error title=CI aggregate::tests-client finished with failure\n",
    );
    expect(result.stderr).toBe("");
  });
});
