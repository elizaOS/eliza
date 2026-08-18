/**
 * Locks the protected Headscale self-enrollment and workflow boundaries without
 * connecting to a host or using live credentials.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface HeadscaleWorkflow {
  jobs: {
    arm: {
      environment: string;
      steps: WorkflowStep[];
    };
  };
  on: {
    workflow_dispatch: {
      inputs: {
        environment: { options: string[] };
        operation: { options: string[] };
      };
    };
  };
}

const repoRoot = resolve(import.meta.dirname, "../../../..");
const scriptPath = resolve(
  repoRoot,
  "packages/cloud/scripts/admin/arm-headscale-control-plane.mjs",
);
const workflowPath = resolve(
  repoRoot,
  ".github/workflows/arm-headscale-control-plane.yml",
);
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function renderRemoteScript(extraArgs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "headscale-arm-test-"));
  tempRoots.push(root);
  const keyPath = join(root, "deploy-key");
  const knownHostsPath = join(root, "known-hosts");
  writeFileSync(keyPath, "test-only-key\n", { mode: 0o600 });
  writeFileSync(knownHostsPath, "test-only-known-host\n", { mode: 0o600 });

  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--host",
      "control-plane.test.invalid",
      "--ssh-key",
      keyPath,
      "--ssh-known-hosts",
      knownHostsPath,
      "--headscale-public-url",
      "https://headscale.eliza.app",
      "--headscale-legacy-public-url",
      "https://headscale.elizacloud.ai",
      "--headscale-api-key",
      "test-only-api-key",
      "--skip-nginx-cert",
      "--dry-run",
      ...extraArgs,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  return result.stdout;
}

function namedStep(workflow: HeadscaleWorkflow, name: string): WorkflowStep {
  const step = workflow.jobs.arm.steps.find(
    (candidate) => candidate.name === name,
  );
  if (!step) throw new Error(`Missing Headscale workflow step: ${name}`);
  return step;
}

describe("Headscale control-plane self-enrollment", () => {
  test("forces reauthentication only after minting a fresh single-use key", () => {
    const remote = renderRemoteScript();
    const forceReauth = remote.indexOf("    --force-reauth \\");
    const mintKey = remote.indexOf(
      "PREAUTH_KEY=$(sudo headscale preauthkeys create",
    );
    const tailscaleUp = remote.indexOf("sudo tailscale up \\");
    const loginServer = remote.indexOf('    --login-server="$LOGIN_SERVER" \\');

    expect(forceReauth).toBeGreaterThan(mintKey);
    expect(forceReauth).toBeGreaterThan(tailscaleUp);
    expect(forceReauth).toBeLessThan(loginServer);
    expect(remote.match(/--force-reauth/g)).toHaveLength(1);
    expect(remote).toContain(
      "already enrolled in headscale; skipping tailscale up",
    );
  });

  test("does not emit forced reauthentication when router enrollment is skipped", () => {
    const remote = renderRemoteScript(["--skip-cp-router"]);

    expect(remote).toContain(
      "skip-cp-router set: leaving CP tailscale enrollment untouched",
    );
    expect(remote).not.toContain("--force-reauth");
    expect(remote).not.toContain("headscale preauthkeys create");
  });
});

describe("Headscale protected workflow contract", () => {
  const workflow = parse(
    readFileSync(workflowPath, "utf8"),
  ) as HeadscaleWorkflow;

  test("keeps production convergence behind the protected environment and main ref", () => {
    expect(workflow.on.workflow_dispatch.inputs.environment.options).toEqual([
      "staging",
      "production",
    ]);
    expect(workflow.on.workflow_dispatch.inputs.operation.options).toContain(
      "converge",
    );
    expect(workflow.jobs.arm.environment).toBe(
      ["$", "{{ inputs.environment }}"].join(""),
    );

    const sourceGuard = namedStep(
      workflow,
      "Validate protected deploy source",
    ).run;
    expect(sourceGuard).toContain('production) expected_ref="refs/heads/main"');
    expect(sourceGuard).toContain('if [ "$GITHUB_REF" != "$expected_ref" ]');
  });

  test("invokes the reviewed script without exposing a force-reauth input", () => {
    const converge = namedStep(
      workflow,
      "Inspect or converge Headscale control plane",
    ).run;

    expect(converge).toContain(
      "node packages/cloud/scripts/admin/arm-headscale-control-plane.mjs",
    );
    expect(converge).not.toContain("force-reauth");
  });
});
