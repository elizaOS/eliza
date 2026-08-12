/**
 * Pins the Discord gateway workflow to the repository's retrying dependency
 * setup boundary so transient package-download failures cannot bypass it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
  "working-directory"?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const workflowSource = readFileSync(
  join(repoRoot, ".github/workflows/cloud-gateway-discord.yml"),
  "utf8",
);
const workflow = Bun.YAML.parse(workflowSource) as Workflow;

describe("Cloud Gateway Discord workflow", () => {
  test("installs through the isolated retrying workspace setup", () => {
    const steps = workflow.jobs?.test?.steps ?? [];
    const setup = steps.find(
      (step) => step.uses === "./.github/actions/setup-bun-workspace",
    );

    expect(setup).toBeDefined();
    expect(setup?.with).toMatchObject({
      "bun-version": "$" + "{{ env.BUN_VERSION }}",
      "setup-python": "false",
      "install-protoc": "false",
      "install-native-deps": "false",
      "install-command":
        "bun install --frozen-lockfile --no-save --ignore-scripts",
    });
    expect(steps.some((step) => step.run?.includes("bun install"))).toBe(false);
    const lockfileCheck = steps.find(
      (step) =>
        step.name === "Verify dependency install preserved the lockfile",
    );
    expect(lockfileCheck?.["working-directory"]).toBe(".");
    expect(lockfileCheck?.run).toBe("git diff --exit-code -- bun.lock");
  });
});
