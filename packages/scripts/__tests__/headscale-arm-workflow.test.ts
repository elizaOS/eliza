/**
 * Exercises the protected Headscale arm workflow and generated remote script
 * against hostname drift, incomplete TLS overlap, and SSH trust acquisition.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
const scriptPath = fileURLToPath(
  new URL(
    "packages/cloud/scripts/admin/arm-headscale-control-plane.mjs",
    repoRoot,
  ),
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

function runDryArm(publicUrl: string, legacyPublicUrl: string) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "headscale-arm-test-"));
  const sshKey = join(fixtureDir, "deploy-key");
  const knownHosts = join(fixtureDir, "known-hosts");
  writeFileSync(sshKey, "test-only-key\n", { mode: 0o600 });
  writeFileSync(knownHosts, "test-only-known-hosts\n", { mode: 0o600 });

  try {
    return spawnSync(
      "node",
      [
        scriptPath,
        "--host",
        "192.0.2.10",
        "--ssh-key",
        sshKey,
        "--ssh-known-hosts",
        knownHosts,
        "--headscale-public-url",
        publicUrl,
        "--headscale-legacy-public-url",
        legacyPublicUrl,
        "--headscale-api-key",
        "test-only-api-key",
        "--skip-cp-router",
        "--dry-run",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
        },
      },
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
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

  test("repairs legacy hosts that have a binary but no package user", () => {
    const groupGuard = scriptSource.indexOf(
      "if ! getent group headscale >/dev/null; then",
    );
    const userGuard = scriptSource.indexOf(
      "if ! id -u headscale >/dev/null 2>&1; then",
    );
    const stateDirectory = scriptSource.indexOf(
      "sudo install -d -o headscale -g headscale",
    );

    expect(groupGuard).toBeGreaterThan(-1);
    expect(userGuard).toBeGreaterThan(groupGuard);
    expect(stateDirectory).toBeGreaterThan(userGuard);
    expect(scriptSource).toContain("sudo groupadd --system headscale");
    expect(scriptSource).toContain("sudo useradd \\\\");
    expect(scriptSource).toContain("--shell /usr/sbin/nologin");
    expect(scriptSource).toContain(
      "existing headscale user is not a member of the headscale group",
    );
  });

  test("cleans both temporary SSH identity files on every outcome", () => {
    const cleanup = step("Remove deploy SSH identity");
    expect(cleanup.run).toContain('"$RUNNER_TEMP/headscale-deploy-key"');
    expect(cleanup.run).toContain('"$RUNNER_TEMP/headscale-known-hosts"');
    expect(cleanup.run).toContain("shred -u");
  });

  test("derives and passes the exact environment-specific legacy overlap", () => {
    const validate = step("Validate canonical control-plane inputs").run;
    expect(validate).toContain(
      'expected_legacy_public_url="https://headscale.elizacloud.ai"',
    );
    expect(validate).toContain(
      'expected_legacy_public_url="https://headscale-staging.elizacloud.ai"',
    );
    expect(validate).toContain(
      "resolved_legacy_public_url=$expected_legacy_public_url",
    );

    const converge = step(
      "Converge Headscale, canonical TLS, and control-plane router",
    ).run;
    expect(converge).toContain("--headscale-legacy-public-url");
    expect(converge).toContain('"$resolved_legacy_public_url"');
  });

  test("verifies canonical and legacy health with normal TLS validation", () => {
    const verify = step("Verify canonical and legacy public health").run;
    expect(verify).toContain(
      'for public_url in "$HEADSCALE_PUBLIC_URL" "$resolved_legacy_public_url"',
    );
    expect(verify).toContain('"$public_url/health"');
    expect(verify).not.toContain("--insecure");
    expect(verify).not.toMatch(/(^|\s)-k(\s|$)/);
  });
});

describe("Headscale migration-overlap remote script", () => {
  test.each([
    [
      "production",
      "https://headscale.eliza.app",
      "https://headscale.elizacloud.ai",
      "headscale.eliza.app",
      "headscale.elizacloud.ai",
    ],
    [
      "staging",
      "https://headscale-staging.eliza.app",
      "https://headscale-staging.elizacloud.ai",
      "headscale-staging.eliza.app",
      "headscale-staging.elizacloud.ai",
    ],
  ])(
    "generates both %s server names and certificate SAN checks",
    (_environment, publicUrl, legacyPublicUrl, canonicalHost, legacyHost) => {
      const result = runDryArm(publicUrl, legacyPublicUrl);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`HS_HOST='${canonicalHost}'`);
      expect(result.stdout).toContain(`HS_LEGACY_HOST='${legacyHost}'`);
      expect(result.stdout).toContain("server_name $HS_HOST $HS_LEGACY_HOST;");
      expect(result.stdout).toContain('-d "$HS_HOST"');
      expect(result.stdout).toContain('-d "$HS_LEGACY_HOST"');
      expect(result.stdout).toContain(
        'openssl x509 -in "$LE_FULLCHAIN" -noout -ext subjectAltName',
      );
      expect(result.stdout).toContain('grep -Fx -- "$1"');
      expect(result.stdout).toContain("certbot_args+=(--expand)");
      expect(result.stdout).not.toContain('test -d "$LE_LIVE"');
      expect(result.stdout).toContain(`PUBLIC_URL='${publicUrl}'`);
      expect(result.stdout).toContain('set_config server_url "$PUBLIC_URL"');
      expect(result.stdout).not.toContain(`PUBLIC_URL='${legacyPublicUrl}'`);

      const syntax = spawnSync("bash", ["-n"], {
        encoding: "utf8",
        input: result.stdout,
      });
      expect(syntax.status).toBe(0);
      expect(syntax.stderr).toBe("");
    },
  );

  test("rejects a cross-environment legacy hostname", () => {
    const result = runDryArm(
      "https://headscale.eliza.app",
      "https://headscale-staging.elizacloud.ai",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "HEADSCALE_LEGACY_PUBLIC_URL must be https://headscale.elizacloud.ai for headscale.eliza.app",
    );
  });

  test("rejects non-origin canonical and legacy URLs", () => {
    const canonicalResult = runDryArm(
      "https://headscale.eliza.app/path",
      "https://headscale.elizacloud.ai",
    );
    expect(canonicalResult.status).toBe(1);
    expect(canonicalResult.stderr).toContain(
      "HEADSCALE_PUBLIC_URL must be an exact HTTPS origin",
    );

    const legacyResult = runDryArm(
      "https://headscale.eliza.app",
      "https://headscale.elizacloud.ai?unexpected=1",
    );
    expect(legacyResult.status).toBe(1);
    expect(legacyResult.stderr).toContain(
      "HEADSCALE_LEGACY_PUBLIC_URL must be an exact HTTPS origin",
    );
  });
});
