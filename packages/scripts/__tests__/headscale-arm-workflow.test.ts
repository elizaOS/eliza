/**
 * Exercises the protected Headscale arm workflow and generated remote script
 * against hostname drift, incomplete TLS overlap, and SSH trust acquisition.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = new URL("../../../", import.meta.url);
const workflowSource = readFileSync(
  new URL(".github/workflows/arm-headscale-control-plane.yml", repoRoot),
  "utf8",
);
const provisioningWorkflowSource = readFileSync(
  new URL(".github/workflows/deploy-eliza-provisioning-worker.yml", repoRoot),
  "utf8",
);
const controlPlaneRunbookSource = readFileSync(
  new URL(
    "packages/cloud/infra/cloud/terraform/hetzner/control-plane/README.md",
    repoRoot,
  ),
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
  uses?: string;
  with?: Record<string, string | boolean>;
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

function expectBashSyntax(source: string) {
  const syntax = spawnSync("bash", ["-n"], {
    encoding: "utf8",
    input: source,
  });
  expect(syntax.status).toBe(0);
  expect(syntax.stderr).toBe("");
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

function ownershipAwkProgram(remoteScript: string) {
  const startMarker = '-v legacy="$HS_LEGACY_HOST" \'\n';
  const start = remoteScript.indexOf(startMarker);
  if (start === -1) throw new Error("Missing Headscale ownership awk start");
  const bodyStart = start + startMarker.length;
  const end = remoteScript.indexOf("\n')", bodyStart);
  if (end === -1) throw new Error("Missing Headscale ownership awk end");
  return remoteScript.slice(bodyStart, end);
}

function renewalHookScript(remoteScript: string) {
  const startMarker = "<<'HOOK'\n";
  const start = remoteScript.indexOf(startMarker);
  if (start === -1) throw new Error("Missing certbot renewal hook start");
  const bodyStart = start + startMarker.length;
  const end = remoteScript.indexOf("\nHOOK\n", bodyStart);
  if (end === -1) throw new Error("Missing certbot renewal hook end");
  return remoteScript.slice(bodyStart, end);
}

function runRenewalHook(hookSource: string, certificateSans: string) {
  const fixtureDir = mkdtempSync(join(tmpdir(), "headscale-renew-hook-test-"));
  const binDir = join(fixtureDir, "bin");
  const lineageDir = join(fixtureDir, "lineage");
  const hookPath = join(fixtureDir, "renew-hook");
  const logPath = join(fixtureDir, "commands.log");
  mkdirSync(binDir);
  mkdirSync(lineageDir);
  writeFileSync(join(lineageDir, "fullchain.pem"), "test-only-certificate\n");
  writeFileSync(logPath, "");
  writeFileSync(
    join(binDir, "openssl"),
    "#!/usr/bin/env bash\nprintf 'X509v3 Subject Alternative Name:\\n    %s\\n' \"$TEST_CERT_SANS\"\n",
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "nginx"),
    '#!/usr/bin/env bash\nprintf \'nginx %s\\n\' "$*" >> "$HOOK_LOG"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(binDir, "systemctl"),
    '#!/usr/bin/env bash\nprintf \'systemctl %s\\n\' "$*" >> "$HOOK_LOG"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    hookPath,
    hookSource.replace(
      /^EXPECTED_LINEAGE=.*$/m,
      `EXPECTED_LINEAGE=${JSON.stringify(lineageDir)}`,
    ),
    { mode: 0o755 },
  );

  try {
    const result = spawnSync("bash", [hookPath], {
      encoding: "utf8",
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        HOOK_LOG: logPath,
        RENEWED_LINEAGE: lineageDir,
        TEST_CERT_SANS: certificateSans,
      },
    });
    return { ...result, commandLog: readFileSync(logPath, "utf8") };
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
    expect(
      converge
        ?.trimEnd()
        .endsWith(
          '--headscale-legacy-public-url "$resolved_legacy_public_url"',
        ),
    ).toBe(true);
  });

  test("does not accept dispatch overrides for loopback API or listen addresses", () => {
    expect(workflowSource).not.toContain("headscale_api_url:");
    expect(workflowSource).not.toContain("listen_addr:");
    expect(arm?.env).not.toHaveProperty("HEADSCALE_API_URL");
    expect(arm?.env).not.toHaveProperty("HEADSCALE_LISTEN_ADDR");

    expect(scriptSource).not.toContain(
      'readArg(args, "headscale-api-url", "HEADSCALE_API_URL")',
    );
    expect(scriptSource).not.toContain(
      'readArg(args, "listen-addr", "HEADSCALE_LISTEN_ADDR")',
    );
    expect(scriptSource).toContain('apiUrl: "http://127.0.0.1:8081"');
    expect(scriptSource).toContain('listenAddr: "127.0.0.1:8081"');
    expect(scriptSource).toContain('apiUrl: "http://127.0.0.1:8080"');
    expect(scriptSource).toContain('listenAddr: "127.0.0.1:8080"');
  });

  test("keeps every control-plane writer on the environment-fixed loopback API", () => {
    expect(provisioningWorkflowSource).not.toContain(
      "HEADSCALE_API_URL: $" + "{{ vars.HEADSCALE_API_URL }}",
    );
    expect(provisioningWorkflowSource).not.toContain(
      "require_exact HEADSCALE_API_URL",
    );
    expect(provisioningWorkflowSource).toContain(
      'resolved_headscale_api_url="http://127.0.0.1:8081"',
    );
    expect(provisioningWorkflowSource).toContain(
      'resolved_headscale_api_url="http://127.0.0.1:8080"',
    );
    expect(provisioningWorkflowSource).toContain(
      'echo "HEADSCALE_API_URL=$resolved_headscale_api_url" >> "$GITHUB_ENV"',
    );
  });

  test("documents only the canonical protected dispatch inputs", () => {
    expect(controlPlaneRunbookSource).toContain("-f environment=production");
    expect(controlPlaneRunbookSource).not.toContain("-f headscale_api_url=");
    expect(controlPlaneRunbookSource).not.toContain("-f listen_addr=");
  });

  test("pins staging and production deploys to their canonical branch SHA", () => {
    const sourceGate = step("Validate protected deploy source").run;
    expect(sourceGate).toContain('staging) expected_ref="refs/heads/develop"');
    expect(sourceGate).toContain('production) expected_ref="refs/heads/main"');
    expect(sourceGate).toContain('if [ "$GITHUB_REF" != "$expected_ref" ]');

    const checkout = arm?.steps?.find((candidate) =>
      candidate.uses?.startsWith("actions/checkout@"),
    );
    expect(checkout?.with?.ref).toContain("github.sha");
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });

  test("verifies dual-SAN SNI identity and health with normal TLS", () => {
    const verify = step("Verify dual-SAN public identity and health").run;
    expect(verify).toContain(
      'for public_url in "$HEADSCALE_PUBLIC_URL" "$resolved_legacy_public_url"',
    );
    expect(verify).toContain('"$public_url/health"');
    expect(verify).toContain("openssl s_client");
    expect(verify).toContain('-servername "$host"');
    expect(verify).toContain('-verify_hostname "$host"');
    expect(verify).toContain("leaf_has_exact_san");
    expect(verify).toContain("openssl dgst -sha256 -r");
    expect(verify).toContain(
      'if [ "$fingerprint" != "$expected_fingerprint" ]',
    );
    expect(verify).not.toContain("--insecure");
    expect(verify).not.toMatch(/(^|\s)-k(\s|$)/);
    expectBashSyntax(verify);
  });

  test("keeps validation gates syntactically valid in bash", () => {
    expectBashSyntax(step("Validate protected deploy source").run ?? "");
    expectBashSyntax(step("Validate canonical control-plane inputs").run ?? "");
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
      expect(result.stdout).toContain(
        "effective_nginx_config=$(sudo nginx -T 2>&1)",
      );
      expect(result.stdout).toContain("conflicting server name");
      expect(result.stdout).toContain('-v expected="$HS_VHOST"');
      expect(result.stdout).toContain("$1 != expected { print }");
      expect(result.stdout).toContain('[ "$canonical_owner_count" -ne 2 ]');
      expect(result.stdout).toContain('[ "$legacy_owner_count" -ne 2 ]');
      expect(result.stdout).toContain(
        "Leaving unknown nginx configs untouched and restoring the prior $HS_VHOST",
      );
      expect(result.stdout).toContain("rollback_headscale_vhost()");
      const acmeTrap = result.stdout.indexOf("trap restore_acme_vhost EXIT");
      const acmeInstall = result.stdout.indexOf(
        'sudo install -o root -g root -m 0644 "$HS_ACME_STAGE" "$HS_ACME_VHOST"',
      );
      expect(acmeTrap).toBeGreaterThan(-1);
      expect(acmeInstall).toBeGreaterThan(-1);
      expect(acmeTrap).toBeLessThan(acmeInstall);

      const finalTrap = result.stdout.indexOf(
        "trap rollback_headscale_vhost EXIT",
      );
      const finalInstall = result.stdout.indexOf(
        'sudo install -o root -g root -m 0644 "$HS_VHOST_STAGE" "$HS_VHOST"',
      );
      expect(finalTrap).toBeGreaterThan(-1);
      expect(finalInstall).toBeGreaterThan(-1);
      expect(finalTrap).toBeLessThan(finalInstall);
      const ownershipProof = result.stdout.indexOf(
        "effective_nginx_config=$(sudo nginx -T 2>&1)",
        finalInstall,
      );
      const finalReload = result.stdout.indexOf(
        "sudo systemctl reload nginx",
        ownershipProof,
      );
      expect(ownershipProof).toBeGreaterThan(finalInstall);
      expect(finalReload).toBeGreaterThan(ownershipProof);
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

      expectBashSyntax(result.stdout);
    },
  );

  test("enumerates multiline exact hostname owners by loaded nginx config", () => {
    const result = runDryArm(
      "https://headscale.eliza.app",
      "https://headscale.elizacloud.ai",
    );
    expect(result.status).toBe(0);
    const fixture = `# configuration file /etc/nginx/conf.d/headscale.conf:
server {
  server_name headscale.eliza.app
    headscale.elizacloud.ai;
}
# configuration file /etc/nginx/sites-enabled/legacy-headscale:
server {
  server_name headscale.elizacloud.ai;
}
`;
    const parsed = spawnSync(
      "awk",
      [
        "-v",
        "canonical=headscale.eliza.app",
        "-v",
        "legacy=headscale.elizacloud.ai",
        ownershipAwkProgram(result.stdout),
      ],
      { encoding: "utf8", input: fixture },
    );
    expect(parsed.status).toBe(0);
    expect(parsed.stderr).toBe("");
    expect(parsed.stdout.trim().split("\n")).toEqual([
      "/etc/nginx/conf.d/headscale.conf\theadscale.eliza.app",
      "/etc/nginx/conf.d/headscale.conf\theadscale.elizacloud.ai",
      "/etc/nginx/sites-enabled/legacy-headscale\theadscale.elizacloud.ai",
    ]);
  });

  test("installs a fail-closed renewal hook that validates both SANs before reload", () => {
    const result = runDryArm(
      "https://headscale.eliza.app",
      "https://headscale.elizacloud.ai",
    );
    expect(result.status).toBe(0);
    const hook = renewalHookScript(result.stdout);
    expectBashSyntax(hook);
    expect(result.stdout).toContain(
      "HS_RENEW_HOOK=/etc/letsencrypt/renewal-hooks/deploy/eliza-headscale-nginx-reload",
    );
    expect(result.stdout).toContain(
      'sudo install -o root -g root -m 0755 "$HS_RENEW_HOOK_STAGE" "$HS_RENEW_HOOK"',
    );
    expect(result.stdout).toContain(
      "sudo systemctl enable --now certbot.timer",
    );
    expect(result.stdout).toContain(
      "sudo systemctl is-enabled --quiet certbot.timer",
    );
    expect(result.stdout).toContain(
      "sudo systemctl is-active --quiet certbot.timer",
    );
    expect(result.stdout).not.toContain("WARN: certbot.timer not active");

    const valid = runRenewalHook(
      hook,
      "DNS:headscale.eliza.app, DNS:headscale.elizacloud.ai",
    );
    expect(valid.status).toBe(0);
    expect(valid.stderr).toBe("");
    expect(valid.commandLog).toBe("nginx -t\nsystemctl reload nginx\n");

    const missingLegacySan = runRenewalHook(hook, "DNS:headscale.eliza.app");
    expect(missingLegacySan.status).not.toBe(0);
    expect(missingLegacySan.stderr).toContain(
      "renewed Headscale certificate does not cover both required hostnames",
    );
    expect(missingLegacySan.commandLog).toBe("");
  });

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
