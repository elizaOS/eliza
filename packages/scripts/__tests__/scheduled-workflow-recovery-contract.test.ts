/**
 * Locks scheduled infrastructure workflows to the state, shell, and runtime
 * contracts required by their real Hetzner, Android, and CodeQL runners.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

interface WorkflowStep {
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  "runs-on"?: unknown;
  steps?: WorkflowStep[];
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
}

function parseWorkflow(name: string): Workflow {
  return Bun.YAML.parse(read(`.github/workflows/${name}`)) as Workflow;
}

function namedStep(job: WorkflowJob | undefined, name: string): WorkflowStep {
  const step = job?.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`Missing workflow step: ${name}`);
  return step;
}

describe("scheduled workflow recovery contracts", () => {
  test("Hetzner sleep-wake consumes the provisioner's server_id state field", () => {
    const workflow = parseWorkflow("hetzner-sleep-wake-smoke.yml");
    const workflowSource = read(
      ".github/workflows/hetzner-sleep-wake-smoke.yml",
    );
    const job = workflow.jobs?.["sleep-wake"];
    const backupStep = namedStep(job, "Write + back up agent state from A");
    const restoreStep = namedStep(
      job,
      "Restore backup onto B + verify state survived",
    );
    const stateSource = read(
      "packages/scripts/cloud/admin/hetzner-e2e/state-file.ts",
    );
    const provisionSource = read(
      "packages/scripts/cloud/admin/hetzner-e2e/hetzner-e2e-provision.ts",
    );

    expect(stateSource).toMatch(
      /export interface HetznerE2EState[\s\S]*server_id\?: number/,
    );
    expect(provisionSource).toContain("server_id: server.id");
    expect(backupStep.run).toContain(
      'ID_A=$(jq -r .server_id "$HETZNER_E2E_STATE_FILE")',
    );
    expect(restoreStep.run).toContain(
      'ID_B=$(jq -r .server_id "$HETZNER_E2E_STATE_FILE")',
    );
    expect(workflowSource.match(/jq -r \.server_id/g)).toHaveLength(2);
    expect(workflowSource).not.toMatch(/jq -r \.id\b/);
  });

  test("every Android emulator action enters one persistent Bash script", () => {
    const workflow = parseWorkflow("android-device-e2e.yml");
    const expectedCommands = [
      [
        "android-e2e",
        "Route coverage on emulator",
        "bash scripts/mobile/android-emulator-webview-ci.sh full",
      ],
      [
        "pr-device-smoke",
        "Onboarding→home + chat turn on emulator (host agent)",
        "bash scripts/mobile/android-emulator-webview-ci.sh pr-smoke",
      ],
      [
        "native-plugin-androidtest",
        "Native-plugin androidTest on emulator",
        "bash scripts/mobile/android-native-plugin-ci.sh",
      ],
    ] as const;

    for (const [jobName, stepName, command] of expectedCommands) {
      const step = namedStep(workflow.jobs?.[jobName], stepName);
      expect(step.uses).toBe("reactivecircus/android-emulator-runner@v2");
      expect(step.with?.script).toBe(command);
      expect(step.with?.script).not.toContain("\n");
    }

    for (const relativePath of [
      "scripts/mobile/android-emulator-webview-ci.sh",
      "scripts/mobile/android-native-plugin-ci.sh",
    ]) {
      const source = read(relativePath);
      expect(source).toContain("set -euo pipefail");
      const syntax = spawnSync("bash", ["-n", join(repoRoot, relativePath)], {
        encoding: "utf8",
      });
      expect(syntax.status, syntax.stderr).toBe(0);
    }

    const invalidLane = spawnSync(
      "bash",
      [
        join(repoRoot, "scripts/mobile/android-emulator-webview-ci.sh"),
        "invalid",
      ],
      { encoding: "utf8" },
    );
    expect(invalidLane.status).toBe(64);
    expect(invalidLane.stderr).toContain("usage:");
  });

  test("self-hosted CodeQL provisions Node 24 before initialization", () => {
    const workflow = parseWorkflow("codeql.yml");
    const job = workflow.jobs?.analyze;
    const steps = job?.steps ?? [];
    const setup = namedStep(job, "Setup Node for CodeQL extraction");
    const setupIndex = steps.indexOf(setup);
    const initIndex = steps.findIndex((step) =>
      step.uses?.startsWith("github/codeql-action/init@"),
    );

    expect(workflow.on?.schedule).toBeDefined();
    expect(String(job?.["runs-on"])).toContain("self-hosted");
    expect(setup.if).toBe("runner.environment == 'self-hosted'");
    expect(setup.uses).toBe(
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
    );
    expect(setup.with?.["node-version"]).toBe("24");
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(initIndex).toBeGreaterThan(setupIndex);
  });
});
