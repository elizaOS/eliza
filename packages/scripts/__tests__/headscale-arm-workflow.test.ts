/**
 * Guards the protected Headscale arm workflow and operator script against
 * canonical-host drift and deployment-time SSH trust acquisition.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const workflowSource = readFileSync(
  new URL(".github/workflows/arm-headscale-control-plane.yml", repoRoot),
  "utf8",
);
const scriptSource = readFileSync(
  new URL(
    "packages/cloud/scripts/admin/arm-headscale-control-plane.mjs",
    repoRoot,
  ),
  "utf8",
);

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const arm = workflow.jobs?.arm;

function step(name: string): WorkflowStep {
  const found = arm?.steps?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing Headscale arm workflow step: ${name}`);
  return found;
}

describe("protected Headscale arm workflow", () => {
  test("requires the independently verified protected SSH inventory", () => {
    expect(arm?.env?.DEPLOY_SSH_KNOWN_HOSTS).toContain(
      "secrets.ELIZA_PROVISIONING_SSH_KNOWN_HOSTS",
    );
    expect(step("Validate canonical control-plane inputs").run).toContain(
      "DEPLOY_SSH_KNOWN_HOSTS",
    );

    const install = step("Install deploy SSH identity").run;
    expect(install).toContain("printf '%s\\n' \"$DEPLOY_SSH_KNOWN_HOSTS\"");
    expect(install).toContain('ssh-keygen -F "$DEPLOY_HOST"');

    const converge = step(
      "Converge Headscale, canonical TLS, and control-plane router",
    ).run;
    expect(converge).toContain("--ssh-known-hosts");
  });

  test("uses only strict, pre-established SSH host trust", () => {
    expect(scriptSource).toContain('"StrictHostKeyChecking=yes"');
    expect(scriptSource).toContain("UserKnownHostsFile=$" + "{sshKnownHosts}");
    expect(scriptSource).toContain('"GlobalKnownHostsFile=/dev/null"');
    expect(scriptSource).not.toContain("StrictHostKeyChecking=accept-new");
    expect(workflowSource).not.toContain("ssh-keyscan");
  });

  test("cleans both temporary SSH identity files on every outcome", () => {
    const cleanup = step("Remove deploy SSH identity");
    expect(cleanup.run).toContain('"$RUNNER_TEMP/headscale-deploy-key"');
    expect(cleanup.run).toContain('"$RUNNER_TEMP/headscale-known-hosts"');
    expect(cleanup.run).toContain("shred -u");
  });
});
