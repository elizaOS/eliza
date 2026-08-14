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
  symlinkSync,
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
  if?: string;
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
const reviewedLegacyVhostSha256 = "a".repeat(64);

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

function runDryArm(
  publicUrl: string,
  legacyPublicUrl: string,
  extraArgs: string[] = [],
  skipCpRouter = true,
) {
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
        ...(skipCpRouter ? ["--skip-cp-router"] : []),
        ...extraArgs,
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

function shellFunction(remoteScript: string, name: string) {
  const startMarker = `${name}() {\n`;
  const start = remoteScript.indexOf(startMarker);
  if (start === -1) throw new Error(`Missing shell function ${name}`);
  const end = remoteScript.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`Missing shell function end for ${name}`);
  return remoteScript.slice(start, end + 2);
}

function runVhostRollbackAfterFailure(failureStage: string) {
  const dry = runDryArm(
    "https://headscale-staging.eliza.app",
    "https://headscale-staging.elizacloud.ai",
    [
      "--retire-retirable-legacy-vhost",
      "--retirable-legacy-vhost-sha256",
      reviewedLegacyVhostSha256,
    ],
    false,
  );
  expect(dry.status).toBe(0);
  const rollback = shellFunction(dry.stdout, "rollback_headscale_vhosts");
  const fixtureDir = mkdtempSync(join(tmpdir(), "headscale-rollback-test-"));
  const vhost = join(fixtureDir, "headscale.conf");
  const vhostBackup = join(fixtureDir, "headscale.conf.backup");
  const vhostStage = join(fixtureDir, "headscale.conf.stage");
  const legacyVhost = join(fixtureDir, "headscale-staging.conf");
  const legacyBackup = join(fixtureDir, "headscale-staging.conf.backup");
  const commandLog = join(fixtureDir, "commands.log");
  writeFileSync(vhost, "new canonical bytes\n");
  writeFileSync(vhostBackup, "old canonical bytes\n");
  writeFileSync(vhostStage, "staged canonical bytes\n");
  writeFileSync(legacyBackup, "old legacy bytes\n");
  writeFileSync(commandLog, "");

  const harness = `
set -euo pipefail
HS_VHOST=${JSON.stringify(vhost)}
HS_VHOST_BACKUP=${JSON.stringify(vhostBackup)}
HS_VHOST_STAGE=${JSON.stringify(vhostStage)}
HS_VHOST_EXISTED=true
HS_RETIRABLE_LEGACY_VHOST=${JSON.stringify(legacyVhost)}
HS_RETIRABLE_LEGACY_VHOST_BACKUP=${JSON.stringify(legacyBackup)}
HS_RETIRABLE_LEGACY_VHOST_EXISTED=true
HS_RETIRABLE_LEGACY_VHOST_MODE=0644
COMMAND_LOG=${JSON.stringify(commandLog)}
sudo() {
  case "$1" in
    cp) command cp "$2" "$3" ;;
    rm) shift; command rm "$@" ;;
    install)
      command cp "\${@: -2:1}" "\${@: -1}"
      ;;
    nginx) return 0 ;;
    systemctl)
      shift
      printf 'systemctl %s\\n' "$*" >> "$COMMAND_LOG"
      ;;
    *) "$@" ;;
  esac
}
${rollback}
trap rollback_headscale_vhosts EXIT
for stage in cp-router env-write worker-restart final-liveness; do
  if [ "$stage" = ${JSON.stringify(failureStage)} ]; then
    false
  fi
done
`;

  try {
    const result = spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
    });
    return {
      ...result,
      canonical: readFileSync(vhost, "utf8"),
      legacy: readFileSync(legacyVhost, "utf8"),
      commandLog: readFileSync(commandLog, "utf8"),
    };
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function ownershipAwkProgram(remoteScript: string) {
  const startMarker = '-v legacy="$HS_LEGACY_HOST" \'\n';
  const start = remoteScript.lastIndexOf(startMarker);
  if (start === -1) throw new Error("Missing Headscale ownership awk start");
  const bodyStart = start + startMarker.length;
  const end = remoteScript.indexOf("\n')", bodyStart);
  if (end === -1) throw new Error("Missing Headscale ownership awk end");
  return remoteScript.slice(bodyStart, end);
}

function legacyVhostValidationFunction(remoteScript: string) {
  const startMarker = "validate_retirable_legacy_vhost() {\n";
  const start = remoteScript.indexOf(startMarker);
  if (start === -1) throw new Error("Missing legacy vhost validator start");
  const endMarker = "\n}\n\nvalidate_retirable_legacy_vhost";
  const end = remoteScript.indexOf(endMarker, start);
  if (end === -1) throw new Error("Missing legacy vhost validator end");
  return remoteScript.slice(start, end + 2);
}

function runLegacyVhostValidation(options: {
  source?: string;
  loadedConfig?: string;
  owner?: string;
  symlink?: boolean;
  writable?: boolean;
  reviewedSha256?: string;
  requireFile?: boolean;
  enforceDirectiveAllowlist?: boolean;
}) {
  const dry = runDryArm(
    "https://headscale-staging.eliza.app",
    "https://headscale-staging.elizacloud.ai",
    [
      "--retire-retirable-legacy-vhost",
      "--retirable-legacy-vhost-sha256",
      reviewedLegacyVhostSha256,
    ],
  );
  expect(dry.status).toBe(0);
  const fixtureDir = mkdtempSync(
    join(tmpdir(), "headscale-legacy-vhost-test-"),
  );
  const legacyVhost = join(fixtureDir, "headscale-staging.conf");
  const target = join(fixtureDir, "target.conf");
  if (options.source !== undefined) {
    if (options.symlink) {
      writeFileSync(target, options.source, { mode: 0o644 });
      symlinkSync(target, legacyVhost);
    } else {
      writeFileSync(legacyVhost, options.source, { mode: 0o644 });
    }
  }
  const validator = legacyVhostValidationFunction(dry.stdout).replaceAll(
    "/etc/nginx/conf.d/headscale-staging.conf",
    legacyVhost,
  );
  const harness = `
set -euo pipefail
HS_HOST=headscale-staging.eliza.app
HS_LEGACY_HOST=headscale-staging.elizacloud.ai
HS_RETIRABLE_LEGACY_VHOST=${JSON.stringify(legacyVhost)}
HS_REVIEWED_LEGACY_VHOST_SHA256=${JSON.stringify(options.reviewedSha256 ?? "")}
HS_REQUIRE_RETIRABLE_LEGACY_VHOST=${options.requireFile ? "true" : "false"}
HS_ENFORCE_LEGACY_VHOST_DIRECTIVE_ALLOWLIST=${options.enforceDirectiveAllowlist ? "true" : "false"}
sudo() {
  case "$1" in
    stat) printf '%s\\n' "$TEST_FILE_OWNER" ;;
    find)
      if [ "$TEST_FILE_WRITABLE" = "true" ]; then
        printf '%s\\n' "$HS_RETIRABLE_LEGACY_VHOST"
      fi
      ;;
    *) "$@" ;;
  esac
}
nginx() { printf '%s\\n' "$TEST_NGINX_CONFIG"; }
${validator}
validate_retirable_legacy_vhost
`;

  try {
    return spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        TEST_FILE_OWNER: options.owner ?? "root:root",
        TEST_FILE_WRITABLE: options.writable ? "true" : "false",
        TEST_NGINX_CONFIG: (options.loadedConfig ?? "").replaceAll(
          "REPLACE_LEGACY_PATH",
          legacyVhost,
        ),
      },
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

function runLegacyVhostInspection(source: string, loadedConfig: string) {
  const dry = runDryArm(
    "https://headscale-staging.eliza.app",
    "https://headscale-staging.elizacloud.ai",
    ["--inspect-retirable-legacy-vhost"],
  );
  expect(dry.status).toBe(0);
  const fixtureDir = mkdtempSync(
    join(tmpdir(), "headscale-legacy-inspection-test-"),
  );
  const legacyVhost = join(fixtureDir, "headscale-staging.conf");
  writeFileSync(legacyVhost, source, { mode: 0o644 });
  const remoteScript = dry.stdout.replaceAll(
    "/etc/nginx/conf.d/headscale-staging.conf",
    legacyVhost,
  );
  const harness = `
sudo() {
  case "$1" in
    stat)
      if [ "$2" = "-c" ] && [ "$3" = "%U:%G" ]; then
        printf 'root:root\\n'
      else
        printf 'type=regular-file owner=root group=root mode=644 bytes=reviewed path=%s\\n' ${JSON.stringify(legacyVhost)}
      fi
      ;;
    find) return 0 ;;
    nginx) printf '%s\\n' "$TEST_NGINX_CONFIG" ;;
    *) "$@" ;;
  esac
}
${remoteScript}
`;

  try {
    return spawnSync("bash", ["-c", harness], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        TEST_NGINX_CONFIG: loadedConfig.replaceAll(
          "REPLACE_LEGACY_PATH",
          legacyVhost,
        ),
      },
    });
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
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

    const converge = step("Inspect or converge Headscale control plane").run;
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

    const converge = step("Inspect or converge Headscale control plane").run;
    expect(converge).toContain("--headscale-legacy-public-url");
    expect(converge).toContain('"$resolved_legacy_public_url"');
    expect(converge).toContain("--inspect-retirable-legacy-vhost");
    expect(converge).toContain("--retire-retirable-legacy-vhost");
    expect(converge).toContain("--retirable-legacy-vhost-sha256");
    expect(converge).toContain('"$' + '{args[@]}"');
  });

  test("separates read-only inspection from explicit staging retirement", () => {
    expect(workflowSource).toContain("inspect-legacy-vhost");
    expect(workflowSource).toContain("retire-legacy-vhost-and-converge");
    expect(workflowSource).toContain("reviewed_legacy_vhost_sha256");
    const sourceGate = step("Validate protected deploy source").run;
    expect(sourceGate).toContain('if [ "$TARGET_ENVIRONMENT" != "staging" ]');
    expect(sourceGate).toContain(
      "is registered only for the reviewed staging legacy vhost",
    );
    expect(sourceGate).toContain("^[0-9a-f]{64}$");
    expect(sourceGate).toContain(
      "retirement requires the exact lowercase SHA-256",
    );
    expect(step("Verify dual-SAN public identity and health").if).toContain(
      "inputs.operation != 'inspect-legacy-vhost'",
    );
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
  const expectedLegacySource = `server {
  listen 80;
  listen [::]:80;
  server_name headscale-staging.elizacloud.ai;
  return 301 https://$host$request_uri;
}
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name headscale-staging.elizacloud.ai;
  proxy_pass http://127.0.0.1:8080;
}
`;
  const expectedLoadedConfig = `# configuration file /etc/nginx/conf.d/headscale.conf:
server_name headscale-staging.eliza.app headscale-staging.elizacloud.ai;
server_name headscale-staging.eliza.app headscale-staging.elizacloud.ai;
# configuration file REPLACE_LEGACY_PATH:
server_name headscale-staging.elizacloud.ai;
server_name headscale-staging.elizacloud.ai;
`;

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
      expect(result.stdout).toContain("rollback_headscale_vhosts()");
      const acmeTrap = result.stdout.indexOf("trap restore_acme_vhost EXIT");
      const acmeInstall = result.stdout.indexOf(
        'sudo install -o root -g root -m 0644 "$HS_ACME_STAGE" "$HS_ACME_VHOST"',
      );
      expect(acmeTrap).toBeGreaterThan(-1);
      expect(acmeInstall).toBeGreaterThan(-1);
      expect(acmeTrap).toBeLessThan(acmeInstall);

      const finalTrap = result.stdout.indexOf(
        "trap rollback_headscale_vhosts EXIT",
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

  test("retires the reviewed staging file only inside the rollback transaction", () => {
    const result = runDryArm(
      "https://headscale-staging.eliza.app",
      "https://headscale-staging.elizacloud.ai",
      [
        "--retire-retirable-legacy-vhost",
        "--retirable-legacy-vhost-sha256",
        reviewedLegacyVhostSha256,
      ],
      false,
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "HS_RETIRABLE_LEGACY_VHOST='/etc/nginx/conf.d/headscale-staging.conf'",
    );
    expect(result.stdout).toContain("HS_RETIRE_REVIEWED_LEGACY_VHOST='true'");
    expect(result.stdout).toContain(
      `HS_REVIEWED_LEGACY_VHOST_SHA256='${reviewedLegacyVhostSha256}'`,
    );
    const validation = result.stdout.indexOf(
      "validate_retirable_legacy_vhost\n",
    );
    const trap = result.stdout.indexOf("trap rollback_headscale_vhosts EXIT");
    const install = result.stdout.indexOf(
      'sudo install -o root -g root -m 0644 "$HS_VHOST_STAGE" "$HS_VHOST"',
    );
    const removal = result.stdout.indexOf(
      'sudo rm -f -- "$HS_RETIRABLE_LEGACY_VHOST"',
    );
    const finalValidation = result.stdout.lastIndexOf(
      "validate_retirable_legacy_vhost",
      removal,
    );
    const ownership = result.stdout.indexOf(
      "effective_nginx_config=$(sudo nginx -T 2>&1)",
      removal,
    );
    const timerProof = result.stdout.indexOf(
      "sudo systemctl is-active --quiet certbot.timer",
    );
    const publicHealthProof = result.stdout.indexOf(
      '"https://$public_host/health"',
      timerProof,
    );
    const publicSniProof = result.stdout.indexOf(
      '-servername "$public_host"',
      publicHealthProof,
    );
    const cpRouter = result.stdout.indexOf("--- CP self-enrollment:");
    const envWrite = result.stdout.indexOf("sudo sed -i", cpRouter);
    const workerRestart = result.stdout.indexOf(
      "sudo systemctl restart eliza-provisioning-worker.service",
      envWrite,
    );
    const finalServiceLiveness = result.stdout.indexOf(
      "systemctl is-active eliza-provisioning-worker.service",
      workerRestart,
    );
    const transactionCommit = result.stdout.lastIndexOf(
      "commit_headscale_vhosts",
    );
    expect(validation).toBeGreaterThan(-1);
    expect(trap).toBeGreaterThan(validation);
    expect(install).toBeGreaterThan(trap);
    expect(removal).toBeGreaterThan(install);
    expect(finalValidation).toBeGreaterThan(install);
    expect(finalValidation).toBeLessThan(removal);
    expect(ownership).toBeGreaterThan(removal);
    expect(timerProof).toBeGreaterThan(ownership);
    expect(publicHealthProof).toBeGreaterThan(timerProof);
    expect(publicSniProof).toBeGreaterThan(publicHealthProof);
    expect(cpRouter).toBeGreaterThan(publicSniProof);
    expect(envWrite).toBeGreaterThan(cpRouter);
    expect(workerRestart).toBeGreaterThan(envWrite);
    expect(finalServiceLiveness).toBeGreaterThan(workerRestart);
    expect(transactionCommit).toBeGreaterThan(finalServiceLiveness);
    expect(transactionCommit).toBeGreaterThan(publicSniProof);
    expect(transactionCommit).toBeGreaterThan(timerProof);
    expect(result.stdout).toContain(
      'sudo install -o root -g root -m "$HS_RETIRABLE_LEGACY_VHOST_MODE"',
    );
    expectBashSyntax(result.stdout);
  });

  test.each(["cp-router", "env-write", "worker-restart", "final-liveness"])(
    "restores both reviewed vhosts when %s convergence fails",
    (failureStage) => {
      const result = runVhostRollbackAfterFailure(failureStage);
      expect(result.status).not.toBe(0);
      expect(result.canonical).toBe("old canonical bytes\n");
      expect(result.legacy).toBe("old legacy bytes\n");
      expect(result.commandLog).toBe("systemctl reload nginx\n");
    },
  );

  test("inspects only the exact reviewed staging file without generating convergence", () => {
    const result = runDryArm(
      "https://headscale-staging.eliza.app",
      "https://headscale-staging.elizacloud.ai",
      ["--inspect-retirable-legacy-vhost"],
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "Legacy Headscale vhost passed the read-only retirement preflight",
    );
    expect(result.stdout).toContain("reviewed-sha256=$legacy_vhost_sha256");
    expect(result.stdout).toContain(
      "directive-name inventory (values withheld)",
    );
    expect(result.stdout).toContain("reviewed-shape=server-blocks:");
    expect(result.stdout).not.toContain(
      "reviewed public routing/TLS directives",
    );
    expect(result.stdout).not.toContain("sudo grep -En");
    expect(result.stdout).not.toContain("sudo systemctl restart headscale");
    expect(result.stdout).not.toContain("sudo rm -f --");
    expectBashSyntax(result.stdout);
  });

  test("withholds every reviewed directive literal from inspection output", () => {
    const signedRedirect = "https://redirect.invalid/canary-signed-query";
    const embeddedCredential =
      "http://canary-user:canary-password@127.0.0.1:8080";
    const privateInclude = "/etc/nginx/canary-private-include.conf";
    const source = `server {
  listen 80;
  listen [::]:80;
  server_name headscale-staging.elizacloud.ai;
  return 301 ${signedRedirect};
}
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name headscale-staging.elizacloud.ai;
  proxy_pass ${embeddedCredential};
  include ${privateInclude};
}
`;
    const result = runLegacyVhostInspection(source, expectedLoadedConfig);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("reviewed-sha256=");
    expect(result.stdout).toContain("reviewed-shape=server-blocks:2");
    expect(result.stdout).toContain("proxy_pass");
    expect(result.stdout).toContain("include");
    expect(result.stdout).not.toContain(signedRedirect);
    expect(result.stdout).not.toContain(embeddedCredential);
    expect(result.stdout).not.toContain(privateInclude);
  });

  test("rejects inspection or retirement for production without a reviewed path", () => {
    const result = runDryArm(
      "https://headscale.eliza.app",
      "https://headscale.elizacloud.ai",
      ["--inspect-retirable-legacy-vhost"],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "no reviewed legacy nginx vhost is registered for headscale.eliza.app",
    );
  });

  test("requires retirement to bind the exact inspected file digest", () => {
    const missing = runDryArm(
      "https://headscale-staging.eliza.app",
      "https://headscale-staging.elizacloud.ai",
      ["--retire-retirable-legacy-vhost"],
    );
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(
      "must be the exact lowercase SHA-256 from inspection",
    );

    const changed = runLegacyVhostValidation({
      source: expectedLegacySource,
      loadedConfig: expectedLoadedConfig,
      reviewedSha256: reviewedLegacyVhostSha256,
    });
    expect(changed.status).toBe(1);
    expect(changed.stdout).toContain("bytes changed after inspection");

    const absent = runLegacyVhostValidation({ requireFile: true });
    expect(absent.status).toBe(1);
    expect(absent.stdout).toContain("is absent; refusing retirement");

    const unrelatedDirective = runLegacyVhostValidation({
      source: expectedLegacySource.replace(
        "  return 301",
        "  auth_basic off;\n  return 301",
      ),
      loadedConfig: expectedLoadedConfig,
      enforceDirectiveAllowlist: true,
    });
    expect(unrelatedDirective.status).toBe(1);
    expect(unrelatedDirective.stdout).toContain(
      "directives outside the reviewed retirement allowlist",
    );
  });

  test("accepts only the reviewed regular legacy-only two-listener contract", () => {
    const valid = runLegacyVhostValidation({
      source: expectedLegacySource,
      loadedConfig: expectedLoadedConfig,
    });
    expect(valid.status).toBe(0);
    expect(valid.stderr).toBe("");

    const absent = runLegacyVhostValidation({});
    expect(absent.status).toBe(0);

    const symlink = runLegacyVhostValidation({
      source: expectedLegacySource,
      loadedConfig: "",
      symlink: true,
    });
    expect(symlink.status).not.toBe(0);
    expect(symlink.stdout).toContain("non-regular legacy Headscale vhost");

    const unexpectedHost = runLegacyVhostValidation({
      source: expectedLegacySource.replace(
        "headscale-staging.elizacloud.ai;",
        "unrelated.example.com;",
      ),
      loadedConfig: "",
    });
    expect(unexpectedHost.status).not.toBe(0);
    expect(unexpectedHost.stdout).toContain(
      "exactly two expected legacy-only server blocks",
    );

    const wrongOwner = runLegacyVhostValidation({
      source: expectedLegacySource,
      loadedConfig: expectedLoadedConfig,
      owner: "deploy:deploy",
    });
    expect(wrongOwner.status).not.toBe(0);
    expect(wrongOwner.stdout).toContain(
      "must be root-owned and not group/world writable",
    );

    const writable = runLegacyVhostValidation({
      source: expectedLegacySource,
      loadedConfig: expectedLoadedConfig,
      writable: true,
    });
    expect(writable.status).not.toBe(0);
    expect(writable.stdout).toContain(
      "must be root-owned and not group/world writable",
    );

    const missingLoadedOwner = runLegacyVhostValidation({
      source: expectedLegacySource,
      loadedConfig: expectedLoadedConfig.replace(
        "# configuration file REPLACE_LEGACY_PATH:",
        "# configuration file /tmp/not-the-reviewed-vhost:",
      ),
    });
    expect(missingLoadedOwner.status).not.toBe(0);
    expect(missingLoadedOwner.stdout).toContain(
      "ownership no longer matches the reviewed two-listener contract",
    );
  });

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
