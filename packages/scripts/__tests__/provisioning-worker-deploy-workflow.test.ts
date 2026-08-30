import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const workflow = readFileSync(
  join(root, ".github/workflows/deploy-eliza-provisioning-worker.yml"),
  "utf8",
);
const effectRegistry = readFileSync(
  join(root, ".github/develop-effects.json"),
  "utf8",
);
const surfaceGraph = readFileSync(
  join(root, ".github/develop-surface-graph.json"),
  "utf8",
);
const provisioningService = readFileSync(
  join(root, "packages/cloud/scripts/admin/eliza-provisioning-worker.service"),
  "utf8",
);
const backupService = readFileSync(
  join(
    root,
    "packages/cloud/scripts/admin/eliza-backup-catalog-worker.service",
  ),
  "utf8",
);
const backupEnvExample = readFileSync(
  join(root, "packages/cloud/shared/.env.example"),
  "utf8",
);
const systemdEnvironmentHelper = readFileSync(
  join(root, "packages/cloud/scripts/admin/systemd-environment-line.mjs"),
  "utf8",
);
const generatedKeywordServices = [
  provisioningService,
  readFileSync(
    join(root, "packages/cloud/scripts/admin/eliza-agent-router.service"),
    "utf8",
  ),
];

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  "timeout-minutes"?: number;
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  env?: Record<string, string>;
  steps?: WorkflowStep[];
  "timeout-minutes"?: number;
}

const parsedWorkflow = Bun.YAML.parse(workflow) as {
  jobs?: Record<string, WorkflowJob>;
};

function deployStep(name: string): WorkflowStep {
  const found = parsedWorkflow.jobs?.deploy?.steps?.find(
    (candidate) => candidate.name === name,
  );
  if (!found) throw new Error(`Missing deploy step: ${name}`);
  return found;
}

describe("provisioning worker deployment contract", () => {
  it("routes both jobs to the online generic self-hosted fleet", () => {
    expect(
      workflow.match(/^\s+runs-on: \[self-hosted, Linux, X64\]$/gm),
    ).toHaveLength(2);
    expect(workflow).not.toContain("HETZNER_FLEET_ONLINE");
    expect(workflow).not.toContain("ubuntu-24.04");
    expect(workflow).not.toContain("hetzner-robot");
  });

  it("resolves one immutable SHA and deploys exactly that snapshot", () => {
    expect(workflow).toContain('deployment_sha="$PUSH_SHA"');
    expect(workflow).toContain(
      'git ls-remote "https://github.com/$' + '{GITHUB_REPOSITORY}.git"',
    );
    expect(workflow).toContain(
      'fetch --no-recurse-submodules origin "$DEPLOY_SHA"',
    );
    expect(workflow).toContain('-B "$DEPLOY_BRANCH" "$DEPLOY_SHA"');
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$DEPLOY_SHA"');
    expect(workflow).toContain('git checkout "$DEPLOY_SHA" -- bun.lock');
    expect(workflow).toContain(
      "SYSTEMD_ENVIRONMENT_HELPER_SHA256=$helper_sha256",
    );
    expect(workflow).toContain(
      "BACKUP_SYSTEMD_UNIT_SHA256=$backup_unit_sha256",
    );
    expect(workflow).not.toContain(
      'origin "+$DEPLOY_BRANCH:refs/remotes/origin/$DEPLOY_BRANCH"',
    );
  });

  it("permits an auditable exact commit only through protected staging dispatch", () => {
    expect(workflow).toContain("deployment_sha:");
    expect(workflow).toContain('elif [ -n "$REQUESTED_SHA" ]; then');
    expect(workflow).toContain('[ "$TARGET_ENVIRONMENT" = "staging" ] || {');
    expect(workflow).toContain('[[ "$REQUESTED_SHA" =~ ^[0-9a-f]{40}$ ]] || {');
    expect(workflow).toContain(
      '"https://github.com/$' + '{GITHUB_REPOSITORY}.git" "$REQUESTED_SHA"',
    );
    expect(workflow).toContain('[ "$deployment_sha" = "$REQUESTED_SHA" ] || {');
    expect(workflow).toContain(
      "($" +
        "{{ needs.determine-env.outputs.environment }} @ $" +
        "{{ needs.determine-env.outputs.deployment_sha }})",
    );
  });

  it("runs canonical migrations from the exact SHA before any SSH mutation", () => {
    const checkout = workflow.indexOf(
      "- name: Checkout exact deployment source for migration gate",
    );
    const verify = workflow.indexOf("- name: Verify exact migration source");
    const migration = workflow.indexOf(
      "- name: Run exact-SHA canonical database migrations",
    );
    const firstSsh = workflow.indexOf(
      "- name: Ensure host prereqs (Node 24, swap, bunx symlink)",
    );
    const restart = workflow.indexOf('sudo systemctl restart "$SYSTEMD_UNIT"');

    expect(checkout).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(checkout);
    expect(migration).toBeGreaterThan(verify);
    expect(firstSsh).toBeGreaterThan(migration);
    expect(restart).toBeGreaterThan(firstSsh);
    expect(workflow).toContain(
      "ref: $" + "{{ needs.determine-env.outputs.deployment_sha }}",
    );
    expect(workflow).toContain(
      "EXPECTED_DEPLOY_SHA: $" +
        "{{ needs.determine-env.outputs.deployment_sha }}",
    );
    expect(workflow).toContain(
      '[ "$actual_sha" = "$EXPECTED_DEPLOY_SHA" ] || {',
    );
    const exactSourceCheck = workflow.indexOf(
      '[ "$actual_sha" = "$EXPECTED_DEPLOY_SHA" ] || {',
      verify,
    );
    const reset = workflow.indexOf(
      'git reset --hard --quiet "$EXPECTED_DEPLOY_SHA"',
      verify,
    );
    const clean = workflow.indexOf("git clean -ffdx -q", verify);
    const cleanVerdict = workflow.indexOf(
      '[ -z "$(git status --porcelain --ignore-submodules=all)" ] || {',
      verify,
    );
    expect(reset).toBeGreaterThan(exactSourceCheck);
    expect(clean).toBeGreaterThan(reset);
    expect(cleanVerdict).toBeGreaterThan(clean);
    expect(migration).toBeGreaterThan(cleanVerdict);
    expect(workflow).toContain("bun run db:cloud:migrate");
  });

  it("fails closed on missing protected DB authority and uses the pinned toolchain", () => {
    const migrationGate = workflow.slice(
      workflow.indexOf(
        "- name: Checkout exact deployment source for migration gate",
      ),
      workflow.indexOf(
        "- name: Ensure host prereqs (Node 24, swap, bunx symlink)",
      ),
    );

    expect(migrationGate).toContain(
      "Protected DATABASE_URL is required before provisioning-worker deploy",
    );
    expect(migrationGate).toContain('node-version: "24.15.0"');
    expect(migrationGate).toContain('bun-version: "1.3.14"');
    expect(migrationGate).toContain(
      "bun install --frozen-lockfile --no-save --ignore-scripts",
    );
    expect(parsedWorkflow.jobs?.deploy?.["timeout-minutes"]).toBe(125);
  });

  it("scopes protected values away from checkout, setup, and install actions", () => {
    const secretNames = [
      "DEPLOY_HOST",
      "DEPLOY_SSH_KEY",
      "HEADSCALE_API_KEY",
      "CONTAINERS_SSH_KEY",
      "SANDBOX_REGISTRY_REDIS_URL",
      "DATABASE_URL",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
      "SECRETS_MASTER_KEY",
      "AGENT_BACKUP_R2_ACCESS_KEY_ID",
      "AGENT_BACKUP_R2_SECRET_ACCESS_KEY",
      "AGENT_BACKUP_HETZNER_ACCESS_KEY_ID",
      "AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY",
      "AGENT_BACKUP_STEWARD_KMS_TOKEN",
    ];
    const deployJob = parsedWorkflow.jobs?.deploy;
    expect(deployJob).toBeDefined();
    for (const name of secretNames) {
      expect(deployJob?.env?.[name]).toBeUndefined();
    }

    for (const name of [
      "Checkout exact deployment source for migration gate",
      "Verify exact migration source",
      "Setup Node for migration gate",
      "Setup Bun for migration gate",
      "Install exact migration dependencies",
    ]) {
      const step = deployStep(name);
      for (const secretName of secretNames) {
        expect(step.env?.[secretName]).toBeUndefined();
      }
    }

    const migration = deployStep("Run exact-SHA canonical database migrations");
    expect(Object.keys(migration.env ?? {})).toEqual([
      "DATABASE_URL",
      "DATABASE_IDENTITY_GATE_MODE",
      "DATABASE_IDENTITY_ENVIRONMENT",
      "DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256",
      "DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256",
    ]);
    expect(migration.env?.DATABASE_URL).toContain("secrets.DATABASE_URL");
    expect(migration.env?.DATABASE_URL).not.toContain("env.DATABASE_URL");
    expect(migration.env?.DATABASE_IDENTITY_GATE_MODE).toContain(
      "vars.DATABASE_IDENTITY_GATE_MODE",
    );
    expect(migration.env?.DATABASE_IDENTITY_ENVIRONMENT).toContain(
      "needs.determine-env.outputs.environment",
    );
    expect(migration.env?.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256).toContain(
      "vars.DATABASE_IDENTITY_EXPECTED_CLUSTER_SHA256",
    );
    expect(
      migration.env?.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256,
    ).toContain("vars.DATABASE_IDENTITY_EXPECTED_AUTHORITY_SHA256");

    const validate = deployStep(
      "Validate canonical deploy configuration and shared secrets",
    );
    for (const name of [
      "DEPLOY_HOST",
      "DEPLOY_SSH_KEY",
      "HEADSCALE_API_KEY",
      "DATABASE_URL",
      "AGENT_TOKEN_PRIVATE_KEY_PEM",
    ]) {
      expect(validate.env?.[name]).toContain("secrets.");
    }
    expect(validate.env?.CONTAINERS_SSH_KEY).toBeUndefined();
    expect(validate.env?.SECRETS_MASTER_KEY).toBeUndefined();

    const remoteDeploy = deployStep("Deploy and restart worker");
    for (const name of [
      "HEADSCALE_API_KEY",
      "CONTAINERS_SSH_KEY",
      "SANDBOX_REGISTRY_REDIS_URL",
      "DATABASE_URL",
      "SECRETS_MASTER_KEY",
    ]) {
      expect(remoteDeploy.env?.[name]).toContain("secrets.");
    }
    expect(remoteDeploy.env?.AGENT_TOKEN_PRIVATE_KEY_PEM).toBeUndefined();
    expect(remoteDeploy.env?.AGENT_TOKEN_PRIVATE_KEY_PEM_BASE64).toContain(
      "env.AGENT_TOKEN_PRIVATE_KEY_PEM_BASE64",
    );
    const deletionAuthoritySecrets = [
      "AGENT_BACKUP_R2_ACCESS_KEY_ID",
      "AGENT_BACKUP_R2_SECRET_ACCESS_KEY",
      "AGENT_BACKUP_HETZNER_ACCESS_KEY_ID",
      "AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY",
    ];
    const forwardedNames = (remoteDeploy.with?.envs ?? "").split(",");
    expect(forwardedNames).toContain("AGENT_TOKEN_PRIVATE_KEY_PEM_BASE64");
    expect(forwardedNames).not.toContain("AGENT_TOKEN_PRIVATE_KEY_PEM");
    for (const name of deletionAuthoritySecrets) {
      expect(remoteDeploy.env?.[name]).toContain("secrets.");
      expect(forwardedNames).toContain(name);
    }
    expect(remoteDeploy.env?.AGENT_BACKUP_STEWARD_KMS_TOKEN).toBeUndefined();
    expect(forwardedNames).not.toContain("AGENT_BACKUP_STEWARD_KMS_TOKEN");
    expect(remoteDeploy.env?.DEPLOY_SSH_KEY).toBeUndefined();
    expect(remoteDeploy.with?.key).toContain(
      "secrets.ELIZA_PROVISIONING_SSH_KEY",
    );
  });

  it("bounds every pre-SSH step below the enclosing deployment fence", () => {
    const expectedBounds = new Map<string, number>([
      ["Validate canonical deploy configuration and shared secrets", 2],
      ["Checkout exact deployment source for migration gate", 5],
      ["Verify exact migration source", 1],
      ["Setup Node for migration gate", 5],
      ["Setup Bun for migration gate", 5],
      ["Install exact migration dependencies", 10],
      ["Fence current develop SHA before database mutation", 1],
      ["Run exact-SHA canonical database migrations", 10],
      ["Recheck current develop SHA before host deployment", 1],
    ]);
    let totalPreSshMinutes = 0;
    for (const [name, expectedMinutes] of expectedBounds) {
      const bound = deployStep(name)["timeout-minutes"];
      expect(bound).toBe(expectedMinutes);
      totalPreSshMinutes += bound ?? 0;
    }

    expect(totalPreSshMinutes).toBe(40);
    const remoteSteps = parsedWorkflow.jobs?.deploy?.steps?.filter((step) =>
      step.uses?.startsWith("appleboy/ssh-action@"),
    );
    const remoteBounds = (remoteSteps ?? []).map((step) => {
      const timeout = step.with?.command_timeout;
      expect(timeout).toMatch(/^\d+m$/);
      return Number.parseInt(timeout ?? "", 10);
    });
    expect(remoteBounds).toEqual([5, 40, 25]);

    const jobBound = parsedWorkflow.jobs?.deploy?.["timeout-minutes"];
    expect(jobBound).toBe(125);
    expect(
      totalPreSshMinutes + remoteBounds.reduce((sum, n) => sum + n, 0),
    ).toBeLessThan(jobBound ?? 0);
    expect(
      (jobBound ?? 0) -
        totalPreSshMinutes -
        remoteBounds.reduce((sum, n) => sum + n, 0),
    ).toBeGreaterThanOrEqual(15);
  });

  it("reports the resolved branch and immutable deployment SHA in both Discord receipts", () => {
    const receipt = [
      "description: |",
      "            Branch: $" + "{{ needs.determine-env.outputs.branch }}",
      "            Commit: $" +
        "{{ needs.determine-env.outputs.deployment_sha }}",
    ].join("\n");
    expect(workflow.split(receipt)).toHaveLength(3);
    expect(workflow).not.toContain("Branch: develop");
    expect(workflow).not.toContain("Commit: $" + "{{ github.sha }}");
  });

  it("fails checkout cleanup loudly and covers all shared-package changes", () => {
    expect(workflow).toContain("git reset --hard HEAD\n");
    expect(workflow).not.toContain("git reset --hard HEAD 2>/dev/null || true");
    expect(effectRegistry).toContain('"id": "provisioning-worker-staging"');
    expect(effectRegistry).toContain('"surfaces": ["canonical", "cloud"]');
    expect(surfaceGraph).toContain('"packages/shared"');
  });

  it("serializes the SSH mutation on the target host after runner cancellation", () => {
    expect(workflow).toContain(
      "group: deploy-eliza-provisioning-worker-mutate-$" +
        "{{ needs.determine-env.outputs.environment }}-$" +
        "{{ format('run-{0}', github.run_id) }}",
    );
    const lock = "exec 9>/tmp/eliza-provisioning-worker-deploy.lock";
    expect(workflow).toContain(lock);
    expect(workflow).toContain("flock -w 1200 9");
    expect(workflow.indexOf(lock)).toBeLessThan(
      workflow.indexOf("cd /opt/eliza"),
    );
    expect(workflow).toContain("command_timeout: 40m");
    expect(parsedWorkflow.jobs?.deploy?.["timeout-minutes"]).toBe(125);
  });

  it("regenerates before deploy and self-heals every service", () => {
    expect(workflow).toContain(
      "bash packages/cloud/scripts/admin/ensure-generated-keywords.sh",
    );
    for (const service of generatedKeywordServices) {
      expect(service).toContain(
        "ExecStartPre=/opt/eliza/packages/cloud/scripts/admin/ensure-generated-keywords.sh",
      );
    }
    // The deployment already generated the sources before systemd is
    // restarted. This unit has ProtectSystem=strict and must not attempt a
    // second write beneath /opt/eliza from its read-only ExecStartPre sandbox.
    expect(backupService).not.toContain("ensure-generated-keywords.sh");
  });

  it("builds the default-condition prompts runtime before core and restart", () => {
    const script = deployStep("Deploy and restart worker").with?.script ?? "";
    const install = script.indexOf(
      "bun install --frozen-lockfile --no-save --ignore-scripts",
    );
    const promptsLinkRemoval = script.indexOf(
      "rm -rf packages/core/node_modules/@elizaos/prompts",
    );
    const promptsLink = script.indexOf(
      "ln -s ../../../prompts packages/core/node_modules/@elizaos/prompts",
    );
    const promptsLinkIdentity = script.indexOf(
      'test "$(realpath packages/core/node_modules/@elizaos/prompts)" =',
    );
    const promptsBuild = script.indexOf(
      "bun run --cwd packages/prompts build:package",
    );
    const promptsSentinel = script.indexOf(
      "test -f packages/core/node_modules/@elizaos/prompts/dist/index.js",
    );
    const coreBuild = script.indexOf("bun run build:core");
    const firstRestart = script.indexOf(
      'sudo systemctl restart "$SYSTEMD_UNIT"',
    );

    expect(install).toBeGreaterThan(-1);
    expect(promptsLinkRemoval).toBeGreaterThan(install);
    expect(promptsLink).toBeGreaterThan(promptsLinkRemoval);
    expect(promptsLinkIdentity).toBeGreaterThan(promptsLink);
    expect(promptsBuild).toBeGreaterThan(promptsLinkIdentity);
    expect(promptsSentinel).toBeGreaterThan(promptsBuild);
    expect(coreBuild).toBeGreaterThan(promptsSentinel);
    expect(firstRestart).toBeGreaterThan(coreBuild);
  });

  it("installs the deletion-only backup worker with persistent spool and live-cycle health", () => {
    expect(workflow).toContain(
      "packages/cloud/scripts/admin/eliza-backup-catalog-worker.service",
    );
    expect(workflow).toContain(
      'sudo systemctl enable "$SYSTEMD_UNIT" eliza-agent-router.service "$BACKUP_SYSTEMD_UNIT"',
    );
    expect(workflow).toContain('sudo systemctl restart "$BACKUP_SYSTEMD_UNIT"');
    expect(workflow).toContain(
      'BACKUP_UNIT_DESTINATION="/etc/systemd/system/$BACKUP_SYSTEMD_UNIT"',
    );
    expect(workflow).toContain(
      'systemd-analyze verify "$BACKUP_UNIT_DESTINATION"',
    );
    expect(workflow).not.toMatch(
      /sudo install -m 0644 \\\s*packages\/cloud\/scripts\/admin\/eliza-backup-catalog-worker\.service/,
    );
    expect(workflow).toContain("--property=DynamicUser --value");
    expect(workflow).toContain("--property=User --value");
    expect(workflow).toContain("--property=Group --value");
    expect(workflow).toContain("--property=ExecStart --value");
    expect(workflow).toContain("--property=FragmentPath --value");
    expect(workflow).toContain("--property=DropInPaths --value");
    expect(workflow).toContain('[ -n "$BACKUP_EFFECTIVE_DROP_INS" ]');
    expect(workflow).toContain(
      `BACKUP_EXPECTED_DYNAMIC_USER="\${BACKUP_SYSTEMD_UNIT%.service}"`,
    );
    const backupDestination = workflow.indexOf(
      'BACKUP_UNIT_DESTINATION="/etc/systemd/system/$BACKUP_SYSTEMD_UNIT"',
    );
    const destinationVerify = workflow.indexOf(
      'systemd-analyze verify "$BACKUP_UNIT_DESTINATION"',
      backupDestination,
    );
    const daemonReload = workflow.indexOf(
      "sudo systemctl daemon-reload",
      destinationVerify,
    );
    const effectiveFragment = workflow.indexOf(
      "--property=FragmentPath --value",
      daemonReload,
    );
    const enable = workflow.indexOf(
      'sudo systemctl enable "$SYSTEMD_UNIT" eliza-agent-router.service "$BACKUP_SYSTEMD_UNIT"',
      effectiveFragment,
    );
    expect(backupDestination).toBeGreaterThan(-1);
    expect(destinationVerify).toBeGreaterThan(backupDestination);
    expect(daemonReload).toBeGreaterThan(destinationVerify);
    expect(effectiveFragment).toBeGreaterThan(daemonReload);
    expect(enable).toBeGreaterThan(effectiveFragment);
    expect(workflow).toContain(
      'parsed.format === "elizaos.agent-backup.catalog-worker-health.v1"',
    );
    expect(workflow).toContain('parsed.state === "idle"');
    expect(workflow).toContain("parsed.enabled === true");
    expect(workflow).toContain("Number.isSafeInteger(parsed.cycles)");
    expect(workflow).toContain("parsed.cycles >= 1");

    expect(backupService).toContain("StateDirectory=eliza-backup-catalog");
    expect(backupService).toContain("RuntimeDirectory=eliza-backup-catalog");
    expect(backupService).toContain("TimeoutStopSec=30");
    expect(backupService).toContain("KillSignal=SIGTERM");
    expect(backupService).toContain("DynamicUser=yes");
    expect(backupService).not.toContain("User=deploy");
    expect(backupService).not.toContain("Group=deploy");
    expect(backupService).toContain(
      "Environment=HOME=/var/lib/eliza-backup-catalog",
    );
    expect(backupService).toContain("ProtectHome=yes");
    expect(backupService).toContain("ReadOnlyPaths=/opt/eliza");
    expect(backupService).not.toContain("/home/deploy/.bun/bin");
    expect(workflow).not.toContain("SAFE_CHILD_PATH=/home/deploy/.bun/bin");
    expect(workflow).toContain('"$BUN_BIN" --conditions=eliza-source');
    expect(backupService).not.toContain("ExecStartPre=");
    expect(backupService).toContain("RestartPreventExitStatus=78");
    expect(workflow).toContain(
      "packages/cloud/scripts/admin/daemons/backup-catalog-worker-preflight.ts",
    );
    expect(backupService).toContain(
      "EnvironmentFile=/etc/eliza/backup-catalog-worker.env",
    );
    expect(backupService).not.toContain(
      "AGENT_BACKUP_CATALOG_RUNTIME_ENABLED=0",
    );
    expect(backupService).not.toContain("AGENT_BACKUP_RPO_SCHEDULER_ENABLED=0");
    expect(workflow).not.toMatch(
      /(?:chown|install -d -o deploy)[^\n]*(?:eliza-backup|BACKUP_)/,
    );
  });

  it("documents deletion authority and dormant capture authority names", () => {
    for (const name of [
      "DATABASE_URL",
      "SECRETS_MASTER_KEY",
      "AGENT_BACKUP_CATALOG_WORKER_ID",
      "AGENT_BACKUP_R2_ENDPOINT_ALIAS",
      "AGENT_BACKUP_R2_ACCOUNT_ID",
      "AGENT_BACKUP_R2_ENDPOINT",
      "AGENT_BACKUP_R2_BUCKET",
      "AGENT_BACKUP_R2_REGION",
      "AGENT_BACKUP_R2_ACCESS_KEY_ID",
      "AGENT_BACKUP_R2_SECRET_ACCESS_KEY",
      "AGENT_BACKUP_HETZNER_ENDPOINT_ALIAS",
      "AGENT_BACKUP_HETZNER_ACCOUNT_ID",
      "AGENT_BACKUP_HETZNER_ENDPOINT",
      "AGENT_BACKUP_HETZNER_BUCKET",
      "AGENT_BACKUP_HETZNER_REGION",
      "AGENT_BACKUP_HETZNER_ACCESS_KEY_ID",
      "AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY",
      "AGENT_BACKUP_STEWARD_KMS_BASE_URL",
      "AGENT_BACKUP_STEWARD_KMS_TOKEN",
      "AGENT_BACKUP_AGENT_SCHEMA_VERSION",
      "AGENT_BACKUP_DATABASE_SCHEMA_VERSION",
      "AGENT_BACKUP_RUNTIME_PLUGINS_JSON",
      "AGENT_BACKUP_LEGACY_WRITER_DRAIN_DEPLOYMENT_ID",
      "AGENT_BACKUP_LEGACY_WRITER_DRAINED_AT",
      "AGENT_BACKUP_STORAGE_SCOPE",
      "AGENT_BACKUP_SPOOL_STATE_DIRECTORY",
      "AGENT_BACKUP_SPOOL_MAX_BYTES",
      "AGENT_BACKUP_SPOOL_MIN_FREE_BYTES",
      "AGENT_BACKUP_SPOOL_CLEANUP_BATCH_SIZE",
      "AGENT_BACKUP_CAPTURE_DEADLINE_MS",
      "AGENT_BACKUP_OBJECT_TRANSFER_DEADLINE_MS",
    ]) {
      expect(workflow).toContain(name);
      expect(backupEnvExample).toContain(name);
    }
  });

  it("keeps capture and scheduling off while enabling only deletion backup authority", () => {
    expect(
      workflow.match(/^\s*ACCOUNT_DELETION_BACKUP_AUTHORITY_GATE=1$/gm),
    ).toHaveLength(1);
    expect(workflow.match(/^\s*BACKUP_CATALOG_RUNTIME_GATE=0$/gm)).toHaveLength(
      1,
    );
    expect(workflow.match(/^\s*BACKUP_RPO_SCHEDULER_GATE=0$/gm)).toHaveLength(
      1,
    );
    expect(workflow).not.toContain(
      "ACCOUNT_DELETION_BACKUP_AUTHORITY_GATE=${{",
    );
    expect(workflow).not.toContain("BACKUP_CATALOG_RUNTIME_GATE=${{");
    expect(workflow).not.toContain("BACKUP_RPO_SCHEDULER_GATE=${{");
    expect(workflow).toContain(
      'if [ "$ACCOUNT_DELETION_BACKUP_AUTHORITY_GATE" = "1" ] \\',
    );
    expect(workflow).toContain(
      '"$BACKUP_ENV_FILE" ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED 1',
    );
    expect(workflow).toContain(
      '"$ENV_FILE" ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED 0',
    );
    expect(workflow).toContain(
      "Verified deletion-only backup authority and disabled capture/scheduler gates; values were not printed.",
    );
  });

  it("validates complete plans before root-owned atomic EnvironmentFile replacement", () => {
    expect(workflow).toContain("printf '%s' \"$value\" \\");
    expect(workflow).toContain('| run_environment_helper serialize "$key" \\');
    expect(workflow).toContain('sudo flock -w 120 "$ENV_FILE.lock" \\');
    expect(workflow).toContain('"$NODE_BIN" "$ENV_SERIALIZER" reconcile \\');
    expect(workflow).toContain('sudo flock -w 120 "$BACKUP_ENV_FILE.lock" \\');
    expect(workflow).toContain('"$NODE_BIN" "$ENV_SERIALIZER" install \\');
    expect(workflow).not.toContain(
      'printf \'%s=%s\\n\' "$key" "$val" | sudo tee -a "$ENV_FILE"',
    );
    expect(workflow).not.toMatch(/sudo sed -i [^\n]*"\$ENV_FILE"/);
    expect(workflow).not.toMatch(/sudo tee -a "\$ENV_FILE"/);

    const safeOffReplacement = workflow.indexOf(
      'sudo flock -w 120 "$BACKUP_ENV_FILE.lock"',
    );
    const oldProcessDisable = workflow.indexOf(
      'sudo systemctl disable --now "$BACKUP_SYSTEMD_UNIT"',
    );
    const inactiveCheck = workflow.indexOf(
      '[ "$BACKUP_OLD_ACTIVE_STATE" = "inactive" ]',
      oldProcessDisable,
    );
    const pidCheck = workflow.indexOf(
      '[ "$BACKUP_OLD_MAIN_PID" = "0" ]',
      oldProcessDisable,
    );
    const disabledCheck = workflow.indexOf(
      '[ "$BACKUP_OLD_ENABLE_STATE" != "disabled" ]',
      oldProcessDisable,
    );
    const firstAtomicReplacement = workflow.indexOf(
      'sudo flock -w 120 "$ENV_FILE.lock"',
    );
    expect(oldProcessDisable).toBeGreaterThan(-1);
    expect(inactiveCheck).toBeGreaterThan(oldProcessDisable);
    expect(pidCheck).toBeGreaterThan(oldProcessDisable);
    expect(disabledCheck).toBeGreaterThan(oldProcessDisable);
    expect(safeOffReplacement).toBeGreaterThan(inactiveCheck);
    expect(safeOffReplacement).toBeGreaterThan(pidCheck);
    expect(safeOffReplacement).toBeGreaterThan(disabledCheck);
    expect(firstAtomicReplacement).toBeGreaterThan(safeOffReplacement);
    expect(firstAtomicReplacement).toBeGreaterThan(
      workflow.indexOf('if [ "$BACKUP_CATALOG_RUNTIME_GATE" = "1" ]; then'),
    );

    const reconcileFunction = systemdEnvironmentHelper.slice(
      systemdEnvironmentHelper.indexOf(
        "export function reconcileSystemdEnvironmentFile",
      ),
      systemdEnvironmentHelper.indexOf("async function readStdinBounded"),
    );
    const write = reconcileFunction.indexOf("writeFileSync(descriptor");
    const chmod = reconcileFunction.indexOf("chmodSync(candidatePath, 0o600)");
    const chown = reconcileFunction.indexOf("chownSync(candidatePath");
    const injection = reconcileFunction.indexOf(
      "beforeRename?.(candidatePath, attempt)",
    );
    const rename = reconcileFunction.indexOf(
      "renameSync(candidatePath, targetPath)",
    );
    expect(write).toBeGreaterThan(-1);
    expect(chmod).toBeGreaterThan(write);
    expect(chown).toBeGreaterThan(chmod);
    expect(injection).toBeGreaterThan(chown);
    expect(rename).toBeGreaterThan(injection);
  });

  it("installs an exact deletion-only allowlist without capture or host authority", () => {
    expect(workflow).toContain(
      "BACKUP_ENV_FILE=/etc/eliza/backup-catalog-worker.env",
    );
    expect(workflow).toContain(
      'sudo install -d -o root -g root -m 0755 "$(dirname "$BACKUP_ENV_FILE")"',
    );
    expect(workflow).toContain(
      '"$(sudo stat -c \'%U:%G:%a\' "$BACKUP_ENV_FILE")" != "root:root:600"',
    );

    const fixedPlan = workflow.slice(
      workflow.indexOf(
        "# The backup daemon receives a separate exact allowlist.",
      ),
      workflow.indexOf(
        'if [ "$ACCOUNT_DELETION_BACKUP_AUTHORITY_GATE" = "1" ]',
      ),
    );
    const fixedNames = [
      "AGENT_BACKUP_CATALOG_RUNTIME_ENABLED",
      "AGENT_BACKUP_RPO_SCHEDULER_ENABLED",
      "AGENT_BACKUP_CATALOG_WORKER_INTERVAL_MS",
      "AGENT_BACKUP_CATALOG_WORKER_RETRY_MS",
      "AGENT_BACKUP_CATALOG_WORKER_SHUTDOWN_TIMEOUT_MS",
      "AGENT_BACKUP_SPOOL_STATE_DIRECTORY",
      "AGENT_BACKUP_CATALOG_WORKER_HEALTH_FILE",
    ];
    expect(fixedPlan).toContain("ACCOUNT_DELETION_BACKUP_AUTHORITY_ENABLED");
    for (const name of fixedNames) {
      expect(fixedPlan).toContain(name);
    }
    const plannedFixedNames = [
      ...new Set(
        [...fixedPlan.matchAll(/\bAGENT_BACKUP_[A-Z0-9_]+\b/g)].map(
          (match) => match[0],
        ),
      ),
    ].sort();
    expect(plannedFixedNames).toEqual([...fixedNames].sort());

    const authorityPlan = workflow.slice(
      workflow.indexOf("authority_backup_names=("),
      workflow.indexOf('if [ "$BACKUP_CATALOG_RUNTIME_GATE" = "1" ]; then'),
    );
    for (const required of [
      "DATABASE_URL",
      "SECRETS_MASTER_KEY",
      "AGENT_BACKUP_R2_ACCESS_KEY_ID",
      "AGENT_BACKUP_R2_SECRET_ACCESS_KEY",
      "AGENT_BACKUP_HETZNER_ACCESS_KEY_ID",
      "AGENT_BACKUP_HETZNER_SECRET_ACCESS_KEY",
      "AGENT_BACKUP_SPOOL_MAX_BYTES",
      "AGENT_BACKUP_SPOOL_MIN_FREE_BYTES",
    ]) {
      expect(authorityPlan).toContain(required);
    }
    for (const forbidden of [
      "AGENT_BACKUP_STEWARD_KMS_TOKEN",
      "CONTAINERS_SSH_KEY",
      "HEADSCALE_API_KEY",
      "SANDBOX_REGISTRY_REDIS_URL",
    ]) {
      expect(authorityPlan).not.toContain(forbidden);
    }

    const sharedAssignmentLoopStart = workflow.indexOf(
      "            for kv in \\",
    );
    const sharedAssignmentLoopEnd = workflow.indexOf(
      '"DATABASE_SSL_NO_VERIFY=$DATABASE_SSL_NO_VERIFY"; do',
      sharedAssignmentLoopStart,
    );
    const sharedAssignmentLoop = workflow.slice(
      sharedAssignmentLoopStart,
      sharedAssignmentLoopEnd,
    );
    expect(sharedAssignmentLoopStart).toBeGreaterThan(-1);
    expect(sharedAssignmentLoopEnd).toBeGreaterThan(sharedAssignmentLoopStart);
    expect(sharedAssignmentLoop).not.toContain("AGENT_BACKUP_");
    expect(workflow).toContain("shared_backup_only_names=(");
    expect(workflow).toContain(
      'remove_environment_setting "$ENV_REPLACEMENTS" "$name"',
    );

    const runtimeAllowlist = workflow.slice(
      workflow.indexOf("runtime_backup_names=("),
      workflow.indexOf(
        "# An EnvironmentFile replacement cannot revoke authority",
      ),
    );
    expect(runtimeAllowlist).toContain("AGENT_BACKUP_STEWARD_KMS_TOKEN");
    for (const forbidden of [
      "DATABASE_URL",
      "SECRETS_MASTER_KEY",
      "CONTAINERS_SSH_KEY",
      "HEADSCALE_API_KEY",
      "SANDBOX_REGISTRY_REDIS_URL",
    ]) {
      expect(runtimeAllowlist).not.toContain(forbidden);
    }
  });

  it("does not offer a value-returning EnvironmentFile CLI command", () => {
    expect(systemdEnvironmentHelper).not.toContain('command === "lookup"');
    expect(systemdEnvironmentHelper).toContain('command === "nonempty"');
    expect(systemdEnvironmentHelper).toContain('command === "equals"');
  });

  it("compares the canonical domain inside the root helper without returning values", () => {
    const healthStep = workflow.slice(workflow.indexOf("- name: Health check"));
    expect(workflow).not.toContain("NODE_BIN=$(command -v node)");
    expect(workflow).not.toMatch(
      /^\s*ENV_SERIALIZER=\/opt\/eliza\/.*systemd-environment-line\.mjs$/m,
    );
    expect(healthStep).toContain("NODE_BIN=/usr/bin/node");
    expect(healthStep).toContain(
      "ENV_SERIALIZER=/usr/local/lib/eliza-admin/systemd-environment-line.mjs",
    );
    expect(healthStep).toContain("root:root:555");
    expect(healthStep).toContain("HEALTH_HELPER_SHA256");
    expect(healthStep).toContain('"$NODE_BIN" "$ENV_SERIALIZER" equals \\');
    expect(healthStep).toContain('"$ENV_FILE" ELIZA_CLOUD_AGENT_BASE_DOMAIN');
    expect(healthStep).not.toContain(" lookup ");
    expect(healthStep).not.toMatch(/awk[^\n]*ELIZA_CLOUD_AGENT_BASE_DOMAIN/);
    expect(healthStep).toContain(
      "Agent router base-domain drift. Values were not printed.",
    );
    expect(healthStep).not.toContain("found ${ACTUAL_AGENT_BASE_DOMAIN");
    expect(healthStep).toContain(
      'sudo /usr/bin/env -i PATH="$SAFE_CHILD_PATH" "$NODE_BIN" -e',
    );
    expect(healthStep).toContain(
      'readFileSync("/run/eliza-backup-catalog/health.json")',
    );
    expect(healthStep).not.toContain(
      "test -s /run/eliza-backup-catalog/health.json",
    );
    expect(healthStep).not.toContain("< /run/eliza-backup-catalog/health.json");
  });

  it("reconciles WARM_POOL_ENABLED from the protected environment so re-arms cannot drop it (#16961)", () => {
    // The daemon replenish phase self-gates on this key; if a re-arm rebuilds
    // /opt/eliza/cloud/.env.local without it, every dedicated provision
    // silently falls back to the 30-120s cold path. The flag must flow from
    // the GitHub environment VARIABLE through the SSH env passthrough into the
    // EnvironmentFile reconcile loop. An absent protected variable must force
    // the safe disabled state instead of preserving unknown host drift.
    expect(workflow).toContain(
      "WARM_POOL_ENABLED: $" + "{{ vars.WARM_POOL_ENABLED || 'false' }}",
    );
    expect(workflow).toMatch(/envs: [^\n]*\bWARM_POOL_ENABLED\b/);
    expect(workflow).toContain('"WARM_POOL_ENABLED=$WARM_POOL_ENABLED" \\');
    expect(workflow).toContain('case "$WARM_POOL_ENABLED" in');
    expect(workflow).toContain(
      '"$ENV_FILE" WARM_POOL_ENABLED "$WARM_POOL_ENABLED"',
    );
    expect(workflow).toContain(
      "Verified provisioning-host warm-pool state: $WARM_POOL_ENABLED",
    );
    const healthStep = workflow.slice(workflow.indexOf("- name: Health check"));
    expect(healthStep).toMatch(/envs: [^\n]*\bWARM_POOL_ENABLED\b/);
    expect(healthStep).toContain('"$ENV_FILE" WARM_POOL_ENABLED');
    expect(healthStep).toContain(
      "Provisioning host warm-pool drift. Values were not printed.",
    );
  });

  it("keeps the Worker warm-pool claim flag committed per wrangler environment (#16961)", () => {
    const wranglerToml = readFileSync(
      join(root, "packages/cloud/api/wrangler.toml"),
      "utf8",
    );
    // A dashboard-only var disappears on redeploy; the intended state must be
    // an explicit committed value in every environment block.
    const occurrences = wranglerToml.match(
      /^WARM_POOL_ENABLED = "(?:true|false)"$/gm,
    );
    expect(occurrences).not.toBeNull();
    expect((occurrences ?? []).length).toBe(3);
  });

  it("checks the canonical router only after local readiness and fails with diagnostics", () => {
    const routerPort = "$" + "{ROUTER_PORT}";
    const publicHost = "$" + "{AGENT_ROUTER_PUBLIC_HOST}";
    const healthStep = workflow.indexOf("- name: Health check");
    const localHealth = workflow.indexOf(
      `curl -sf -m 3 "http://127.0.0.1:${routerPort}/healthz"`,
    );
    const localReadiness = workflow.indexOf(
      `curl -sf -m 3 "http://127.0.0.1:${routerPort}/readyz"`,
    );
    const canonicalHealth = workflow.indexOf(
      `curl -fsS -m 5 "https://${publicHost}/healthz"`,
    );
    const canonicalReadiness = workflow.indexOf(
      `curl -fsS -m 5 "https://${publicHost}/readyz"`,
    );

    expect(healthStep).toBeGreaterThan(-1);
    expect(localHealth).toBeGreaterThan(healthStep);
    expect(localReadiness).toBeGreaterThan(localHealth);
    expect(canonicalHealth).toBeGreaterThan(localReadiness);
    expect(canonicalReadiness).toBeGreaterThan(canonicalHealth);
    expect(workflow.slice(0, healthStep)).not.toContain(
      `"https://${publicHost}/healthz"`,
    );
    expect(workflow).toContain(
      "Canonical agent-router route failed after local readiness",
    );
    expect(workflow).toContain("Canonical agent-router health contract failed");
    expect(workflow).toContain(
      "Canonical agent-router readiness contract failed",
    );
    expect(workflow).toContain("report_unit_diagnostic public-route");
  });

  it("settles both public-route failure branches with diagnostics then exit 1", () => {
    // Both the transport-failure branch and the unexpected-payload branch
    // must run diagnostics and then terminate the deployment immediately;
    // a mutation that logs diagnostics and continues must fail here.
    const failFast = [
      ...workflow.matchAll(/report_public_route_failure\n\s*exit 1\b/g),
    ];
    expect(failFast).toHaveLength(3);
    // The transport probe is bounded: a short retry absorbs one-off blips
    // without reintroducing the blind 30-attempt loop this PR removed.
    expect(workflow).toContain("for public_attempt in 1 2 3; do");
    expect(workflow).not.toContain("for attempt in $(seq 1 30)");
  });

  it("rejects non-JSON and malformed public health payloads", () => {
    // Execute the actual validator embedded in the workflow rather than
    // asserting on its text, so a regression to substring matching fails.
    const validator = workflow.match(
      /validate_public_health_payload\(\) \{\n\s*\/usr\/bin\/env -i PATH="\$SAFE_CHILD_PATH" "\$NODE_BIN" -e '([\s\S]*?)'\n\s*\}/,
    );
    expect(validator).not.toBeNull();
    const script = (validator as RegExpMatchArray)[1];

    const runValidator = (payload: string): number => {
      const proc = Bun.spawnSync(["node", "-e", script], {
        stdin: Buffer.from(payload),
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          TMPDIR: "/tmp",
          NODE_ENV: "test",
        },
      });
      return proc.exitCode;
    };

    expect(runValidator('{"ok":true}')).toBe(0);
    expect(runValidator('{ "ok" : true, "uptime": 12 }')).toBe(0);
    // HTTP-200 HTML error page containing the healthy substring must fail.
    expect(
      runValidator('<html><body>router says "ok": true</body></html>'),
    ).not.toBe(0);
    expect(runValidator('{"ok":false}')).not.toBe(0);
    expect(runValidator('{"ok":"true"}')).not.toBe(0);
    expect(runValidator('[{"ok":true}]')).not.toBe(0);
    expect(runValidator("null")).not.toBe(0);
    expect(runValidator("")).not.toBe(0);
  });

  it("keeps replacement workload memory inside the control-plane service fence", () => {
    const oldSpaceMatches = [
      ...provisioningService.matchAll(
        /^Environment=NODE_OPTIONS=--max-old-space-size=(\d+)$/gm,
      ),
    ];
    const memoryHighMatches = [
      ...provisioningService.matchAll(/^MemoryHigh=(\d+)M$/gm),
    ];
    const memoryMaxMatches = [
      ...provisioningService.matchAll(/^MemoryMax=(\d+)M$/gm),
    ];

    expect(oldSpaceMatches).toHaveLength(1);
    expect(memoryHighMatches).toHaveLength(1);
    expect(memoryMaxMatches).toHaveLength(1);

    const oldSpaceMiB = Number(oldSpaceMatches[0]?.[1]);
    const memoryHighMiB = Number(memoryHighMatches[0]?.[1]);
    const memoryMaxMiB = Number(memoryMaxMatches[0]?.[1]);

    expect(oldSpaceMiB).toBe(1536);
    expect(memoryHighMiB).toBe(1792);
    expect(memoryMaxMiB).toBe(2048);
    expect(oldSpaceMiB).toBeLessThan(memoryHighMiB);
    expect(memoryHighMiB).toBeLessThan(memoryMaxMiB);
    expect(memoryHighMiB - oldSpaceMiB).toBeGreaterThanOrEqual(256);
    expect(memoryMaxMiB - oldSpaceMiB).toBeGreaterThanOrEqual(512);
  });
});
