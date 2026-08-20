/**
 * Locks the protected Headscale self-enrollment, ACL policy, and workflow
 * boundaries without connecting to a host or using live credentials.
 *
 * The ACL assertions parse the committed policy the same way Headscale does, so
 * a malformed or over-broad `acl.hujson` fails here instead of taking the
 * control plane's tailnet down after the next converge run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import JSON5 from "json5";
import { parse } from "yaml";

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface HeadscaleAclRule {
  action: string;
  src: string[];
  dst: string[];
}

interface HeadscalePolicy {
  tagOwners: Record<string, string[]>;
  acls: HeadscaleAclRule[];
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
        skip_nginx_cert: { type: string; default: boolean };
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
const aclPath = resolve(
  repoRoot,
  "packages/cloud/services/headscale/acl.hujson",
);
// Must equal the port in acl.hujson; that file explains why the coupling is manual.
const AGENT_CONTAINER_PORT = "2138";
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

/**
 * Parse the committed policy. json5 is a superset of HuJSON: it accepts a few
 * forms headscale rejects (unquoted keys, single quotes, leading `+`), so a
 * green parse here is necessary but not sufficient. It catches the failure that
 * actually matters — a malformed edit shipping base64-encoded and taking
 * headscale down on restart — without hand-rolling a parser to chase parity.
 */
function parsePolicy(source: string): HeadscalePolicy {
  return JSON5.parse(source) as HeadscalePolicy;
}

/** Parsed inside each test so a malformed policy fails a named test rather
 * than aborting collection. */
function committedPolicy(): HeadscalePolicy {
  return parsePolicy(readFileSync(aclPath, "utf8"));
}

function rulesFrom(
  policy: HeadscalePolicy,
  src: string,
  dstTag: string,
): HeadscaleAclRule[] {
  return policy.acls.filter(
    (rule) =>
      rule.src.includes(src) &&
      rule.dst.some((dst) => dst.startsWith(`${dstTag}:`)),
  );
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

describe("Headscale ACL policy", () => {
  test("parses as HuJSON with every rule fully specified", () => {
    const policy = committedPolicy();

    expect(policy.acls.length).toBeGreaterThan(0);
    for (const rule of policy.acls) {
      expect(rule.action).toBe("accept");
      expect(rule.src.length).toBeGreaterThan(0);
      expect(rule.dst.length).toBeGreaterThan(0);
    }
    for (const tag of Object.keys(policy.tagOwners)) {
      expect(tag).toMatch(/^tag:/);
    }
    for (const rule of policy.acls) {
      for (const tag of [...rule.src, ...rule.dst]) {
        expect(
          policy.tagOwners[tag.split(":").slice(0, 2).join(":")],
        ).toBeDefined();
      }
    }
  });

  test("grants tag:eliza-proxy (control plane AND public tunnel proxy) the agent container port only", () => {
    const proxyToAgent = rulesFrom(
      committedPolicy(),
      "tag:eliza-proxy",
      "tag:agent",
    );

    expect(proxyToAgent).toHaveLength(1);
    expect(proxyToAgent[0]?.dst).toEqual([`tag:agent:${AGENT_CONTAINER_PORT}`]);
  });

  test("keeps customer tunnels and iMessage gateways off the agent fleet", () => {
    const policy = committedPolicy();

    for (const src of ["tag:eliza-tunnel", "tag:imessage-gateway"]) {
      expect(rulesFrom(policy, src, "tag:agent")).toEqual([]);
    }
  });

  test("ships the committed policy to the control plane", () => {
    const remote = renderRemoteScript();
    const encoded = remote.match(
      /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| sudo tee \/etc\/headscale\/acl\.hujson/,
    )?.[1];
    if (!encoded) throw new Error("remote script does not install an ACL file");

    const shipped = parsePolicy(
      Buffer.from(encoded, "base64").toString("utf8"),
    );

    const shippedProxyToAgent = rulesFrom(
      shipped,
      "tag:eliza-proxy",
      "tag:agent",
    );
    expect(shippedProxyToAgent).toHaveLength(1);
    expect(shippedProxyToAgent[0]?.dst).toEqual([
      `tag:agent:${AGENT_CONTAINER_PORT}`,
    ]);
    expect(shipped).toEqual(committedPolicy());
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

  test("can reach the ACL when the certificate step is the broken thing", () => {
    // The remote script runs the nginx + Let's Encrypt block BEFORE it writes
    // acl.hujson and the headscale policy config, so a cert failure aborts the
    // run with the policy left unconverged. That is exactly what happened on
    // 2026-08-18: both production runs died at certbot and the corrected ACL
    // never reached the box. This input is the escape hatch.
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.skip_nginx_cert.type).toBe("boolean");
    expect(inputs.skip_nginx_cert.default).toBe(false);

    const converge = namedStep(
      workflow,
      "Inspect or converge Headscale control plane",
    ).run;
    expect(converge).toContain("args+=(--skip-nginx-cert)");
    // The script refuses this pairing itself; the workflow must refuse it
    // before SSH rather than after.
    expect(converge).toContain(
      "skip_nginx_cert cannot be combined with legacy vhost retirement",
    );
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
