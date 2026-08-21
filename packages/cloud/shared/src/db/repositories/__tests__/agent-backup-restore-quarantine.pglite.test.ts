/** Real-primary-DB proofs for the dormant restore activation quarantine. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import {
  AGENT_BACKUP_MANIFEST_FORMAT,
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  type AgentBackupManifestV3Draft,
  canonicalizeAgentBackupManifestV3,
  createAgentBackupManifestV3,
} from "@elizaos/shared";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { eq, sql } from "drizzle-orm";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import {
  agentBackupCatalogAuthorities,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../../schemas/agent-backup-catalog";
import { agentNodeIncarnationHistories } from "../../schemas/agent-backup-restore-history";
import { agentSandboxBackups, agentSandboxes } from "../../schemas/agent-sandboxes";
import {
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
} from "../../schemas/agent-vault-key-authority";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import type { AgentBackupRestoreLeaseAuthorityReceipt } from "../agent-backup-restore-lease";
import {
  advanceAgentBackupRestoreOperation,
  claimAgentBackupRestoreOperation,
  openAgentBackupRestoreOperation,
  reserveAgentBackupRestoreTarget,
} from "../agent-backup-restore-operations";
import {
  openAgentBackupRestoreQuarantine,
  recordAgentBackupRestoreQuarantinedContainer,
} from "../agent-backup-restore-quarantine";

const TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-00000000e101";
const USER_ID = "00000000-0000-4000-8000-00000000e102";
const AGENT_ID = "00000000-0000-4000-8000-00000000e103";
const BACKUP_ID = "00000000-0000-4000-8000-00000000e104";
const BACKUP_OPERATION_ID = "00000000-0000-4000-8000-00000000e105";
const SOURCE_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000e106";
const RESTORE_ATTEMPT_ID = "00000000-0000-4000-8000-00000000e107";
const LEASE_ID = "00000000-0000-4000-8000-00000000e108";
const LEASE_GENERATION = "00000000-0000-4000-8000-00000000e109";
const PREVIOUS_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000e10c";
const PREVIOUS_BOOT_ID = "00000000-0000-4000-8000-00000000e10d";
const TARGET_NODE_RECORD_ID = "00000000-0000-4000-8000-00000000e10e";
const TARGET_NODE_INCARNATION = "00000000-0000-4000-8000-00000000e10f";
const OTHER_NODE_INCARNATION = "00000000-0000-4000-8000-00000000e110";
const VAULT_GENERATION_ID = "00000000-0000-4000-8000-00000000e111";
const SOURCE_NODE_RECORD_ID = "00000000-0000-4000-8000-00000000e112";
const KEY_BUNDLE_GENERATION_ID = "00000000-0000-4000-8000-00000000e113";
const HASH = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const IMAGE_DIGEST = `sha256:${"c".repeat(64)}`;
const CANONICAL_IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const TOKEN_SHA = "e".repeat(64);
const OTHER_TOKEN_SHA = "f".repeat(64);
const TOKEN_CIPHERTEXT = "test-only-field-ciphertext-v1";
const CONTAINER_A = "1".repeat(64);
const CONTAINER_B = "2".repeat(64);
const OLD_CONTAINER = "3".repeat(64);
const KEY_BUNDLE = Buffer.alloc(92, 0x44).toString("base64");

let schemaFailure = "";
let operationId = "";
let initialClaimGeneration = "";
let manifestFixture: Readonly<{ canonicalDraft: string; digest: string }>;

async function buildManifestFixture(): Promise<typeof manifestFixture> {
  const component = (name: "character" | "database" | "media" | "state-files" | "vault") => ({
    name,
    format: "raw-v1",
    compression: "none" as const,
    payloadContentHmacSha256: HASH,
    state: { kind: "full" as const, resultContentHmacSha256: HASH },
    totals: { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
    chunks: [],
  });
  const draft: AgentBackupManifestV3Draft = {
    format: AGENT_BACKUP_MANIFEST_FORMAT,
    schemaVersion: 3,
    operationId: BACKUP_OPERATION_ID,
    createdAt: "2026-08-20T00:00:00.000Z",
    identity: {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      activationGeneration: SOURCE_ACTIVATION_GENERATION,
      lifecycleRevision: "4",
    },
    source: {
      kind: "robot",
      provider: "hetzner",
      nodeRecordId: SOURCE_NODE_RECORD_ID,
      nodeIncarnation: PREVIOUS_BOOT_ID,
      nodeId: "restore-source",
      containerId: OLD_CONTAINER,
    },
    runtime: {
      imageDigest: IMAGE_DIGEST,
      agentSchemaVersion: "2.0.0",
      databaseSchemaVersion: "1",
      plugins: [],
    },
    chain: { kind: "full", baseOperationId: null, parentOperationId: null, depth: 0 },
    components: [
      component("character"),
      component("database"),
      component("media"),
      component("state-files"),
      component("vault"),
    ],
    watermarks: [{ namespace: "database.lsn", value: "0/1" }],
    totals: { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
    vaultKeyAuthority: {
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      generationId: VAULT_GENERATION_ID,
      receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      receiptDigest: HASH,
    },
    encryption: {
      algorithm: "AES-256-GCM",
      chunkEnvelope: "aes-256-gcm-v1",
      nonceBytes: 12,
      tagBytes: 16,
      noncePlacement: "prefix",
      tagPlacement: "suffix",
      aad: { version: 1, derivation: "elizaos.agent-backup.chunk-aad.v1" },
      kms: { provider: "steward", keyId: `org:${ORG_ID}/dek/v1`, keyVersion: 1 },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        generationId: KEY_BUNDLE_GENERATION_ID,
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek,
        contentHmac: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac,
        wrapped: {
          ref: `backup-key-bundle:${BACKUP_OPERATION_ID}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256: HASH,
          localReceiptDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest: HASH,
          contextDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
    integrity: {
      framedContentHmacSha256: HASH,
      contentAddressing: {
        algorithm: "HMAC-SHA-256",
        scope: "operation",
        derivation: AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
        keyBundleFormat: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        keyOffsetBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
        keyBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes,
      },
    },
  };
  const manifest = await createAgentBackupManifestV3(draft);
  return Object.freeze({
    canonicalDraft: canonicalizeAgentBackupManifestV3(draft),
    digest: manifest.integrity.manifestSha256,
  });
}

function quarantineTransactionBody(functionName: string, nextFunctionName?: string): string {
  const source = readFileSync(
    new URL("../agent-backup-restore-quarantine.ts", import.meta.url),
    "utf8",
  );
  const functionStart = source.indexOf(`export async function ${functionName}`);
  const transactionStart = source.indexOf("return dbWrite.transaction", functionStart);
  const functionEnd = nextFunctionName
    ? source.indexOf(`export async function ${nextFunctionName}`, transactionStart)
    : source.length;
  expect(functionStart).toBeGreaterThanOrEqual(0);
  expect(transactionStart).toBeGreaterThan(functionStart);
  expect(functionEnd).toBeGreaterThan(transactionStart);
  return source.slice(transactionStart, functionEnd);
}

function expectCanonicalQuarantineLockOrder(body: string): void {
  const anchors = [
    ".from(agentSandboxBackups)",
    ".from(agentBackupRestoreOperations)",
    ".from(agentBackupRestoreLeases)",
    ".from(agentSandboxes)",
    ".from(dockerNodes)",
    "proveUnambiguousAgentNodeIncarnationForLockedNode(",
    "lockAgentBackupCatalogAuthority(",
    "readPostLockDatabaseNow(tx)",
  ];
  const positions = anchors.map((anchor) => body.indexOf(anchor));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((left, right) => left - right));
}

const openInput = () => ({
  operationId,
  ownerId: "restore-worker",
  claimGeneration: initialClaimGeneration,
  activationTokenSha256: TOKEN_SHA,
  activationTokenCiphertext: TOKEN_CIPHERTEXT,
});

function leaseAuthorityReceipt(
  lease: typeof agentBackupRestoreLeases.$inferSelect,
  databaseNow: Date,
): AgentBackupRestoreLeaseAuthorityReceipt {
  return Object.freeze({
    lease: Object.freeze({ ...lease }),
    leaseId: lease.id,
    organizationId: lease.organization_id,
    agentId: lease.agent_id,
    backupId: lease.backup_id,
    operationId: lease.operation_id,
    sourceActivationGeneration: lease.activation_generation,
    sourceLifecycleRevision: lease.lifecycle_revision.toString(),
    expectedManifestSha256: lease.expected_manifest_sha256,
    restoreAttemptId: lease.restore_attempt_id,
    ownerId: lease.owner_id,
    fencingToken: lease.generation,
    catalogEpoch: lease.catalog_epoch.toString(),
    copyRole: lease.copy_role,
    databaseNow,
    expiresAt: lease.expires_at,
  });
}

async function seedFixture(): Promise<void> {
  await dbWrite.insert(organizations).values({
    id: ORG_ID,
    name: "Restore quarantine",
    slug: "restore-quarantine",
  });
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "restore-quarantine-user",
    organization_id: ORG_ID,
  });
  await dbWrite.insert(dockerNodes).values({
    id: TARGET_NODE_RECORD_ID,
    node_id: "restore-target",
    hostname: "restore-target.invalid",
    capacity: 2,
    allocated_count: 0,
    enabled: true,
    placement_state: "open",
    status: "healthy",
    host_key_fingerprint: "SHA256:test-only-target",
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    node_incarnation: TARGET_NODE_INCARNATION,
  });
  const publishedAt = new Date("2026-08-20T08:00:00.000Z");
  const dispatchedAt = new Date("2026-08-20T08:00:01.000Z");
  const completedAt = new Date("2026-08-20T08:00:02.000Z");
  await dbWrite.insert(agentSandboxes).values({
    id: AGENT_ID,
    organization_id: ORG_ID,
    user_id: USER_ID,
    status: "running",
    execution_tier: "dedicated-always",
    sandbox_id: "canonical-provider-handle",
    node_id: "canonical-node",
    image_digest: CANONICAL_IMAGE_DIGEST,
    lifecycle_revision: 7,
    activation_generation: PREVIOUS_ACTIVATION_GENERATION,
    activation_previous_generation: null,
    activation_lifecycle_revision: 7n,
    activation_purpose: "provision",
    activation_phase: "active",
    activation_receipt: {} as never,
    activation_receipt_hash: OTHER_SHA,
    activation_container_id: OLD_CONTAINER,
    activation_node_id: "canonical-node",
    activation_image_digest: CANONICAL_IMAGE_DIGEST,
    activation_token_hash: OTHER_TOKEN_SHA,
    activation_token_ciphertext: "old-ciphertext",
    activation_boot_id: PREVIOUS_BOOT_ID,
    activation_authority_published_at: publishedAt,
    activation_funding_revision: 0n,
    activation_dispatched_at: dispatchedAt,
    activation_completed_at: completedAt,
  });
  await dbWrite.insert(agentBackupCatalogAuthorities).values({
    organization_id: ORG_ID,
    agent_id: AGENT_ID,
    catalog_revision: 3n,
  });
  await dbWrite.insert(agentSandboxBackups).values({
    id: BACKUP_ID,
    sandbox_record_id: AGENT_ID,
    snapshot_type: "auto",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    state_data_storage: "inline",
    size_bytes: 92,
    backup_kind: "full",
    backup_operation_id: BACKUP_OPERATION_ID,
    catalog_version: 2,
    catalog_state: "protected",
    catalog_payload_digest: HASH,
    catalog_revision: 0n,
    catalog_organization_id: ORG_ID,
    catalog_agent_id: AGENT_ID,
    lifecycle_generation: SOURCE_ACTIVATION_GENERATION,
    lifecycle_revision: 4n,
    source_provider: "operator-onboarded",
    source_node_record_id: SOURCE_NODE_RECORD_ID,
    source_node_id: "restore-source",
    source_node_incarnation: PREVIOUS_BOOT_ID,
    source_provider_server_id: null,
    source_provider_handle: "restore-source-handle",
    source_container_id: OLD_CONTAINER,
    retention_reason: "schedule",
    retention_until: new Date("2026-12-01T00:00:00.000Z"),
    manifest_format: "elizaos.agent-backup",
    manifest_version: 3,
    manifest_digest: manifestFixture.digest,
    manifest_canonical_draft: manifestFixture.canonicalDraft,
    manifest_object_count: 1,
    object_inventory_digest: HASH,
    image_digest: IMAGE_DIGEST,
    database_schema_version: "1",
    plugin_set_digest: HASH,
    watermark_digest: HASH,
    raw_size_bytes: 1,
    compressed_size_bytes: 1,
    encrypted_size_bytes: 92,
    kms_key_id: `org:${ORG_ID}/backup/v1`,
    kms_key_version: 1,
    operation_key_bundle_generation_id: KEY_BUNDLE_GENERATION_ID,
    operation_key_bundle_format: "kms-aead-operation-key-bundle-v1",
    operation_key_bundle_ref: `backup-key-bundle:${BACKUP_OPERATION_ID}`,
    operation_key_bundle_ciphertext_base64: KEY_BUNDLE,
    operation_key_bundle_sha256: HASH,
    operation_key_bundle_size_bytes: 92,
    operation_key_bundle_context: "{}",
    operation_key_bundle_context_derivation: "elizaos.agent-backup.operation-key-bundle-context.v1",
    operation_key_bundle_local_receipt_derivation:
      "elizaos.kms-aead-operation-key-bundle.local-receipt.v1",
    operation_key_bundle_local_receipt_digest: HASH,
    vault_key_generation_id: VAULT_GENERATION_ID,
    vault_key_authority_receipt_digest: HASH,
  });
  const createdAt = new Date(Date.now() - 60_000);
  const expiresAt = new Date(Date.now() + 600_000);
  const [lease] = await dbWrite
    .insert(agentBackupRestoreLeases)
    .values({
      id: LEASE_ID,
      organization_id: ORG_ID,
      agent_id: AGENT_ID,
      backup_id: BACKUP_ID,
      operation_id: BACKUP_OPERATION_ID,
      activation_generation: SOURCE_ACTIVATION_GENERATION,
      lifecycle_revision: 4n,
      expected_manifest_sha256: manifestFixture.digest,
      copy_role: "primary",
      restore_attempt_id: RESTORE_ATTEMPT_ID,
      owner_id: "restore-worker",
      generation: LEASE_GENERATION,
      catalog_epoch: 3n,
      created_at: createdAt,
      expires_at: expiresAt,
    })
    .returning();
  if (!lease) throw new Error("restore lease fixture was not inserted");
  const opened = await openAgentBackupRestoreOperation({
    authority: leaseAuthorityReceipt(lease, createdAt),
    leaseId: LEASE_ID,
  });
  const claimed = await claimAgentBackupRestoreOperation({
    operationId: opened.operation.id,
    ownerId: "restore-worker",
    claimMs: 300_000,
  });
  await reserveAgentBackupRestoreTarget({
    operationId: opened.operation.id,
    ownerId: "restore-worker",
    claimGeneration: claimed.claimGeneration,
    targetNodeRecordId: TARGET_NODE_RECORD_ID,
    targetNodeIncarnation: TARGET_NODE_INCARNATION,
  });
  operationId = opened.operation.id;
  initialClaimGeneration = claimed.claimGeneration;
}

async function openAndClaimVaultSeeded(): Promise<string> {
  await openAgentBackupRestoreQuarantine(openInput());
  await advanceAgentBackupRestoreOperation({
    operationId,
    ownerId: "restore-worker",
    claimGeneration: initialClaimGeneration,
    fromPhase: "reserved",
    toPhase: "vault_seeded",
  });
  const claim = await claimAgentBackupRestoreOperation({
    operationId,
    ownerId: "restore-worker",
    claimMs: 60_000,
  });
  return claim.claimGeneration;
}

async function readRows() {
  const [sandbox] = await dbWrite
    .select()
    .from(agentSandboxes)
    .where(eq(agentSandboxes.id, AGENT_ID));
  const [operation] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(eq(agentBackupRestoreOperations.id, operationId));
  const [node] = await dbWrite
    .select()
    .from(dockerNodes)
    .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
  if (!sandbox || !operation || !node) throw new Error("fixture rows are missing");
  return { sandbox, operation, node };
}

beforeAll(async () => {
  try {
    manifestFixture = await buildManifestFixture();
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
      } as never,
      dbWrite as never,
    );
    await apply();
    // pushSchema creates the shape, while deployed databases also have the
    // lifecycle trigger. Install that authority so the CAS is tested honestly.
    await dbWrite.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION test_advance_agent_sandbox_lifecycle_revision()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
        RETURN NEW;
      END;
      $$
    `),
    );
    await dbWrite.execute(
      sql.raw(`
      CREATE TRIGGER test_agent_sandboxes_lifecycle_revision_trigger
      BEFORE UPDATE ON agent_sandboxes
      FOR EACH ROW EXECUTE FUNCTION test_advance_agent_sandbox_lifecycle_revision()
    `),
    );
    await dbWrite.execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION test_journal_node_incarnation()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.node_incarnation IS NULL THEN RETURN NEW; END IF;
        INSERT INTO agent_node_incarnation_histories (
          docker_node_record_id, node_id, node_incarnation, fleet_kind,
          infrastructure_provider, provider_server_id, host_key_fingerprint, attested_at
        ) VALUES (
          NEW.id, NEW.node_id, NEW.node_incarnation, NEW.fleet_kind,
          NEW.infrastructure_provider, NEW.provider_server_id, NEW.host_key_fingerprint,
          clock_timestamp()
        ) ON CONFLICT (docker_node_record_id, node_incarnation) DO NOTHING;
        RETURN NEW;
      END;
      $$
    `),
    );
    await dbWrite.execute(
      sql.raw(`
      CREATE TRIGGER test_docker_nodes_incarnation_history
      BEFORE INSERT OR UPDATE OF node_id, node_incarnation, fleet_kind,
        infrastructure_provider, provider_server_id, host_key_fingerprint
      ON docker_nodes FOR EACH ROW EXECUTE FUNCTION test_journal_node_incarnation()
    `),
    );
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.delete(agentBackupRestoreOperations);
  await dbWrite.delete(agentBackupRestoreLeases);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(agentNodeIncarnationHistories);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await seedFixture();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("restore activation quarantine", () => {
  test("keeps both writers on backup-operation-lease-sandbox-node-catalogue lock order", () => {
    expectCanonicalQuarantineLockOrder(
      quarantineTransactionBody(
        "openAgentBackupRestoreQuarantine",
        "recordAgentBackupRestoreQuarantinedContainer",
      ),
    );
    expectCanonicalQuarantineLockOrder(
      quarantineTransactionBody("recordAgentBackupRestoreQuarantinedContainer"),
    );
  });

  test(
    "opens once, replays exactly, derives the target generation, and preserves the canonical route",
    async () => {
      const before = await readRows();
      const results = await Promise.all([
        openAgentBackupRestoreQuarantine(openInput()),
        openAgentBackupRestoreQuarantine(openInput()),
      ]);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);

      const { sandbox, operation, node } = await readRows();
      expect(sandbox.activation_generation).toBe(RESTORE_ATTEMPT_ID);
      expect(sandbox.activation_generation).not.toBe(SOURCE_ACTIVATION_GENERATION);
      expect(sandbox.activation_previous_generation).toBe(PREVIOUS_ACTIVATION_GENERATION);
      expect(sandbox.activation_lifecycle_revision).toBe(BigInt(sandbox.lifecycle_revision));
      expect(sandbox.lifecycle_revision).toBe(8);
      expect(sandbox.activation_purpose).toBe("restore");
      expect(sandbox.activation_phase).toBe("container_pending");
      expect(sandbox.activation_backup_id).toBe(BACKUP_ID);
      expect(sandbox.activation_backup_hash).toBe(manifestFixture.digest);
      expect(sandbox.activation_token_hash).toBe(TOKEN_SHA);
      expect(sandbox.activation_token_ciphertext).toBe(TOKEN_CIPHERTEXT);
      expect([
        sandbox.activation_receipt,
        sandbox.activation_receipt_hash,
        sandbox.activation_container_id,
        sandbox.activation_node_id,
        sandbox.activation_image_digest,
        sandbox.activation_boot_id,
        sandbox.activation_authority_published_at,
        sandbox.activation_funding_revision,
        sandbox.activation_dispatched_at,
        sandbox.activation_completed_at,
      ]).toEqual(Array.from({ length: 10 }, () => null));
      expect({
        sandbox_id: sandbox.sandbox_id,
        node_id: sandbox.node_id,
        image_digest: sandbox.image_digest,
        status: sandbox.status,
      }).toEqual({
        sandbox_id: before.sandbox.sandbox_id,
        node_id: before.sandbox.node_id,
        image_digest: before.sandbox.image_digest,
        status: before.sandbox.status,
      });
      expect(operation.phase).toBe("reserved");
      expect(operation.claim_generation).toBe(initialClaimGeneration);
      expect(node.allocated_count).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "makes token and backup divergence conflicts without rewriting quarantine authority",
    async () => {
      await openAgentBackupRestoreQuarantine(openInput());
      const opened = await readRows();
      await expect(
        openAgentBackupRestoreQuarantine({
          ...openInput(),
          activationTokenSha256: OTHER_TOKEN_SHA,
        }),
      ).rejects.toThrow("replay authority mismatch");
      expect((await readRows()).sandbox.lifecycle_revision).toBe(opened.sandbox.lifecycle_revision);

      await dbWrite
        .update(agentSandboxes)
        .set({
          activation_backup_hash: OTHER_SHA,
          activation_lifecycle_revision: sql`${agentSandboxes.lifecycle_revision} + 1`,
        })
        .where(eq(agentSandboxes.id, AGENT_ID));
      const divergent = await readRows();
      await expect(openAgentBackupRestoreQuarantine(openInput())).rejects.toThrow(
        "replay authority mismatch",
      );
      const after = await readRows();
      expect(after.sandbox.activation_backup_hash).toBe(OTHER_SHA);
      expect(after.sandbox.lifecycle_revision).toBe(divergent.sandbox.lifecycle_revision);
    },
    TIMEOUT,
  );

  test(
    "rejects lost claims, expired leases, and catalogue drift before any sandbox write",
    async () => {
      await dbWrite
        .update(agentBackupRestoreOperations)
        .set({ expected_container_id: CONTAINER_A })
        .where(eq(agentBackupRestoreOperations.id, operationId));
      await expect(openAgentBackupRestoreQuarantine(openInput())).rejects.toThrow(
        "pre-existing container authority",
      );
      await dbWrite
        .update(agentBackupRestoreOperations)
        .set({ expected_container_id: null })
        .where(eq(agentBackupRestoreOperations.id, operationId));

      await expect(
        openAgentBackupRestoreQuarantine({
          ...openInput(),
          claimGeneration: LEASE_GENERATION,
        }),
      ).rejects.toThrow("claim is not live");
      expect((await readRows()).sandbox.activation_generation).toBe(PREVIOUS_ACTIVATION_GENERATION);

      await dbWrite
        .update(agentBackupRestoreLeases)
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .where(eq(agentBackupRestoreLeases.id, LEASE_ID));
      await expect(openAgentBackupRestoreQuarantine(openInput())).rejects.toThrow(
        "lease is expired or released",
      );
      await dbWrite
        .update(agentBackupRestoreLeases)
        .set({ expires_at: new Date(Date.now() + 600_000) })
        .where(eq(agentBackupRestoreLeases.id, LEASE_ID));

      await dbWrite
        .update(agentBackupCatalogAuthorities)
        .set({ catalog_revision: 4n })
        .where(eq(agentBackupCatalogAuthorities.agent_id, AGENT_ID));
      await expect(openAgentBackupRestoreQuarantine(openInput())).rejects.toThrow(
        "invalidated by a catalogue revision",
      );
      const after = await readRows();
      expect(after.sandbox.activation_generation).toBe(PREVIOUS_ACTIVATION_GENERATION);
      expect(after.sandbox.lifecycle_revision).toBe(7);
      expect(after.node.allocated_count).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "rejects a true target-node A-to-B-to-A incarnation replay without mutation",
    async () => {
      await dbWrite
        .update(dockerNodes)
        .set({ node_incarnation: OTHER_NODE_INCARNATION })
        .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
      await dbWrite
        .update(dockerNodes)
        .set({ node_incarnation: TARGET_NODE_INCARNATION })
        .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
      expect((await readRows()).node.node_incarnation).toBe(TARGET_NODE_INCARNATION);
      await expect(openAgentBackupRestoreQuarantine(openInput())).rejects.toThrow(
        "ambiguous multi-incarnation history",
      );
      const after = await readRows();
      expect(after.sandbox.activation_generation).toBe(PREVIOUS_ACTIVATION_GENERATION);
      expect(after.operation.phase).toBe("reserved");
      expect(after.operation.expected_container_id).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "rejects an ancient backdated B history before the first quarantine write",
    async () => {
      const [history] = await dbWrite
        .select()
        .from(agentNodeIncarnationHistories)
        .where(eq(agentNodeIncarnationHistories.docker_node_record_id, TARGET_NODE_RECORD_ID));
      if (!history) throw new Error("restore target history fixture is missing");
      await dbWrite.insert(agentNodeIncarnationHistories).values({
        docker_node_record_id: history.docker_node_record_id,
        node_id: history.node_id,
        node_incarnation: OTHER_NODE_INCARNATION,
        fleet_kind: history.fleet_kind,
        infrastructure_provider: history.infrastructure_provider,
        provider_server_id: history.provider_server_id,
        host_key_fingerprint: history.host_key_fingerprint,
        attested_at: new Date("2000-01-01T00:00:00.000Z"),
      });

      await expect(openAgentBackupRestoreQuarantine(openInput())).rejects.toThrow(
        "ambiguous multi-incarnation history",
      );
      const after = await readRows();
      expect(after.sandbox.activation_generation).toBe(PREVIOUS_ACTIVATION_GENERATION);
      expect(after.operation.phase).toBe("reserved");
      expect(after.operation.expected_container_id).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "rejects first placement after node eligibility drift but preserves exact open replay",
    async () => {
      const ineligibleStates = [
        { enabled: false },
        { enabled: true, status: "degraded" as const },
        { status: "healthy" as const, placement_state: "cordoned" as const },
        { placement_state: "open" as const, metadata: { capacityProvisional: true } },
      ];
      for (const state of ineligibleStates) {
        await dbWrite
          .update(dockerNodes)
          .set({
            enabled: true,
            status: "healthy",
            placement_state: "open",
            metadata: {},
            ...state,
          })
          .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
        await expect(openAgentBackupRestoreQuarantine(openInput())).rejects.toThrow(
          "no longer eligible for first placement",
        );
        expect((await readRows()).sandbox.activation_generation).toBe(
          PREVIOUS_ACTIVATION_GENERATION,
        );
      }

      await dbWrite
        .update(dockerNodes)
        .set({ enabled: true, status: "healthy", placement_state: "open", metadata: {} })
        .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
      await openAgentBackupRestoreQuarantine(openInput());
      await dbWrite
        .update(dockerNodes)
        .set({
          enabled: false,
          status: "degraded",
          placement_state: "cordoned",
          metadata: { capacityProvisional: true },
        })
        .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
      const replay = await openAgentBackupRestoreQuarantine(openInput());
      expect(replay.replayed).toBe(true);
      expect(replay.sandbox.activation_phase).toBe("container_pending");
    },
    TIMEOUT,
  );

  test(
    "records one exact container atomically, clears the claim, and replays without rewind",
    async () => {
      const claimGeneration = await openAndClaimVaultSeeded();
      const request = {
        operationId,
        ownerId: "restore-worker",
        claimGeneration,
        containerId: CONTAINER_A,
        expectedActivationTokenSha256: TOKEN_SHA,
      } as const;
      const results = await Promise.all([
        recordAgentBackupRestoreQuarantinedContainer(request),
        recordAgentBackupRestoreQuarantinedContainer(request),
      ]);
      expect(results.filter((result) => !result.replayed)).toHaveLength(1);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);

      const replay = await recordAgentBackupRestoreQuarantinedContainer(request);
      expect(replay.replayed).toBe(true);
      const { sandbox, operation, node } = await readRows();
      expect(sandbox.activation_generation).toBe(RESTORE_ATTEMPT_ID);
      expect(sandbox.activation_phase).toBe("restore_pending");
      expect(sandbox.activation_container_id).toBe(CONTAINER_A);
      expect(sandbox.activation_node_id).toBe("restore-target");
      expect(sandbox.activation_image_digest).toBe(IMAGE_DIGEST);
      expect(sandbox.activation_boot_id).toBe(TARGET_NODE_INCARNATION);
      expect(sandbox.activation_lifecycle_revision).toBe(BigInt(sandbox.lifecycle_revision));
      expect(sandbox.lifecycle_revision).toBe(9);
      expect(sandbox.activation_authority_published_at).toBeNull();
      expect(sandbox.activation_dispatched_at).toBeNull();
      expect(sandbox.activation_completed_at).toBeNull();
      expect(sandbox.sandbox_id).toBe("canonical-provider-handle");
      expect(sandbox.node_id).toBe("canonical-node");
      expect(sandbox.image_digest).toBe(CANONICAL_IMAGE_DIGEST);
      expect(sandbox.status).toBe("running");
      expect(operation.phase).toBe("container_created");
      expect(operation.expected_container_id).toBe(CONTAINER_A);
      expect(operation.claim_owner).toBeNull();
      expect(operation.claim_generation).toBeNull();
      expect(operation.claim_expires_at).toBeNull();
      expect(node.allocated_count).toBe(1);

      await expect(
        recordAgentBackupRestoreQuarantinedContainer({
          ...request,
          containerId: CONTAINER_B,
        }),
      ).rejects.toThrow("replay authority mismatch");
      expect((await readRows()).operation.expected_container_id).toBe(CONTAINER_A);

      await dbWrite
        .update(dockerNodes)
        .set({
          enabled: false,
          status: "degraded",
          placement_state: "cordoned",
          metadata: { capacityProvisional: true },
        })
        .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
      expect((await recordAgentBackupRestoreQuarantinedContainer(request)).replayed).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "allows only one concurrent divergent container contender",
    async () => {
      const claimGeneration = await openAndClaimVaultSeeded();
      const base = {
        operationId,
        ownerId: "restore-worker",
        claimGeneration,
        expectedActivationTokenSha256: TOKEN_SHA,
      } as const;
      const outcomes = await Promise.allSettled([
        recordAgentBackupRestoreQuarantinedContainer({ ...base, containerId: CONTAINER_A }),
        recordAgentBackupRestoreQuarantinedContainer({ ...base, containerId: CONTAINER_B }),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
      const { sandbox, operation } = await readRows();
      const expectedContainerId = operation.expected_container_id;
      if (!expectedContainerId) {
        throw new Error("winning quarantine contender did not persist its container id");
      }
      expect([CONTAINER_A, CONTAINER_B]).toContain(expectedContainerId);
      expect(sandbox.activation_container_id).toBe(expectedContainerId);
      expect(operation.phase).toBe("container_created");
    },
    TIMEOUT,
  );

  test(
    "rejects container recording after node loss without partial phase writes",
    async () => {
      const claimGeneration = await openAndClaimVaultSeeded();
      const request = {
        operationId,
        ownerId: "restore-worker",
        claimGeneration,
        containerId: CONTAINER_A,
        expectedActivationTokenSha256: TOKEN_SHA,
      } as const;
      await dbWrite
        .update(dockerNodes)
        .set({ node_incarnation: OTHER_NODE_INCARNATION })
        .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
      await expect(recordAgentBackupRestoreQuarantinedContainer(request)).rejects.toThrow(
        "node incarnation changed",
      );
      const after = await readRows();
      expect(after.sandbox.activation_phase).toBe("container_pending");
      expect(after.sandbox.activation_container_id).toBeNull();
      expect(after.operation.phase).toBe("vault_seeded");
      expect(after.operation.expected_container_id).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "rejects first container binding after placement or lease loss without partial writes",
    async () => {
      const claimGeneration = await openAndClaimVaultSeeded();
      const request = {
        operationId,
        ownerId: "restore-worker",
        claimGeneration,
        containerId: CONTAINER_A,
        expectedActivationTokenSha256: TOKEN_SHA,
      } as const;
      await dbWrite
        .update(dockerNodes)
        .set({ placement_state: "cordoned" })
        .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
      await expect(recordAgentBackupRestoreQuarantinedContainer(request)).rejects.toThrow(
        "no longer eligible for first placement",
      );
      let after = await readRows();
      expect(after.sandbox.activation_phase).toBe("container_pending");
      expect(after.operation.phase).toBe("vault_seeded");

      await dbWrite
        .update(dockerNodes)
        .set({ placement_state: "open" })
        .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
      await dbWrite
        .update(agentBackupRestoreLeases)
        .set({ expires_at: new Date(Date.now() - 1_000) })
        .where(eq(agentBackupRestoreLeases.id, LEASE_ID));
      await expect(recordAgentBackupRestoreQuarantinedContainer(request)).rejects.toThrow(
        "lease is expired or released",
      );
      after = await readRows();
      expect(after.sandbox.activation_phase).toBe("container_pending");
      expect(after.operation.phase).toBe("vault_seeded");
      expect(after.operation.claim_generation).toBe(claimGeneration);
    },
    TIMEOUT,
  );
});
