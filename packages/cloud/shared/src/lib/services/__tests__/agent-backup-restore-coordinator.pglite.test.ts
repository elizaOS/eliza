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

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
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
async function seedContainerCreatedRestore(
  options: {
    unresolved?: boolean;
    observedContainer?: boolean;
    sourceFixture?: CandidateFixture;
    namespace?: string;
  } = {},
): Promise<Seed> {
  const sourceFixture = options.sourceFixture ?? fixture;
  const previousNodeId = options.namespace ? `previous-${options.namespace}` : "previous-node";
  const targetNodeId = options.namespace ? `restore-${options.namespace}` : "restore-node";
  const organizationId = sourceFixture.authority.organizationId;
  const agentId = sourceFixture.authority.agentId;
  const restoreAttemptId = sourceFixture.authority.restoreAttemptId;
  const backupId = sourceFixture.authority.backupId;
  const manifestSha256 = sourceFixture.authority.expectedManifestSha256;
  const operationId = randomUUID();
  const leaseId = sourceFixture.authority.leaseId;
  const leaseGeneration = sourceFixture.authority.fencingToken;
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
    [previousHistoryId, previousNodeRecordId, previousNodeId, previousIncarnation],
    [targetHistoryId, targetNodeRecordId, targetNodeId, targetIncarnation],
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
    node_id: previousNodeId,
    bridge_port: 18790,
    web_ui_port: 20000,
    bridge_url: `http://${previousNodeId}.example.internal:18790`,
    health_url: `http://${previousNodeId}.example.internal:20000/api`,
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
    backup_operation_id: sourceFixture.authority.operationId,
    lifecycle_generation: sourceFixture.authority.sourceActivationGeneration,
    lifecycle_revision: BigInt(sourceFixture.authority.sourceLifecycleRevision),
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
    operation_id: sourceFixture.authority.operationId,
    activation_generation: sourceFixture.authority.sourceActivationGeneration,
    lifecycle_revision: BigInt(sourceFixture.authority.sourceLifecycleRevision),
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
    phase: options.unresolved ? "vault_seeded" : "container_created",
    expected_operation_id: sourceFixture.authority.operationId,
    expected_manifest_sha256: manifestSha256,
    expected_activation_generation: sourceFixture.authority.sourceActivationGeneration,
    expected_lifecycle_revision: BigInt(sourceFixture.authority.sourceLifecycleRevision),
    expected_node_record_id: targetNodeRecordId,
    expected_node_incarnation: targetIncarnation,
    expected_node_history_id: targetHistoryId,
    expected_container_id: options.unresolved ? null : containerId,
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
  if (!options.unresolved)
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
        activation_node_id: targetNodeId,
        activation_image_digest: IMAGE_DIGEST,
        activation_boot_id: targetIncarnation,
      })
      .where(eq(agentSandboxes.id, agentId));
  const [attested] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, agentId));
  expect(attested!.lifecycle_revision).toBe(
    sandbox!.lifecycle_revision + (options.unresolved ? 0 : 1),
  );
  const now = new Date();
  await dbWrite.insert(agentSandboxReplacementAttempts).values({
    id: replacementAttemptId,
    organization_id: organizationId,
    agent_id: agentId,
    operation_kind: "provision",
    lifecycle_revision: BigInt(attested!.lifecycle_revision - (options.unresolved ? 0 : 1)),
    activation_generation: restoreAttemptId,
    restore_lease_id: leaseId,
    restore_backup_id: backupId,
    restore_attempt_id: restoreAttemptId,
    restore_lease_owner_id: WORKER,
    restore_lease_generation: leaseGeneration,
    restore_catalog_epoch: 9n,
    restore_copy_role: "primary",
    restore_operation_id: sourceFixture.authority.operationId,
    restore_source_activation_generation: sourceFixture.authority.sourceActivationGeneration,
    restore_source_lifecycle_revision: BigInt(sourceFixture.authority.sourceLifecycleRevision),
    restore_manifest_sha256: manifestSha256,
    restore_lease_expires_at: leaseExpiresAt,
    state: options.unresolved ? "in_flight_unresolved" : "provider_succeeded",
    locator_sandbox_id: containerName,
    locator_node_id: targetNodeId,
    locator_container_name: containerName,
    locator_node_record_id: targetNodeRecordId,
    locator_node_incarnation: targetIncarnation,
    locator_node_history_id: targetHistoryId,
    locator_node_hostname: `${targetNodeId}.example.internal`,
    locator_node_ssh_port: 22,
    locator_node_ssh_user: "root",
    locator_node_host_key_fingerprint: HOST_KEY,
    locator_secret_cleanup_version: 1,
    locator_allocation_counted: true,
    locator_recorded_at: now,
    locator_container_id: options.unresolved && !options.observedContainer ? null : containerId,
    locator_container_recorded_at: options.unresolved && !options.observedContainer ? null : now,
    provider_started_at: now,
    provider_succeeded_at: options.unresolved ? null : now,
    provider_receipt_digest: options.unresolved ? null : "f".repeat(64),
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
    operation_id: sourceFixture.authority.operationId,
    source_activation_generation: sourceFixture.authority.sourceActivationGeneration,
    source_lifecycle_revision: BigInt(sourceFixture.authority.sourceLifecycleRevision),
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
      nodeId: previousNodeId,
      nodeRecordId: previousNodeRecordId,
      nodeIncarnation: previousIncarnation,
      nodeHistoryId: previousHistoryId,
      hostname: `${previousNodeId}.example.internal`,
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

async function expireUnresolvedRestore(seed: Seed) {
  const { abandonAgentBackupRestoreWithExpiredLease, listAgentBackupRestoreTerminalCleanups } =
    await import("../../../db/repositories/agent-backup-restore-serving");
  await dbWrite.update(agentBackupRestoreLeases).set({
    created_at: new Date(Date.now() - 120_000),
    expires_at: new Date(Date.now() - 60_000),
  });
  expect((await abandonAgentBackupRestoreWithExpiredLease(seed.operationId))?.phase).toBe(
    "failed_terminal",
  );
  expect(await listAgentBackupRestoreTerminalCleanups({ ownerId: WORKER, limit: 10 })).toEqual([
    seed.operationId,
  ]);
}

/** Only SSH is controlled: the real provider verifies node identity and every
 * tombstone/inspect/observation/removal receipt over real repository state. */
async function exactCleanupTransport(seed: Seed) {
  const { DockerSSHClient } = await import("../docker-ssh");
  const proof = await import("../docker-sandbox-utils");
  const containerName = `agent-restore-${seed.agentId}-${seed.restoreAttemptId}`;
  const state = {
    live: false,
    quiescent: false,
    observed: false,
    removed: 0,
    commands: [] as string[],
    loseVolumeResponse: false,
  };
  const dedicated = spyOn(DockerSSHClient, "createDedicated").mockImplementation(
    () =>
      ({
        async exec(command: string) {
          state.commands.push(command);
          const volumeReceipt = proof.getExactRestoreStagingVolumeCleanupReceipt(
            seed.replacementAttemptId,
            seed.restoreAttemptId,
          );
          if (command.includes(volumeReceipt)) {
            expect(state.live).toBe(false);
            if (state.loseVolumeResponse) {
              state.loseVolumeResponse = false;
              throw new Error("SSH response lost after exact removal");
            }
            return volumeReceipt;
          }
          const purgeReceipt = proof.getReplacementSecretArtifactsCleanupReceipt(
            seed.replacementAttemptId,
          );
          if (command.includes(purgeReceipt)) {
            return [
              purgeReceipt,
              ...(state.quiescent
                ? [proof.getReplacementDockerCreateQuiescentReceipt(seed.replacementAttemptId)]
                : []),
              ...(state.observed
                ? [
                    proof.getReplacementCandidateObservedReceipt(
                      seed.replacementAttemptId,
                      seed.containerId,
                    ),
                  ]
                : []),
            ].join("\n");
          }
          const observedReceipt = proof.getReplacementCandidateObservedReceipt(
            seed.replacementAttemptId,
            seed.containerId,
          );
          if (command.includes(observedReceipt)) {
            state.observed = true;
            return observedReceipt;
          }
          if (command.includes("docker inspect --format")) {
            if (!state.live) throw new Error(`Error: No such container: ${containerName}`);
            return `${seed.containerId}|${seed.replacementAttemptId}|/${containerName}|2026-01-01T00:00:00Z`;
          }
          if (command.includes("docker stop -t")) return "";
          if (command.includes("docker rm -f")) {
            expect(command).toContain(seed.containerId);
            state.live = false;
            state.removed += 1;
            return "";
          }
          throw new Error(`Unexpected exact cleanup command: ${command.slice(0, 120)}`);
        },
        async disconnect() {},
      }) as never,
  );
  return { state, restore: () => dedicated.mockRestore() };
}

async function replacementRow(seed: Seed) {
  const [row] = await dbWrite
    .select()
    .from(agentSandboxReplacementAttempts)
    .where(eq(agentSandboxReplacementAttempts.id, seed.replacementAttemptId));
  return row!;
}

async function allocatedCount(seed: Seed) {
  const [row] = await dbWrite
    .select()
    .from(dockerNodes)
    .where(eq(dockerNodes.id, seed.targetNodeRecordId));
  return row!.allocated_count;
}

test(
  "terminal unresolved create stays quarantined until the delayed daemon candidate is removed",
  async () => {
    const seed = await seedContainerCreatedRestore({ unresolved: true });
    const ssh = await exactCleanupTransport(seed);
    const deps = coordinator.createProductionCoordinatorDependencies();
    try {
      await expireUnresolvedRestore(seed);
      const first = await coordinator.cleanupTerminalAgentBackupRestore(deps, seed.operationId);
      expect(first).toMatchObject({ status: "quarantined", reason: "daemon_outcome_unresolved" });
      expect((await replacementRow(seed)).state).toBe("cleanup_in_progress");
      expect(await allocatedCount(seed)).toBe(1);

      // The daemon completes a submitted create AFTER its caller and lease ended.
      // Both the exact created callback and success callback remain fenced.
      ssh.state.live = true;
      const { beginAgentBackupRestoreTerminalCleanup } = await import(
        "../../../db/repositories/agent-backup-restore-serving"
      );
      const fenced = await beginAgentBackupRestoreTerminalCleanup(seed.operationId);
      const attempt = await replacementRow(seed);
      const callbacks = await import("../../../db/repositories/agent-sandbox-replacement-attempts");
      await expect(
        dbWrite.transaction((tx) =>
          callbacks.recordAgentSandboxReplacementCreatedInTransaction(
            tx,
            { attemptId: attempt.id, organizationId: seed.organizationId, agentId: seed.agentId },
            { ...fenced.locator, containerId: seed.containerId },
          ),
        ),
      ).rejects.toThrow();
      await expect(
        dbWrite.transaction((tx) =>
          callbacks.recordAgentSandboxExactRestoreProviderSucceededForLockedAuthoritiesInTransaction(
            tx,
            {
              attemptId: attempt.id,
              organizationId: seed.organizationId,
              agentId: seed.agentId,
              lifecycleRevision: attempt.lifecycle_revision.toString(),
              activationGeneration: seed.restoreAttemptId,
              lifecycleJobId: attempt.lifecycle_job_id,
              lifecycleExecutionGeneration: attempt.lifecycle_execution_generation,
              restoreAuthority: {
                leaseId: attempt.restore_lease_id!,
                backupId: attempt.restore_backup_id!,
                restoreAttemptId: seed.restoreAttemptId,
                ownerId: attempt.restore_lease_owner_id!,
                fencingToken: attempt.restore_lease_generation!,
                catalogEpoch: attempt.restore_catalog_epoch!.toString(),
                copyRole: attempt.restore_copy_role!,
                operationId: attempt.restore_operation_id!,
                sourceActivationGeneration: attempt.restore_source_activation_generation!,
                sourceLifecycleRevision: attempt.restore_source_lifecycle_revision!.toString(),
                expectedManifestSha256: attempt.restore_manifest_sha256!,
                expiresAt: attempt.restore_lease_expires_at!,
              },
              locator: { ...fenced.locator, containerId: seed.containerId },
              databaseNow: new Date(),
              receiptDigest: "f".repeat(64),
            },
          ),
        ),
      ).rejects.toThrow();
      expect((await replacementRow(seed)).locator_container_id).toBeNull();

      // A lost post-removal response leaves the fence; the next pass uses the
      // durable observed-ID proof and releases capacity once, without another rm.
      ssh.state.loseVolumeResponse = true;
      expect(
        await coordinator.cleanupTerminalAgentBackupRestore(deps, seed.operationId),
      ).toMatchObject({
        status: "quarantined",
        reason: "cleanup_proof_unavailable",
      });
      expect(ssh.state.removed).toBe(1);
      expect(await allocatedCount(seed)).toBe(1);
      expect(await coordinator.cleanupTerminalAgentBackupRestore(deps, seed.operationId)).toEqual({
        status: "cleaned",
      });
      expect(await coordinator.cleanupTerminalAgentBackupRestore(deps, seed.operationId)).toEqual({
        status: "settled",
      });
      expect(ssh.state.removed).toBe(1);
      expect(await allocatedCount(seed)).toBe(0);
      expect((await operationRow(seed.operationId)).phase).toBe("failed_terminal");
      expect((await replacementRow(seed)).cleanup_receipt_digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      ssh.restore();
      await clearSeed(seed);
    }
  },
  TEST_TIMEOUT,
);

test(
  "terminal unresolved create with proven producer quiescence releases its reserved slot",
  async () => {
    const seed = await seedContainerCreatedRestore({ unresolved: true });
    const ssh = await exactCleanupTransport(seed);
    try {
      await expireUnresolvedRestore(seed);
      ssh.state.quiescent = true;
      const summary = await coordinator.runAgentBackupRestoreCoordinatorCycle({
        config: CONFIG,
        dependencies: coordinator.createProductionCoordinatorDependencies(),
      });
      expect(summary.terminalCleanups).toBe(1);
      expect(summary.quarantinedCleanups).toEqual([]);
      expect(await allocatedCount(seed)).toBe(0);
      expect((await operationRow(seed.operationId)).phase).toBe("failed_terminal");
    } finally {
      ssh.restore();
      await clearSeed(seed);
    }
  },
  TEST_TIMEOUT,
);

test(
  "terminal cleanup retains exact node authority instead of using its replacement",
  async () => {
    const seed = await seedContainerCreatedRestore({ unresolved: true, observedContainer: true });
    const ssh = await exactCleanupTransport(seed);
    try {
      await expireUnresolvedRestore(seed);
      await dbWrite
        .update(dockerNodes)
        .set({ hostname: "replacement.example.internal" })
        .where(eq(dockerNodes.id, seed.targetNodeRecordId));
      const summary = await coordinator.runAgentBackupRestoreCoordinatorCycle({
        config: CONFIG,
        dependencies: coordinator.createProductionCoordinatorDependencies(),
      });
      expect(summary.terminalCleanups).toBe(0);
      expect(summary.quarantinedCleanups).toMatchObject([{ reason: "node_authority_unavailable" }]);
      expect(ssh.state.commands).toHaveLength(0);
      expect(await allocatedCount(seed)).toBe(1);
      expect((await replacementRow(seed)).state).toBe("cleanup_in_progress");
    } finally {
      ssh.restore();
      await clearSeed(seed);
    }
  },
  TEST_TIMEOUT,
);

test(
  "terminal cleanup selects the active attempt after earlier proven cleanup and releases once across concurrent turns",
  async () => {
    const seed = await seedContainerCreatedRestore({ unresolved: true });
    const ssh = await exactCleanupTransport(seed);
    try {
      const active = await replacementRow(seed);
      const previousAttemptId = randomUUID();
      await dbWrite.insert(agentSandboxReplacementAttempts).values({
        ...active,
        id: previousAttemptId,
        state: "cleanup_proven",
        cleanup_proven_at: new Date(),
        cleanup_receipt_digest: "8".repeat(64),
        created_at: new Date(active.created_at.getTime() - 60_000),
      });
      await expireUnresolvedRestore(seed);
      ssh.state.quiescent = true;
      const deps = coordinator.createProductionCoordinatorDependencies();
      const results = await Promise.all([
        coordinator.cleanupTerminalAgentBackupRestore(
          deps,
          seed.operationId,
          seed.replacementAttemptId,
        ),
        coordinator.cleanupTerminalAgentBackupRestore(
          deps,
          seed.operationId,
          seed.replacementAttemptId,
        ),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["cleaned", "settled"]);
      const serving = await import("../../../db/repositories/agent-backup-restore-serving");
      await expect(
        serving.beginAgentBackupRestoreTerminalCleanup(seed.operationId),
      ).rejects.toThrow("replay requires an exact replacement attempt");
      await expect(
        serving.beginAgentBackupRestoreTerminalCleanup(seed.operationId, randomUUID()),
      ).rejects.toThrow();
      await expect(
        serving.finishAgentBackupRestoreTerminalCleanup({
          operationId: seed.operationId,
          replacementAttemptId: seed.replacementAttemptId,
          receiptDigest: "0".repeat(64),
        }),
      ).rejects.toThrow("receipt replay mismatch");
      expect(
        await coordinator.cleanupTerminalAgentBackupRestore(
          deps,
          seed.operationId,
          seed.replacementAttemptId,
        ),
      ).toEqual({ status: "settled" });
      expect(await allocatedCount(seed)).toBe(0);
      expect((await replacementRow(seed)).state).toBe("cleanup_proven");
      const [previous] = await dbWrite
        .select()
        .from(agentSandboxReplacementAttempts)
        .where(eq(agentSandboxReplacementAttempts.id, previousAttemptId));
      expect(previous!.cleanup_receipt_digest).toBe("8".repeat(64));
      expect((await operationRow(seed.operationId)).phase).toBe("failed_terminal");
    } finally {
      ssh.restore();
      await clearSeed(seed);
    }
  },
  TEST_TIMEOUT,
);

test(
  "a node replacement after remote proof cannot consume the replacement node's capacity",
  async () => {
    const seed = await seedContainerCreatedRestore();
    const ssh = await exactCleanupTransport(seed);
    try {
      await expireUnresolvedRestore(seed);
      ssh.state.quiescent = true;
      const deps = coordinator.createProductionCoordinatorDependencies();
      const result = await coordinator.cleanupTerminalAgentBackupRestore(
        {
          ...deps,
          async removeRestoreContainer(cleanup) {
            await deps.removeRestoreContainer(cleanup);
            const [oldHistory] = await dbWrite
              .select()
              .from(agentNodeIncarnationHistories)
              .where(eq(agentNodeIncarnationHistories.id, cleanup.locator.nodeHistoryId));
            const newHistoryId = randomUUID();
            const newIncarnation = randomUUID();
            await dbWrite.insert(agentNodeIncarnationHistories).values({
              ...oldHistory!,
              id: newHistoryId,
              node_incarnation: newIncarnation,
            });
            await dbWrite
              .update(dockerNodes)
              .set({
                node_incarnation: newIncarnation,
                current_node_history_id: newHistoryId,
                allocated_count: 5,
              })
              .where(eq(dockerNodes.id, seed.targetNodeRecordId));
          },
        },
        seed.operationId,
      );
      expect(await allocatedCount(seed)).toBe(5);
      expect(result).toMatchObject({
        status: "quarantined",
        reason: "node_authority_unavailable",
        errorCode: "AGENT_BACKUP_RESTORE_CLEANUP_CAPACITY_UNAVAILABLE",
      });
      expect(await allocatedCount(seed)).toBe(5);
      const attempt = await replacementRow(seed);
      expect(attempt.state).toBe("cleanup_in_progress");
      expect(attempt.cleanup_receipt_digest).toBeNull();
      expect((await operationRow(seed.operationId)).phase).toBe("failed_terminal");
    } finally {
      ssh.restore();
      await clearSeed(seed);
    }
  },
  TEST_TIMEOUT,
);

test(
  "terminal cleanup rotates permanent quarantines so later recoverable attempts are not starved",
  async () => {
    const { abandonAgentBackupRestoreWithExpiredLease } = await import(
      "../../../db/repositories/agent-backup-restore-serving"
    );
    const { ElizaError } = await import("@elizaos/core");
    const seeds: Seed[] = [];
    try {
      for (let index = 0; index < 11; index += 1) {
        const sourceFixture: CandidateFixture = {
          ...fixture,
          authority: {
            ...fixture.authority,
            organizationId: randomUUID(),
            agentId: randomUUID(),
            backupId: randomUUID(),
            restoreAttemptId: randomUUID(),
            operationId: randomUUID(),
            leaseId: randomUUID(),
            fencingToken: randomUUID(),
          },
        };
        const seed = await seedContainerCreatedRestore({
          unresolved: true,
          sourceFixture,
          namespace: `rotation-${index}`,
        });
        seeds.push(seed);
        await dbWrite
          .update(agentBackupRestoreLeases)
          .set({
            created_at: new Date(Date.now() - 120_000),
            expires_at: new Date(Date.now() - 60_000),
          })
          .where(eq(agentBackupRestoreLeases.id, sourceFixture.authority.leaseId));
        expect((await abandonAgentBackupRestoreWithExpiredLease(seed.operationId))?.phase).toBe(
          "failed_terminal",
        );
      }
      const recoverable = seeds[10]!;
      const calls: string[] = [];
      const deps = {
        ...coordinator.createProductionCoordinatorDependencies(),
        async removeRestoreContainer(
          cleanup: import("../../../db/repositories/agent-backup-restore-serving").AgentBackupRestoreTerminalCleanup,
        ) {
          calls.push(cleanup.operationId);
          if (cleanup.operationId !== recoverable.operationId) {
            throw new ElizaError("Original node is permanently unavailable", {
              code: "SANDBOX_REPLACEMENT_NODE_AUTHORITY_MISSING",
              severity: "ephemeral",
            });
          }
        },
      };
      const first = await coordinator.runAgentBackupRestoreCoordinatorCycle({
        config: CONFIG,
        dependencies: deps,
        limit: 10,
      });
      expect(first.quarantinedCleanups).toHaveLength(10);
      expect(first.terminalCleanups).toBe(0);
      expect(new Set(calls).size).toBe(10);
      const second = await coordinator.runAgentBackupRestoreCoordinatorCycle({
        config: CONFIG,
        dependencies: deps,
        limit: 10,
      });
      expect(second.terminalCleanups).toBe(1);
      expect(second.quarantinedCleanups).toHaveLength(9);
      expect(await allocatedCount(recoverable)).toBe(0);
      for (const seed of seeds.slice(0, 10)) expect(await allocatedCount(seed)).toBe(1);
      expect((await operationRow(recoverable.operationId)).phase).toBe("failed_terminal");
    } finally {
      if (seeds.length) await clearSeed(seeds[0]!);
    }
  },
  TEST_TIMEOUT,
);
