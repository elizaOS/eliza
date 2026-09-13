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
  test("requires live canonical control authority before skipping reauthentication", () => {
    const remote = renderRemoteScript();
    const forceReauth = remote.indexOf("    --force-reauth \\");
    const mintKey = remote.indexOf(
      "PREAUTH_KEY=$(sudo headscale preauthkeys create",
    );
    const inspectPrefs = remote.indexOf("sudo tailscale debug prefs");
    const convergedBranch = remote.indexOf(
      "CP router enrollment already converged (category=cp-router-already-enrolled)",
    );
    const retireStaleNode = remote.indexOf(
      'sudo headscale nodes delete --identifier "$STALE_NODE_ID" --force',
    );
    const tailscaleUp = remote.indexOf("sudo tailscale up \\");
    const resetProfile = remote.indexOf("      --reset \\");
    const loginServer = remote.indexOf('    --login-server="$LOGIN_SERVER" \\');

    expect(inspectPrefs).toBeGreaterThan(0);
    expect(inspectPrefs).toBeLessThan(convergedBranch);
    expect(remote).toContain("CONTROL_URL_MATCH=true");
    expect(forceReauth).toBeGreaterThan(mintKey);
    expect(forceReauth).toBeGreaterThan(tailscaleUp);
    expect(resetProfile).toBeGreaterThan(tailscaleUp);
    expect(resetProfile).toBeLessThan(forceReauth);
    expect(forceReauth).toBeLessThan(loginServer);
    expect(retireStaleNode).toBeGreaterThan(mintKey);
    expect(retireStaleNode).toBeLessThan(tailscaleUp);
    expect(remote.match(/--force-reauth/g)).toHaveLength(1);
    expect(remote).toContain("--tags tag:eliza-proxy");
    expect(remote).not.toContain("      --advertise-tags=");
    expect(remote).toContain(
      "CP router forced reauthentication failed (category=cp-router-reauth-failed)",
    );
    expect(remote).toContain(
      "CP router live identity and canonical control URL verified (category=cp-router-visible)",
    );
    expect(remote).toContain('.BackendState == "Running"');
    expect(remote).toContain("(.Self.TailscaleIPs // []) | length > 0");
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

  test("limits managed Devices hosts to proxy HTTPS with no peer or agent edge", () => {
    const policy = committedPolicy();
    const remoteToProxy = rulesFrom(
      policy,
      "tag:eliza-remote-host",
      "tag:eliza-proxy",
    );

    expect(policy.tagOwners["tag:eliza-remote-host"]).toEqual(["tunnel@"]);
    expect(remoteToProxy).toHaveLength(1);
    expect(remoteToProxy[0]?.dst).toEqual(["tag:eliza-proxy:443"]);
    expect(rulesFrom(policy, "tag:eliza-remote-host", "tag:agent")).toEqual([]);
    expect(
      rulesFrom(policy, "tag:eliza-remote-host", "tag:eliza-remote-host"),
    ).toEqual([]);
    expect(
      rulesFrom(policy, "tag:eliza-proxy", "tag:eliza-remote-host"),
    ).toEqual([]);
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

  test("emits only closed remote failure categories", () => {
    const step = namedStep(
      workflow,
      "Inspect or converge Headscale control plane",
    );
    const run = String(step.run ?? "");

    expect(run).toContain("grep -hEo 'category=(");
    expect(run).toContain('safe_category="headscale-remote-failed"');
    expect(run).toContain("raw-output=suppressed");
    expect(run).not.toContain('cat "$arm_stdout"');
    expect(run).not.toContain('cat "$arm_stderr"');
  });

  /**
   * Runs the workflow's own failure-classification block against synthetic
   * captures. The block reads only the two capture files, so it executes
   * faithfully without a host, credentials, or the surrounding step.
   */
  function classify(stdout: string, stderr: string): string {
    const run = String(
      namedStep(workflow, "Inspect or converge Headscale control plane").run ??
        "",
    );
    const start = run.indexOf('if [ "$arm_status" -ne 0 ]; then');
    const end = run.indexOf('exit "$arm_status"', start);
    expect(start, "classification block not found").toBeGreaterThan(-1);
    expect(end, "classification block not terminated").toBeGreaterThan(start);
    const block = `${run.slice(start, end)}fi\n`;

    const root = mkdtempSync(join(tmpdir(), "headscale-classify-"));
    tempRoots.push(root);
    const outPath = join(root, "stdout");
    const errPath = join(root, "stderr");
    writeFileSync(outPath, stdout);
    writeFileSync(errPath, stderr);
    const result = spawnSync("bash", ["-c", `set -euo pipefail\n${block}`], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        arm_status: "1",
        arm_stdout: outPath,
        arm_stderr: errPath,
      },
    });
    return `${result.stdout}${result.stderr}`;
  }

  test("classifies a failing run by its failure category, not its last progress token", () => {
    // `report_headscale_unit_state` prints immediately before the health
    // failure exits, so the newest category on a health failure is the state
    // reporter rather than the failure itself.
    expect(
      classify(
        [
          "headscale local health failed (category=headscale-local-health-failed; attempts=30)",
          "headscale-unit-state category=headscale-unit-state active=failed",
        ].join("\n"),
        "",
      ),
    ).toContain("category=headscale-local-health-failed;");

    // The cp-router block ends by announcing success; anything failing after
    // it must not be reported as that success.
    expect(
      classify(
        [
          "CP router live identity and canonical control URL verified (category=cp-router-visible)",
          "env file /etc/eliza.env not found on host",
        ].join("\n"),
        "",
      ),
    ).toContain("category=headscale-remote-failed;");

    // A self-classifying failure is still reported exactly.
    expect(
      classify(
        "CP router forced reauthentication failed (category=cp-router-reauth-failed)",
        "",
      ),
    ).toContain("category=cp-router-reauth-failed;");

    // No category anywhere falls back rather than inventing one.
    expect(classify("ssh: connection reset by peer", "")).toContain(
      "category=headscale-remote-failed;",
    );
  });

  test("never emits captured remote output, whatever it contains", () => {
    const secret = "sentinel-headscale-preauth-key-value";
    for (const [stdout, stderr] of [
      [`tailscale up --authkey=${secret} failed`, ""],
      [`authkey=${secret} (category=cp-router-reauth-failed) aborted`, ""],
      ["", `${secret} refused (category=cp-router-key-failed)`],
    ]) {
      expect(classify(stdout, stderr), stdout || stderr).not.toContain(secret);
    }
  });

  test("accepts exactly the categories the remote script exits on", () => {
    const remote = renderRemoteScript();
    const lines = remote.split("\n");
    const exiting = new Set<string>();
    for (let index = 0; index < lines.length; index += 1) {
      // A category is a failure category when the statement printing it also
      // terminates the script; `headscale-local-health-failed` reports unit
      // state first, so look a couple of lines ahead.
      const window = lines.slice(index, index + 3).join(" ");
      for (const match of lines[index].matchAll(/category=([a-z0-9-]+)/g)) {
        if (/\bexit 1\b/.test(window)) exiting.add(match[1]);
      }
    }
    expect(exiting.size).toBeGreaterThan(0);

    const run = String(
      namedStep(workflow, "Inspect or converge Headscale control plane").run ??
        "",
    );
    const pattern = run.match(/grep -hEo 'category=\((.+)\)'/)?.[1] ?? "";
    expect(pattern, "classifier alternation not found").not.toBe("");
    const accepted = new Set(
      splitTopLevel(pattern).flatMap((alternative) =>
        expandAlternation(alternative),
      ),
    );
    // Every category the script exits on is classifiable, and the workflow
    // accepts nothing the script never exits on.
    expect([...accepted].sort()).toEqual([...exiting].sort());
  });
});

/** Splits a grep alternation on the `|`s that sit outside any group. */
function splitTopLevel(pattern: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of pattern) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** Expands a single `a-(b|c)-d` grep alternative into concrete tokens. */
function expandAlternation(pattern: string): string[] {
  const group = pattern.match(/^(.*)\(([^)]*)\)(.*)$/);
  if (!group) return [pattern];
  const [, prefix, choices, suffix] = group;
  return choices.split("|").map((choice) => `${prefix}${choice}${suffix}`);
}
