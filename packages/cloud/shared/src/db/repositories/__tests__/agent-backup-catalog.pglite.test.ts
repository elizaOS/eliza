/** Real-PGlite proofs for the v2 backup catalogue and exact-key GC outbox. */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
  type AgentBackupManifestV2Draft,
  type AgentBackupManifestV3Draft,
  canonicalizeAgentBackupManifestV2,
  canonicalizeAgentBackupManifestV3,
  canonicalizeAgentBackupOperationKeyBundleContext,
  computeAgentBackupChunkAadDigest,
  computeAgentBackupManifestV2Digest,
  createAgentBackupManifestV3,
} from "@elizaos/shared";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { executeAgentBackupGcClaims } from "../../../lib/services/agent-backup-catalog-worker";
import { createAgentBackupObjectStoreRegistry } from "../../../lib/storage/agent-backup-object-store";
import type {
  RuntimeR2Bucket,
  RuntimeR2ObjectMetadata,
} from "../../../lib/storage/r2-runtime-binding";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import {
  agentBackupCatalogAuthorities,
  agentBackupGcOutbox,
  agentBackupObjects,
  agentBackupRestoreLeases,
} from "../../schemas/agent-backup-catalog";
import { agentSandboxBackups, agentSandboxes } from "../../schemas/agent-sandboxes";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import type { AgentBackupOperationExecution } from "../agent-backup-catalog";
import {
  agentBackupObjectInventoryDigest,
  buildAgentBackupObjectKey,
  claimDueAgentBackupOperations,
  failAgentBackupOperation,
  markAgentBackupObjectUploading,
  markAgentBackupObjectVerified,
  recordAgentBackupObjectPresent,
  recordCapturedAgentBackupManifest,
  reserveAgentBackupObject,
  reserveAgentBackupOperation,
  transitionAgentBackupOperation,
} from "../agent-backup-catalog";
import {
  adoptAgentBackupGcObservedLocator,
  claimAgentBackupGc,
  enqueueAgentBackupDeletion,
  failAgentBackupGc,
  finalizeAgentBackupDeletion,
  listDueAgentBackupDeletions,
  listFinalizableAgentBackupDeletions,
  settleAgentBackupGc,
} from "../agent-backup-gc";
import {
  authorizeAgentBackupProtectedSpoolCleanup,
  listAgentBackupProtectedSpoolCleanupCandidates,
} from "../agent-backup-publication";
import { agentSandboxesRepository } from "../agent-sandboxes";

const PGLITE_TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-00000000c001";
const FOREIGN_ORG_ID = "00000000-0000-4000-8000-00000000c00a";
const USER_ID = "00000000-0000-4000-8000-00000000c002";
const AGENT_ID = "00000000-0000-4000-8000-00000000c003";
const OPERATION_ID = "00000000-0000-4000-8000-00000000c004";
const LIFECYCLE_GENERATION = "00000000-0000-4000-8000-00000000c005";
const NODE_RECORD_ID = "00000000-0000-4000-8000-00000000c006";
const NODE_INCARNATION = "00000000-0000-4000-8000-00000000c00d";
const INCREMENTAL_OPERATION_ID = "00000000-0000-4000-8000-00000000c007";
const INCREMENTAL_GENERATION = "00000000-0000-4000-8000-00000000c008";
const NONCATALOG_BACKUP_ID = "00000000-0000-4000-8000-00000000c00b";
const LEGACY_BACKUP_ID = "00000000-0000-4000-8000-00000000c00c";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SOURCE_CONTAINER_ID = "f".repeat(64);
const SOURCE_IMAGE_DIGEST = `sha256:${"9".repeat(64)}`;
const KEY_BUNDLE_GENERATION_ID = "00000000-0000-4000-8000-00000000c014";
const VAULT_KEY_GENERATION_ID = "00000000-0000-4000-8000-00000000c015";
const WRAPPED_KEY_BUNDLE = Buffer.alloc(AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes, 0x43);
const PRIMARY_ENDPOINT_FINGERPRINT = `sha256:${"1".repeat(64)}`;
const SECONDARY_ENDPOINT_FINGERPRINT = `sha256:${"2".repeat(64)}`;

let schemaFailure = "";

interface TestBackupReservation {
  organizationId: string;
  agentId: string;
  sandboxRecordId: string;
  operationId: string;
  lifecycleGeneration: string;
  lifecycleRevision: string;
  snapshotType: "auto" | "manual" | "pre-shutdown" | "pre-upgrade" | "pre-delete";
  backupKind: "full" | "incremental";
  parentBackupId?: string;
  baseBackupId?: string;
  sourceProvider: "operator-onboarded" | "hetzner-cloud";
  sourceNodeRecordId: string;
  sourceNodeId: string;
  sourceNodeIncarnation: string;
  sourceProviderServerId: string | null;
  sourceProviderHandle: string;
  sourceContainerId: string;
  retentionReason:
    | "schedule"
    | "manual"
    | "pre-shutdown"
    | "pre-delete"
    | "pre-upgrade"
    | "pre-move"
    | "billing-freeze"
    | "legal-hold"
    | "user-erasure";
  retentionUntil: Date;
}

function reservation(overrides: Partial<TestBackupReservation> = {}): TestBackupReservation {
  return {
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    sandboxRecordId: AGENT_ID,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    lifecycleRevision: "0",
    snapshotType: "auto" as const,
    backupKind: "full" as const,
    sourceProvider: "operator-onboarded" as const,
    sourceNodeRecordId: NODE_RECORD_ID,
    sourceNodeId: "robot-node-1",
    sourceNodeIncarnation: NODE_INCARNATION,
    sourceProviderServerId: null,
    sourceProviderHandle: "container-generation-1",
    sourceContainerId: SOURCE_CONTAINER_ID,
    retentionReason: "schedule" as const,
    retentionUntil: new Date("2020-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function exactReservation(
  overrides: Partial<Parameters<typeof reserveAgentBackupOperation>[0]> = {},
): Parameters<typeof reserveAgentBackupOperation>[0] {
  return {
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    sandboxRecordId: AGENT_ID,
    operationId: OPERATION_ID,
    activationGeneration: LIFECYCLE_GENERATION,
    lifecycleRevision: "0",
    snapshotType: "auto",
    backupKind: "full",
    sourceProvider: "operator-onboarded",
    sourceNodeRecordId: NODE_RECORD_ID,
    sourceNodeId: "robot-node-1",
    sourceNodeIncarnation: NODE_INCARNATION,
    sourceProviderServerId: null,
    sourceProviderHandle: "container-generation-1",
    sourceContainerId: SOURCE_CONTAINER_ID,
    retentionReason: "schedule",
    retentionUntil: new Date("2026-09-17T00:00:00.000Z"),
    ...overrides,
  };
}

async function reserveTestBackup(overrides: Partial<TestBackupReservation> = {}) {
  const input = reservation(overrides);
  await dbWrite
    .insert(agentBackupCatalogAuthorities)
    .values({ organization_id: input.organizationId, agent_id: input.agentId })
    .onConflictDoNothing();
  const [authority] = await dbWrite
    .select({ revision: agentBackupCatalogAuthorities.catalog_revision })
    .from(agentBackupCatalogAuthorities)
    .where(eq(agentBackupCatalogAuthorities.agent_id, input.agentId));
  if (!authority) throw new Error("Expected catalogue authority fixture");
  const [backup] = await dbWrite
    .insert(agentSandboxBackups)
    .values({
      id: randomUUID(),
      sandbox_record_id: input.sandboxRecordId,
      snapshot_type: input.snapshotType,
      state_data: { memories: [], config: {}, workspaceFiles: {} },
      state_data_storage: "inline",
      size_bytes: 0,
      backup_kind: input.backupKind,
      parent_backup_id: input.parentBackupId ?? null,
      base_backup_id: input.baseBackupId ?? null,
      backup_operation_id: input.operationId,
      catalog_version: 2,
      catalog_state: "scheduled",
      catalog_payload_digest: SHA_A,
      catalog_revision: authority.revision,
      catalog_organization_id: input.organizationId,
      catalog_agent_id: input.agentId,
      lifecycle_generation: input.lifecycleGeneration,
      lifecycle_revision: BigInt(input.lifecycleRevision),
      source_provider: input.sourceProvider,
      source_node_record_id: input.sourceNodeRecordId,
      source_node_id: input.sourceNodeId,
      source_node_incarnation: input.sourceNodeIncarnation,
      source_provider_server_id: input.sourceProviderServerId,
      source_provider_handle: input.sourceProviderHandle,
      source_container_id: input.sourceContainerId,
      retention_reason: input.retentionReason,
      retention_until: input.retentionUntil,
      catalog_next_attempt_at: new Date("2020-01-01T00:00:00.000Z"),
      catalog_updated_at: new Date(),
    })
    .returning();
  if (!backup) throw new Error("Expected catalogue backup fixture");
  return backup;
}

function objectDescriptor(index = 0) {
  return {
    component: "database",
    chunkIndex: index,
    contentHmacSha256: index === 0 ? SHA_A : SHA_C,
    ciphertextSha256: index === 0 ? SHA_B : SHA_D,
    sizeBytes: index === 0 ? 123 : 456,
  };
}

async function capturedManifest(
  inventory: ReturnType<typeof objectDescriptor>[],
  options: Readonly<{
    operationId?: string;
    createdAt?: string;
    chain?: AgentBackupManifestV2Draft["chain"];
  }> = {},
) {
  const operationId = options.operationId ?? OPERATION_ID;
  const identity = {
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    activationGeneration: LIFECYCLE_GENERATION,
    lifecycleRevision: "0",
  } as const;
  let offsetBytes = 0;
  const databaseChunks = await Promise.all(
    inventory.map(async (object) => {
      const payloadBytes = object.sizeBytes - 28;
      const descriptor = {
        index: object.chunkIndex,
        offsetBytes,
        plainBytes: payloadBytes,
        compressedBytes: payloadBytes,
        encryptedBytes: object.sizeBytes,
        contentHmacSha256: object.contentHmacSha256,
        sha256: object.ciphertextSha256,
      };
      offsetBytes += payloadBytes;
      return {
        ...descriptor,
        aadSha256: await computeAgentBackupChunkAadDigest({
          identity,
          operationId,
          component: { name: "database", format: "raw-v1", compression: "none" },
          chunk: {
            index: descriptor.index,
            offsetBytes: descriptor.offsetBytes,
            plainBytes: descriptor.plainBytes,
            compressedBytes: descriptor.compressedBytes,
            contentHmacSha256: descriptor.contentHmacSha256,
          },
        }),
      };
    }),
  );
  const componentNames =
    options.chain?.kind === "incremental"
      ? (["database"] as const)
      : (["character", "database", "media", "state-files", "vault"] as const);
  const components = componentNames.map((name) => {
    const chunks = name === "database" ? databaseChunks : [];
    const totals = chunks.reduce(
      (sum, chunk) => ({
        plainBytes: sum.plainBytes + chunk.plainBytes,
        compressedBytes: sum.compressedBytes + chunk.compressedBytes,
        encryptedBytes: sum.encryptedBytes + chunk.encryptedBytes,
        chunkCount: sum.chunkCount + 1,
      }),
      { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
    );
    return {
      name,
      format: "raw-v1",
      compression: "none" as const,
      payloadContentHmacSha256: SHA_A,
      state:
        options.chain?.kind === "incremental"
          ? {
              kind: "delta" as const,
              baseContentHmacSha256: SHA_B,
              resultContentHmacSha256: SHA_A,
              tombstoneCount: 0,
              overlayOrder: "delete-then-upsert" as const,
            }
          : { kind: "full" as const, resultContentHmacSha256: SHA_A },
      totals,
      chunks,
    };
  });
  const totals = components.reduce(
    (sum, component) => ({
      plainBytes: sum.plainBytes + component.totals.plainBytes,
      compressedBytes: sum.compressedBytes + component.totals.compressedBytes,
      encryptedBytes: sum.encryptedBytes + component.totals.encryptedBytes,
      chunkCount: sum.chunkCount + component.totals.chunkCount,
    }),
    { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
  );
  const wrappedDek = new Uint8Array(64).fill(7);
  const kmsKeyId = `org:${ORG_ID}/dek/v1`;
  const draft: AgentBackupManifestV2Draft = {
    format: "elizaos.agent-backup",
    schemaVersion: 2,
    operationId,
    createdAt: options.createdAt ?? "2026-08-17T00:00:00.000Z",
    identity,
    source: {
      kind: "robot",
      provider: "hetzner",
      nodeRecordId: NODE_RECORD_ID,
      nodeIncarnation: NODE_INCARNATION,
      nodeId: "robot-node-1",
      containerId: SOURCE_CONTAINER_ID,
    },
    runtime: {
      imageDigest: SOURCE_IMAGE_DIGEST,
      agentSchemaVersion: "2",
      databaseSchemaVersion: "1",
      plugins: [],
    },
    chain: options.chain ?? {
      kind: "full",
      baseOperationId: null,
      parentOperationId: null,
      depth: 0,
    },
    components,
    watermarks: [{ namespace: "database.sequence", value: "1" }],
    totals,
    encryption: {
      algorithm: "AES-256-GCM",
      dekGenerationId: operationId,
      envelopeVersion: 1,
      chunkEnvelope: "aes-256-gcm-v1",
      nonceBytes: 12,
      tagBytes: 16,
      noncePlacement: "prefix",
      tagPlacement: "suffix",
      aad: { version: 1, derivation: "elizaos.agent-backup.chunk-aad.v1" },
      kms: { provider: "steward", keyId: kmsKeyId, keyVersion: 1 },
      wrappedDek: {
        format: "kms-aead-envelope-v1",
        ref: `backup-dek:${operationId}`,
        bytes: wrappedDek.byteLength,
        sha256: await digestHex(wrappedDek),
        contextDerivation: "elizaos.agent-backup.dek-context.v1",
      },
    },
    integrity: {
      framedContentHmacSha256: SHA_D,
      contentAddressing: {
        algorithm: "HMAC-SHA-256",
        scope: "organization",
        derivation: "elizaos.agent-backup.content-hmac.v1",
        keyId: `org:${ORG_ID}/backup-content/v1`,
        keyVersion: 1,
      },
    },
  };
  const canonicalManifestDraft = canonicalizeAgentBackupManifestV2(draft);
  return {
    canonicalManifestDraft,
    format: draft.format,
    version: draft.schemaVersion,
    digest: await computeAgentBackupManifestV2Digest(draft),
    objectCount: inventory.length,
    objectInventoryDigest: await agentBackupObjectInventoryDigest(inventory),
    imageDigest: draft.runtime.imageDigest,
    databaseSchemaVersion: draft.runtime.databaseSchemaVersion,
    pluginSetDigest: await digestCanonical({ version: 1, plugins: draft.runtime.plugins }),
    watermarkDigest: await digestCanonical({ version: 1, watermarks: draft.watermarks }),
    rawSizeBytes: totals.plainBytes,
    compressedSizeBytes: totals.compressedBytes,
    encryptedSizeBytes: totals.encryptedBytes,
    kmsKeyId,
    kmsKeyVersion: 1,
    wrappedDekCiphertextBase64: Buffer.from(wrappedDek).toString("base64"),
    wrappedDekReceiptDigest: SHA_B,
  };
}

function operationKeyBundleContext(operationId: string): string {
  return canonicalizeAgentBackupOperationKeyBundleContext({
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    activationGeneration: LIFECYCLE_GENERATION,
    lifecycleRevision: "0",
    operationId,
    keyBundleGenerationId: KEY_BUNDLE_GENERATION_ID,
    sourceKind: "robot",
    sourceProvider: "hetzner",
    kmsProvider: "steward",
    keyId: `org:${ORG_ID}/dek/v1`,
    keyVersion: 1,
  });
}

async function operationKeyBundleLocalReceiptDigest(input: {
  keyId: string;
  keyVersion: number;
  canonicalContext: string;
  wrappedKeyBundle: Uint8Array;
}): Promise<string> {
  return digestHex(
    new TextEncoder().encode(
      JSON.stringify({
        derivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        keyId: input.keyId,
        keyVersion: input.keyVersion,
        contextSha256: await digestHex(new TextEncoder().encode(input.canonicalContext)),
        wrappedKeyBundleSha256: await digestHex(input.wrappedKeyBundle),
      }),
    ),
  );
}

async function capturedManifestV3(
  inventory: ReturnType<typeof objectDescriptor>[],
  options: Readonly<{ operationId?: string; createdAt?: string }> = {},
) {
  const operationId = options.operationId ?? OPERATION_ID;
  const v2 = await capturedManifest(inventory, {
    operationId,
    createdAt: options.createdAt,
  });
  const v2Draft = JSON.parse(v2.canonicalManifestDraft) as AgentBackupManifestV2Draft;
  const {
    schemaVersion: _schemaVersion,
    encryption: v2Encryption,
    integrity: v2Integrity,
    ...common
  } = v2Draft;
  const canonicalContext = operationKeyBundleContext(operationId);
  const wrappedKeyBundleSha256 = await digestHex(WRAPPED_KEY_BUNDLE);
  const wrappedKeyBundleLocalReceiptDigest = await operationKeyBundleLocalReceiptDigest({
    keyId: v2Encryption.kms.keyId,
    keyVersion: v2Encryption.kms.keyVersion,
    canonicalContext,
    wrappedKeyBundle: WRAPPED_KEY_BUNDLE,
  });
  const draft: AgentBackupManifestV3Draft = {
    ...common,
    schemaVersion: 3,
    vaultKeyAuthority: {
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      generationId: VAULT_KEY_GENERATION_ID,
      receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      receiptDigest: SHA_D,
    },
    encryption: {
      algorithm: v2Encryption.algorithm,
      chunkEnvelope: v2Encryption.chunkEnvelope,
      nonceBytes: v2Encryption.nonceBytes,
      tagBytes: v2Encryption.tagBytes,
      noncePlacement: v2Encryption.noncePlacement,
      tagPlacement: v2Encryption.tagPlacement,
      aad: v2Encryption.aad,
      kms: { ...v2Encryption.kms, provider: "steward" },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        generationId: KEY_BUNDLE_GENERATION_ID,
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek,
        contentHmac: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac,
        wrapped: {
          ref: `backup-key-bundle:${operationId}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256: wrappedKeyBundleSha256,
          localReceiptDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest: wrappedKeyBundleLocalReceiptDigest,
          contextDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
    integrity: {
      framedContentHmacSha256: v2Integrity.framedContentHmacSha256,
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
  return {
    canonicalManifestDraft: canonicalizeAgentBackupManifestV3(draft),
    format: manifest.format,
    version: manifest.schemaVersion,
    digest: manifest.integrity.manifestSha256,
    objectCount: inventory.length,
    objectInventoryDigest: await agentBackupObjectInventoryDigest(inventory),
    imageDigest: manifest.runtime.imageDigest,
    databaseSchemaVersion: manifest.runtime.databaseSchemaVersion,
    pluginSetDigest: await digestCanonical({ version: 1, plugins: manifest.runtime.plugins }),
    watermarkDigest: await digestCanonical({ version: 1, watermarks: manifest.watermarks }),
    rawSizeBytes: manifest.totals.plainBytes,
    compressedSizeBytes: manifest.totals.compressedBytes,
    encryptedSizeBytes: manifest.totals.encryptedBytes,
    kmsKeyId: manifest.encryption.kms.keyId,
    kmsKeyVersion: manifest.encryption.kms.keyVersion,
    wrappedKeyBundleCiphertextBase64: WRAPPED_KEY_BUNDLE.toString("base64"),
    wrappedKeyBundleSha256,
    wrappedKeyBundleLocalReceiptDigest,
    wrappedKeyBundleGenerationId: KEY_BUNDLE_GENERATION_ID,
    vaultKeyGenerationId: VAULT_KEY_GENERATION_ID,
    vaultKeyAuthorityReceiptDigest: SHA_D,
  };
}

async function captureBackup(
  objectCount = 1,
  suppliedInventory?: ReturnType<typeof objectDescriptor>[],
) {
  const reserved = await reserveTestBackup();
  const execution = await claimExecution(reserved.id);
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId: reserved.id,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "scheduled",
    to: "capturing",
    execution,
  });
  const inventory =
    suppliedInventory ?? Array.from({ length: objectCount }, (_, index) => objectDescriptor(index));
  const manifest = await capturedManifest(inventory);
  const draft = JSON.parse(manifest.canonicalManifestDraft) as AgentBackupManifestV2Draft;
  const [captured] = await dbWrite
    .update(agentSandboxBackups)
    .set({
      catalog_state: "captured",
      manifest_format: manifest.format,
      manifest_version: manifest.version,
      manifest_digest: manifest.digest,
      manifest_canonical_draft: manifest.canonicalManifestDraft,
      manifest_object_count: manifest.objectCount,
      object_inventory_digest: manifest.objectInventoryDigest,
      image_digest: manifest.imageDigest,
      database_schema_version: manifest.databaseSchemaVersion,
      plugin_set_digest: manifest.pluginSetDigest,
      watermark_digest: manifest.watermarkDigest,
      raw_size_bytes: manifest.rawSizeBytes,
      compressed_size_bytes: manifest.compressedSizeBytes,
      encrypted_size_bytes: manifest.encryptedSizeBytes,
      kms_key_id: manifest.kmsKeyId,
      kms_key_version: manifest.kmsKeyVersion,
      wrapped_dek_ref: draft.encryption.wrappedDek.ref,
      wrapped_dek_ciphertext_base64: manifest.wrappedDekCiphertextBase64,
      wrapped_dek_sha256: draft.encryption.wrappedDek.sha256,
      wrapped_dek_size_bytes: draft.encryption.wrappedDek.bytes,
      wrapped_dek_receipt_digest: manifest.wrappedDekReceiptDigest,
      catalog_updated_at: new Date(),
    })
    .where(eq(agentSandboxBackups.id, reserved.id))
    .returning();
  if (!captured) throw new Error("Expected captured catalogue fixture");
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId: reserved.id,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "captured",
    to: "uploading",
    execution,
  });
  return { backupId: reserved.id, inventory, execution };
}

function digestHex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return crypto.subtle
    .digest("SHA-256", owned)
    .then((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digestCanonical(value: unknown): Promise<string> {
  return digestHex(new TextEncoder().encode(canonicalJson(value)));
}

function exactRuntimeBucket(): {
  bucket: RuntimeR2Bucket;
  objects: Map<string, RuntimeR2ObjectMetadata>;
  loseNextDeleteResponse: () => void;
} {
  const objects = new Map<string, RuntimeR2ObjectMetadata>();
  let loseDeleteResponse = false;
  return {
    objects,
    loseNextDeleteResponse() {
      loseDeleteResponse = true;
    },
    bucket: {
      async head(key) {
        return objects.get(key) ?? null;
      },
      async get() {
        return null;
      },
      async put(key, value, options) {
        if (objects.has(key)) return null;
        const size =
          value instanceof Uint8Array
            ? value.byteLength
            : value instanceof ArrayBuffer
              ? value.byteLength
              : 0;
        const sha256 = options?.sha256;
        if (!(sha256 instanceof ArrayBuffer)) throw new Error("Expected immutable SHA-256");
        const object = {
          size,
          etag: `etag-${key.length}`,
          version: `version-${key.length}`,
          checksums: { sha256: sha256.slice(0) },
          customMetadata: options?.customMetadata,
        };
        objects.set(key, object);
        return object;
      },
      async delete(key) {
        objects.delete(key);
        if (loseDeleteResponse) {
          loseDeleteResponse = false;
          throw new Error("simulated delete response loss");
        }
      },
    },
  };
}

async function claimExecution(backupId: string) {
  const generation = randomUUID();
  const [claimed] = await dbWrite
    .update(agentSandboxBackups)
    .set({
      catalog_lease_owner: "backup-worker-1",
      catalog_lease_generation: generation,
      catalog_lease_expires_at: new Date(Date.now() + 60_000),
      catalog_updated_at: new Date(),
    })
    .where(eq(agentSandboxBackups.id, backupId))
    .returning({ id: agentSandboxBackups.id });
  if (!claimed) throw new Error(`Expected backup operation fixture for ${backupId}`);
  return { ownerId: "backup-worker-1", generation };
}

async function reserveCopy(
  backupId: string,
  copyRole: "primary" | "secondary",
  execution: AgentBackupOperationExecution,
  descriptor = objectDescriptor(),
) {
  return reserveAgentBackupObject({
    organizationId: ORG_ID,
    backupId,
    copyRole,
    ...descriptor,
    transport: copyRole === "primary" ? "worker-r2" : "s3-compatible",
    provider: copyRole === "primary" ? "cloudflare-r2" : "hetzner-object-storage",
    endpointAlias: copyRole === "primary" ? "r2-primary-eu" : "hetzner-secondary-eu",
    endpointIdentityFingerprint:
      copyRole === "primary" ? PRIMARY_ENDPOINT_FINGERPRINT : SECONDARY_ENDPOINT_FINGERPRINT,
    bucket: copyRole === "primary" ? "agent-backups-primary" : "agent-backups-secondary",
    region: copyRole === "primary" ? "weur" : "fsn1",
    execution,
  });
}

async function markPresentAndVerified(
  objectId: string,
  execution: AgentBackupOperationExecution,
  receipt = SHA_D,
) {
  await markAgentBackupObjectUploading({
    organizationId: ORG_ID,
    objectId,
    execution,
  });
  await recordAgentBackupObjectPresent({
    organizationId: ORG_ID,
    objectId,
    providerEtag: "etag-1",
    uploadReceiptDigest: receipt,
    execution,
  });
  return markAgentBackupObjectVerified({
    organizationId: ORG_ID,
    objectId,
    uploadReceiptDigest: receipt,
    execution,
  });
}

async function protectBackup(objectCount = 1) {
  const { backupId, inventory, execution } = await captureBackup(objectCount);
  const primaries = [];
  for (const descriptor of inventory) {
    const primary = await reserveCopy(backupId, "primary", execution, descriptor);
    await markAgentBackupObjectUploading({
      organizationId: ORG_ID,
      objectId: primary.id,
      execution,
    });
    await recordAgentBackupObjectPresent({
      organizationId: ORG_ID,
      objectId: primary.id,
      providerEtag: `etag-primary-${descriptor.chunkIndex}`,
      uploadReceiptDigest: descriptor.chunkIndex === 0 ? SHA_D : SHA_C,
      execution,
    });
    primaries.push(primary);
  }
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "uploading",
    to: "primary_uploaded",
    execution,
  });
  for (const [index, primary] of primaries.entries()) {
    await markAgentBackupObjectVerified({
      organizationId: ORG_ID,
      objectId: primary.id,
      uploadReceiptDigest: index === 0 ? SHA_D : SHA_C,
      execution,
    });
  }
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "primary_uploaded",
    to: "primary_verified",
    execution,
  });
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "primary_verified",
    to: "secondary_pending",
    execution,
  });
  const secondaries = [];
  for (const descriptor of inventory) {
    const secondary = await reserveCopy(backupId, "secondary", execution, descriptor);
    await markPresentAndVerified(
      secondary.id,
      execution,
      descriptor.chunkIndex === 0 ? SHA_C : SHA_D,
    );
    secondaries.push(secondary);
  }
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "secondary_pending",
    to: "protected",
    execution,
  });
  return {
    backupId,
    primary: primaries[0]!,
    secondary: secondaries[0]!,
    primaries,
    secondaries,
    execution,
  };
}

async function protectManifestV3Backup() {
  const reserved = await reserveAgentBackupOperation(
    exactReservation({ retentionUntil: new Date("2020-01-01T00:00:00.000Z") }),
  );
  const [claim] = await claimDueAgentBackupOperations({
    ownerId: "capture-worker-v3",
    limit: 1,
    leaseMs: 60_000,
  });
  if (!claim) throw new Error("Expected one manifest-v3 capture claim");
  const execution = { ownerId: claim.ownerId, generation: claim.generation };
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId: reserved.id,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "scheduled",
    to: "capturing",
    execution,
  });
  const descriptor = objectDescriptor();
  const manifest = await capturedManifestV3([descriptor], {
    createdAt: reserved.created_at.toISOString(),
  });
  await recordCapturedAgentBackupManifest({
    organizationId: ORG_ID,
    backupId: reserved.id,
    operationId: OPERATION_ID,
    expectedActivationGeneration: LIFECYCLE_GENERATION,
    expectedLifecycleRevision: "0",
    execution,
    manifest,
  });
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId: reserved.id,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "captured",
    to: "uploading",
    execution,
  });
  const primary = await reserveCopy(reserved.id, "primary", execution, descriptor);
  await markAgentBackupObjectUploading({ organizationId: ORG_ID, objectId: primary.id, execution });
  await recordAgentBackupObjectPresent({
    organizationId: ORG_ID,
    objectId: primary.id,
    providerEtag: "etag-primary-v3",
    uploadReceiptDigest: SHA_D,
    execution,
  });
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId: reserved.id,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "uploading",
    to: "primary_uploaded",
    execution,
  });
  await markAgentBackupObjectVerified({
    organizationId: ORG_ID,
    objectId: primary.id,
    uploadReceiptDigest: SHA_D,
    execution,
  });
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId: reserved.id,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "primary_uploaded",
    to: "primary_verified",
    execution,
  });
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId: reserved.id,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "primary_verified",
    to: "secondary_pending",
    execution,
  });
  const secondary = await reserveCopy(reserved.id, "secondary", execution, descriptor);
  await markPresentAndVerified(secondary.id, execution, SHA_C);
  await transitionAgentBackupOperation({
    organizationId: ORG_ID,
    backupId: reserved.id,
    operationId: OPERATION_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    expectedState: "secondary_pending",
    to: "protected",
    execution,
  });
  return { backupId: reserved.id, manifest };
}

async function createActiveRestoreLease(backupId: string) {
  const [backup] = await dbWrite
    .select()
    .from(agentSandboxBackups)
    .where(eq(agentSandboxBackups.id, backupId));
  if (
    !backup?.catalog_organization_id ||
    !backup.catalog_agent_id ||
    !backup.backup_operation_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null ||
    !backup.manifest_digest
  ) {
    throw new Error("Expected exact backup authority fixture");
  }
  const [authority] = await dbWrite
    .select({ revision: agentBackupCatalogAuthorities.catalog_revision })
    .from(agentBackupCatalogAuthorities)
    .where(eq(agentBackupCatalogAuthorities.organization_id, backup.catalog_organization_id));
  if (!authority) throw new Error("Expected catalogue authority fixture");
  const [lease] = await dbWrite
    .insert(agentBackupRestoreLeases)
    .values({
      organization_id: backup.catalog_organization_id,
      agent_id: backup.catalog_agent_id,
      backup_id: backup.id,
      operation_id: backup.backup_operation_id,
      activation_generation: backup.lifecycle_generation,
      lifecycle_revision: backup.lifecycle_revision,
      expected_manifest_sha256: backup.manifest_digest,
      copy_role: "primary",
      restore_attempt_id: randomUUID(),
      owner_id: "restore-worker-1",
      generation: randomUUID(),
      catalog_epoch: authority.revision,
      expires_at: sql`NOW() + INTERVAL '1 hour'`,
    })
    .returning();
  if (!lease) throw new Error("Expected active restore lease fixture");
  return lease;
}

beforeAll(async () => {
  try {
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        dockerNodes,
        agentSandboxes,
        agentSandboxBackups,
        agentBackupCatalogAuthorities,
        agentBackupObjects,
        agentBackupGcOutbox,
        agentBackupRestoreLeases,
      } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.delete(agentBackupRestoreLeases);
  await dbWrite.delete(agentBackupGcOutbox);
  await dbWrite.delete(agentBackupObjects);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await dbWrite.insert(organizations).values([
    {
      id: ORG_ID,
      name: "Backup Catalogue Org",
      slug: "backup-catalogue-org",
    },
    {
      id: FOREIGN_ORG_ID,
      name: "Foreign Backup Catalogue Org",
      slug: "foreign-backup-catalogue-org",
    },
  ]);
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "backup-catalogue-user",
    organization_id: ORG_ID,
  });
  const sourceNode = {
    id: NODE_RECORD_ID,
    node_id: "robot-node-1",
    hostname: "robot-node-1.example.test",
    host_key_fingerprint: "sha256:robot-host-key",
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    node_incarnation: NODE_INCARNATION,
    status: "healthy",
    enabled: true,
  } satisfies typeof dockerNodes.$inferInsert;
  await dbWrite.insert(dockerNodes).values(sourceNode);
  await dbWrite.insert(agentSandboxes).values({
    id: AGENT_ID,
    organization_id: ORG_ID,
    user_id: USER_ID,
    agent_name: "Backup Catalogue Agent",
    status: "running",
    sandbox_id: "container-generation-1",
    node_id: "robot-node-1",
    container_name: "backup-catalogue-agent",
    image_digest: SOURCE_IMAGE_DIGEST,
    lifecycle_revision: 0,
    activation_generation: LIFECYCLE_GENERATION,
    activation_lifecycle_revision: 0n,
    activation_purpose: "provision",
    activation_phase: "active",
    activation_receipt: {
      schemaVersion: 1,
      generation: LIFECYCLE_GENERATION,
      purpose: "provision",
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      lifecycleRevision: "0",
      backupId: null,
      backupHash: null,
      manifestHash: null,
      componentHashes: null,
      freshAuthorization: null,
      containerId: SOURCE_CONTAINER_ID,
      imageDigest: SOURCE_IMAGE_DIGEST,
      receiptId: NODE_INCARNATION,
      receiptHash: SHA_D,
      receiptMac: SHA_C,
      appliedAt: "2026-08-17T00:00:00.000Z",
      restored: true,
      requiresRestart: false,
    },
    activation_receipt_hash: SHA_D,
    activation_container_id: SOURCE_CONTAINER_ID,
    activation_node_id: "robot-node-1",
    activation_image_digest: SOURCE_IMAGE_DIGEST,
    activation_boot_id: NODE_INCARNATION,
    activation_token_hash: SHA_A,
    activation_token_ciphertext: "sealed-activation-token",
    activation_funding_revision: 0n,
    activation_authority_published_at: new Date("2026-08-17T00:00:00.000Z"),
    activation_dispatched_at: new Date("2026-08-17T00:00:01.000Z"),
    activation_completed_at: new Date("2026-08-17T00:00:02.000Z"),
  });
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("agent backup catalogue on primary PGlite", () => {
  test("reserves and claims only one exact active source authority", async () => {
    const first = await reserveAgentBackupOperation(exactReservation());
    const replay = await reserveAgentBackupOperation(exactReservation());
    expect(replay.id).toBe(first.id);
    expect(first).toMatchObject({
      source_node_record_id: NODE_RECORD_ID,
      source_node_incarnation: NODE_INCARNATION,
      source_provider_handle: "container-generation-1",
      source_container_id: SOURCE_CONTAINER_ID,
    });

    await expect(
      reserveAgentBackupOperation(
        exactReservation({ sourceNodeIncarnation: LIFECYCLE_GENERATION }),
      ),
    ).rejects.toThrow(/source|stale|authority/i);
    const claims = await claimDueAgentBackupOperations({
      ownerId: "capture-worker-1",
      limit: 2,
      leaseMs: 60_000,
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]?.backup.id).toBe(first.id);
  });

  test("derives manifest projections and revalidates the active image before capture commit", async () => {
    const reserved = await reserveAgentBackupOperation(exactReservation());
    const [claim] = await claimDueAgentBackupOperations({
      ownerId: "capture-worker-1",
      limit: 1,
      leaseMs: 60_000,
    });
    if (!claim) throw new Error("Expected one capture claim");
    const execution = { ownerId: claim.ownerId, generation: claim.generation };
    await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId: reserved.id,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "scheduled",
      to: "capturing",
      execution,
    });
    const manifest = await capturedManifest([objectDescriptor()], {
      createdAt: reserved.created_at.toISOString(),
    });
    await expect(
      recordCapturedAgentBackupManifest({
        organizationId: ORG_ID,
        backupId: reserved.id,
        operationId: OPERATION_ID,
        expectedActivationGeneration: LIFECYCLE_GENERATION,
        expectedLifecycleRevision: "0",
        execution,
        manifest: { ...manifest, pluginSetDigest: SHA_A },
      }),
    ).rejects.toThrow(/projection digests/);

    const capture = {
      organizationId: ORG_ID,
      backupId: reserved.id,
      operationId: OPERATION_ID,
      expectedActivationGeneration: LIFECYCLE_GENERATION,
      expectedLifecycleRevision: "0",
      execution,
      manifest,
    } as const;
    await recordCapturedAgentBackupManifest(capture);
    await recordCapturedAgentBackupManifest(capture);
    const [captured] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, reserved.id));
    expect(captured).toMatchObject({
      catalog_state: "captured",
      plugin_set_digest: manifest.pluginSetDigest,
      watermark_digest: manifest.watermarkDigest,
      image_digest: SOURCE_IMAGE_DIGEST,
    });
  });

  test("persists and exactly replays one manifest-v3 operation key bundle", async () => {
    const reserved = await reserveAgentBackupOperation(exactReservation());
    const [claim] = await claimDueAgentBackupOperations({
      ownerId: "capture-worker-v3",
      limit: 1,
      leaseMs: 60_000,
    });
    if (!claim) throw new Error("Expected one manifest-v3 capture claim");
    const execution = { ownerId: claim.ownerId, generation: claim.generation };
    await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId: reserved.id,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "scheduled",
      to: "capturing",
      execution,
    });
    const manifest = await capturedManifestV3([objectDescriptor()], {
      createdAt: reserved.created_at.toISOString(),
    });
    const common = {
      organizationId: ORG_ID,
      backupId: reserved.id,
      operationId: OPERATION_ID,
      expectedActivationGeneration: LIFECYCLE_GENERATION,
      expectedLifecycleRevision: "0",
      execution,
    } as const;
    await expect(
      recordCapturedAgentBackupManifest({
        ...common,
        manifest: { ...manifest, wrappedKeyBundleLocalReceiptDigest: SHA_A },
      }),
    ).rejects.toThrow(/canonical manifest-v3 authority/);

    await recordCapturedAgentBackupManifest({ ...common, manifest });
    await recordCapturedAgentBackupManifest({ ...common, manifest });
    const [captured] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, reserved.id));
    expect(captured).toMatchObject({
      manifest_version: 3,
      wrapped_dek_ref: null,
      operation_key_bundle_generation_id: KEY_BUNDLE_GENERATION_ID,
      operation_key_bundle_format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
      operation_key_bundle_ref: `backup-key-bundle:${OPERATION_ID}`,
      operation_key_bundle_ciphertext_base64: manifest.wrappedKeyBundleCiphertextBase64,
      operation_key_bundle_sha256: manifest.wrappedKeyBundleSha256,
      operation_key_bundle_local_receipt_digest: manifest.wrappedKeyBundleLocalReceiptDigest,
      vault_key_generation_id: VAULT_KEY_GENERATION_ID,
      vault_key_authority_receipt_digest: SHA_D,
    });
  });

  test("keeps exact spool cleanup authority after retention enters object GC", async () => {
    const { backupId, manifest } = await protectManifestV3Backup();
    const authorization = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      backupId,
      operationId: OPERATION_ID,
      activationGeneration: LIFECYCLE_GENERATION,
      lifecycleRevision: "0",
      manifestDigest: manifest.digest,
      objectInventoryDigest: manifest.objectInventoryDigest,
    };

    await expect(authorizeAgentBackupProtectedSpoolCleanup(authorization)).resolves.toMatchObject({
      id: backupId,
      catalog_state: "protected",
    });
    await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });

    await expect(authorizeAgentBackupProtectedSpoolCleanup(authorization)).resolves.toMatchObject({
      id: backupId,
      catalog_state: "deleting",
    });
    const candidates = await listAgentBackupProtectedSpoolCleanupCandidates({
      operationId: OPERATION_ID,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: backupId, catalog_state: "deleting" });
  });

  test("rejects capture when the active runtime image changes after reservation", async () => {
    const reserved = await reserveAgentBackupOperation(exactReservation());
    const [claim] = await claimDueAgentBackupOperations({
      ownerId: "capture-worker-1",
      limit: 1,
      leaseMs: 60_000,
    });
    if (!claim) throw new Error("Expected one capture claim");
    const execution = { ownerId: claim.ownerId, generation: claim.generation };
    await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId: reserved.id,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "scheduled",
      to: "capturing",
      execution,
    });
    const manifest = await capturedManifest([objectDescriptor()], {
      createdAt: reserved.created_at.toISOString(),
    });
    const changedImage = `sha256:${"8".repeat(64)}`;
    await dbWrite
      .update(agentSandboxes)
      .set({ image_digest: changedImage, activation_image_digest: changedImage })
      .where(eq(agentSandboxes.id, AGENT_ID));
    await expect(
      recordCapturedAgentBackupManifest({
        organizationId: ORG_ID,
        backupId: reserved.id,
        operationId: OPERATION_ID,
        expectedActivationGeneration: LIFECYCLE_GENERATION,
        expectedLifecycleRevision: "0",
        execution,
        manifest,
      }),
    ).rejects.toThrow(/source activation changed/);
  });

  test("rejects incremental capture before allocating a catalogue operation", async () => {
    const base = await protectBackup();
    await expect(
      reserveAgentBackupOperation(
        exactReservation({
          operationId: INCREMENTAL_OPERATION_ID,
          backupKind: "incremental",
          parentBackupId: base.backupId,
          baseBackupId: base.backupId,
        }),
      ),
    ).rejects.toThrow(/full-only/);
    expect(
      await dbWrite
        .select({ id: agentSandboxBackups.id })
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.backup_operation_id, INCREMENTAL_OPERATION_ID)),
    ).toEqual([]);
  });

  test("hides v2 placeholders and enforces operation uniqueness", async () => {
    const first = await reserveTestBackup();
    expect(await agentSandboxesRepository.getLatestStoredBackup(AGENT_ID)).toBeUndefined();

    await expect(reserveTestBackup()).rejects.toThrow();
    expect(await dbWrite.select().from(agentSandboxBackups)).toHaveLength(1);
    expect(first.catalog_state).toBe("scheduled");
  });

  test("rejects retention typos for v2 while preserving legacy rows", async () => {
    await expect(reserveTestBackup({ retentionReason: "scheduel" as never })).rejects.toThrow();
    expect(await dbWrite.select().from(agentSandboxBackups)).toHaveLength(0);

    const reserved = await reserveTestBackup();
    await expect(
      (async () => {
        await dbWrite.execute(sql`
          UPDATE ${agentSandboxBackups}
          SET "retention_reason" = 'scheduel'
          WHERE "id" = ${reserved.id}
        `);
      })(),
    ).rejects.toThrow();
    expect(
      await dbWrite
        .select({ retentionReason: agentSandboxBackups.retention_reason })
        .from(agentSandboxBackups)
        .where(eq(agentSandboxBackups.id, reserved.id)),
    ).toEqual([{ retentionReason: "schedule" }]);

    const stateData = { memories: [], config: {}, workspaceFiles: {} };
    await dbWrite.insert(agentSandboxBackups).values({
      id: NONCATALOG_BACKUP_ID,
      sandbox_record_id: AGENT_ID,
      snapshot_type: "auto",
      state_data: stateData,
      retention_reason: "legacy-custom" as never,
    });
    await dbWrite.insert(agentSandboxBackups).values({
      id: LEGACY_BACKUP_ID,
      sandbox_record_id: AGENT_ID,
      snapshot_type: "auto",
      state_data: stateData,
      backup_operation_id: LEGACY_BACKUP_ID,
      catalog_version: 1,
      catalog_state: "legacy_unmigrated",
      catalog_payload_digest: SHA_A,
      catalog_organization_id: ORG_ID,
      catalog_agent_id: AGENT_ID,
      lifecycle_generation: LEGACY_BACKUP_ID,
      lifecycle_revision: 0n,
      retention_reason: "legacy-custom" as never,
    });

    const compatible = await dbWrite
      .select({
        id: agentSandboxBackups.id,
        catalogVersion: agentSandboxBackups.catalog_version,
        retentionReason: agentSandboxBackups.retention_reason,
      })
      .from(agentSandboxBackups)
      .where(sql`${agentSandboxBackups.id} IN (${NONCATALOG_BACKUP_ID}, ${LEGACY_BACKUP_ID})`)
      .orderBy(agentSandboxBackups.id);
    expect(
      compatible.map((row) => ({
        ...row,
        retentionReason: row.retentionReason as string | null,
      })),
    ).toEqual([
      {
        id: NONCATALOG_BACKUP_ID,
        catalogVersion: null,
        retentionReason: "legacy-custom",
      },
      {
        id: LEGACY_BACKUP_ID,
        catalogVersion: 1,
        retentionReason: "legacy-custom",
      },
    ]);
  });

  test("refuses to advance when the catalogued chunks do not equal the manifest inventory", async () => {
    const { backupId, execution } = await captureBackup(2);
    const primary = await reserveCopy(backupId, "primary", execution, objectDescriptor(0));
    await markAgentBackupObjectUploading({
      organizationId: ORG_ID,
      objectId: primary.id,
      execution,
    });
    await recordAgentBackupObjectPresent({
      organizationId: ORG_ID,
      objectId: primary.id,
      providerEtag: "etag-incomplete-inventory",
      uploadReceiptDigest: SHA_D,
      execution,
    });

    await expect(
      transitionAgentBackupOperation({
        organizationId: ORG_ID,
        backupId,
        operationId: OPERATION_ID,
        lifecycleGeneration: LIFECYCLE_GENERATION,
        expectedState: "uploading",
        to: "primary_uploaded",
        execution,
      }),
    ).rejects.toThrow("authenticated manifest");
    const [persisted] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId));
    expect(persisted?.catalog_state).toBe("uploading");
  });

  test("requires every verified primary chunk to have an exact verified Hetzner secondary", async () => {
    const { backupId } = await protectBackup();
    const [persisted] = await dbWrite
      .select()
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId));
    expect(persisted?.catalog_state).toBe("protected");
    expect(persisted?.primary_verified_at).toBeInstanceOf(Date);
    expect(persisted?.secondary_verified_at).toBeInstanceOf(Date);
  });

  test("rejects secondary objects outside the authenticated primary inventory", async () => {
    const { backupId, execution } = await captureBackup();
    const descriptor = objectDescriptor();
    const primary = await reserveCopy(backupId, "primary", execution, descriptor);
    await markPresentAndVerified(primary.id, execution, SHA_D);
    await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "uploading",
      to: "primary_uploaded",
      execution,
    });
    await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "primary_uploaded",
      to: "primary_verified",
      execution,
    });
    await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "primary_verified",
      to: "secondary_pending",
      execution,
    });
    await expect(
      reserveCopy(backupId, "secondary", execution, {
        ...descriptor,
        component: "media",
        chunkIndex: 7,
      }),
    ).rejects.toThrow("exactly replicate a verified primary");

    const secondary = await reserveCopy(backupId, "secondary", execution, descriptor);
    await markPresentAndVerified(secondary.id, execution, SHA_C);
    const extraKey = buildAgentBackupObjectKey({
      organizationId: ORG_ID,
      backupId,
      copyRole: "secondary",
      component: "media",
      chunkIndex: 7,
    });
    await dbWrite.insert(agentBackupObjects).values({
      organization_id: ORG_ID,
      backup_id: backupId,
      copy_role: "secondary",
      component: "media",
      chunk_index: 7,
      state: "verified",
      transport: "s3-compatible",
      provider: "hetzner-object-storage",
      endpoint_alias: "extra-secondary",
      endpoint_identity_fingerprint: SECONDARY_ENDPOINT_FINGERPRINT,
      bucket: "agent-backups-secondary",
      region: "fsn1",
      object_key: extraKey,
      key_fingerprint: await digestHex(new TextEncoder().encode(extraKey)),
      provider_write_started: true,
      provider_etag: "etag-extra-secondary",
      content_hmac_sha256: SHA_A,
      ciphertext_sha256: SHA_B,
      size_bytes: 1,
      upload_receipt_digest: SHA_D,
      verified_at: new Date(),
    });
    await expect(
      transitionAgentBackupOperation({
        organizationId: ORG_ID,
        backupId,
        operationId: OPERATION_ID,
        lifecycleGeneration: LIFECYCLE_GENERATION,
        expectedState: "secondary_pending",
        to: "protected",
        execution,
      }),
    ).rejects.toThrow("every primary object");
  });

  test("resumes only the recorded retry state and replays a lost response", async () => {
    const reserved = await reserveTestBackup();
    const firstExecution = await claimExecution(reserved.id);
    await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId: reserved.id,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "scheduled",
      to: "capturing",
      execution: firstExecution,
    });
    await failAgentBackupOperation({
      organizationId: ORG_ID,
      backupId: reserved.id,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "capturing",
      terminal: false,
      error: { code: "CAPTURE_RETRY", message: "capture transport unavailable" },
      retryDelayMs: 1,
      execution: firstExecution,
    });
    await dbWrite
      .update(agentSandboxBackups)
      .set({ catalog_next_attempt_at: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(agentSandboxBackups.id, reserved.id));
    const retryExecution = await claimExecution(reserved.id);

    await expect(
      transitionAgentBackupOperation({
        organizationId: ORG_ID,
        backupId: reserved.id,
        operationId: OPERATION_ID,
        lifecycleGeneration: LIFECYCLE_GENERATION,
        expectedState: "failed_retryable",
        to: "uploading",
        resumeState: "uploading",
        execution: retryExecution,
      }),
    ).rejects.toThrow("exact state recorded");

    const resumed = await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId: reserved.id,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "failed_retryable",
      to: "capturing",
      resumeState: "capturing",
      execution: retryExecution,
    });
    expect(resumed.catalog_state).toBe("capturing");
    const replay = await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId: reserved.id,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "failed_retryable",
      to: "capturing",
      resumeState: "capturing",
      execution: retryExecution,
    });
    expect(replay.id).toBe(reserved.id);
  });

  test("turns terminal post-upload failures into exact-object compensation", async () => {
    const runtime = exactRuntimeBucket();
    const registry = await createAgentBackupObjectStoreRegistry([
      {
        endpointAlias: "r2-never-started-gc",
        provider: "cloudflare-r2",
        transport: "worker-r2",
        accountIdentity: "cloudflare-account-staging",
        bindingIdentity: "AGENT_BACKUPS_PRIMARY",
        bucket: "agent-backups-primary",
        region: "auto",
        bucketBinding: runtime.bucket,
      },
    ]);
    const { backupId, execution } = await captureBackup();
    const descriptor = objectDescriptor();
    const store = registry.forNewObject("r2-never-started-gc");
    const primary = await reserveAgentBackupObject({
      organizationId: ORG_ID,
      backupId,
      copyRole: "primary",
      ...descriptor,
      transport: store.authority.transport,
      provider: store.authority.provider,
      endpointAlias: store.authority.endpointAlias,
      endpointIdentityFingerprint: store.authority.endpointIdentityFingerprint,
      bucket: store.authority.bucket,
      region: store.authority.region,
      execution,
    });
    const failed = await failAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "uploading",
      terminal: true,
      error: { code: "UPLOAD_TERMINAL", message: "provider rejected the immutable upload" },
      execution,
    });
    expect(failed.catalog_state).toBe("failed_terminal");

    const compensated = await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    expect(compensated.backup.catalog_state).toBe("deleting");
    expect(compensated.enqueued).toBe(1);
    const [object] = await dbWrite
      .select()
      .from(agentBackupObjects)
      .where(eq(agentBackupObjects.id, primary.id));
    expect(object?.state).toBe("delete_pending");
    expect(object?.provider_write_started).toBe(false);
    const claims = await claimAgentBackupGc({
      ownerId: "never-started-gc-worker",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(claims).toHaveLength(1);
    expect(await executeAgentBackupGcClaims({ claims, registry, retryDelayMs: 1 })).toEqual({
      completed: 1,
      failed: 0,
    });
    const deleted = await finalizeAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    expect(deleted.catalog_state).toBe("deleted");
  });

  test("persists an ambiguous upload locator before GC and survives delete response loss", async () => {
    const body = new Uint8Array(32).fill(11);
    const descriptor = {
      ...objectDescriptor(),
      ciphertextSha256: await digestHex(body),
      sizeBytes: body.byteLength,
    };
    const runtime = exactRuntimeBucket();
    const registry = await createAgentBackupObjectStoreRegistry([
      {
        endpointAlias: "r2-ambiguous-upload-gc",
        provider: "cloudflare-r2",
        transport: "worker-r2",
        accountIdentity: "cloudflare-account-staging",
        bindingIdentity: "AGENT_BACKUPS_PRIMARY",
        bucket: "agent-backups-primary",
        region: "auto",
        bucketBinding: runtime.bucket,
      },
    ]);
    const { backupId, execution } = await captureBackup(1, [descriptor]);
    const store = registry.forNewObject("r2-ambiguous-upload-gc");
    const object = await reserveAgentBackupObject({
      organizationId: ORG_ID,
      backupId,
      copyRole: "primary",
      ...descriptor,
      transport: store.authority.transport,
      provider: store.authority.provider,
      endpointAlias: store.authority.endpointAlias,
      endpointIdentityFingerprint: store.authority.endpointIdentityFingerprint,
      bucket: store.authority.bucket,
      region: store.authority.region,
      execution,
    });
    await expect(
      recordAgentBackupObjectPresent({
        organizationId: ORG_ID,
        objectId: object.id,
        uploadReceiptDigest: SHA_D,
        execution,
      }),
    ).rejects.toThrow("provider version, ETag, or checksum");
    await expect(
      recordAgentBackupObjectPresent({
        organizationId: ORG_ID,
        objectId: object.id,
        providerEtag: "etag-before-write-start",
        uploadReceiptDigest: SHA_D,
        execution,
      }),
    ).rejects.toThrow("reserved");
    await markAgentBackupObjectUploading({
      organizationId: ORG_ID,
      objectId: object.id,
      execution,
    });
    await store.putImmutable({ key: object.object_key, body });
    await failAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "uploading",
      terminal: true,
      error: { code: "UPLOAD_RESPONSE_LOST", message: "provider response was lost" },
      execution,
    });
    await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    const firstClaims = await claimAgentBackupGc({
      ownerId: "ambiguous-gc-worker",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(firstClaims).toHaveLength(1);
    runtime.loseNextDeleteResponse();
    expect(
      await executeAgentBackupGcClaims({
        claims: firstClaims,
        registry,
        retryDelayMs: 1,
      }),
    ).toEqual({ completed: 0, failed: 1 });

    const [afterLostDelete] = await dbWrite
      .select()
      .from(agentBackupObjects)
      .where(eq(agentBackupObjects.id, object.id));
    const [pendingIntent] = await dbWrite
      .select()
      .from(agentBackupGcOutbox)
      .where(eq(agentBackupGcOutbox.object_id, object.id));
    expect(afterLostDelete?.provider_write_started).toBe(true);
    expect(afterLostDelete?.provider_version_id).toBeTruthy();
    expect(afterLostDelete?.upload_receipt_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(pendingIntent?.expected_provider_version_id).toBe(afterLostDelete?.provider_version_id);
    expect(pendingIntent?.state).toBe("pending");
    expect(runtime.objects.size).toBe(0);

    const failedReplay = await failAgentBackupGc({
      outboxId: firstClaims[0]!.outbox.id,
      ownerId: "ambiguous-gc-worker",
      generation: firstClaims[0]!.outbox.claim_generation as string,
      error: {
        code: "BACKUP_GC_PROVIDER_FAILURE",
        message: "simulated delete response loss",
      },
      retryDelayMs: 1,
      terminal: false,
    });
    expect(failedReplay.state).toBe("pending");
    await dbWrite
      .update(agentBackupGcOutbox)
      .set({ next_attempt_at: sql`NOW()` })
      .where(eq(agentBackupGcOutbox.id, firstClaims[0]!.outbox.id));
    const retryClaims = await claimAgentBackupGc({
      ownerId: "ambiguous-gc-worker-retry",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(retryClaims).toHaveLength(1);
    expect(
      await executeAgentBackupGcClaims({ claims: retryClaims, registry, retryDelayMs: 1 }),
    ).toEqual({ completed: 1, failed: 0 });
    const [completedIntent] = await dbWrite
      .select()
      .from(agentBackupGcOutbox)
      .where(eq(agentBackupGcOutbox.id, firstClaims[0]!.outbox.id));
    expect(completedIntent?.state).toBe("completed");
  });

  test("quarantines a never-started provider object without deleting it", async () => {
    const body = new Uint8Array(32).fill(12);
    const descriptor = {
      ...objectDescriptor(),
      ciphertextSha256: await digestHex(body),
      sizeBytes: body.byteLength,
    };
    const runtime = exactRuntimeBucket();
    const registry = await createAgentBackupObjectStoreRegistry([
      {
        endpointAlias: "r2-unauthorized-object-gc",
        provider: "cloudflare-r2",
        transport: "worker-r2",
        accountIdentity: "cloudflare-account-staging",
        bindingIdentity: "AGENT_BACKUPS_PRIMARY",
        bucket: "agent-backups-primary",
        region: "auto",
        bucketBinding: runtime.bucket,
      },
    ]);
    const { backupId, execution } = await captureBackup(1, [descriptor]);
    const store = registry.forNewObject("r2-unauthorized-object-gc");
    const object = await reserveAgentBackupObject({
      organizationId: ORG_ID,
      backupId,
      copyRole: "primary",
      ...descriptor,
      transport: store.authority.transport,
      provider: store.authority.provider,
      endpointAlias: store.authority.endpointAlias,
      endpointIdentityFingerprint: store.authority.endpointIdentityFingerprint,
      bucket: store.authority.bucket,
      region: store.authority.region,
      execution,
    });
    await store.putImmutable({ key: object.object_key, body });
    await failAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "uploading",
      terminal: true,
      error: { code: "PRE_WRITE_ABORT", message: "no provider write was authorized" },
      execution,
    });
    await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    const claims = await claimAgentBackupGc({
      ownerId: "unauthorized-object-gc-worker",
      limit: 1,
      leaseMs: 60_000,
    });
    expect(await executeAgentBackupGcClaims({ claims, registry, retryDelayMs: 1 })).toEqual({
      completed: 0,
      failed: 1,
    });
    const [intent] = await dbWrite
      .select()
      .from(agentBackupGcOutbox)
      .where(eq(agentBackupGcOutbox.object_id, object.id));
    expect(intent?.state).toBe("quarantined");
    expect(runtime.objects.has(object.object_key)).toBe(true);
  });

  test("blocks legal-hold and premature expiration by database time", async () => {
    const { backupId } = await protectBackup();
    await dbWrite
      .update(agentSandboxBackups)
      .set({
        retention_reason: "legal-hold",
        retention_until: new Date("2020-01-01T00:00:00.000Z"),
      })
      .where(eq(agentSandboxBackups.id, backupId));
    await expect(
      transitionAgentBackupOperation({
        organizationId: ORG_ID,
        backupId,
        operationId: OPERATION_ID,
        lifecycleGeneration: LIFECYCLE_GENERATION,
        expectedState: "protected",
        to: "expiration_pending",
      }),
    ).rejects.toThrow("legal-hold");

    await dbWrite
      .update(agentSandboxBackups)
      .set({
        retention_reason: "schedule",
        retention_until: new Date("2030-01-01T00:00:00.000Z"),
      })
      .where(eq(agentSandboxBackups.id, backupId));
    await expect(
      transitionAgentBackupOperation({
        organizationId: ORG_ID,
        backupId,
        operationId: OPERATION_ID,
        lifecycleGeneration: LIFECYCLE_GENERATION,
        expectedState: "protected",
        to: "expiration_pending",
      }),
    ).rejects.toThrow("retention has not expired");

    await dbWrite
      .update(agentSandboxBackups)
      .set({ retention_until: new Date("2020-01-01T00:00:00.000Z") })
      .where(eq(agentSandboxBackups.id, backupId));
    const expiring = await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "protected",
      to: "expiration_pending",
    });
    expect(expiring.catalog_state).toBe("expiration_pending");
  });

  test("fences a late active restore lease and replays direct expiration after release", async () => {
    const { backupId } = await protectBackup();
    const lease = await createActiveRestoreLease(backupId);
    const transition = {
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "protected" as const,
      to: "expiration_pending" as const,
    };

    await expect(transitionAgentBackupOperation(transition)).rejects.toThrow(
      "active restore lease",
    );
    const [fenced] = await dbWrite
      .select({ state: agentSandboxBackups.catalog_state })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, backupId));
    expect(fenced?.state).toBe("protected");

    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ released_at: sql`NOW()` })
      .where(eq(agentBackupRestoreLeases.id, lease.id));
    const expired = await transitionAgentBackupOperation(transition);
    const replay = await transitionAgentBackupOperation(transition);
    expect(expired.catalog_state).toBe("expiration_pending");
    expect(replay.catalog_revision).toBe(expired.catalog_revision);
  });

  test("rejects a cross-tenant object at the database boundary", async () => {
    const { backupId } = await protectBackup();
    await expect(
      Promise.resolve(
        dbWrite.insert(agentBackupObjects).values({
          organization_id: FOREIGN_ORG_ID,
          backup_id: backupId,
          copy_role: "primary",
          component: "database",
          chunk_index: 99,
          state: "reserved",
          transport: "worker-r2",
          provider: "cloudflare-r2",
          endpoint_alias: "foreign-r2",
          endpoint_identity_fingerprint: PRIMARY_ENDPOINT_FINGERPRINT,
          bucket: "foreign-bucket",
          region: "weur",
          object_key: "foreign/object",
          key_fingerprint: SHA_A,
          content_hmac_sha256: SHA_B,
          ciphertext_sha256: SHA_C,
          size_bytes: 1,
        }),
      ),
    ).rejects.toThrow();
  });

  test("rejects an incomplete restore-verification projection", async () => {
    const { backupId } = await protectBackup();
    await expect(
      Promise.resolve(
        dbWrite
          .update(agentSandboxBackups)
          .set({ catalog_state: "restore_verified" })
          .where(eq(agentSandboxBackups.id, backupId)),
      ),
    ).rejects.toThrow();
  });

  test("keeps a base backup until every dependent incremental is deleted", async () => {
    const { backupId } = await protectBackup();
    const child = await reserveTestBackup({
      operationId: INCREMENTAL_OPERATION_ID,
      lifecycleGeneration: INCREMENTAL_GENERATION,
      backupKind: "incremental",
      parentBackupId: backupId,
      baseBackupId: backupId,
    });
    expect(child.parent_backup_id).toBe(backupId);
    await expect(
      transitionAgentBackupOperation({
        organizationId: ORG_ID,
        backupId,
        operationId: OPERATION_ID,
        lifecycleGeneration: LIFECYCLE_GENERATION,
        expectedState: "protected",
        to: "expiration_pending",
      }),
    ).rejects.toThrow("dependent incremental");

    const childExecution = await claimExecution(child.id);
    await failAgentBackupOperation({
      organizationId: ORG_ID,
      backupId: child.id,
      operationId: INCREMENTAL_OPERATION_ID,
      lifecycleGeneration: INCREMENTAL_GENERATION,
      expectedState: "scheduled",
      terminal: true,
      error: {
        code: "CAPTURE_UNAVAILABLE",
        message: "capture failed before any provider object was reserved",
      },
      execution: childExecution,
    });
    const expiration = await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "protected",
      to: "expiration_pending",
    });
    expect(expiration.catalog_state).toBe("expiration_pending");
  });

  test("keeps an actively restored backup out of GC discovery and enqueue", async () => {
    const { backupId } = await protectBackup();
    const lease = await createActiveRestoreLease(backupId);

    expect(
      (await listDueAgentBackupDeletions({ limit: 10 })).some(
        (candidate) => candidate.backupId === backupId,
      ),
    ).toBe(false);
    await expect(
      enqueueAgentBackupDeletion({
        organizationId: ORG_ID,
        backupId,
        operationId: OPERATION_ID,
      }),
    ).rejects.toThrow("active restore lease");

    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ released_at: sql`NOW()` })
      .where(eq(agentBackupRestoreLeases.id, lease.id));
    expect(
      (await listDueAgentBackupDeletions({ limit: 10 })).some(
        (candidate) => candidate.backupId === backupId,
      ),
    ).toBe(true);
  });

  test("rechecks a late restore lease before final GC tombstoning", async () => {
    const { backupId } = await protectBackup();
    await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    const claims = await claimAgentBackupGc({
      ownerId: "restore-fenced-gc-worker",
      limit: 10,
      leaseMs: 60_000,
    });
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      await settleAgentBackupGc({
        outboxId: claim.outbox.id,
        ownerId: "restore-fenced-gc-worker",
        generation: claim.outbox.claim_generation as string,
        receiptDigest: claim.object.copy_role === "primary" ? SHA_A : SHA_B,
      });
    }

    const lease = await createActiveRestoreLease(backupId);
    expect(
      (await listFinalizableAgentBackupDeletions({ limit: 10 })).some(
        (candidate) => candidate.backupId === backupId,
      ),
    ).toBe(false);
    await expect(
      finalizeAgentBackupDeletion({
        organizationId: ORG_ID,
        backupId,
        operationId: OPERATION_ID,
      }),
    ).rejects.toThrow("Restore lease blocks GC finalization");

    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ released_at: sql`NOW()` })
      .where(eq(agentBackupRestoreLeases.id, lease.id));
    expect(
      (await listFinalizableAgentBackupDeletions({ limit: 10 })).some(
        (candidate) => candidate.backupId === backupId,
      ),
    ).toBe(true);
    expect(
      (
        await finalizeAgentBackupDeletion({
          organizationId: ORG_ID,
          backupId,
          operationId: OPERATION_ID,
        })
      ).catalog_state,
    ).toBe("deleted");
  });

  test("starts each GC lease from its own post-lock database clock", async () => {
    const { backupId } = await protectBackup();
    await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    await dbWrite.execute(sql`
      CREATE OR REPLACE FUNCTION test_delay_gc_claim() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.claim_owner = 'delayed-gc-worker' AND NEW.state = 'leased' THEN
          PERFORM pg_sleep(0.03);
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await dbWrite.execute(sql`
      CREATE TRIGGER test_delay_gc_claim
      BEFORE UPDATE ON agent_backup_gc_outbox
      FOR EACH ROW EXECUTE FUNCTION test_delay_gc_claim()
    `);
    try {
      const claims = await claimAgentBackupGc({
        ownerId: "delayed-gc-worker",
        limit: 2,
        leaseMs: 1_000,
      });
      expect(claims).toHaveLength(2);
      for (const claim of claims) {
        expect(claim.outbox.lease_expires_at!.getTime() - claim.outbox.updated_at.getTime()).toBe(
          1_000,
        );
      }
      const [clock] = await dbWrite
        .select({ databaseNow: sql<Date | string>`clock_timestamp()` })
        .from(agentBackupGcOutbox)
        .limit(1);
      const databaseNow =
        clock!.databaseNow instanceof Date ? clock!.databaseNow : new Date(clock!.databaseNow);
      expect(
        claims.every((claim) => claim.outbox.lease_expires_at!.getTime() > databaseNow.getTime()),
      ).toBe(true);
      expect(
        claims[1]!.outbox.updated_at.getTime() - claims[0]!.outbox.updated_at.getTime(),
      ).toBeGreaterThanOrEqual(20);
    } finally {
      await dbWrite.execute(
        sql`DROP TRIGGER IF EXISTS test_delay_gc_claim ON agent_backup_gc_outbox`,
      );
      await dbWrite.execute(sql`DROP FUNCTION IF EXISTS test_delay_gc_claim()`);
    }
  });

  test("rolls back a GC claim when DB-side delay consumes its whole lease", async () => {
    const { backupId } = await protectBackup();
    await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    await dbWrite.execute(sql`
      CREATE OR REPLACE FUNCTION test_expire_gc_claim() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.claim_owner = 'expired-before-return-gc-worker' AND NEW.state = 'leased' THEN
          PERFORM pg_sleep(0.03);
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await dbWrite.execute(sql`
      CREATE TRIGGER test_expire_gc_claim
      BEFORE UPDATE ON agent_backup_gc_outbox
      FOR EACH ROW EXECUTE FUNCTION test_expire_gc_claim()
    `);
    try {
      await expect(
        claimAgentBackupGc({
          ownerId: "expired-before-return-gc-worker",
          limit: 1,
          leaseMs: 1,
        }),
      ).rejects.toThrow("GC claim expired before it could be returned");
      const [intent] = await dbWrite
        .select()
        .from(agentBackupGcOutbox)
        .where(eq(agentBackupGcOutbox.state, "pending"));
      expect(intent?.claim_owner).toBeNull();
      expect(intent?.claim_generation).toBeNull();
      expect(intent?.lease_expires_at).toBeNull();
    } finally {
      await dbWrite.execute(
        sql`DROP TRIGGER IF EXISTS test_expire_gc_claim ON agent_backup_gc_outbox`,
      );
      await dbWrite.execute(sql`DROP FUNCTION IF EXISTS test_expire_gc_claim()`);
    }
  });

  test("rejects GC settlement when validation crosses the execution-lease expiry", async () => {
    const { backupId } = await protectBackup();
    await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    const [claim] = await claimAgentBackupGc({
      ownerId: "expiry-gc-worker",
      limit: 1,
      leaseMs: 20,
    });
    expect(claim).toBeDefined();
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      await Bun.sleep(40);
      return originalDigest(algorithm, data);
    });
    try {
      await expect(
        settleAgentBackupGc({
          outboxId: claim!.outbox.id,
          ownerId: "expiry-gc-worker",
          generation: claim!.outbox.claim_generation as string,
          receiptDigest: SHA_A,
        }),
      ).rejects.toThrow("execution lease expired");
    } finally {
      digestSpy.mockRestore();
    }
    const [intent] = await dbWrite
      .select()
      .from(agentBackupGcOutbox)
      .where(eq(agentBackupGcOutbox.id, claim!.outbox.id));
    const [object] = await dbWrite
      .select()
      .from(agentBackupObjects)
      .where(eq(agentBackupObjects.id, claim!.object.id));
    expect(intent?.state).toBe("leased");
    expect(object?.state).toBe("delete_pending");
  });

  test("receipts every exact object before tombstoning", async () => {
    const { backupId } = await protectBackup();
    await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "protected",
      to: "expiration_pending",
    });
    const enqueued = await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    expect(enqueued.enqueued).toBe(2);
    const claims = await claimAgentBackupGc({ ownerId: "gc-worker-1", limit: 10, leaseMs: 60_000 });
    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      await settleAgentBackupGc({
        outboxId: claim.outbox.id,
        ownerId: "gc-worker-1",
        generation: claim.outbox.claim_generation as string,
        receiptDigest: claim.object.copy_role === "primary" ? SHA_A : SHA_B,
      });
    }
    const deleted = await finalizeAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    expect(deleted.catalog_state).toBe("deleted");
    expect(deleted.catalog_delete_receipt_digest).toMatch(/^[0-9a-f]{64}$/);

    const replay = await finalizeAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    expect(replay.catalog_delete_receipt_digest).toBe(deleted.catalog_delete_receipt_digest);

    await expect(
      settleAgentBackupGc({
        outboxId: claims[0]!.outbox.id,
        ownerId: "gc-worker-1",
        generation: claims[0]!.outbox.claim_generation as string,
        receiptDigest: SHA_C,
      }),
    ).rejects.toThrow("receipt replay mismatch");
  });

  test("quarantines a poisoned locator without rolling back healthy claims", async () => {
    const { backupId, primary } = await protectBackup(2);
    await transitionAgentBackupOperation({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
      lifecycleGeneration: LIFECYCLE_GENERATION,
      expectedState: "protected",
      to: "expiration_pending",
    });
    await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    await dbWrite
      .update(agentBackupObjects)
      .set({ bucket: "tampered-bucket" })
      .where(eq(agentBackupObjects.id, primary.id));

    const claims = await claimAgentBackupGc({ ownerId: "gc-worker-1", limit: 10, leaseMs: 60_000 });
    expect(claims).toHaveLength(3);
    expect(claims.some((claim) => claim.object.id === primary.id)).toBe(false);
    const [poisonedObject] = await dbWrite
      .select()
      .from(agentBackupObjects)
      .where(eq(agentBackupObjects.id, primary.id));
    const [poisonedIntent] = await dbWrite
      .select()
      .from(agentBackupGcOutbox)
      .where(eq(agentBackupGcOutbox.object_id, primary.id));
    expect(poisonedObject?.state).toBe("quarantined");
    expect(poisonedIntent?.state).toBe("quarantined");
    expect(poisonedIntent?.last_error_code).toBe("GC_LOCATOR_CHANGED");
  });

  test("refuses exact-replay adoption once the execution lease has expired", async () => {
    const { backupId } = await protectBackup();
    await enqueueAgentBackupDeletion({
      organizationId: ORG_ID,
      backupId,
      operationId: OPERATION_ID,
    });
    const [claim] = await claimAgentBackupGc({
      ownerId: "adopt-expiry-worker",
      limit: 1,
      leaseMs: 40,
    });
    expect(claim).toBeDefined();
    await Bun.sleep(80);
    const before = await dbWrite
      .select()
      .from(agentBackupObjects)
      .where(eq(agentBackupObjects.id, claim!.object.id));
    await expect(
      adoptAgentBackupGcObservedLocator({
        outboxId: claim!.outbox.id,
        ownerId: "adopt-expiry-worker",
        generation: claim!.outbox.claim_generation as string,
        providerVersionId: claim!.object.provider_version_id,
        providerEtag: claim!.object.provider_etag,
        providerChecksum: claim!.object.provider_checksum,
        uploadReceiptDigest: claim!.object.upload_receipt_digest as string,
      }),
    ).rejects.toThrow("GC execution lease expired");
    const after = await dbWrite
      .select()
      .from(agentBackupObjects)
      .where(eq(agentBackupObjects.id, claim!.object.id));
    expect(after).toEqual(before);
  });
});
