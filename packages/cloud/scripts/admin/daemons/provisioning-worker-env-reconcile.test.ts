/** Executes the workflow's atomic EnvironmentFile plan and guards its secret boundary. */
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookupSystemdEnvironmentValue } from "../systemd-environment-line.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const workflowPath = path.join(
  repoRoot,
  ".github/workflows/deploy-eliza-provisioning-worker.yml",
);
const serializerPath = path.join(
  repoRoot,
  "packages/cloud/scripts/admin/systemd-environment-line.mjs",
);
const servicePath = path.join(
  repoRoot,
  "packages/cloud/scripts/admin/eliza-backup-catalog-worker.service",
);
const workflow = readFileSync(workflowPath, "utf8");
const service = readFileSync(servicePath, "utf8");

const ENV_KEY = "SANDBOX_REGISTRY_REDIS_URL";
const FIELD_ENCRYPTION_KEY = "SECRETS_MASTER_KEY";
const BRIDGE_FALLBACK_KEY = "AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK";
const AGENT_BASE_DOMAIN_KEY = "ELIZA_CLOUD_AGENT_BASE_DOMAIN";
const VPN_REGISTRATION_TIMEOUT_KEY = "VPN_REGISTRATION_TIMEOUT_MS";
const CONTAINERS_SSH_KEY = "CONTAINERS_SSH_KEY";
const STEWARD_API_URL = "STEWARD_API_URL";
const STEWARD_PLATFORM_KEYS = "STEWARD_PLATFORM_KEYS";
const AGENT_TOKEN_PRIVATE_KEY_PEM = "AGENT_TOKEN_PRIVATE_KEY_PEM";
const AGENT_TOKEN_PRIVATE_KEY_PEM_BASE64 =
  "AGENT_TOKEN_PRIVATE_KEY_PEM_BASE64";
const AGENT_TOKEN_PRIVATE_KEY_TRANSPORT_FIXTURE = Buffer.from(
  "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n",
).toString("base64");
const DELETION_AUTHORITY_SECRET_NAMES = [
  "AGENT_BACKUP_R2_ACCESS_KEY_ID",
  "AGENT_BACKUP_R2_SECRET_ACCESS_KEY",
  "AGENT_BACKUP_HETZNER_ACCESS_KEY_ID",
  "AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY",
] as const;
const FULL_RUNTIME_SECRET_NAMES = ["AGENT_BACKUP_STEWARD_KMS_TOKEN"] as const;
const DELETION_AUTHORITY_DEFAULTS: Readonly<Record<string, string>> = {
  DATABASE_URL: "postgresql://backup:test@database.example.test/eliza",
  SECRETS_MASTER_KEY: "a".repeat(64),
  AGENT_BACKUP_R2_ENDPOINT_ALIAS: "r2-primary",
  AGENT_BACKUP_R2_ACCOUNT_ID: "r2-account",
  AGENT_BACKUP_R2_ENDPOINT: "https://r2.example.test",
  AGENT_BACKUP_R2_BUCKET: "r2-bucket",
  AGENT_BACKUP_R2_REGION: "auto",
  AGENT_BACKUP_R2_ACCESS_KEY_ID: "r2-access",
  AGENT_BACKUP_R2_SECRET_ACCESS_KEY: "r2-secret",
  AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS: "hetzner-secondary",
  AGENT_BACKUP_HETZNER_ACCOUNT_ID: "hetzner-account",
  AGENT_BACKUP_HETZNER_ENDPOINT: "https://object-storage.example.test",
  AGENT_BACKUP_HETZNER_BUCKET: "hetzner-bucket",
  AGENT_BACKUP_HETZNER_REGION: "fsn1",
  AGENT_BACKUP_HETZNER_ACCESS_KEY_ID: "hetzner-access",
  AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY: "hetzner-secret",
  AGENT_BACKUP_SPOOL_MAX_BYTES: String(8 * 1024 ** 3),
  AGENT_BACKUP_SPOOL_MIN_FREE_BYTES: String(1024 ** 3),
};

function workflowEnvs(): string[] {
  const envsLine = workflow
    .split("\n")
    .find(
      (line) => line.trim().startsWith("envs:") && line.includes("DEPLOY_SHA"),
    );
  expect(envsLine).toBeDefined();
  return (envsLine ?? "")
    .slice((envsLine ?? "").indexOf("envs:") + "envs:".length)
    .split(",")
    .map((name) => name.trim());
}

function extractAtomicReconcileBlock(): string {
  const beginMarker =
    "            # TEST-ANCHOR: atomic-environment-reconcile-begin";
  const endMarker =
    "            # TEST-ANCHOR: atomic-environment-reconcile-end";
  const begin = workflow.indexOf(beginMarker);
  const end = workflow.indexOf(endMarker);
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  const block = workflow.slice(begin + beginMarker.length, end);
  const deindented = block
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n")
    .trim();
  expect(deindented).toContain("run_environment_helper");
  expect(deindented).toContain("/usr/bin/env -i");
  expect(deindented).toContain('$ENV_SERIALIZER" install');
  expect(deindented).toContain('$ENV_SERIALIZER" reconcile');
  expect(deindented).toContain(ENV_KEY);
  expect(deindented).toContain(BRIDGE_FALLBACK_KEY);
  return deindented;
}

const atomicReconcileBlock = extractAtomicReconcileBlock();

function extractRootArtifactInstaller(): string {
  const beginMarker =
    "            # TEST-ANCHOR: root-artifact-installer-begin";
  const endMarker = "            # TEST-ANCHOR: root-artifact-installer-end";
  const begin = workflow.indexOf(beginMarker);
  const end = workflow.indexOf(endMarker);
  expect(begin).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(begin);
  return workflow
    .slice(begin + beginMarker.length, end)
    .split("\n")
    .map((line) => (line.startsWith("            ") ? line.slice(12) : line))
    .join("\n")
    .trim();
}

const rootArtifactInstaller = extractRootArtifactInstaller();
const loopEnvironmentNames = Array.from(
  new Set(
    Array.from(
      atomicReconcileBlock.matchAll(/"([A-Z0-9_]+)=\$([A-Z0-9_]+)"/g),
      (match) => {
        expect(match[1]).toBe(match[2]);
        return match[1] ?? "";
      },
    ),
  ),
).filter(Boolean);

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function installPinnedHelperWithSourceRace() {
  const directory = mkdtempSync(path.join(tmpdir(), "root-helper-install-"));
  const sourcePath = path.join(directory, "deploy-writable-helper.mjs");
  const mutationPath = path.join(directory, "mutated-helper.mjs");
  const destinationPath = path.join(
    directory,
    "root-owned",
    "systemd-environment-line.mjs",
  );
  const originalBytes = readFileSync(serializerPath);
  writeFileSync(sourcePath, originalBytes);
  writeFileSync(
    mutationPath,
    'process.stdout.write("MUTATED_SOURCE_EXECUTED");\n',
  );
  const sha256Binary = existsSync("/usr/bin/sha256sum")
    ? "/usr/bin/sha256sum"
    : "/sbin/sha256sum";
  expect(existsSync(sha256Binary)).toBe(true);
  const installer = rootArtifactInstaller.replaceAll(
    "/usr/bin/sha256sum",
    sha256Binary,
  );
  const script = [
    "set -euo pipefail",
    `TEST_SHA256_BIN=${shellLiteral(sha256Binary)}`,
    `TEST_SOURCE_PATH=${shellLiteral(sourcePath)}`,
    `TEST_MUTATION_PATH=${shellLiteral(mutationPath)}`,
    "TEST_FILE_MODE=555",
    "sudo() {",
    '  local command="$1"',
    "  shift",
    '  case "$command" in',
    "    /usr/bin/install)",
    `      if [ "\${1:-}" = "-d" ]; then`,
    `        local directory="\${!#}"`,
    '        /bin/mkdir -p -- "$directory"',
    '        /bin/chmod 0755 "$directory"',
    "        return",
    "      fi",
    '      local mode=""',
    '      local source=""',
    '      local destination=""',
    '      while [ "$#" -gt 0 ]; do',
    '        case "$1" in',
    "          -o|-g) shift 2 ;;",
    '          -m) mode="$2"; shift 2 ;;',
    '          --) shift; source="$1"; destination="$2"; break ;;',
    "          *) shift ;;",
    "        esac",
    "      done",
    '      /bin/cp -- "$source" "$destination"',
    '      /bin/chmod "$mode" "$destination"',
    `      TEST_FILE_MODE="\${mode#0}"`,
    '      if [ "$source" = "$TEST_SOURCE_PATH" ]; then',
    '        /bin/cp -- "$TEST_MUTATION_PATH" "$source"',
    "      fi",
    "      ;;",
    "    /usr/bin/stat)",
    `      local target="\${!#}"`,
    '      if [ -d "$target" ]; then',
    "        printf '%s\\n' root:root:755",
    "      else",
    "        printf 'root:root:%s\\n' \"$TEST_FILE_MODE\"",
    "      fi",
    "      ;;",
    "    /usr/bin/mv)",
    "      shift 2",
    '      /bin/mv -f -- "$1" "$2"',
    "      ;;",
    "    /usr/bin/rm)",
    '      /bin/rm "$@"',
    "      ;;",
    '    "$TEST_SHA256_BIN")',
    '      "$TEST_SHA256_BIN" "$@"',
    "      ;;",
    "    *)",
    '      printf "unexpected sudo command: %s\\n" "$command" >&2',
    "      return 1",
    "      ;;",
    "  esac",
    "}",
    "DEPLOY_SHA=0123456789abcdef0123456789abcdef01234567",
    installer,
    `install_root_verified_file ${shellLiteral(sourcePath)} ${shellLiteral(destinationPath)} ${shellLiteral(sha256(originalBytes))} 0555`,
  ].join("\n");

  try {
    execFileSync("/bin/bash", ["-c", script], {
      cwd: repoRoot,
      env: {
        PATH: "/usr/bin:/bin:/sbin",
        TMPDIR: directory,
      },
      stdio: "pipe",
      timeout: 20_000,
    });
    const execution = execFileSync(
      process.execPath,
      [destinationPath, "serialize", "PINNED_VALUE"],
      {
        cwd: repoRoot,
        env: { PATH: "/usr/bin:/bin:/sbin" },
        input: "stable",
        timeout: 20_000,
      },
    ).toString();
    return {
      destinationBytes: readFileSync(destinationPath),
      execution,
      sourceBytes: readFileSync(sourcePath),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runAtomicReconcile(options: {
  backupUnitLoadState?: "loaded" | "not-found";
  values?: Readonly<Record<string, string | undefined>>;
  seedBackupFile?: string;
  seedHostFile?: string;
}) {
  const directory = mkdtempSync(path.join(tmpdir(), "provisioning-env-plan-"));
  const hostFile = path.join(directory, "cloud.env.local");
  const backupFile = path.join(directory, "backup-catalog-worker.env");
  const eventFile = path.join(directory, "events");
  writeFileSync(hostFile, options.seedHostFile ?? "");
  writeFileSync(eventFile, "");
  if (options.seedBackupFile !== undefined) {
    writeFileSync(backupFile, options.seedBackupFile);
  }
  const values = options.values ?? {};
  const assignmentNames = new Set([
    ...loopEnvironmentNames,
    ...Object.keys(DELETION_AUTHORITY_DEFAULTS),
    AGENT_TOKEN_PRIVATE_KEY_PEM_BASE64,
  ]);
  const assignments = [...assignmentNames].map(
    (name) =>
      `${name}=${shellLiteral(
        values[name] ??
          DELETION_AUTHORITY_DEFAULTS[name] ??
          (name === AGENT_TOKEN_PRIVATE_KEY_PEM_BASE64
            ? AGENT_TOKEN_PRIVATE_KEY_TRANSPORT_FIXTURE
            : ""),
      )}`,
  );
  const script = [
    "set -euo pipefail",
    "sudo() {",
    `  if [ "\${1:-}" = "install" ] && [ "\${2:-}" = "-d" ]; then`,
    `    mkdir -p "\${!#}"`,
    "    return",
    "  fi",
    `  if [ "\${1:-}" = "stat" ]; then`,
    "    printf '%s\\n' root:root:600",
    "    return",
    "  fi",
    `  if [ "\${1:-}" = "flock" ]; then`,
    `    if [ "\${4:-}" = "$BACKUP_ENV_FILE.lock" ]; then printf '%s\\n' backup-safe-off >> "$SYSTEMCTL_TEST_LOG"; fi`,
    `    if [ "\${4:-}" = "$ENV_FILE.lock" ]; then printf '%s\\n' shared-reconcile >> "$SYSTEMCTL_TEST_LOG"; fi`,
    "    shift",
    `    if [ "\${1:-}" = "-w" ]; then shift 2; fi`,
    "    shift",
    '    "$@"',
    "    return",
    "  fi",
    `  if [ "\${1:-}" = "systemctl" ]; then`,
    `    case "\${2:-}" in`,
    `      show)`,
    `        case "$*" in`,
    `          *--property=LoadState*) printf '%s\\n' backup-load-check >> "$SYSTEMCTL_TEST_LOG"; printf '%s\\n' "$SYSTEMCTL_TEST_LOAD_STATE" ;;`,
    `          *--property=ActiveState*) printf '%s\\n' backup-active-check >> "$SYSTEMCTL_TEST_LOG"; printf '%s\\n' inactive ;;`,
    `          *--property=MainPID*) printf '%s\\n' backup-pid-check >> "$SYSTEMCTL_TEST_LOG"; printf '%s\\n' 0 ;;`,
    `        esac`,
    `        return`,
    `        ;;`,
    `      disable)`,
    `        if [ "\${3:-}" = "--now" ]; then printf '%s\\n' backup-disable-now >> "$SYSTEMCTL_TEST_LOG"; fi`,
    `        return`,
    `        ;;`,
    `      is-enabled)`,
    `        printf '%s\\n' backup-enabled-check >> "$SYSTEMCTL_TEST_LOG"`,
    `        printf '%s\\n' disabled`,
    `        return 1`,
    `        ;;`,
    `      stop) printf '%s\\n' backup-stop >> "$SYSTEMCTL_TEST_LOG"; return ;;`,
    `      kill) printf '%s\\n' backup-kill >> "$SYSTEMCTL_TEST_LOG"; return ;;`,
    `    esac`,
    "  fi",
    '  "$@"',
    "}",
    `ENV_FILE=${shellLiteral(hostFile)}`,
    `BACKUP_ENV_FILE=${shellLiteral(backupFile)}`,
    `BACKUP_SYSTEMD_UNIT=${shellLiteral("eliza-backup-catalog-worker.service")}`,
    `ENV_SERIALIZER=${shellLiteral(serializerPath)}`,
    `NODE_BIN=${shellLiteral(process.execPath)}`,
    `SAFE_CHILD_PATH=${shellLiteral(process.env.PATH ?? "/usr/bin:/bin")}`,
    `SYSTEMCTL_TEST_LOG=${shellLiteral(eventFile)}`,
    `SYSTEMCTL_TEST_LOAD_STATE=${shellLiteral(options.backupUnitLoadState ?? "loaded")}`,
    ...assignments,
    atomicReconcileBlock,
  ].join("\n");
  try {
    execFileSync("bash", ["-c", script], {
      cwd: repoRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: directory,
        POISON_PARENT_SECRET: "AKIA_DO_NOT_INHERIT_IN_HELPERS",
      },
      stdio: "pipe",
      timeout: 20_000,
    });
    return {
      host: readFileSync(hostFile, "utf8"),
      backup: readFileSync(backupFile, "utf8"),
      events: readFileSync(eventFile, "utf8").split("\n").filter(Boolean),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("provisioning deployment EnvironmentFile wiring", () => {
  it("sources, forwards, and plans every protected shared setting", () => {
    expect(workflow).toContain(`${ENV_KEY}: \${{ secrets.${ENV_KEY} }}`);
    expect(workflow).toContain(
      `${FIELD_ENCRYPTION_KEY}: \${{ secrets.${FIELD_ENCRYPTION_KEY} }}`,
    );
    expect(workflow).toContain(
      `${CONTAINERS_SSH_KEY}: \${{ secrets.${CONTAINERS_SSH_KEY} }}`,
    );
    const forwarded = workflowEnvs();
    for (const name of [
      ENV_KEY,
      FIELD_ENCRYPTION_KEY,
      CONTAINERS_SSH_KEY,
      STEWARD_API_URL,
      STEWARD_PLATFORM_KEYS,
    ]) {
      expect(forwarded).toContain(name);
      expect(workflow).toContain(`"${name}=$${name}"`);
    }
    expect(forwarded).toContain(AGENT_TOKEN_PRIVATE_KEY_PEM_BASE64);
    expect(workflow).toContain(
      `"${AGENT_TOKEN_PRIVATE_KEY_PEM}=$${AGENT_TOKEN_PRIVATE_KEY_PEM}"`,
    );
  });

  it("uses empty inherited environments and closed root checks", () => {
    expect(workflow).toContain('/usr/bin/env -i PATH="$SAFE_CHILD_PATH"');
    expect(workflow).toContain('"$NODE_BIN" "$ENV_SERIALIZER" "$@"');
    expect(workflow).toContain(
      '"$NODE_BIN" "$ENV_SERIALIZER" nonempty "$file" "$@"',
    );
    expect(workflow).toContain(
      '"$NODE_BIN" "$ENV_SERIALIZER" equals "$file" "$key"',
    );
    expect(workflow).not.toContain("lookup_environment_setting");
    expect(workflow).not.toContain('sudo cat "$ENV_FILE"');
    expect(workflow).toContain(
      "git status --porcelain --ignore-submodules=all",
    );
    expect(workflow).toContain("AGENT_BACKUP_CATALOG_RUNTIME_ENABLED=0");
    expect(workflow).toContain('DATABASE_URL="$DATABASE_URL"');
    expect(workflow).toContain(
      'DATABASE_SSL_NO_VERIFY="$DATABASE_SSL_NO_VERIFY"',
    );
  });

  it("pins privileged helper execution to an exact-SHA root-owned copy", () => {
    expect(workflow).toContain(
      "sha256sum \\\n            packages/cloud/scripts/admin/systemd-environment-line.mjs",
    );
    expect(workflow).toContain(
      "SYSTEMD_ENVIRONMENT_HELPER_SHA256=$helper_sha256",
    );
    expect(workflow).toContain(
      "ENV_SERIALIZER=/usr/local/lib/eliza-admin/systemd-environment-line.mjs",
    );
    expect(workflow).not.toMatch(
      /^\s*ENV_SERIALIZER=\/opt\/eliza\/.*systemd-environment-line\.mjs$/m,
    );
    expect(workflow).not.toContain("NODE_BIN=$(command -v node)");
    expect(workflow).toContain("NODE_BIN=/usr/bin/node");
    expect(rootArtifactInstaller).toContain(
      "sudo /usr/bin/install -d -o root -g root -m 0755",
    );
    expect(rootArtifactInstaller).toContain(
      'sudo /usr/bin/mv -fT -- "$candidate_path" "$destination_path"',
    );
    expect(rootArtifactInstaller).toContain('"root:root:$expected_stat_mode"');
    const helperInstall = workflow.indexOf(
      '"$ENV_SERIALIZER_SOURCE" \\',
      workflow.indexOf("# TEST-ANCHOR: root-artifact-installer-end"),
    );
    const firstProtectedPlan = workflow.indexOf("            for kv in \\");
    expect(helperInstall).toBeGreaterThan(-1);
    expect(firstProtectedPlan).toBeGreaterThan(helperInstall);

    const installed = installPinnedHelperWithSourceRace();
    expect(installed.sourceBytes.toString()).toContain(
      "MUTATED_SOURCE_EXECUTED",
    );
    expect(installed.destinationBytes).toEqual(readFileSync(serializerPath));
    expect(installed.execution).not.toContain("MUTATED_SOURCE_EXECUTED");
    expect(
      lookupSystemdEnvironmentValue(installed.execution, "PINNED_VALUE"),
    ).toBe("stable");
  });

  it("installs and validates the backup unit only from its root-owned exact-SHA destination", () => {
    expect(workflow).toContain(
      "sha256sum \\\n            packages/cloud/scripts/admin/eliza-backup-catalog-worker.service",
    );
    expect(workflow).toContain(
      "BACKUP_SYSTEMD_UNIT_SHA256=$backup_unit_sha256",
    );
    expect(workflow).toContain(
      'BACKUP_UNIT_DESTINATION="/etc/systemd/system/$BACKUP_SYSTEMD_UNIT"',
    );
    expect(workflow).toContain(
      'systemd-analyze verify "$BACKUP_UNIT_DESTINATION"',
    );
    expect(workflow).not.toContain(
      "systemd-analyze verify \\\n              packages/cloud/scripts/admin/eliza-backup-catalog-worker.service",
    );
    expect(workflow).toContain("--property=DynamicUser --value");
    expect(workflow).toContain("--property=User --value");
    expect(workflow).toContain("--property=Group --value");
    expect(workflow).toContain("--property=ExecStart --value");
    expect(workflow).toContain("--property=FragmentPath --value");
    expect(workflow).toContain("--property=DropInPaths --value");
    expect(workflow).toContain(
      `BACKUP_EXPECTED_DYNAMIC_USER="\${BACKUP_SYSTEMD_UNIT%.service}"`,
    );
    expect(workflow).toContain(
      '[ "$BACKUP_EFFECTIVE_USER" != "$BACKUP_EXPECTED_DYNAMIC_USER" ]',
    );
    expect(workflow).toContain(
      '[ "$BACKUP_EFFECTIVE_FRAGMENT" != "$BACKUP_UNIT_DESTINATION" ]',
    );
    expect(workflow).toContain('[ -n "$BACKUP_EFFECTIVE_DROP_INS" ]');
  });

  it("keeps activation inputs complete without reading host secrets into the shell", () => {
    const forwarded = workflowEnvs();
    const activationPlan = workflow.slice(
      workflow.indexOf(
        'if [ "$ACCOUNT_DELETION_BACKUP_AUTHORITY_GATE" = "1" ]',
      ),
      workflow.indexOf(
        "# An EnvironmentFile replacement cannot revoke authority",
      ),
    );
    const schedulerRuntimeNames = [
      "DATABASE_SSL_NO_VERIFY",
      "AGENT_BACKUP_SCHEDULE_BATCH_SIZE",
      "AGENT_BACKUP_SCHEDULE_LEASE_MS",
      "AGENT_BACKUP_SCHEDULE_RETRY_MS",
      "AGENT_BACKUP_OPERATION_BATCH_SIZE",
      "AGENT_BACKUP_OPERATION_LEASE_MS",
      "AGENT_BACKUP_OPERATION_RETRY_BASE_MS",
      "AGENT_BACKUP_OPERATION_RETRY_MAX_MS",
      "AGENT_BACKUP_GC_BATCH_SIZE",
      "AGENT_BACKUP_GC_LEASE_MS",
      "AGENT_BACKUP_GC_RETRY_BASE_MS",
      "AGENT_BACKUP_GC_RETRY_MAX_MS",
      "AGENT_BACKUP_DELETION_BATCH_SIZE",
    ];
    for (const name of schedulerRuntimeNames) {
      expect(forwarded).toContain(name);
      expect(workflow).toContain(`${name}: \${{ vars.${name} }}`);
      expect(activationPlan).toContain(`                ${name}`);
    }
    for (const name of DELETION_AUTHORITY_SECRET_NAMES) {
      expect(forwarded).toContain(name);
      expect(workflow).toContain(`${name}: \${{ secrets.${name} }}`);
    }
    for (const name of FULL_RUNTIME_SECRET_NAMES) {
      expect(forwarded).not.toContain(name);
    }
    expect(workflow).toContain(
      "Backup catalogue activation input is missing required protected setting name",
    );
  });

  it("forces safe-off before shared reconciliation and installs units last", () => {
    const safeOff = workflow.indexOf('"$NODE_BIN" "$ENV_SERIALIZER" install');
    const shared = workflow.indexOf('"$NODE_BIN" "$ENV_SERIALIZER" reconcile');
    const unitInstall = workflow.indexOf(
      "# Install units only after both EnvironmentFiles",
    );
    const reenable = workflow.indexOf(
      'sudo systemctl enable "$SYSTEMD_UNIT" eliza-agent-router.service "$BACKUP_SYSTEMD_UNIT"',
    );
    const restart = workflow.indexOf('sudo systemctl restart "$SYSTEMD_UNIT"');
    expect(safeOff).toBeGreaterThan(-1);
    const disableOld = workflow.indexOf(
      'sudo systemctl disable --now "$BACKUP_SYSTEMD_UNIT"',
    );
    const inactiveCheck = workflow.indexOf(
      '[ "$BACKUP_OLD_ACTIVE_STATE" = "inactive" ]',
    );
    const pidCheck = workflow.indexOf('[ "$BACKUP_OLD_MAIN_PID" = "0" ]');
    expect(disableOld).toBeGreaterThan(-1);
    expect(inactiveCheck).toBeGreaterThan(disableOld);
    expect(pidCheck).toBeGreaterThan(disableOld);
    expect(safeOff).toBeGreaterThan(inactiveCheck);
    expect(safeOff).toBeGreaterThan(pidCheck);
    expect(shared).toBeGreaterThan(safeOff);
    expect(unitInstall).toBeGreaterThan(shared);
    expect(reenable).toBeGreaterThan(unitInstall);
    expect(restart).toBeGreaterThan(unitInstall);
  });

  it("requires real host systemd consumption and terminal main-process fencing", () => {
    expect(workflow).toContain("systemd-analyze verify");
    expect(workflow).toContain(
      '--property="EnvironmentFile=$SYSTEMD_PROBE_ENV"',
    );
    expect(workflow).toContain(
      `[ "\${SYSTEMD_ENVIRONMENT_PROBE:-}" = expected-safe-literal ]`,
    );
    expect(workflow).toContain("--property=RestartPreventExitStatus=78");
    expect(workflow).toContain("--property=NRestarts --value");
    expect(workflow).toContain('[ "$RESTART_PROBE_STATUS" != "78" ]');
    expect(workflow).toContain('[ "$RESTART_PROBE_COUNT" != "0" ]');
    expect(service).toContain("RestartPreventExitStatus=78");
    expect(service).not.toContain("ExecStartPre=");
    expect(service).toContain("DynamicUser=yes");
    expect(service).not.toContain("User=deploy");
    expect(service).not.toContain("Group=deploy");
    expect(service).toContain("Environment=HOME=/var/lib/eliza-backup-catalog");
    expect(service).toContain("ReadOnlyPaths=/opt/eliza");
    expect(service).not.toContain("/home/deploy/.bun/bin");
    expect(workflow).not.toContain("SAFE_CHILD_PATH=/home/deploy/.bun/bin");
    expect(workflow).toContain('"$BUN_BIN" --conditions=eliza-source');
    expect(workflow).not.toMatch(
      /(?:chown|install -d -o deploy)[^\n]*(?:eliza-backup|BACKUP_)/,
    );
  });

  it("pins the router environment without reflecting its value", () => {
    expect(workflow).toContain(
      `${AGENT_BASE_DOMAIN_KEY}: \${{ needs.determine-env.outputs.environment == 'production' && 'cloud.eliza.app' || 'cloud-staging.eliza.app' }}`,
    );
    expect(workflow).toContain('"$ENV_FILE" ELIZA_CLOUD_AGENT_BASE_DOMAIN');
    expect(workflow).toContain(
      "Agent router base-domain drift. Values were not printed.",
    );
  });

  it("owns and verifies a VPN observation budget longer than the container join budget", () => {
    const forwarded = workflowEnvs();
    expect(workflow).toContain(`${VPN_REGISTRATION_TIMEOUT_KEY}: "180000"`);
    expect(forwarded).toContain(VPN_REGISTRATION_TIMEOUT_KEY);
    expect(workflow).toContain(
      `"${VPN_REGISTRATION_TIMEOUT_KEY}=$${VPN_REGISTRATION_TIMEOUT_KEY}"`,
    );
    expect(workflow).toContain(
      `"$ENV_FILE" ${VPN_REGISTRATION_TIMEOUT_KEY}`,
    );
    expect(workflow).toContain(
      "Provisioning host VPN registration timeout drift. Values were not printed.",
    );
  });
});

describe("atomic workflow block (executed verbatim)", () => {
  it("writes a supplied secret canonically and preserves unrelated settings", () => {
    const value = 'redis://new.example:6379/path?quoted="yes"&slash=\\';
    const result = runAtomicReconcile({
      values: { [ENV_KEY]: value },
      seedHostFile: `${ENV_KEY}=redis://stale.example:6379\nUNRELATED=preserved\n`,
    });
    expect(lookupSystemdEnvironmentValue(result.host, ENV_KEY)).toBe(value);
    expect(result.host.match(new RegExp(`^${ENV_KEY}=`, "gm"))).toHaveLength(1);
    expect(result.host).toContain("UNRELATED=preserved\n");
    expect(
      lookupSystemdEnvironmentValue(result.host, AGENT_TOKEN_PRIVATE_KEY_PEM),
    ).toBe(
      "-----BEGIN PRIVATE KEY-----\\nfixture\\n-----END PRIVATE KEY-----",
    );
  });

  it("preserves an existing value when GitHub supplies an empty setting", () => {
    const result = runAtomicReconcile({
      values: { [ENV_KEY]: "" },
      seedHostFile: `${ENV_KEY}=redis://hand-set.example:6379\n`,
    });
    expect(lookupSystemdEnvironmentValue(result.host, ENV_KEY)).toBe(
      "redis://hand-set.example:6379",
    );
  });

  it("removes bridge fallback, pins the lane, and strips backup authority from the shared file", () => {
    const result = runAtomicReconcile({
      seedHostFile:
        `${BRIDGE_FALLBACK_KEY}=1\nOTHER=keep\n` +
        "AGENT_BACKUP_R2_SECRET_ACCESS_KEY=must-disappear\n" +
        "AGENT_BACKUP_OPERATION_LEASE_MS=must-disappear\n",
      seedBackupFile:
        "DATABASE_URL=postgres://must-disappear\n" +
        "AGENT_BACKUP_CATALOG_RUNTIME_ENABLED=1\n",
    });
    expect(result.host).not.toContain(BRIDGE_FALLBACK_KEY);
    expect(
      lookupSystemdEnvironmentValue(result.host, "PROVISIONING_JOB_LANES"),
    ).toBe("agent");
    expect(result.host).toContain("OTHER=keep\n");
    expect(result.host).not.toContain("AGENT_BACKUP_R2_SECRET_ACCESS_KEY");
    expect(result.host).not.toContain("AGENT_BACKUP_OPERATION_LEASE_MS");
    expect(
      lookupSystemdEnvironmentValue(
        result.host,
        "ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED",
      ),
    ).toBe("0");
    expect(
      [...result.host.matchAll(/^AGENT_BACKUP_[A-Z0-9_]+=/gm)].map((match) =>
        match[0].slice(0, -1),
      ),
    ).toEqual([
      "AGENT_BACKUP_CATALOG_RUNTIME_ENABLED",
      "AGENT_BACKUP_RPO_SCHEDULER_ENABLED",
      "AGENT_BACKUP_SPOOL_STATE_DIRECTORY",
      "AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE",
    ]);
    expect(lookupSystemdEnvironmentValue(result.backup, "DATABASE_URL")).toBe(
      DELETION_AUTHORITY_DEFAULTS.DATABASE_URL,
    );
    expect(
      lookupSystemdEnvironmentValue(
        result.backup,
        "ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED",
      ),
    ).toBe("1");
    expect(
      lookupSystemdEnvironmentValue(
        result.backup,
        "AGENT_BACKUP_CATALOG_RUNTIME_ENABLED",
      ),
    ).toBe("0");
    expect(
      lookupSystemdEnvironmentValue(
        result.backup,
        "AGENT_BACKUP_RPO_SCHEDULER_ENABLED",
      ),
    ).toBe("0");
    expect(result.backup).not.toContain("AGENT_BACKUP_STEWARD_KMS_TOKEN");
    expect(result.events).toEqual([
      "backup-load-check",
      "backup-disable-now",
      "backup-active-check",
      "backup-pid-check",
      "backup-enabled-check",
      "backup-safe-off",
      "shared-reconcile",
    ]);
  });

  it("tolerates a first deployment with no previously installed backup unit", () => {
    const result = runAtomicReconcile({ backupUnitLoadState: "not-found" });

    expect(result.events).toEqual([
      "backup-load-check",
      "backup-safe-off",
      "shared-reconcile",
    ]);
    expect(
      lookupSystemdEnvironmentValue(
        result.backup,
        "ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED",
      ),
    ).toBe("1");
    expect(
      lookupSystemdEnvironmentValue(
        result.backup,
        "AGENT_BACKUP_CATALOG_RUNTIME_ENABLED",
      ),
    ).toBe("0");
  });
});
