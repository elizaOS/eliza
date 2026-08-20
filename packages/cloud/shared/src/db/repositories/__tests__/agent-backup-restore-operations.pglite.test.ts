/**
 * Real-DB proofs for the restore operation spine. The repository is exercised
 * against the pushed Drizzle schema with real collaborators — the lease and the
 * catalogue authority are genuine rows, not doubles, because every fence here is
 * a SQL predicate and a mocked lease would prove nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1 } from "@elizaos/shared";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import type { AgentBackupRestorePhase } from "../../schemas/agent-backup-catalog";
import {
  agentBackupCatalogAuthorities,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../../schemas/agent-backup-catalog";
import { agentSandboxBackups, agentSandboxes } from "../../schemas/agent-sandboxes";
import {
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
  AGENT_VAULT_KEY_KMS_CONTEXT_DERIVATION,
  agentVaultKeyGenerations,
} from "../../schemas/agent-vault-key-authority";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import type { AgentBackupRestoreLeaseAuthorityReceipt } from "../agent-backup-restore-lease";
import {
  advanceAgentBackupRestoreOperation,
  claimAgentBackupRestoreOperation,
  failAgentBackupRestoreOperation,
  heartbeatAgentBackupRestoreOperation,
  openAgentBackupRestoreOperation,
} from "../agent-backup-restore-operations";

const TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-00000000f001";
const AGENT_ID = "00000000-0000-4000-8000-00000000f002";
const BACKUP_ID = "00000000-0000-4000-8000-00000000f003";
const OPERATION_ID = "00000000-0000-4000-8000-00000000f004";
const ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000f005";
const ATTEMPT_ID = "00000000-0000-4000-8000-00000000f006";
const LEASE_ID = "00000000-0000-4000-8000-00000000f007";
const FENCE = "00000000-0000-4000-8000-00000000f008";
const SHA = "a".repeat(64);
const CONTAINER = "b".repeat(64);
const RECEIPT_SHA = "d".repeat(64);
const KEY_BUNDLE = Buffer.alloc(AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes, 0x44).toString(
  "base64",
);
const VAULT_GENERATION = "00000000-0000-4000-8000-00000000f009";
let schemaFailure = "";

function authorityReceipt(): AgentBackupRestoreLeaseAuthorityReceipt {
  return {
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    backupId: BACKUP_ID,
    operationId: OPERATION_ID,
    sourceActivationGeneration: ACTIVATION_GENERATION,
    sourceLifecycleRevision: "7",
    expectedManifestSha256: SHA,
    restoreAttemptId: ATTEMPT_ID,
    leaseId: LEASE_ID,
    ownerId: "restore-worker",
    fencingToken: FENCE,
    catalogEpoch: "3",
    copyRole: "primary",
  } as AgentBackupRestoreLeaseAuthorityReceipt;
}

async function seedLease(expiresInMs = 600_000): Promise<void> {
  const createdAt = new Date(Date.now() - 3_600_000);
  await dbWrite.insert(agentBackupRestoreLeases).values({
    created_at: createdAt,
    id: LEASE_ID,
    organization_id: ORG_ID,
    agent_id: AGENT_ID,
    backup_id: BACKUP_ID,
    operation_id: OPERATION_ID,
    activation_generation: ACTIVATION_GENERATION,
    lifecycle_revision: 7n,
    expected_manifest_sha256: SHA,
    copy_role: "primary",
    restore_attempt_id: ATTEMPT_ID,
    owner_id: "restore-worker",
    generation: FENCE,
    catalog_epoch: 3n,
    expires_at: new Date(Date.now() + expiresInMs),
  });
}

/** Walks the machine one adjacent step at a time, re-claiming per phase. */
async function walkTo(operationId: string, target: AgentBackupRestorePhase): Promise<void> {
  const order: AgentBackupRestorePhase[] = [
    "reserved",
    "vault_seeded",
    "container_created",
    "restoring",
    "committed",
    "restart_attested",
    "probed",
    "published",
  ];
  for (let index = 0; order[index] !== target; index += 1) {
    const claim = await claimAgentBackupRestoreOperation({
      operationId,
      ownerId: "restore-worker",
      claimMs: 60_000,
    });
    await advanceAgentBackupRestoreOperation({
      operationId,
      ownerId: "restore-worker",
      claimGeneration: claim.claimGeneration,
      fromPhase: order[index] as AgentBackupRestorePhase,
      toPhase: order[index + 1] as AgentBackupRestorePhase,
    });
  }
}

beforeAll(async () => {
  try {
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
        agentVaultKeyGenerations,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.delete(agentBackupRestoreOperations);
  await dbWrite.delete(agentBackupRestoreLeases);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentVaultKeyGenerations);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await dbWrite
    .insert(organizations)
    .values({ id: ORG_ID, name: "Restore ops", slug: "restore-ops" });
  await dbWrite
    .insert(agentBackupCatalogAuthorities)
    .values({ organization_id: ORG_ID, agent_id: AGENT_ID, catalog_revision: 3n });
  await dbWrite.insert(agentVaultKeyGenerations).values({
    organization_id: ORG_ID,
    agent_id: AGENT_ID,
    generation_id: VAULT_GENERATION,
    source_activation_generation: ACTIVATION_GENERATION,
    supersedes_generation_id: null,
    format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
    kms_key_id: `org:${ORG_ID}/dek/v1`,
    kms_key_version: 1n,
    kms_context: "{}",
    kms_context_derivation: AGENT_VAULT_KEY_KMS_CONTEXT_DERIVATION,
    wrapped_ciphertext_base64: Buffer.alloc(32, 0x11).toString("base64"),
    wrapped_nonce_base64: Buffer.alloc(12, 0x22).toString("base64"),
    wrapped_auth_tag_base64: Buffer.alloc(16, 0x33).toString("base64"),
    wrapped_envelope_sha256: SHA,
    authority_receipt_derivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
    authority_receipt_digest: RECEIPT_SHA,
  });
  await dbWrite.insert(agentSandboxBackups).values({
    id: BACKUP_ID,
    sandbox_record_id: null,
    snapshot_type: "auto",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    state_data_storage: "inline",
    size_bytes: 92,
    backup_kind: "full",
    backup_operation_id: OPERATION_ID,
    catalog_version: 2,
    catalog_state: "protected",
    catalog_payload_digest: SHA,
    catalog_revision: 0n,
    catalog_organization_id: ORG_ID,
    catalog_agent_id: AGENT_ID,
    lifecycle_generation: ACTIVATION_GENERATION,
    lifecycle_revision: 7n,
    source_provider: "operator-onboarded",
    source_node_record_id: "00000000-0000-4000-8000-00000000f00a",
    source_node_id: "restore-source-node",
    source_node_incarnation: "00000000-0000-4000-8000-00000000f00b",
    source_provider_server_id: null,
    source_provider_handle: "restore-source-handle",
    source_container_id: "c".repeat(64),
    retention_reason: "schedule",
    retention_until: new Date("2026-12-01T00:00:00.000Z"),
    manifest_format: "elizaos.agent-backup",
    manifest_version: 3,
    manifest_digest: SHA,
    manifest_canonical_draft: "{}",
    manifest_object_count: 1,
    object_inventory_digest: SHA,
    image_digest: `sha256:${SHA}`,
    database_schema_version: "1",
    plugin_set_digest: SHA,
    watermark_digest: SHA,
    raw_size_bytes: 1,
    compressed_size_bytes: 1,
    encrypted_size_bytes: 92,
    kms_key_id: `org:${ORG_ID}/backup/v1`,
    kms_key_version: 1,
    operation_key_bundle_generation_id: "00000000-0000-4000-8000-00000000f00c",
    operation_key_bundle_format: "kms-aead-operation-key-bundle-v1",
    operation_key_bundle_ref: `backup-key-bundle:${OPERATION_ID}`,
    operation_key_bundle_ciphertext_base64: KEY_BUNDLE,
    operation_key_bundle_sha256: SHA,
    operation_key_bundle_size_bytes: 92,
    operation_key_bundle_context: "{}",
    operation_key_bundle_context_derivation: "elizaos.agent-backup.operation-key-bundle-context.v1",
    operation_key_bundle_local_receipt_derivation:
      "elizaos.kms-aead-operation-key-bundle.local-receipt.v1",
    operation_key_bundle_local_receipt_digest: SHA,
    vault_key_generation_id: VAULT_GENERATION,
    vault_key_authority_receipt_digest: RECEIPT_SHA,
  });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("restore operation spine", () => {
  test(
    "opens once under concurrent response-loss replay and DB-refuses divergent authority",
    async () => {
      await seedLease();
      const results = await Promise.all([
        openAgentBackupRestoreOperation({ authority: authorityReceipt(), leaseId: LEASE_ID }),
        openAgentBackupRestoreOperation({ authority: authorityReceipt(), leaseId: LEASE_ID }),
      ]);
      const opened = results.find((result) => !result.replayed);
      const replay = results.find((result) => result.replayed);
      expect(opened?.operation.phase).toBe("reserved");
      expect(opened?.operation.lease_generation).toBe(FENCE);
      expect(opened?.operation.catalog_epoch).toBe(3n);
      expect(replay?.operation.id).toBe(opened?.operation.id);

      let divergenceError: unknown;
      try {
        await dbWrite
          .update(agentBackupRestoreOperations)
          .set({ lease_owner_id: "someone-else" })
          .where(eq(agentBackupRestoreOperations.id, opened?.operation.id ?? ""))
          .execute();
      } catch (error) {
        divergenceError = error;
      }
      expect((divergenceError as { cause?: { constraint?: string } }).cause?.constraint).toBe(
        "agent_backup_restore_operations_lease_authority_fkey",
      );
    },
    TIMEOUT,
  );

  test(
    "refuses to open once the catalogue revision has moved past the lease epoch",
    async () => {
      await seedLease();
      await dbWrite
        .update(agentBackupCatalogAuthorities)
        .set({ catalog_revision: 4n })
        .where(eq(agentBackupCatalogAuthorities.agent_id, AGENT_ID));
      await expect(
        openAgentBackupRestoreOperation({ authority: authorityReceipt(), leaseId: LEASE_ID }),
      ).rejects.toThrow("invalidated by a catalogue revision");
      expect(await dbWrite.select().from(agentBackupRestoreOperations)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "refuses to open against an expired lease",
    async () => {
      await seedLease(-1_000);
      await expect(
        openAgentBackupRestoreOperation({ authority: authorityReceipt(), leaseId: LEASE_ID }),
      ).rejects.toThrow("Restore lease is expired or released");
    },
    TIMEOUT,
  );

  test(
    "claims exclusively and refuses a second live claim",
    async () => {
      await seedLease();
      const { operation } = await openAgentBackupRestoreOperation({
        authority: authorityReceipt(),
        leaseId: LEASE_ID,
      });
      const claim = await claimAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimMs: 60_000,
      });
      expect(claim.operation.claim_owner).toBe("restore-worker");
      expect(claim.operation.attempts).toBe(1);

      await expect(
        claimAgentBackupRestoreOperation({
          operationId: operation.id,
          ownerId: "restore-worker",
          claimMs: 60_000,
        }),
      ).rejects.toThrow("claimed by another worker");
    },
    TIMEOUT,
  );

  test(
    "advances forward under a live claim and refuses a stale claim generation",
    async () => {
      await seedLease();
      const { operation } = await openAgentBackupRestoreOperation({
        authority: authorityReceipt(),
        leaseId: LEASE_ID,
      });
      const claim = await claimAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimMs: 60_000,
      });
      const advanced = await advanceAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimGeneration: claim.claimGeneration,
        fromPhase: "reserved",
        toPhase: "vault_seeded",
        recordedIdentity: { containerId: CONTAINER },
      });
      expect(advanced.phase).toBe("vault_seeded");
      expect(advanced.expected_container_id).toBe(CONTAINER);
      expect(advanced.claim_owner).toBeNull();

      await expect(
        advanceAgentBackupRestoreOperation({
          operationId: operation.id,
          ownerId: "restore-worker",
          claimGeneration: claim.claimGeneration,
          fromPhase: "vault_seeded",
          toPhase: "container_created",
        }),
      ).rejects.toThrow("claim is not live");
    },
    TIMEOUT,
  );

  test(
    "refuses a backward transition before it reaches the database",
    async () => {
      await seedLease();
      const { operation } = await openAgentBackupRestoreOperation({
        authority: authorityReceipt(),
        leaseId: LEASE_ID,
      });
      await expect(
        advanceAgentBackupRestoreOperation({
          operationId: operation.id,
          ownerId: "restore-worker",
          claimGeneration: FENCE,
          fromPhase: "restoring",
          toPhase: "reserved",
        }),
      ).rejects.toThrow("cannot advance from restoring to reserved");

      const claim = await claimAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimMs: 60_000,
      });
      await expect(
        advanceAgentBackupRestoreOperation({
          operationId: operation.id,
          ownerId: "restore-worker",
          claimGeneration: claim.claimGeneration,
          fromPhase: "reserved",
          toPhase: "finalized",
          receiptDigest: SHA,
        }),
      ).rejects.toThrow("cannot advance from reserved to finalized");
    },
    TIMEOUT,
  );

  test(
    "a retryable failure pins the phase a later claim must resume",
    async () => {
      await seedLease();
      const { operation } = await openAgentBackupRestoreOperation({
        authority: authorityReceipt(),
        leaseId: LEASE_ID,
      });
      const claim = await claimAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimMs: 60_000,
      });
      for (const retryDelayMs of [-1, Number.NaN, 3_600_001]) {
        await expect(
          failAgentBackupRestoreOperation({
            operationId: operation.id,
            ownerId: "restore-worker",
            claimGeneration: claim.claimGeneration,
            retryable: true,
            resumePhase: "reserved",
            errorCode: "VAULT_SEED_TIMEOUT",
            error: "seeding timed out",
            failureDigest: SHA,
            retryDelayMs,
          }),
        ).rejects.toThrow("retryDelayMs must be an integer between 0 and 3600000");
      }
      const failed = await failAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimGeneration: claim.claimGeneration,
        retryable: true,
        resumePhase: "reserved",
        errorCode: "VAULT_SEED_TIMEOUT",
        error: "seeding timed out",
        failureDigest: SHA,
        retryDelayMs: 0,
      });
      expect(failed.phase).toBe("failed_retryable");
      expect(failed.resume_phase).toBe("reserved");
      expect(failed.last_failure_generation).toBe(claim.claimGeneration);
      expect(failed.claim_owner).toBeNull();

      const reclaim = await claimAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimMs: 60_000,
      });
      expect(reclaim.operation.attempts).toBe(2);
    },
    TIMEOUT,
  );

  test(
    "refuses a receipt naming an agent the lease does not cover",
    async () => {
      const OTHER_AGENT = "00000000-0000-4000-8000-00000000fb02";
      await dbWrite
        .insert(agentBackupCatalogAuthorities)
        .values({ organization_id: ORG_ID, agent_id: OTHER_AGENT, catalog_revision: 3n });
      await seedLease();
      await expect(
        openAgentBackupRestoreOperation({
          authority: { ...authorityReceipt(), agentId: OTHER_AGENT },
          leaseId: LEASE_ID,
        }),
      ).rejects.toThrow("Restore lease authority does not match");
      expect(await dbWrite.select().from(agentBackupRestoreOperations)).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "a retryable failure pins the phase it was in, and resuming re-enters exactly that phase",
    async () => {
      await seedLease();
      const { operation } = await openAgentBackupRestoreOperation({
        authority: authorityReceipt(),
        leaseId: LEASE_ID,
      });
      await walkTo(operation.id, "restoring");
      const claim = await claimAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimMs: 60_000,
      });
      await expect(
        failAgentBackupRestoreOperation({
          operationId: operation.id,
          ownerId: "restore-worker",
          claimGeneration: claim.claimGeneration,
          retryable: true,
          resumePhase: "published",
          errorCode: "STREAM_TIMEOUT",
          error: "stream timed out",
          failureDigest: SHA,
          retryDelayMs: 0,
        }),
      ).rejects.toThrow("is in restoring and cannot pin a resume at published");

      const failed = await failAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimGeneration: claim.claimGeneration,
        retryable: true,
        resumePhase: "restoring",
        errorCode: "STREAM_TIMEOUT",
        error: "stream timed out",
        failureDigest: SHA,
        retryDelayMs: 0,
      });
      expect(failed.phase).toBe("failed_retryable");
      expect(failed.resume_phase).toBe("restoring");

      const retry = await claimAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimMs: 60_000,
      });
      await expect(
        advanceAgentBackupRestoreOperation({
          operationId: operation.id,
          ownerId: "restore-worker",
          claimGeneration: retry.claimGeneration,
          fromPhase: "failed_retryable",
          toPhase: "committed",
        }),
      ).rejects.toThrow("must resume restoring, not committed");

      const resumed = await advanceAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimGeneration: retry.claimGeneration,
        fromPhase: "failed_retryable",
        toPhase: "restoring",
      });
      expect(resumed.phase).toBe("restoring");
      expect(resumed.resume_phase).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "a heartbeat extends a live claim and an expired claim can no longer write a failure",
    async () => {
      await seedLease();
      const { operation } = await openAgentBackupRestoreOperation({
        authority: authorityReceipt(),
        leaseId: LEASE_ID,
      });
      const claim = await claimAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimMs: 1_000,
      });
      const renewed = await heartbeatAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimGeneration: claim.claimGeneration,
        claimMs: 600_000,
      });
      expect(renewed.claim_expires_at?.getTime()).toBeGreaterThan(
        claim.operation.claim_expires_at?.getTime() ?? 0,
      );

      await dbWrite
        .update(agentBackupRestoreOperations)
        .set({ claim_expires_at: new Date(Date.now() - 3_600_000) })
        .where(eq(agentBackupRestoreOperations.id, operation.id));
      await expect(
        failAgentBackupRestoreOperation({
          operationId: operation.id,
          ownerId: "restore-worker",
          claimGeneration: claim.claimGeneration,
          retryable: true,
          resumePhase: "reserved",
          errorCode: "LATE",
          error: "zombie writer",
          failureDigest: SHA,
          retryDelayMs: 900_000,
        }),
      ).rejects.toThrow("claim is not live");
    },
    TIMEOUT,
  );

  test(
    "finalization requires a receipt digest and every other phase refuses one",
    async () => {
      await seedLease();
      const { operation } = await openAgentBackupRestoreOperation({
        authority: authorityReceipt(),
        leaseId: LEASE_ID,
      });
      await walkTo(operation.id, "published");
      const claim = await claimAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimMs: 60_000,
      });
      await expect(
        advanceAgentBackupRestoreOperation({
          operationId: operation.id,
          ownerId: "restore-worker",
          claimGeneration: claim.claimGeneration,
          fromPhase: "published",
          toPhase: "finalized",
        }),
      ).rejects.toThrow("Finalization requires a receipt digest");

      const finalized = await advanceAgentBackupRestoreOperation({
        operationId: operation.id,
        ownerId: "restore-worker",
        claimGeneration: claim.claimGeneration,
        fromPhase: "published",
        toPhase: "finalized",
        receiptDigest: SHA,
      });
      expect(finalized.phase).toBe("finalized");
      expect(finalized.receipt_digest).toBe(SHA);
      expect(finalized.completed_at).toBeInstanceOf(Date);

      await expect(
        claimAgentBackupRestoreOperation({
          operationId: operation.id,
          ownerId: "restore-worker",
          claimMs: 60_000,
        }),
      ).rejects.toThrow("terminal in phase finalized");
    },
    TIMEOUT,
  );
});
