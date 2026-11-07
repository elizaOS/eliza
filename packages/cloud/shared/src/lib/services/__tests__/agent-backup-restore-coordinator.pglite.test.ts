/**
 * Drives the real restore coordinator turn loop over real PGlite repositories
 * from a settled quarantine container to a finalized restore, and proves the
 * fail-closed rollback before route publication (#20732).
 *
 * Remote effects (Docker over SSH, catalogue streaming with KMS, previous
 * runtime stop/start) are the injected boundary: the fake container transport
 * signs attestations with the real per-restore activation token through the
 * real core contract, so MAC verification, write-once evidence, the route
 * compare-and-swap, activation publication and the final receipt all run for
 * real. The lifecycle-revision trigger and schema checks are installed; only
 * the capture-side backup shape checks and vault-key FKs are dropped, because
 * restore reads the backup's identity columns and never writes those shapes.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const ambientDatabaseUrl = process.env.DATABASE_URL ?? "";
if (ambientDatabaseUrl && !ambientDatabaseUrl.startsWith("pglite")) {
  throw new Error(
    "agent-backup-restore-coordinator.pglite.test requires an isolated PGlite DATABASE_URL",
  );
}
process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  type AgentBackupRestoreV3ComponentReceipt,
} from "@elizaos/contracts";
import {
  type AgentBackupRestoreV3BootGrant,
  agentBackupRestoreV3TokenSha256,
  canonicalizeAgentBackupRestoreV3ServingValue,
  signAgentBackupRestoreV3Attestation,
} from "@elizaos/contracts/node";
import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import {
  buildCandidateFixture,
  buildCandidateSealReceipt,
  type CandidateFixture,
} from "../../../db/repositories/__tests__/agent-backup-restore-v3-candidate-test-fixture";
import {
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../../../db/schemas/agent-backup-catalog";
import {
  agentActivationPublications,
  agentBackupRestoreReceipts,
  agentVaultKeySeedReceipts,
} from "../../../db/schemas/agent-backup-restore-history";
import { agentNodeIncarnationHistories } from "../../../db/schemas/agent-node-incarnation-histories";
import { agentSandboxReplacementAttempts } from "../../../db/schemas/agent-sandbox-replacement-attempts";
import {
  agentBackupCatalogAuthorities,
  agentSandboxBackups,
  agentSandboxes,
} from "../../../db/schemas/agent-sandboxes";
import {
  agentVaultKeyAuthorities,
  agentVaultKeyBackupBindings,
  agentVaultKeyGenerations,
} from "../../../db/schemas/agent-vault-key-authority";
import { dockerNodes } from "../../../db/schemas/docker-nodes";
import { organizations } from "../../../db/schemas/organizations";
import { userCharacters } from "../../../db/schemas/user-characters";
import { users } from "../../../db/schemas/users";
import type { AgentBackupRestoreContainerTransport } from "../agent-backup-restore-serving-transport";
import type { SandboxRuntimeIdentity } from "../sandbox-runtime-observation";

const TEST_TIMEOUT = 600_000;
const WORKER = "restore-coordinator-test";
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const PLATFORM_DIGEST = `sha256:${"e".repeat(64)}`;
const IMAGE_REFERENCE = `ghcr.io/elizaos/eliza@${IMAGE_DIGEST}`;
const HOST_KEY = "SHA256:restoreTargetHostKey";

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests;
let coordinator: typeof import("../agent-backup-restore-coordinator");
let fixture: CandidateFixture;

async function applyMigrationStatements(name: string, filter?: (statement: string) => boolean) {
  const source = await readFile(
    new URL(`../../../db/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  for (const statement of source.split("--> statement-breakpoint")) {
    if (statement.trim() && (!filter || filter(statement))) {
      await dbWrite.execute(sql.raw(statement));
    }
  }
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  coordinator = await import("../agent-backup-restore-coordinator");
  fixture = await buildCandidateFixture();
  const { apply } = await pushSchema(
    {
      organizations,
      users,
      userCharacters,
      agentSandboxes,
      agentSandboxBackups,
      agentBackupCatalogAuthorities,
      agentBackupRestoreLeases,
      agentBackupRestoreOperations,
      agentNodeIncarnationHistories,
      dockerNodes,
      agentSandboxReplacementAttempts,
      agentActivationPublications,
      agentVaultKeySeedReceipts,
      agentBackupRestoreReceipts,
      agentVaultKeyGenerations,
      agentVaultKeyAuthorities,
      agentVaultKeyBackupBindings,
    } as never,
    dbWrite as never,
  );
  await apply();
  // Restore only reads the captured backup's identity; capture-shape checks
  // and the vault-key authority chain belong to capture tests.
  for (const [table, constraint] of [
    ["agent_sandbox_backups", "agent_sandbox_backups_catalog_shape_check"],
    ["agent_sandbox_backups", "agent_sandbox_backups_catalog_manifest_shape_check"],
    ["agent_sandbox_backups", "agent_sandbox_backups_catalog_v2_source_check"],
    ["agent_sandbox_backups", "agent_sandbox_backups_catalog_v2_source_authority_check"],
    ["agent_sandbox_backups", "agent_sandbox_backups_capture_source_occurrence_check"],
    ["agent_sandbox_backups", "agent_sandbox_backups_catalog_lease_shape_check"],
    ["agent_sandbox_backups", "agent_sandbox_backups_catalog_sizes_check"],
    ["agent_sandbox_backups", "agent_sandbox_backups_source_node_occurrence_fkey"],
    ["agent_vault_key_seed_receipts", "agent_vault_key_seed_receipts_vault_binding_fkey"],
    ["agent_activation_publications", "agent_activation_publications_backup_authority_fkey"],
  ] as const) {
    await dbWrite.execute(
      sql.raw(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`),
    );
  }
  await applyMigrationStatements("0189_agent_sandbox_lifecycle_revision_scope", (statement) =>
    statement.includes("CREATE OR REPLACE FUNCTION advance_agent_sandbox_lifecycle_revision"),
  );
  await applyMigrationStatements("0386_agent_heartbeat_lifecycle_revision");
  // Production guard triggers: every coordinator write must satisfy the same
  // monotone phase, write-once identity, activation and receipt guards.
  const triggerOnly = (statement: string) =>
    /CREATE (OR REPLACE )?(FUNCTION|TRIGGER)|DROP TRIGGER/.test(statement) &&
    !/ALTER TABLE/.test(statement);
  for (const migration of [
    "0240_agent_vault_key_generations",
    "0236_agent_sandbox_activation_quarantine",
    "0250_agent_restore_receipt_guards",
    "0252_agent_backup_restore_operation_guard",
    "0302_agent_restore_target_occurrence",
    "0326_agent_sandbox_replacement_attempt_identity_guard",
    "0327_agent_sandbox_replacement_attempt_locator_guard",
    "0328_agent_sandbox_replacement_attempt_state_guard",
    "0370_agent_sandbox_replacement_restore_locator",
    "0371_agent_vault_key_seed_receipts_per_replacement",
  ]) {
    await applyMigrationStatements(migration, triggerOnly);
  }
  const installed = await dbWrite.execute(
    sql.raw(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`),
  );
  const names = (installed as unknown as { rows: { tgname: string }[] }).rows.map(
    (row) => row.tgname,
  );
  for (const expected of [
    "agent_backup_restore_operation_guard",
    "agent_sandbox_replacement_attempts_guard_state",
    "agent_sandbox_legacy_activation_write_guard",
    "agent_activation_publications_immutable",
    "agent_sandboxes_lifecycle_revision_trigger",
  ]) {
    expect(names).toContain(expected);
  }
}, TEST_TIMEOUT);

afterAll(async () => {
  await closeDb();
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface Seed {
  readonly operationId: string;
  readonly agentId: string;
  readonly organizationId: string;
  readonly restoreAttemptId: string;
  readonly replacementAttemptId: string;
  readonly containerId: string;
  readonly token: string;
  readonly targetNodeRecordId: string;
  readonly previousNodeRecordId: string;
  readonly previousRuntime: SandboxRuntimeIdentity;
}

/**
 * Seed one restore exactly as the quarantined create leaves it: operation at
 * container_created, sandbox activation restore_pending on the created
 * container, replacement attempt provider_succeeded and its vault seed.
 */
async function seedContainerCreatedRestore(): Promise<Seed> {
  const organizationId = fixture.authority.organizationId;
  const agentId = fixture.authority.agentId;
  const restoreAttemptId = fixture.authority.restoreAttemptId;
  const backupId = fixture.authority.backupId;
  const manifestSha256 = fixture.authority.expectedManifestSha256;
  const operationId = randomUUID();
  const leaseId = fixture.authority.leaseId;
  const leaseGeneration = fixture.authority.fencingToken;
  const replacementAttemptId = randomUUID();
  const containerId = "c".repeat(63) + "1";
  const token = randomBytes(32).toString("base64url");
  const tokenSha256 = agentBackupRestoreV3TokenSha256(token);
  const [previousHistoryId, targetHistoryId] = [randomUUID(), randomUUID()];
  const [previousNodeRecordId, targetNodeRecordId] = [randomUUID(), randomUUID()];
  const [previousIncarnation, targetIncarnation] = [randomUUID(), randomUUID()];

  await dbWrite
    .insert(organizations)
    .values({ id: organizationId, name: "Org", slug: `org-${operationId}` });
  const [user] = await dbWrite
    .insert(users)
    .values({ steward_user_id: `steward-${operationId}`, organization_id: organizationId })
    .returning();
  for (const [historyId, recordId, nodeId, incarnation] of [
    [previousHistoryId, previousNodeRecordId, "previous-node", previousIncarnation],
    [targetHistoryId, targetNodeRecordId, "restore-node", targetIncarnation],
  ] as const) {
    await dbWrite.insert(agentNodeIncarnationHistories).values({
      id: historyId,
      docker_node_record_id: recordId,
      node_id: nodeId,
      node_incarnation: incarnation,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      host_key_fingerprint: HOST_KEY,
    });
    await dbWrite.insert(dockerNodes).values({
      id: recordId,
      node_id: nodeId,
      hostname: `${nodeId}.example.internal`,
      capacity: 8,
      allocated_count: 1,
      status: "healthy",
      enabled: true,
      host_key_fingerprint: HOST_KEY,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      node_incarnation: incarnation,
      current_node_history_id: historyId,
      metadata: { architecture: "amd64" },
    });
  }
  await dbWrite.insert(agentBackupCatalogAuthorities).values({
    organization_id: organizationId,
    agent_id: agentId,
    catalog_revision: 9n,
  });
  await dbWrite.insert(agentSandboxes).values({
    id: agentId,
    organization_id: organizationId,
    user_id: user!.id,
    agent_name: "restore-agent",
    status: "running",
    execution_tier: "dedicated-always",
    sandbox_id: `agent-${agentId}`,
    container_name: `agent-${agentId}`,
    node_id: "previous-node",
    bridge_port: 18790,
    web_ui_port: 20000,
    bridge_url: "http://previous-node.example.internal:18790",
    health_url: "http://previous-node.example.internal:20000/api",
    docker_image: "ghcr.io/elizaos/eliza:previous",
    image_digest: `sha256:${"a".repeat(64)}`,
  });
  await dbWrite.insert(agentSandboxBackups).values({
    id: backupId,
    sandbox_record_id: agentId,
    snapshot_type: "auto",
    state_data: {} as never,
    catalog_organization_id: organizationId,
    catalog_agent_id: agentId,
    backup_operation_id: fixture.authority.operationId,
    lifecycle_generation: fixture.authority.sourceActivationGeneration,
    lifecycle_revision: BigInt(fixture.authority.sourceLifecycleRevision),
    manifest_digest: manifestSha256,
    manifest_version: 3,
    catalog_state: "protected",
    catalog_revision: 9n,
  });
  const leaseExpiresAt = new Date(Date.now() + 3_000_000);
  await dbWrite.insert(agentBackupRestoreLeases).values({
    id: leaseId,
    organization_id: organizationId,
    agent_id: agentId,
    backup_id: backupId,
    restore_attempt_id: restoreAttemptId,
    owner_id: WORKER,
    generation: leaseGeneration,
    catalog_epoch: 9n,
    copy_role: "primary",
    operation_id: fixture.authority.operationId,
    activation_generation: fixture.authority.sourceActivationGeneration,
    lifecycle_revision: BigInt(fixture.authority.sourceLifecycleRevision),
    expected_manifest_sha256: manifestSha256,
    expires_at: leaseExpiresAt,
  });
  await dbWrite.insert(agentBackupRestoreOperations).values({
    id: operationId,
    organization_id: organizationId,
    agent_id: agentId,
    backup_id: backupId,
    restore_attempt_id: restoreAttemptId,
    lease_id: leaseId,
    lease_generation: leaseGeneration,
    lease_owner_id: WORKER,
    catalog_epoch: 9n,
    copy_role: "primary",
    phase: "container_created",
    expected_operation_id: fixture.authority.operationId,
    expected_manifest_sha256: manifestSha256,
    expected_activation_generation: fixture.authority.sourceActivationGeneration,
    expected_lifecycle_revision: BigInt(fixture.authority.sourceLifecycleRevision),
    expected_node_record_id: targetNodeRecordId,
    expected_node_incarnation: targetIncarnation,
    expected_node_history_id: targetHistoryId,
    expected_container_id: containerId,
    expected_image_digest: IMAGE_DIGEST,
    expected_image_platform: "linux/amd64",
    expected_image_reference: IMAGE_REFERENCE,
    expected_image_platform_digest: PLATFORM_DIGEST,
  });
  const containerName = `agent-restore-${agentId}-${restoreAttemptId}`;
  const [sandbox] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  await dbWrite
    .update(agentSandboxes)
    .set({
      activation_generation: restoreAttemptId,
      activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
      activation_purpose: "restore",
      activation_phase: "restore_pending",
      activation_backup_id: backupId,
      activation_backup_hash: manifestSha256,
      activation_token_hash: tokenSha256,
      activation_token_ciphertext: `test-cipher:${token}`,
      activation_container_id: containerId,
      activation_node_id: "restore-node",
      activation_image_digest: IMAGE_DIGEST,
      activation_boot_id: targetIncarnation,
    })
    .where(eq(agentSandboxes.id, agentId));
  const [attested] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  expect(attested!.lifecycle_revision).toBe(sandbox!.lifecycle_revision + 1);
  const now = new Date();
  await dbWrite.insert(agentSandboxReplacementAttempts).values({
    id: replacementAttemptId,
    organization_id: organizationId,
    agent_id: agentId,
    operation_kind: "provision",
    lifecycle_revision: BigInt(attested!.lifecycle_revision - 1),
    activation_generation: restoreAttemptId,
    restore_lease_id: leaseId,
    restore_backup_id: backupId,
    restore_attempt_id: restoreAttemptId,
    restore_lease_owner_id: WORKER,
    restore_lease_generation: leaseGeneration,
    restore_catalog_epoch: 9n,
    restore_copy_role: "primary",
    restore_operation_id: fixture.authority.operationId,
    restore_source_activation_generation: fixture.authority.sourceActivationGeneration,
    restore_source_lifecycle_revision: BigInt(fixture.authority.sourceLifecycleRevision),
    restore_manifest_sha256: manifestSha256,
    restore_lease_expires_at: leaseExpiresAt,
    state: "provider_succeeded",
    locator_sandbox_id: containerName,
    locator_node_id: "restore-node",
    locator_container_name: containerName,
    locator_node_record_id: targetNodeRecordId,
    locator_node_incarnation: targetIncarnation,
    locator_node_history_id: targetHistoryId,
    locator_node_hostname: "restore-node.example.internal",
    locator_node_ssh_port: 22,
    locator_node_ssh_user: "root",
    locator_node_host_key_fingerprint: HOST_KEY,
    locator_secret_cleanup_version: 1,
    locator_allocation_counted: true,
    locator_recorded_at: now,
    locator_container_id: containerId,
    locator_container_recorded_at: now,
    provider_started_at: now,
    provider_succeeded_at: now,
    provider_receipt_digest: "f".repeat(64),
    // Every locator/provider timestamp must follow creation on one clock.
    created_at: new Date(now.getTime() - 1_000),
    updated_at: now,
  });
  await dbWrite.insert(agentVaultKeySeedReceipts).values({
    id: randomUUID(),
    organization_id: organizationId,
    agent_id: agentId,
    restore_attempt_id: restoreAttemptId,
    replacement_attempt_id: replacementAttemptId,
    lease_id: leaseId,
    lease_owner_id: WORKER,
    lease_fencing_token: leaseGeneration,
    lease_expires_at: leaseExpiresAt,
    backup_id: backupId,
    operation_id: fixture.authority.operationId,
    source_activation_generation: fixture.authority.sourceActivationGeneration,
    source_lifecycle_revision: BigInt(fixture.authority.sourceLifecycleRevision),
    manifest_sha256: manifestSha256,
    vault_key_generation_id: randomUUID(),
    vault_key_authority_receipt_digest: "b".repeat(64),
    target_activation_generation: restoreAttemptId,
    node_history_id: targetHistoryId,
    docker_node_record_id: targetNodeRecordId,
    node_incarnation: targetIncarnation,
    receipt_digest: "9".repeat(64),
  });
  return {
    operationId,
    agentId,
    organizationId,
    restoreAttemptId,
    replacementAttemptId,
    containerId,
    token,
    targetNodeRecordId,
    previousNodeRecordId,
    previousRuntime: {
      organizationId,
      agentId,
      nodeId: "previous-node",
      nodeRecordId: previousNodeRecordId,
      nodeIncarnation: previousIncarnation,
      nodeHistoryId: previousHistoryId,
      hostname: "previous-node.example.internal",
      sshPort: 22,
      sshUser: "root",
      hostKeyFingerprint: HOST_KEY,
      containerName: `agent-${agentId}`,
      containerId: "a".repeat(64),
    },
  };
}

function candidateComponents(): AgentBackupRestoreV3ComponentReceipt[] {
  return AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map((componentName, componentIndex) => ({
    componentIndex,
    componentName,
    descriptor: AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[componentIndex]!,
    dataFrameCount: 1,
    payloadBytes: 8,
    payloadSha256: sha256(`payload-${componentIndex}`),
    recordStreamContentHmacSha256: sha256(`hmac-${componentIndex}`),
  }));
}

interface Harness {
  readonly deps: import("../agent-backup-restore-coordinator").AgentBackupRestoreCoordinatorDependencies;
  readonly calls: string[];
  forgeProbeMac: boolean;
}

function harness(seed: Seed, failures = { commitGeneration: 0 }): Harness {
  const calls: string[] = [];
  let grant: AgentBackupRestoreV3BootGrant | null = null;
  const state = { forgeProbeMac: false };
  const transport: AgentBackupRestoreContainerTransport = {
    async controller(request) {
      calls.push(`controller:${request.method}`);
      const identity = (inode: string) => ({ device: "64768", inode });
      if (request.method === "prepareRoots") {
        return {
          method: "prepareRoots",
          roots: {
            trustedRootIdentity: identity("11"),
            attemptRootIdentity: identity("12"),
            generationTrustedRootIdentity: identity("13"),
            generationRootIdentity: identity("14"),
            runtimeRootIdentity: identity("15"),
          },
        };
      }
      if (request.method === "commitGeneration") {
        if (failures.commitGeneration > 0) {
          failures.commitGeneration -= 1;
          throw Object.assign(new Error("injected lost controller response"), {
            code: "AGENT_BACKUP_RESTORE_TEST_CONTROLLER_LOST",
          });
        }
        return {
          method: "commitGeneration",
          generation: {
            preparedReceipt: { receiptSha256: "1".repeat(64) },
            preparedReceiptSha256: "1".repeat(64),
            committedReceiptSha256: "2".repeat(64),
            runtimeRootIdentity: identity("15"),
            generationTrustedRootIdentity: identity("13"),
            generationRootIdentity: identity("14"),
          },
        };
      }
      grant = request.grant;
      return {
        method: "writeBootGrant",
        grantSha256: sha256(canonicalizeAgentBackupRestoreV3ServingValue(request.grant)),
      };
    },
    async attach() {
      calls.push("attach");
      return { bridgePort: 18_801, webUiPort: 20_011, containerPort: 3000 };
    },
    async launch() {
      calls.push("launch");
    },
    async probe(request) {
      calls.push("probe");
      if (!grant) throw new Error("runtime was never granted");
      const attestation = signAgentBackupRestoreV3Attestation(
        state.forgeProbeMac && calls.filter((call) => call === "probe").length > 1
          ? randomBytes(32).toString("base64url")
          : grant.token,
        {
          version: 1,
          format: "elizaos.agent-backup.restore-v3-runtime-attestation.v1",
          agentId: grant.agentId,
          organizationId: grant.organizationId,
          restoreAttemptId: grant.restoreAttemptId,
          containerId: grant.containerId,
          nodeIncarnation: grant.nodeIncarnation,
          committedReceiptSha256: grant.generation.committedReceiptSha256,
          tokenSha256: grant.tokenSha256,
          nonce: request.nonce,
          runtimeReady: true,
          listenPort: 3000,
          characterName: "Restored persona",
        },
      );
      return attestation;
    },
    async stop() {
      calls.push("stop");
    },
  };
  const production = coordinator.createProductionCoordinatorDependencies({
    async stream(input) {
      calls.push(`stream:${input.quarantine.roots.attemptRoot}`);
      return {
        sealed: true,
        receipt: buildCandidateSealReceipt(fixture, candidateComponents()),
        session: {
          restoreAttemptId: seed.restoreAttemptId,
          operationId: fixture.authority.operationId,
          expectedManifestSha256: fixture.authority.expectedManifestSha256,
          stagingHandle: "staging-handle",
          cleanupHandle: randomUUID(),
          executionToken: "execution-token",
          cleanupRegistered: true,
          isolatedCandidate: true,
        },
      };
    },
  });
  const deps: Harness["deps"] = {
    ...production,
    sleep: async () => {},
    // Lease renewal and release re-prove the vault-key binding chain that is
    // out of scope here; their calls are recorded instead.
    renewLease: async () => {
      calls.push("renewLease");
      return undefined as never;
    },
    releaseLease: async () => {
      calls.push("releaseLease");
      return undefined as never;
    },
    encryptToken: async (_operation, token) => `test-cipher:${token}`,
    decryptToken: async (_operation, ciphertext) => ciphertext.slice("test-cipher:".length),
    prepareQuarantine: async () => {
      calls.push("prepareQuarantine");
      return {
        status: "quarantine_running",
        operationId: seed.operationId,
        replacementAttemptId: seed.replacementAttemptId,
        containerId: seed.containerId,
        providerReceiptDigest: "f".repeat(64),
        startReceiptDigest: "e".repeat(64),
        createReplayed: true,
      };
    },
    reconcileCreate: async () => {
      throw new Error("create reconciliation is not expected");
    },
    transport: () => transport,
    removeRestoreContainer: async (cleanup) => {
      calls.push(`removeRestore:${cleanup.locator.containerName}`);
    },
    previousRuntime: {
      async observe() {
        calls.push("observePrevious");
        return seed.previousRuntime;
      },
      async retainStopped() {
        calls.push("retainPrevious");
      },
      async startRetained() {
        calls.push("startPrevious");
      },
      async remove() {
        calls.push("removePrevious");
      },
    },
  };
  return {
    deps,
    calls,
    get forgeProbeMac() {
      return state.forgeProbeMac;
    },
    set forgeProbeMac(value: boolean) {
      state.forgeProbeMac = value;
    },
  };
}

const CONFIG = {
  enabled: true as const,
  workerId: WORKER,
  claimMs: 60_000,
  retryBaseMs: 1,
  maxAttempts: 3,
  automaticFailoverEnabled: false as const,
};

async function operationRow(operationId: string) {
  const [row] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId));
  return row!;
}

async function sandboxRow(agentId: string) {
  const [row] = await dbWrite.select().from(agentSandboxes).where(eq(agentSandboxes.id, agentId));
  return row!;
}

async function clearSeed(seed: Seed) {
  // Each scenario reuses the fixture's catalogue identities in a clean schema.
  // Append-only guards reject deletes by design; fixture teardown bypasses
  // triggers for this session only.
  await dbWrite.execute(sql.raw("SET session_replication_role = replica"));
  for (const table of [
    "agent_backup_restore_receipts",
    "agent_activation_publications",
    "agent_vault_key_seed_receipts",
    "agent_sandbox_replacement_attempts",
    "agent_backup_restore_operations",
    "agent_backup_restore_leases",
    "agent_sandbox_backups",
    "agent_sandboxes",
    "agent_backup_catalog_authorities",
    "docker_nodes",
    "agent_node_incarnation_histories",
    "users",
    "organizations",
  ]) {
    await dbWrite.execute(sql.raw(`DELETE FROM "${table}"`));
  }
  await dbWrite.execute(sql.raw("SET session_replication_role = origin"));
  expect(seed.operationId).toBeTruthy();
}

test(
  "walks a settled quarantine container to a finalized, routed restore",
  async () => {
    const seed = await seedContainerCreatedRestore();
    const { deps, calls } = harness(seed);
    const phases: string[] = [];
    for (let turn = 0; turn < 8; turn += 1) {
      const result = await coordinator.runAgentBackupRestoreCoordinatorTurn({
        operationId: seed.operationId,
        config: CONFIG,
        dependencies: deps,
      });
      phases.push(`${result.fromPhase}:${result.status}`);
      if (result.status === "finalized") break;
    }
    expect(phases).toEqual([
      "container_created:advanced",
      "restoring:advanced",
      "committed:advanced",
      "restart_attested:advanced",
      "probed:advanced",
      "published:finalized",
    ]);

    const operation = await operationRow(seed.operationId);
    expect(operation.phase).toBe("finalized");
    expect(operation.route_published_at).not.toBeNull();
    expect(operation.receipt_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(operation.claim_owner).toBeNull();

    const sandbox = await sandboxRow(seed.agentId);
    const containerName = `agent-restore-${seed.agentId}-${seed.restoreAttemptId}`;
    expect(sandbox.activation_phase).toBe("active");
    expect(sandbox.sandbox_id).toBe(containerName);
    expect(sandbox.container_name).toBe(containerName);
    expect(sandbox.node_id).toBe("restore-node");
    expect(sandbox.bridge_url).toBe("http://restore-node.example.internal:18801");
    expect(sandbox.health_url).toBe("http://restore-node.example.internal:20011/api");
    expect(sandbox.image_digest).toBe(IMAGE_DIGEST);
    expect(sandbox.activation_lifecycle_revision).toBe(BigInt(sandbox.lifecycle_revision));
    expect(sandbox.activation_receipt?.receiptMac).toMatch(/^[0-9a-f]{64}$/);

    const [attempt] = await dbWrite
      .select()
      .from(agentSandboxReplacementAttempts)
      .where(eq(agentSandboxReplacementAttempts.id, seed.replacementAttemptId));
    expect(attempt!.state).toBe("lifecycle_committed");
    const receipts = await dbWrite.select().from(agentBackupRestoreReceipts);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.receipt_digest).toBe(operation.receipt_digest);
    const [backup] = await dbWrite.select().from(agentSandboxBackups);
    expect(backup!.catalog_state).toBe("restore_verified");
    const [previousNode] = await dbWrite
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, seed.previousNodeRecordId));
    expect(previousNode!.allocated_count).toBe(0);

    // Remote effects ran in the only safe order: the previous runtime stops
    // before the restored one boots, and is removed only after the route CAS.
    const order = (name: string) => calls.indexOf(name);
    expect(order("retainPrevious")).toBeLessThan(order("attach"));
    expect(order("attach")).toBeLessThan(order("controller:writeBootGrant"));
    expect(order("controller:writeBootGrant")).toBeLessThan(order("launch"));
    expect(order("launch")).toBeLessThan(order("probe"));
    expect(order("removePrevious")).toBeGreaterThan(order("probe"));
    expect(calls).not.toContain("startPrevious");
    expect(calls.filter((call) => call === "probe")).toHaveLength(4);
    expect(calls).toContain("releaseLease");

    // A replayed turn on a finalized restore performs no effect.
    const before = calls.length;
    const replay = await coordinator.runAgentBackupRestoreCoordinatorTurn({
      operationId: seed.operationId,
      config: CONFIG,
      dependencies: deps,
    });
    expect(replay.status).toBe("finalized");
    expect(calls.length).toBe(before);
    await clearSeed(seed);
  },
  TEST_TIMEOUT,
);

test(
  "rolls back to the previous runtime when a probe signature is forged",
  async () => {
    const seed = await seedContainerCreatedRestore();
    const h = harness(seed);
    h.forgeProbeMac = true;
    const phases: string[] = [];
    for (let turn = 0; turn < 6; turn += 1) {
      const result = await coordinator.runAgentBackupRestoreCoordinatorTurn({
        operationId: seed.operationId,
        config: CONFIG,
        dependencies: h.deps,
      });
      phases.push(`${result.fromPhase}:${result.status}`);
      if (result.status !== "advanced") break;
    }
    expect(phases).toEqual([
      "container_created:advanced",
      "restoring:advanced",
      "committed:advanced",
      "restart_attested:rolled_back",
    ]);
    const operation = await operationRow(seed.operationId);
    expect(operation.phase).toBe("failed_terminal");
    expect(operation.last_error_code).toBe("AGENT_BACKUP_RESTORE_ATTESTATION_INVALID");
    expect(operation.route_published_at).toBeNull();

    // The canonical route never moved and the restore activation is blocked.
    const sandbox = await sandboxRow(seed.agentId);
    expect(sandbox.activation_phase).toBe("blocked");
    expect(sandbox.sandbox_id).toBe(`agent-${seed.agentId}`);
    expect(sandbox.node_id).toBe("previous-node");
    expect(sandbox.bridge_url).toBe("http://previous-node.example.internal:18790");
    expect(h.calls).toContain("stop");
    expect(h.calls.indexOf("startPrevious")).toBeGreaterThan(h.calls.indexOf("stop"));
    expect(h.calls).not.toContain("removePrevious");
    // The terminal restore frees its backup for a new restore attempt.
    expect(h.calls.at(-1)).toBe("releaseLease");

    // The failed container is removed exactly and its replacement fence and
    // node slot are released, so the agent can be restored or upgraded again.
    const containerName = `agent-restore-${seed.agentId}-${seed.restoreAttemptId}`;
    expect(h.calls).toContain(`removeRestore:${containerName}`);
    expect(h.calls.indexOf(`removeRestore:${containerName}`)).toBeGreaterThan(
      h.calls.indexOf("stop"),
    );
    const [attempt] = await dbWrite
      .select()
      .from(agentSandboxReplacementAttempts)
      .where(eq(agentSandboxReplacementAttempts.id, seed.replacementAttemptId));
    expect(attempt!.state).toBe("cleanup_proven");
    expect(attempt!.cleanup_receipt_digest).toMatch(/^[0-9a-f]{64}$/);
    const [targetNode] = await dbWrite
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, seed.targetNodeRecordId));
    expect(targetNode!.allocated_count).toBe(0);
    // A replayed sweep settles nothing twice.
    const sweep = await coordinator.runAgentBackupRestoreCoordinatorCycle({
      config: CONFIG,
      dependencies: h.deps,
    });
    expect(sweep.terminalCleanups).toBe(0);
    const [unchangedNode] = await dbWrite
      .select()
      .from(dockerNodes)
      .where(eq(dockerNodes.id, seed.targetNodeRecordId));
    expect(unchangedNode!.allocated_count).toBe(0);
    const publications = await dbWrite.select().from(agentActivationPublications);
    expect(publications).toHaveLength(0);
    await clearSeed(seed);
  },
  TEST_TIMEOUT,
);

test(
  "retries a lost pre-boot controller response and resumes the recorded phase",
  async () => {
    const seed = await seedContainerCreatedRestore();
    const h = harness(seed, { commitGeneration: 1 });
    const phases: string[] = [];
    for (let turn = 0; turn < 4; turn += 1) {
      const result = await coordinator.runAgentBackupRestoreCoordinatorTurn({
        operationId: seed.operationId,
        config: CONFIG,
        dependencies: h.deps,
      });
      phases.push(`${result.fromPhase}:${result.status}`);
      if (phases.length === 4) break;
      // The retry delay is 1 ms; wait it out on the database clock.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(phases).toEqual([
      "container_created:advanced",
      "restoring:retry_scheduled",
      "failed_retryable:advanced",
      "restoring:advanced",
    ]);
    const operation = await operationRow(seed.operationId);
    expect(operation.phase).toBe("committed");
    expect(operation.last_error_code).toBe("AGENT_BACKUP_RESTORE_TEST_CONTROLLER_LOST");
    // Nothing touched the previous runtime or the route while retrying.
    expect(h.calls).not.toContain("retainPrevious");
    const sandbox = await sandboxRow(seed.agentId);
    expect(sandbox.activation_phase).toBe("restore_pending");
    expect(sandbox.sandbox_id).toBe(`agent-${seed.agentId}`);
    await clearSeed(seed);
  },
  TEST_TIMEOUT,
);

test(
  "selects the agent's current node first and otherwise the least-loaded eligible node",
  async () => {
    const seed = await seedContainerCreatedRestore();
    const { selectAgentBackupRestoreTargetNode } = await import(
      "../../../db/repositories/agent-backup-restore-serving"
    );
    const operation = await operationRow(seed.operationId);
    expect((await selectAgentBackupRestoreTargetNode(operation))?.nodeId).toBe("previous-node");
    await dbWrite
      .update(dockerNodes)
      .set({ allocated_count: 8 })
      .where(eq(dockerNodes.id, seed.previousNodeRecordId));
    expect((await selectAgentBackupRestoreTargetNode(operation))?.nodeRecordId).toBe(
      seed.targetNodeRecordId,
    );
    await dbWrite
      .update(dockerNodes)
      .set({ placement_state: "cordoned" })
      .where(eq(dockerNodes.id, seed.targetNodeRecordId));
    expect(await selectAgentBackupRestoreTargetNode(operation)).toBeNull();
    await clearSeed(seed);
  },
  TEST_TIMEOUT,
);
