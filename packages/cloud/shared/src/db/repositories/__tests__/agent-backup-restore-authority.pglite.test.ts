/** Real-DB proofs that restore entrypoints require dual-provider catalogue authority. */

import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ElizaError } from "@elizaos/core";
import { MemoryKmsAdapter } from "@elizaos/core/security/kms";
import {
  AGENT_BACKUP_MANIFEST_FORMAT,
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  type AgentBackupManifestV3Draft,
  canonicalizeAgentBackupManifestV3,
  canonicalizeAgentBackupOperationKeyBundleContext,
  computeAgentBackupChunkAadDigest,
  createAgentBackupManifestV3,
} from "@elizaos/shared";
import { eq, sql } from "drizzle-orm";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";
process.env.SKIP_AGENT_SANDBOX_ENSURE = "1";

import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../client";
import {
  agentBackupCatalogAuthorities,
  agentBackupObjects,
  agentBackupRestoreLeases,
  agentBackupRestoreOperations,
} from "../../schemas/agent-backup-catalog";
import {
  agentActivationPublications,
  agentBackupRestoreReceipts,
  agentNodeIncarnationHistories,
  agentVaultKeySeedReceipts,
} from "../../schemas/agent-backup-restore-history";
import { agentSandboxBackups, agentSandboxes } from "../../schemas/agent-sandboxes";
import {
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
  AGENT_VAULT_KEY_KMS_CONTEXT_DERIVATION,
  agentVaultKeyAuthorities,
  agentVaultKeyBackupBindings,
  agentVaultKeyGenerations,
} from "../../schemas/agent-vault-key-authority";
import { dockerNodes } from "../../schemas/docker-nodes";
import { organizations } from "../../schemas/organizations";
import { userCharacters } from "../../schemas/user-characters";
import { users } from "../../schemas/users";
import { agentBackupObjectInventoryDigest } from "../agent-backup-catalog";
import {
  type AgentBackupRestoreSourceV3Input,
  loadAgentBackupRestoreSourceV3,
} from "../agent-backup-restore";
import {
  authorizeAgentActivationDispatch,
  commitAgentBackupRestore,
  recordAgentActivationPublication,
  recordAgentVaultKeySeedReceipt,
} from "../agent-backup-restore-history";
import {
  acquireAgentBackupRestoreLease,
  releaseAgentBackupRestoreLease,
  renewAgentBackupRestoreLease,
} from "../agent-backup-restore-lease";
import {
  claimAgentBackupRestoreOperation,
  openAgentBackupRestoreOperation,
  reserveAgentBackupRestoreTarget,
} from "../agent-backup-restore-operations";
import {
  AgentVaultKeySecretHandle,
  bindAgentBackupVaultKeyGeneration,
  createOrRotateAgentVaultKeyGeneration,
  loadCurrentAgentVaultKeyAuthority,
  withAgentBackupRestoreVaultPassphrase,
} from "../agent-vault-key-authority";
import { dockerNodesRepository } from "../docker-nodes";

const TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-00000000d001";
const AGENT_ID = "00000000-0000-4000-8000-00000000d002";
const BACKUP_ID = "00000000-0000-4000-8000-00000000d003";
const OPERATION_ID = "00000000-0000-4000-8000-00000000d004";
const ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000d005";
const VAULT_GENERATION = "00000000-0000-4000-8000-00000000d006";
const ROTATED_VAULT_GENERATION = "00000000-0000-4000-8000-00000000d030";
const STALE_VAULT_GENERATION = "00000000-0000-4000-8000-00000000d031";
const USER_ID = "00000000-0000-4000-8000-00000000d032";
const TARGET_ACTIVATION_GENERATION = "00000000-0000-4000-8000-00000000d042";
const TARGET_NODE_RECORD_ID = "00000000-0000-4000-8000-00000000d043";
const TARGET_NODE_INCARNATION = "00000000-0000-4000-8000-00000000d044";
const REARMED_TARGET_NODE_INCARNATION = "00000000-0000-4000-8000-00000000d065";
const TARGET_NODE_CREATED_AT = new Date("2026-08-19T23:59:59.000Z");
const TARGET_NODE_ATTESTED_AT = new Date("2026-08-20T00:00:00.000Z");
const ACTIVATION_PUBLICATION_ID = "00000000-0000-4000-8000-00000000d045";
const SEED_RECEIPT_ID = "00000000-0000-4000-8000-00000000d046";
const FINAL_RECEIPT_ID = "00000000-0000-4000-8000-00000000d047";
const RESTORE_ATTEMPT_ID = "00000000-0000-4000-8000-00000000d048";
const RESTORE_CONTAINER_ID = "e".repeat(64);
const SHA = "a".repeat(64);
const RECEIPT_SHA = "b".repeat(64);
const CONTENT_SHA = "c".repeat(64);
const CIPHERTEXT_SHA = "d".repeat(64);
const KEY_BUNDLE = Buffer.alloc(92, 0x42).toString("base64");
let schemaFailure = "";

function isZeroized(value: Uint8Array | null): boolean {
  return value !== null && value.every((byte) => byte === 0);
}

function expectTokensInOrder(source: string, tokens: readonly string[]): void {
  let previous = -1;
  for (const token of tokens) {
    const index = source.indexOf(token);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

function captureVaultRawKeyAtRelease(): {
  readonly rawKey: Uint8Array | null;
  restore: () => void;
} {
  const originalRelease = AgentVaultKeySecretHandle.prototype.release;
  let capturedRawKey: Uint8Array | null = null;
  const releaseSpy = spyOn(AgentVaultKeySecretHandle.prototype, "release").mockImplementation(
    function (this: AgentVaultKeySecretHandle) {
      const rawKey = Reflect.get(this, "rawKey");
      capturedRawKey = rawKey instanceof Uint8Array ? rawKey : null;
      originalRelease.call(this);
    },
  );
  return {
    get rawKey() {
      return capturedRawKey;
    },
    restore: () => releaseSpy.mockRestore(),
  };
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function insertActiveSandbox(): Promise<void> {
  await dbWrite.insert(users).values({
    id: USER_ID,
    steward_user_id: "restore-authority-user",
    organization_id: ORG_ID,
  });
  await dbWrite.insert(agentSandboxes).values({
    id: AGENT_ID,
    organization_id: ORG_ID,
    user_id: USER_ID,
    agent_name: "Restore authority agent",
    status: "running",
    sandbox_id: "provider-handle",
    node_id: "restore-source-node",
    image_digest: `sha256:${SHA}`,
    lifecycle_revision: 7,
    activation_generation: ACTIVATION_GENERATION,
    activation_lifecycle_revision: 7n,
    activation_purpose: "provision",
    activation_phase: "active",
    activation_receipt: {
      schemaVersion: 1,
      generation: ACTIVATION_GENERATION,
      purpose: "provision",
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      lifecycleRevision: "7",
      backupId: null,
      backupHash: null,
      manifestHash: null,
      componentHashes: null,
      freshAuthorization: null,
      containerId: "c".repeat(64),
      imageDigest: `sha256:${SHA}`,
      receiptId: "00000000-0000-4000-8000-00000000d033",
      receiptHash: RECEIPT_SHA,
      receiptMac: CONTENT_SHA,
      appliedAt: "2026-08-17T00:00:02.000Z",
      restored: true,
      requiresRestart: false,
    },
    activation_receipt_hash: RECEIPT_SHA,
    activation_container_id: "c".repeat(64),
    activation_node_id: "restore-source-node",
    activation_image_digest: `sha256:${SHA}`,
    activation_token_hash: SHA,
    activation_token_ciphertext: "sealed-restore-authority-token",
    activation_boot_id: "00000000-0000-4000-8000-00000000d034",
    activation_funding_revision: 1n,
    activation_authority_published_at: new Date("2026-08-17T00:00:00.000Z"),
    activation_dispatched_at: new Date("2026-08-17T00:00:01.000Z"),
    activation_completed_at: new Date("2026-08-17T00:00:02.000Z"),
  });
}

function operationKeyBundleContext(): string {
  return canonicalizeAgentBackupOperationKeyBundleContext({
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    activationGeneration: ACTIVATION_GENERATION,
    lifecycleRevision: "7",
    operationId: OPERATION_ID,
    keyBundleGenerationId: "00000000-0000-4000-8000-00000000d009",
    sourceKind: "robot",
    sourceProvider: "hetzner",
    kmsProvider: "steward",
    keyId: `org:${ORG_ID}/dek/v1`,
    keyVersion: 1,
  });
}

async function exactManifestV3(vaultAuthority: { generationId: string; receiptDigest: string }) {
  const contentHmacSha256 = CONTENT_SHA;
  const ciphertextSha256 = CIPHERTEXT_SHA;
  const encryptedBytes = 32;
  const plainBytes = 4;
  const aadSha256 = await computeAgentBackupChunkAadDigest({
    identity: {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "7",
    },
    operationId: OPERATION_ID,
    component: { name: "database", format: "raw-v1", compression: "none" },
    chunk: {
      index: 0,
      offsetBytes: 0,
      plainBytes,
      compressedBytes: plainBytes,
      contentHmacSha256,
    },
  });
  const emptyComponent = (name: "character" | "media" | "state-files" | "vault") => ({
    name,
    format: "raw-v1",
    compression: "none" as const,
    payloadContentHmacSha256: SHA,
    state: { kind: "full" as const, resultContentHmacSha256: SHA },
    totals: { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
    chunks: [],
  });
  const components: AgentBackupManifestV3Draft["components"] = [
    emptyComponent("character"),
    {
      name: "database",
      format: "raw-v1",
      compression: "none",
      payloadContentHmacSha256: contentHmacSha256,
      state: { kind: "full", resultContentHmacSha256: contentHmacSha256 },
      totals: {
        plainBytes,
        compressedBytes: plainBytes,
        encryptedBytes,
        chunkCount: 1,
      },
      chunks: [
        {
          index: 0,
          offsetBytes: 0,
          plainBytes,
          compressedBytes: plainBytes,
          encryptedBytes,
          contentHmacSha256,
          aadSha256,
          sha256: ciphertextSha256,
        },
      ],
    },
    emptyComponent("media"),
    emptyComponent("state-files"),
    emptyComponent("vault"),
  ];
  const canonicalContext = operationKeyBundleContext();
  const wrappedBytes = Buffer.from(KEY_BUNDLE, "base64");
  const wrappedSha256 = sha256Hex(wrappedBytes);
  const localReceiptDigest = sha256Hex(
    JSON.stringify({
      derivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
      format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
      keyId: `org:${ORG_ID}/dek/v1`,
      keyVersion: 1,
      contextSha256: sha256Hex(canonicalContext),
      wrappedKeyBundleSha256: wrappedSha256,
    }),
  );
  wrappedBytes.fill(0);
  const draft: AgentBackupManifestV3Draft = {
    format: AGENT_BACKUP_MANIFEST_FORMAT,
    schemaVersion: 3,
    operationId: OPERATION_ID,
    createdAt: "2026-08-17T01:00:00.000Z",
    identity: {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      activationGeneration: ACTIVATION_GENERATION,
      lifecycleRevision: "7",
    },
    source: {
      kind: "robot",
      provider: "hetzner",
      nodeRecordId: "00000000-0000-4000-8000-00000000d007",
      nodeIncarnation: "00000000-0000-4000-8000-00000000d008",
      nodeId: "restore-source-node",
      containerId: "c".repeat(64),
    },
    runtime: {
      imageDigest: `sha256:${SHA}`,
      agentSchemaVersion: "2.0.0",
      databaseSchemaVersion: "1",
      plugins: [],
    },
    chain: { kind: "full", baseOperationId: null, parentOperationId: null, depth: 0 },
    components,
    watermarks: [{ namespace: "database.lsn", value: "0/16B6C50" }],
    totals: { plainBytes, compressedBytes: plainBytes, encryptedBytes, chunkCount: 1 },
    vaultKeyAuthority: {
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      generationId: vaultAuthority.generationId,
      receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      receiptDigest: vaultAuthority.receiptDigest,
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
        generationId: "00000000-0000-4000-8000-00000000d009",
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek,
        contentHmac: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac,
        wrapped: {
          ref: `backup-key-bundle:${OPERATION_ID}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256: wrappedSha256,
          localReceiptDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest,
          contextDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
    integrity: {
      framedContentHmacSha256: SHA,
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
    manifest,
    canonicalDraft: canonicalizeAgentBackupManifestV3(draft),
    canonicalContext,
    wrappedSha256,
    localReceiptDigest,
    inventory: [
      {
        component: "database",
        chunkIndex: 0,
        contentHmacSha256,
        ciphertextSha256,
        sizeBytes: encryptedBytes,
      },
    ],
  };
}

async function insertSource(
  state: "primary_verified" | "secondary_pending" | "protected",
): Promise<void> {
  await dbWrite.insert(agentBackupCatalogAuthorities).values({
    organization_id: ORG_ID,
    agent_id: AGENT_ID,
  });
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
    catalog_state: state,
    catalog_payload_digest: SHA,
    catalog_revision: 0n,
    catalog_organization_id: ORG_ID,
    catalog_agent_id: AGENT_ID,
    lifecycle_generation: ACTIVATION_GENERATION,
    lifecycle_revision: 7n,
    source_provider: "operator-onboarded",
    source_node_record_id: "00000000-0000-4000-8000-00000000d007",
    source_node_id: "restore-source-node",
    source_node_incarnation: "00000000-0000-4000-8000-00000000d008",
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
    operation_key_bundle_generation_id: "00000000-0000-4000-8000-00000000d009",
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
  await dbWrite.insert(agentVaultKeyBackupBindings).values({
    organization_id: ORG_ID,
    agent_id: AGENT_ID,
    backup_id: BACKUP_ID,
    operation_id: OPERATION_ID,
    source_activation_generation: ACTIVATION_GENERATION,
    source_lifecycle_revision: 7n,
    manifest_sha256: SHA,
    vault_key_generation_id: VAULT_GENERATION,
    vault_key_authority_receipt_digest: RECEIPT_SHA,
  });
}

async function insertExactProtectedSource(vaultAuthority: {
  generationId: string;
  receiptDigest: string;
}) {
  const exact = await exactManifestV3(vaultAuthority);
  const [catalogAuthority] = await dbWrite
    .select({ revision: agentBackupCatalogAuthorities.catalog_revision })
    .from(agentBackupCatalogAuthorities)
    .where(eq(agentBackupCatalogAuthorities.agent_id, AGENT_ID));
  if (!catalogAuthority) throw new Error("Expected vault-created catalogue authority");
  await dbWrite.insert(agentSandboxBackups).values({
    id: BACKUP_ID,
    sandbox_record_id: null,
    snapshot_type: "auto",
    state_data: { memories: [], config: {}, workspaceFiles: {} },
    state_data_storage: "inline",
    size_bytes: 32,
    backup_kind: "full",
    backup_operation_id: OPERATION_ID,
    catalog_version: 2,
    catalog_state: "protected",
    catalog_payload_digest: SHA,
    catalog_revision: catalogAuthority.revision,
    catalog_organization_id: ORG_ID,
    catalog_agent_id: AGENT_ID,
    lifecycle_generation: ACTIVATION_GENERATION,
    lifecycle_revision: 7n,
    source_provider: "operator-onboarded",
    source_node_record_id: "00000000-0000-4000-8000-00000000d007",
    source_node_id: "restore-source-node",
    source_node_incarnation: "00000000-0000-4000-8000-00000000d008",
    source_provider_server_id: null,
    source_provider_handle: "restore-source-handle",
    source_container_id: "c".repeat(64),
    retention_reason: "schedule",
    retention_until: new Date("2026-12-01T00:00:00.000Z"),
    manifest_format: exact.manifest.format,
    manifest_version: exact.manifest.schemaVersion,
    manifest_digest: exact.manifest.integrity.manifestSha256,
    manifest_canonical_draft: exact.canonicalDraft,
    manifest_object_count: 1,
    object_inventory_digest: await agentBackupObjectInventoryDigest(exact.inventory),
    image_digest: exact.manifest.runtime.imageDigest,
    database_schema_version: exact.manifest.runtime.databaseSchemaVersion,
    plugin_set_digest: SHA,
    watermark_digest: RECEIPT_SHA,
    raw_size_bytes: exact.manifest.totals.plainBytes,
    compressed_size_bytes: exact.manifest.totals.compressedBytes,
    encrypted_size_bytes: exact.manifest.totals.encryptedBytes,
    kms_key_id: exact.manifest.encryption.kms.keyId,
    kms_key_version: exact.manifest.encryption.kms.keyVersion,
    operation_key_bundle_generation_id: exact.manifest.encryption.operationKeyBundle.generationId,
    operation_key_bundle_format: exact.manifest.encryption.operationKeyBundle.format,
    operation_key_bundle_ref: exact.manifest.encryption.operationKeyBundle.wrapped.ref,
    operation_key_bundle_ciphertext_base64: KEY_BUNDLE,
    operation_key_bundle_sha256: exact.wrappedSha256,
    operation_key_bundle_size_bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
    operation_key_bundle_context: exact.canonicalContext,
    operation_key_bundle_context_derivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
    operation_key_bundle_local_receipt_derivation:
      AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
    operation_key_bundle_local_receipt_digest: exact.localReceiptDigest,
    vault_key_generation_id: vaultAuthority.generationId,
    vault_key_authority_receipt_digest: vaultAuthority.receiptDigest,
  });
  const bindingInput = {
    organizationId: ORG_ID,
    agentId: AGENT_ID,
    backupId: BACKUP_ID,
    operationId: OPERATION_ID,
    sourceActivationGeneration: ACTIVATION_GENERATION,
    sourceLifecycleRevision: "7",
    manifestSha256: exact.manifest.integrity.manifestSha256,
    vaultKeyGenerationId: vaultAuthority.generationId,
    vaultKeyAuthorityReceiptDigest: vaultAuthority.receiptDigest,
  } as const;
  const binding = await bindAgentBackupVaultKeyGeneration(bindingInput);
  const replay = await bindAgentBackupVaultKeyGeneration(bindingInput);
  expect(replay).toEqual(binding);
  await expect(
    bindAgentBackupVaultKeyGeneration({
      ...bindingInput,
      vaultKeyAuthorityReceiptDigest: SHA,
    }),
  ).rejects.toThrow("differs from the requested vault-key binding");

  const verifiedAt = new Date("2026-08-17T01:01:00.000Z");
  await dbWrite.insert(agentBackupObjects).values([
    {
      organization_id: ORG_ID,
      backup_id: BACKUP_ID,
      copy_role: "primary",
      component: "database",
      chunk_index: 0,
      state: "verified",
      transport: "worker-r2",
      provider: "cloudflare-r2",
      endpoint_alias: "r2-primary-eu",
      endpoint_identity_fingerprint: `sha256:${SHA}`,
      bucket: "restore-primary",
      region: "weur",
      object_key: `${ORG_ID}/${BACKUP_ID}/primary/0`,
      key_fingerprint: SHA,
      provider_write_started: true,
      provider_etag: "primary-etag",
      content_hmac_sha256: exact.inventory[0]!.contentHmacSha256,
      ciphertext_sha256: exact.inventory[0]!.ciphertextSha256,
      size_bytes: exact.inventory[0]!.sizeBytes,
      upload_receipt_digest: SHA,
      verified_at: verifiedAt,
    },
    {
      organization_id: ORG_ID,
      backup_id: BACKUP_ID,
      copy_role: "secondary",
      component: "database",
      chunk_index: 0,
      state: "verified",
      transport: "s3-compatible",
      provider: "hetzner-object-storage",
      endpoint_alias: "hetzner-secondary-eu",
      endpoint_identity_fingerprint: `sha256:${RECEIPT_SHA}`,
      bucket: "restore-secondary",
      region: "fsn1",
      object_key: `${ORG_ID}/${BACKUP_ID}/secondary/0`,
      key_fingerprint: RECEIPT_SHA,
      provider_write_started: true,
      provider_etag: "secondary-etag",
      content_hmac_sha256: exact.inventory[0]!.contentHmacSha256,
      ciphertext_sha256: exact.inventory[0]!.ciphertextSha256,
      size_bytes: exact.inventory[0]!.sizeBytes,
      upload_receipt_digest: RECEIPT_SHA,
      verified_at: verifiedAt,
    },
  ]);
  return { exact, binding };
}

async function acquireVaultPassphraseFixture(
  entropyByte = 0x43,
  options: Readonly<{ reserveTarget?: boolean }> = {},
) {
  const kms = new MemoryKmsAdapter({ seed: () => new Uint8Array(32).fill(0x93) });
  const generation = await createOrRotateAgentVaultKeyGeneration(
    {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      generationId: VAULT_GENERATION,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      expectedCurrentGenerationId: null,
    },
    {
      kmsClient: kms,
      randomBytes: (size) => new Uint8Array(size).fill(entropyByte),
    },
  );
  generation.secret.release();
  const { exact } = await insertExactProtectedSource(generation.authority);
  const acquired = await acquireAgentBackupRestoreLease({
    organizationId: ORG_ID,
    backupId: BACKUP_ID,
    operationId: OPERATION_ID,
    sourceActivationGeneration: ACTIVATION_GENERATION,
    sourceLifecycleRevision: "7",
    expectedManifestSha256: exact.manifest.integrity.manifestSha256,
    copyRole: "primary",
    restoreAttemptId: RESTORE_ATTEMPT_ID,
    ownerId: "vault-restore-worker",
    leaseMs: 60_000,
  });
  const opened = await openAgentBackupRestoreOperation({
    authority: acquired.authority,
    leaseId: acquired.authority.leaseId,
  });
  const claimed = await claimAgentBackupRestoreOperation({
    operationId: opened.operation.id,
    ownerId: acquired.authority.ownerId,
    claimMs: 60_000,
  });
  await dbWrite.insert(dockerNodes).values({
    id: TARGET_NODE_RECORD_ID,
    node_id: "vault-restore-target-node",
    hostname: "vault-restore-target-node.internal",
    capacity: 2,
    enabled: true,
    placement_state: "open",
    status: "healthy",
    host_key_fingerprint: `SHA256:${SHA}`,
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    node_incarnation: TARGET_NODE_INCARNATION,
    metadata: {},
    created_at: TARGET_NODE_CREATED_AT,
  });
  await dbWrite.insert(agentNodeIncarnationHistories).values({
    docker_node_record_id: TARGET_NODE_RECORD_ID,
    node_id: "vault-restore-target-node",
    node_incarnation: TARGET_NODE_INCARNATION,
    fleet_kind: "robot",
    infrastructure_provider: "hetzner",
    provider_server_id: null,
    host_key_fingerprint: `SHA256:${SHA}`,
    attested_at: TARGET_NODE_ATTESTED_AT,
  });
  if (options.reserveTarget !== false) {
    await reserveAgentBackupRestoreTarget({
      operationId: opened.operation.id,
      ownerId: acquired.authority.ownerId,
      claimGeneration: claimed.claimGeneration,
      targetNodeRecordId: TARGET_NODE_RECORD_ID,
      targetNodeIncarnation: TARGET_NODE_INCARNATION,
    });
  }
  return {
    kms,
    generation,
    operation: claimed.operation,
    input: {
      ...acquired.authority,
      restoreOperationId: opened.operation.id,
      restoreClaimGeneration: claimed.claimGeneration,
      targetNodeRecordId: TARGET_NODE_RECORD_ID,
      targetNodeIncarnation: TARGET_NODE_INCARNATION,
      vaultKeyGenerationId: generation.authority.generationId,
      vaultKeyAuthorityReceiptDigest: generation.authority.receiptDigest,
    },
  } as const;
}

async function rearmVaultTargetNodeThroughIncarnation(
  nextIncarnation: string,
  timing: "later" | "backdated" = "later",
): Promise<void> {
  const [originalHistory] = await dbWrite
    .select()
    .from(agentNodeIncarnationHistories)
    .where(eq(agentNodeIncarnationHistories.docker_node_record_id, TARGET_NODE_RECORD_ID));
  if (!originalHistory) throw new Error("vault target history fixture is missing");
  await dbWrite
    .update(dockerNodes)
    .set({ node_incarnation: nextIncarnation })
    .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
  await dbWrite.insert(agentNodeIncarnationHistories).values({
    docker_node_record_id: TARGET_NODE_RECORD_ID,
    node_id: originalHistory.node_id,
    node_incarnation: nextIncarnation,
    fleet_kind: originalHistory.fleet_kind,
    infrastructure_provider: originalHistory.infrastructure_provider,
    provider_server_id: originalHistory.provider_server_id,
    host_key_fingerprint: originalHistory.host_key_fingerprint,
    attested_at: new Date(
      originalHistory.attested_at.getTime() + (timing === "backdated" ? -1_000 : 1_000),
    ),
  });
  await dbWrite
    .update(dockerNodes)
    .set({ node_incarnation: TARGET_NODE_INCARNATION })
    .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
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
        agentBackupObjects,
        agentBackupRestoreLeases,
        agentBackupRestoreOperations,
        dockerNodes,
        agentNodeIncarnationHistories,
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
    // error-policy:J1 setup failure is retained for the test boundary assertion.
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.delete(agentBackupRestoreReceipts);
  await dbWrite.delete(agentVaultKeySeedReceipts);
  await dbWrite.delete(agentActivationPublications);
  await dbWrite.delete(agentNodeIncarnationHistories);
  await dbWrite.delete(agentVaultKeyBackupBindings);
  await dbWrite.delete(agentBackupRestoreOperations);
  await dbWrite.delete(agentBackupRestoreLeases);
  await dbWrite.delete(agentBackupObjects);
  await dbWrite.delete(agentSandboxBackups);
  await dbWrite.delete(agentVaultKeyAuthorities);
  await dbWrite.delete(agentVaultKeyGenerations);
  await dbWrite.delete(agentBackupCatalogAuthorities);
  await dbWrite.delete(agentSandboxes);
  await dbWrite.delete(dockerNodes);
  await dbWrite.delete(userCharacters);
  await dbWrite.delete(users);
  await dbWrite.delete(organizations);
  await dbWrite.insert(organizations).values({
    id: ORG_ID,
    name: "Restore authority test",
    slug: "restore-authority-test",
  });
  await insertActiveSandbox();
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("strict restore catalogue authority", () => {
  test("creates, replays, rotates, zeroizes, and retains vault-key authority", async () => {
    const kms = new MemoryKmsAdapter({ seed: () => new Uint8Array(32).fill(0x91) });
    let entropyCalls = 0;
    const options = {
      kmsClient: kms,
      randomBytes: (size: number) => {
        entropyCalls += 1;
        return new Uint8Array(size).fill(entropyCalls);
      },
    };
    const firstInput = {
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      generationId: VAULT_GENERATION,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      expectedCurrentGenerationId: null,
    } as const;
    const first = await createOrRotateAgentVaultKeyGeneration(firstInput, options);
    let borrowedPassphrase: Uint8Array | null = null;
    let copiedPassphrase = Buffer.alloc(0);
    await first.secret.withPassphrase((passphrase) => {
      borrowedPassphrase = passphrase;
      copiedPassphrase = Buffer.from(passphrase);
    });
    expect(copiedPassphrase.toString("ascii")).toBe("01".repeat(32));
    expect(isZeroized(borrowedPassphrase)).toBe(true);
    const borrowedRawKey = (first.secret as unknown as { rawKey: Uint8Array | null }).rawKey;
    expect(borrowedRawKey).not.toBeNull();
    first.secret.release();
    expect(first.secret.released).toBe(true);
    expect(borrowedRawKey?.every((byte) => byte === 0)).toBe(true);
    await expect(first.secret.withPassphrase(() => undefined)).rejects.toMatchObject({
      code: "AGENT_VAULT_KEY_HANDLE_RELEASED",
    });

    const replay = await createOrRotateAgentVaultKeyGeneration(firstInput, options);
    let replayPassphrase = Buffer.alloc(0);
    await replay.secret.withPassphrase((passphrase) => {
      replayPassphrase = Buffer.from(passphrase);
    });
    replay.secret.release();
    expect(replay.replayed).toBe(true);
    expect(replay.authority).toEqual(first.authority);
    expect(replayPassphrase).toEqual(copiedPassphrase);
    expect(entropyCalls).toBe(1);

    const rotated = await createOrRotateAgentVaultKeyGeneration(
      {
        ...firstInput,
        generationId: ROTATED_VAULT_GENERATION,
        expectedCurrentGenerationId: VAULT_GENERATION,
      },
      options,
    );
    rotated.secret.release();
    expect(rotated.replayed).toBe(false);
    expect(entropyCalls).toBe(2);
    expect(
      await loadCurrentAgentVaultKeyAuthority({ organizationId: ORG_ID, agentId: AGENT_ID }),
    ).toEqual(rotated.authority);
    await expect(
      createOrRotateAgentVaultKeyGeneration(
        {
          ...firstInput,
          generationId: STALE_VAULT_GENERATION,
          expectedCurrentGenerationId: VAULT_GENERATION,
        },
        options,
      ),
    ).rejects.toMatchObject({ code: "AGENT_VAULT_KEY_ROTATION_CAS_LOST" });
    expect(await dbWrite.select().from(agentVaultKeyGenerations)).toHaveLength(2);

    await dbWrite.delete(agentSandboxes).where(eq(agentSandboxes.id, AGENT_ID));
    expect(await dbWrite.select().from(agentVaultKeyGenerations)).toHaveLength(2);
    expect(
      await loadCurrentAgentVaultKeyAuthority({ organizationId: ORG_ID, agentId: AGENT_ID }),
    ).toEqual(rotated.authority);
    await dbWrite
      .update(agentVaultKeyGenerations)
      .set({ wrapped_envelope_sha256: SHA })
      .where(eq(agentVaultKeyGenerations.generation_id, ROTATED_VAULT_GENERATION));
    await expect(
      loadCurrentAgentVaultKeyAuthority({ organizationId: ORG_ID, agentId: AGENT_ID }),
    ).rejects.toMatchObject({ code: "AGENT_VAULT_KEY_AUTHORITY_CORRUPT" });
    await dbWrite
      .update(agentVaultKeyGenerations)
      .set({ wrapped_envelope_sha256: rotated.generation.wrapped_envelope_sha256 })
      .where(eq(agentVaultKeyGenerations.generation_id, ROTATED_VAULT_GENERATION));
    copiedPassphrase.fill(0);
    replayPassphrase.fill(0);
  });

  test("zeroizes transient vault-key material when KMS encryption fails", async () => {
    const kms = new MemoryKmsAdapter({ seed: () => new Uint8Array(32).fill(0x94) });
    let borrowedPlaintext: Uint8Array | null = null;
    const encryptSpy = spyOn(kms, "encrypt").mockImplementation(async (_keyId, plaintext, _aad) => {
      borrowedPlaintext = plaintext;
      throw new Error("simulated KMS failure");
    });
    try {
      const attempt = createOrRotateAgentVaultKeyGeneration(
        {
          organizationId: ORG_ID,
          agentId: AGENT_ID,
          generationId: VAULT_GENERATION,
          sourceActivationGeneration: ACTIVATION_GENERATION,
          expectedCurrentGenerationId: null,
        },
        {
          kmsClient: kms,
          randomBytes: (size) => new Uint8Array(size).fill(0x45),
        },
      );
      await expect(attempt).rejects.toBeInstanceOf(ElizaError);
      await expect(attempt).rejects.toMatchObject({
        code: "AGENT_VAULT_KEY_CREATE_FAILED",
        cause: expect.any(Error),
      });
      expect(borrowedPlaintext).not.toBeNull();
      expect(isZeroized(borrowedPlaintext)).toBe(true);
      expect(await dbWrite.select().from(agentVaultKeyGenerations)).toHaveLength(0);
    } finally {
      encryptSpy.mockRestore();
    }
  });

  test("rejects non-canonical restore authority inputs with typed field context", async () => {
    const input = {
      organizationId: ORG_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      sourceLifecycleRevision: "7",
      expectedManifestSha256: SHA,
      copyRole: "primary" as const,
      restoreAttemptId: "00000000-0000-4000-8000-00000000d010",
      ownerId: "restore-worker",
      leaseMs: 60_000,
    };
    const uppercaseTenant = acquireAgentBackupRestoreLease({
      ...input,
      organizationId: ORG_ID.toUpperCase(),
    });
    await expect(uppercaseTenant).rejects.toBeInstanceOf(ElizaError);
    await expect(uppercaseTenant).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_INPUT_INVALID",
      context: { field: "organizationId" },
    });
    await expect(
      acquireAgentBackupRestoreLease({ ...input, expectedManifestSha256: SHA.toUpperCase() }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_INPUT_INVALID",
      context: { field: "expectedManifestSha256" },
    });
    await expect(
      acquireAgentBackupRestoreLease({ ...input, ownerId: "x".repeat(256) }),
    ).rejects.toMatchObject({
      code: "AGENT_BACKUP_RESTORE_INPUT_INVALID",
      context: { field: "ownerId" },
    });
  });

  for (const state of ["primary_verified", "secondary_pending"] as const) {
    test(`rejects ${state} through both lease and source entrypoints`, async () => {
      await insertSource(state);
      const common = {
        organizationId: ORG_ID,
        backupId: BACKUP_ID,
        operationId: OPERATION_ID,
        sourceActivationGeneration: ACTIVATION_GENERATION,
        sourceLifecycleRevision: "7",
        expectedManifestSha256: SHA,
        copyRole: "primary",
        restoreAttemptId: "00000000-0000-4000-8000-00000000d010",
        ownerId: "restore-worker",
      } as const;
      await expect(acquireAgentBackupRestoreLease({ ...common, leaseMs: 60_000 })).rejects.toThrow(
        "not in a restorable catalogue state",
      );
      await expect(
        loadAgentBackupRestoreSourceV3({
          organizationId: ORG_ID,
          agentId: AGENT_ID,
          backupId: BACKUP_ID,
          operationId: OPERATION_ID,
          sourceActivationGeneration: ACTIVATION_GENERATION,
          sourceLifecycleRevision: "7",
          expectedManifestSha256: SHA,
          restoreAttemptId: common.restoreAttemptId,
          leaseId: "00000000-0000-4000-8000-00000000d011",
          ownerId: common.ownerId,
          fencingToken: "00000000-0000-4000-8000-00000000d012",
          catalogEpoch: "0",
          copyRole: "primary",
        }),
      ).rejects.toThrow("no longer restorable");
    });
  }

  test("loads only the copy selected by an exact manifest-v3 lease and rejects tamper", async () => {
    const kms = new MemoryKmsAdapter({ seed: () => new Uint8Array(32).fill(0x92) });
    const generation = await createOrRotateAgentVaultKeyGeneration(
      {
        organizationId: ORG_ID,
        agentId: AGENT_ID,
        generationId: VAULT_GENERATION,
        sourceActivationGeneration: ACTIVATION_GENERATION,
        expectedCurrentGenerationId: null,
      },
      {
        kmsClient: kms,
        randomBytes: (size) => new Uint8Array(size).fill(0x42),
      },
    );
    generation.secret.release();
    const { exact } = await insertExactProtectedSource(generation.authority);
    await dbWrite
      .update(agentVaultKeyGenerations)
      .set({ wrapped_envelope_sha256: SHA })
      .where(eq(agentVaultKeyGenerations.generation_id, VAULT_GENERATION));
    await expect(
      bindAgentBackupVaultKeyGeneration({
        organizationId: ORG_ID,
        agentId: AGENT_ID,
        backupId: BACKUP_ID,
        operationId: OPERATION_ID,
        sourceActivationGeneration: ACTIVATION_GENERATION,
        sourceLifecycleRevision: "7",
        manifestSha256: exact.manifest.integrity.manifestSha256,
        vaultKeyGenerationId: generation.authority.generationId,
        vaultKeyAuthorityReceiptDigest: generation.authority.receiptDigest,
      }),
    ).rejects.toMatchObject({ code: "AGENT_VAULT_KEY_AUTHORITY_CORRUPT" });
    await dbWrite
      .update(agentVaultKeyGenerations)
      .set({ wrapped_envelope_sha256: generation.generation.wrapped_envelope_sha256 })
      .where(eq(agentVaultKeyGenerations.generation_id, VAULT_GENERATION));
    const acquireInput = {
      organizationId: ORG_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      sourceLifecycleRevision: "7",
      expectedManifestSha256: exact.manifest.integrity.manifestSha256,
      copyRole: "primary",
      restoreAttemptId: "00000000-0000-4000-8000-00000000d035",
      ownerId: "restore-worker",
      leaseMs: 60_000,
    } as const;
    const acquired = await acquireAgentBackupRestoreLease(acquireInput);
    const canonicalSourceAuthority: AgentBackupRestoreSourceV3Input = acquired.authority;
    const source = await loadAgentBackupRestoreSourceV3(canonicalSourceAuthority);
    expect(source.manifest.integrity.manifestSha256).toBe(exact.manifest.integrity.manifestSha256);
    expect(source.copyRole).toBe("primary");
    expect(source.objects.map((object) => [object.copy_role, object.chunk_index])).toEqual([
      ["primary", 0],
    ]);
    expect(Object.isFrozen(source)).toBe(true);
    expect(Object.isFrozen(source.manifest.components)).toBe(true);
    expect(Object.isFrozen(source.objects[0])).toBe(true);

    const replay = await acquireAgentBackupRestoreLease(acquireInput);
    expect(replay.status).toBe("active");
    await expect(
      loadAgentBackupRestoreSourceV3({ ...canonicalSourceAuthority, copyRole: "secondary" }),
    ).rejects.toThrow("expired, released, or fenced");
    await releaseAgentBackupRestoreLease(canonicalSourceAuthority);
    const secondaryAcquired = await acquireAgentBackupRestoreLease({
      ...acquireInput,
      copyRole: "secondary",
      restoreAttemptId: "00000000-0000-4000-8000-00000000d036",
    });
    const secondaryAuthority: AgentBackupRestoreSourceV3Input = secondaryAcquired.authority;
    const secondary = await loadAgentBackupRestoreSourceV3(secondaryAuthority);
    expect(secondary.objects.map((object) => [object.copy_role, object.chunk_index])).toEqual([
      ["secondary", 0],
    ]);

    await dbWrite
      .update(agentSandboxBackups)
      .set({
        operation_key_bundle_ciphertext_base64: Buffer.alloc(
          AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          0x44,
        ).toString("base64"),
      })
      .where(eq(agentSandboxBackups.id, BACKUP_ID));
    await expect(loadAgentBackupRestoreSourceV3(secondaryAuthority)).rejects.toThrow("key bundle");
    await dbWrite
      .update(agentSandboxBackups)
      .set({ operation_key_bundle_ciphertext_base64: KEY_BUNDLE })
      .where(eq(agentSandboxBackups.id, BACKUP_ID));

    await dbWrite
      .update(agentBackupObjects)
      .set({ state: "quarantined" })
      .where(eq(agentBackupObjects.copy_role, "secondary"));
    await expect(loadAgentBackupRestoreSourceV3(secondaryAuthority)).rejects.toThrow("coverage");
  });

  test("surfaces a cross-backup attempt replay as an explicit authority mismatch", async () => {
    await insertSource("protected");
    const BACKUP_B = "00000000-0000-4000-8000-00000000d0b2";
    const OPERATION_B = "00000000-0000-4000-8000-00000000d0b4";
    await dbWrite.execute(
      sql.raw(`INSERT INTO agent_sandbox_backups
        SELECT (jsonb_populate_record(b,
          '{"id": "${BACKUP_B}", "backup_operation_id": "${OPERATION_B}",
             "operation_key_bundle_ref": "backup-key-bundle:${OPERATION_B}"}'::jsonb)).*
        FROM agent_sandbox_backups AS b WHERE b.id = '${BACKUP_ID}'`),
    );
    await dbWrite.execute(
      sql.raw(`INSERT INTO agent_vault_key_backup_bindings
        SELECT (jsonb_populate_record(v,
          '{"backup_id": "${BACKUP_B}", "operation_id": "${OPERATION_B}"}'::jsonb)).*
        FROM agent_vault_key_backup_bindings AS v WHERE v.backup_id = '${BACKUP_ID}'`),
    );
    const acquireInput = {
      organizationId: ORG_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      sourceLifecycleRevision: "7",
      expectedManifestSha256: SHA,
      copyRole: "primary",
      restoreAttemptId: "00000000-0000-4000-8000-00000000d0b3",
      ownerId: "restore-worker",
      leaseMs: 60_000,
    } as const;
    const first = await acquireAgentBackupRestoreLease(acquireInput);
    expect(first.status).toBe("acquired");
    await expect(
      acquireAgentBackupRestoreLease({
        ...acquireInput,
        backupId: BACKUP_B,
        operationId: OPERATION_B,
      }),
    ).rejects.toThrow("Restore attempt replay authority mismatch");
  });

  test("returns exact DB-clock authority across acquire and renewal response loss", async () => {
    await insertSource("protected");
    const acquireInput = {
      organizationId: ORG_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      sourceLifecycleRevision: "7",
      expectedManifestSha256: SHA,
      copyRole: "primary",
      restoreAttemptId: "00000000-0000-4000-8000-00000000d020",
      ownerId: "restore-worker",
      leaseMs: 60_000,
    } as const;
    const acquired = await acquireAgentBackupRestoreLease(acquireInput);
    expect(acquired.status).toBe("acquired");
    expect(acquired.authority.expiresAt.getTime() - acquired.authority.databaseNow.getTime()).toBe(
      60_000,
    );
    expect(acquired.authority).toMatchObject({
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      sourceLifecycleRevision: "7",
      expectedManifestSha256: SHA,
      copyRole: "primary",
      restoreAttemptId: acquireInput.restoreAttemptId,
      ownerId: acquireInput.ownerId,
      catalogEpoch: "0",
    });

    const replay = await acquireAgentBackupRestoreLease(acquireInput);
    expect(replay.status).toBe("active");
    expect(replay.authority.leaseId).toBe(acquired.authority.leaseId);
    expect(replay.authority.fencingToken).toBe(acquired.authority.fencingToken);
    await expect(
      acquireAgentBackupRestoreLease({ ...acquireInput, copyRole: "secondary" }),
    ).rejects.toThrow("replay authority mismatch");

    const renewInput = {
      ...acquireInput,
      leaseId: acquired.authority.leaseId,
      fencingToken: acquired.authority.fencingToken,
      catalogEpoch: acquired.authority.catalogEpoch,
      leaseMs: 120_000,
    };
    const renewed = await renewAgentBackupRestoreLease(renewInput);
    expect(renewed.expiresAt.getTime() - renewed.databaseNow.getTime()).toBe(120_000);
    expect(renewed).toMatchObject({
      leaseId: acquired.authority.leaseId,
      fencingToken: acquired.authority.fencingToken,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      ownerId: acquireInput.ownerId,
    });
    const renewalReplay = await renewAgentBackupRestoreLease(renewInput);
    expect(renewalReplay.leaseId).toBe(renewed.leaseId);
    expect(renewalReplay.fencingToken).toBe(renewed.fencingToken);
    expect(renewalReplay.expiresAt.getTime() - renewalReplay.databaseNow.getTime()).toBe(120_000);
    await expect(
      renewAgentBackupRestoreLease({ ...renewInput, copyRole: "secondary" }),
    ).rejects.toThrow("lost ownership");
    await expect(
      renewAgentBackupRestoreLease({ ...renewInput, ownerId: "wrong-restore-worker" }),
    ).rejects.toThrow("lost ownership");
    await expect(
      renewAgentBackupRestoreLease({
        ...renewInput,
        fencingToken: "00000000-0000-4000-8000-00000000d041",
      }),
    ).rejects.toThrow("lost ownership");
    const released = await releaseAgentBackupRestoreLease(renewed);
    const releaseReplay = await releaseAgentBackupRestoreLease(renewed);
    expect(releaseReplay.id).toBe(released.id);
    expect(releaseReplay.released_at).toEqual(released.released_at);
  });

  test("replays one immutable seed-to-activation receipt chain and fences current boot drift", async () => {
    const kms = new MemoryKmsAdapter({ seed: () => new Uint8Array(32).fill(0x94) });
    const generation = await createOrRotateAgentVaultKeyGeneration(
      {
        organizationId: ORG_ID,
        agentId: AGENT_ID,
        generationId: VAULT_GENERATION,
        sourceActivationGeneration: ACTIVATION_GENERATION,
        expectedCurrentGenerationId: null,
      },
      {
        kmsClient: kms,
        randomBytes: (size) => new Uint8Array(size).fill(0x44),
      },
    );
    generation.secret.release();
    const { exact } = await insertExactProtectedSource(generation.authority);
    await dbWrite.insert(dockerNodes).values({
      id: TARGET_NODE_RECORD_ID,
      node_id: "restore-target-node",
      hostname: "restore-target-node.internal",
      host_key_fingerprint: `SHA256:${SHA}`,
      fleet_kind: "robot",
      infrastructure_provider: "hetzner",
      provider_server_id: null,
      node_incarnation: TARGET_NODE_INCARNATION,
    });
    await dbWrite
      .update(agentSandboxes)
      .set({
        lifecycle_revision: 8,
        activation_generation: TARGET_ACTIVATION_GENERATION,
        activation_previous_generation: ACTIVATION_GENERATION,
        activation_lifecycle_revision: 8n,
        activation_purpose: "restore",
        activation_phase: "restart_attested",
        activation_backup_id: BACKUP_ID,
        activation_backup_hash: exact.manifest.integrity.manifestSha256,
        activation_receipt: {
          schemaVersion: 1,
          generation: TARGET_ACTIVATION_GENERATION,
          purpose: "restore",
          agentId: AGENT_ID,
          organizationId: ORG_ID,
          lifecycleRevision: "8",
          backupId: BACKUP_ID,
          backupHash: exact.manifest.integrity.manifestSha256,
          manifestHash: exact.manifest.integrity.manifestSha256,
          componentHashes: null,
          freshAuthorization: null,
          containerId: RESTORE_CONTAINER_ID,
          imageDigest: `sha256:${SHA}`,
          receiptId: "00000000-0000-4000-8000-00000000d049",
          receiptHash: RECEIPT_SHA,
          receiptMac: CONTENT_SHA,
          appliedAt: "2026-08-17T02:00:00.000Z",
          restored: true,
          requiresRestart: true,
        },
        activation_receipt_hash: RECEIPT_SHA,
        activation_container_id: RESTORE_CONTAINER_ID,
        activation_node_id: "restore-target-node",
        activation_image_digest: `sha256:${SHA}`,
        activation_token_hash: SHA,
        activation_token_ciphertext: "sealed-target-restore-token",
        activation_boot_id: TARGET_NODE_INCARNATION,
        activation_funding_revision: 2n,
        activation_authority_published_at: null,
        activation_dispatched_at: null,
        activation_completed_at: null,
      })
      .where(eq(agentSandboxes.id, AGENT_ID));

    const publicationInput = {
      publicationId: ACTIVATION_PUBLICATION_ID,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      activationGeneration: TARGET_ACTIVATION_GENERATION,
      expectedActivationReceiptSha256: RECEIPT_SHA,
      expectedContainerId: RESTORE_CONTAINER_ID,
      expectedNodeRecordId: TARGET_NODE_RECORD_ID,
      expectedNodeIncarnation: TARGET_NODE_INCARNATION,
      expectedTokenSha256: SHA,
    } as const;
    const [publicationFirst, publicationReplay] = await Promise.all([
      recordAgentActivationPublication(publicationInput),
      recordAgentActivationPublication(publicationInput),
    ]);
    expect([publicationFirst.replayed, publicationReplay.replayed].sort()).toEqual([false, true]);
    expect(publicationFirst.publication.id).toBe(publicationReplay.publication.id);
    await authorizeAgentActivationDispatch(publicationInput);

    await dbWrite
      .update(agentSandboxes)
      .set({ activation_boot_id: "00000000-0000-4000-8000-00000000d050" })
      .where(eq(agentSandboxes.id, AGENT_ID));
    await expect(authorizeAgentActivationDispatch(publicationInput)).rejects.toThrow(
      "lost current mutable authority",
    );
    await dbWrite
      .update(agentSandboxes)
      .set({ activation_boot_id: TARGET_NODE_INCARNATION })
      .where(eq(agentSandboxes.id, AGENT_ID));
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: "00000000-0000-4000-8000-00000000d050" })
      .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
    await expect(authorizeAgentActivationDispatch(publicationInput)).rejects.toThrow(
      "Target node incarnation is absent",
    );
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: TARGET_NODE_INCARNATION })
      .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
    // This direct mutation did not publish a B history. Journaled A -> B -> A
    // is covered separately and remains rejected after the mutable row rewinds.

    const acquired = await acquireAgentBackupRestoreLease({
      organizationId: ORG_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      sourceLifecycleRevision: "7",
      expectedManifestSha256: exact.manifest.integrity.manifestSha256,
      copyRole: "primary",
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      ownerId: "immutable-restore-worker",
      fencingToken: "00000000-0000-4000-8000-00000000d051",
      leaseMs: 60_000,
    });
    const seedInput = {
      receiptId: SEED_RECEIPT_ID,
      receiptDigest: CONTENT_SHA,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      leaseId: acquired.authority.leaseId,
      leaseOwnerId: acquired.authority.ownerId,
      leaseFencingToken: acquired.authority.fencingToken,
      targetActivationGeneration: TARGET_ACTIVATION_GENERATION,
      targetNodeRecordId: TARGET_NODE_RECORD_ID,
      targetNodeIncarnation: TARGET_NODE_INCARNATION,
    } as const;
    await expect(
      recordAgentVaultKeySeedReceipt({
        ...seedInput,
        receiptId: "00000000-0000-4000-8000-00000000d052",
        targetNodeIncarnation: "00000000-0000-4000-8000-00000000d050",
      }),
    ).rejects.toThrow("unattested, changed, or blocked");
    // The seed receipt is append-only (0250), so a stale catalogue epoch must be
    // refused BEFORE the row exists rather than left as an unremovable record.
    const [epochBefore] = await dbWrite
      .select({ revision: agentBackupCatalogAuthorities.catalog_revision })
      .from(agentBackupCatalogAuthorities)
      .where(eq(agentBackupCatalogAuthorities.agent_id, AGENT_ID));
    if (!epochBefore) throw new Error("Expected vault-created catalogue authority");
    await dbWrite
      .update(agentBackupCatalogAuthorities)
      .set({ catalog_revision: epochBefore.revision + 1n })
      .where(eq(agentBackupCatalogAuthorities.agent_id, AGENT_ID));
    await expect(recordAgentVaultKeySeedReceipt(seedInput)).rejects.toThrow(
      "lost its exact live restore lease",
    );
    const [seedAfterStaleEpoch] = await dbWrite
      .select({ id: agentVaultKeySeedReceipts.id })
      .from(agentVaultKeySeedReceipts)
      .where(eq(agentVaultKeySeedReceipts.id, SEED_RECEIPT_ID));
    expect(seedAfterStaleEpoch).toBeUndefined();
    await dbWrite
      .update(agentBackupCatalogAuthorities)
      .set({ catalog_revision: epochBefore.revision })
      .where(eq(agentBackupCatalogAuthorities.agent_id, AGENT_ID));

    const [seedFirst, seedReplay] = await Promise.all([
      recordAgentVaultKeySeedReceipt(seedInput),
      recordAgentVaultKeySeedReceipt(seedInput),
    ]);
    expect([seedFirst.replayed, seedReplay.replayed].sort()).toEqual([false, true]);
    expect(seedFirst.receipt.lease_expires_at).toEqual(acquired.authority.expiresAt);

    const dispatchedAt = new Date(publicationFirst.publication.published_at.getTime() + 1_000);
    const activatedAt = new Date(dispatchedAt.getTime() + 1_000);
    await dbWrite
      .update(agentSandboxes)
      .set({
        status: "running",
        sandbox_id: "restored-provider-handle",
        node_id: "restore-target-node",
        image_digest: `sha256:${SHA}`,
        activation_phase: "active",
        activation_authority_published_at: publicationFirst.publication.published_at,
        activation_dispatched_at: dispatchedAt,
        activation_completed_at: activatedAt,
      })
      .where(eq(agentSandboxes.id, AGENT_ID));

    const finalInput = {
      receiptId: FINAL_RECEIPT_ID,
      receiptDigest: CIPHERTEXT_SHA,
      organizationId: ORG_ID,
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
      restoreAttemptId: RESTORE_ATTEMPT_ID,
      seedReceiptId: SEED_RECEIPT_ID,
      seedReceiptDigest: CONTENT_SHA,
      activationPublicationId: ACTIVATION_PUBLICATION_ID,
      targetActivationGeneration: TARGET_ACTIVATION_GENERATION,
      expectedActivationReceiptSha256: RECEIPT_SHA,
    } as const;

    const originalLeaseExpiry = acquired.authority.expiresAt;
    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ expires_at: new Date(acquired.lease.created_at.getTime() + 1) })
      .where(eq(agentBackupRestoreLeases.id, acquired.authority.leaseId));
    await expect(commitAgentBackupRestore(finalInput)).rejects.toThrow(
      "expired while mutable authorities were revalidated",
    );
    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ expires_at: originalLeaseExpiry })
      .where(eq(agentBackupRestoreLeases.id, acquired.authority.leaseId));

    // A target that reboots between publication and commit must not earn a
    // permanent receipt naming an incarnation that no longer exists.
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: "00000000-0000-4000-8000-00000000d055" })
      .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));
    await expect(commitAgentBackupRestore(finalInput)).rejects.toThrow(
      "Target node incarnation is absent",
    );
    await dbWrite
      .update(dockerNodes)
      .set({ node_incarnation: TARGET_NODE_INCARNATION })
      .where(eq(dockerNodes.id, TARGET_NODE_RECORD_ID));

    await releaseAgentBackupRestoreLease(acquired.authority);
    await expect(commitAgentBackupRestore(finalInput)).rejects.toThrow(
      "lost its exact live restore lease",
    );
    const takeover = await acquireAgentBackupRestoreLease({
      organizationId: ORG_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      sourceLifecycleRevision: "7",
      expectedManifestSha256: exact.manifest.integrity.manifestSha256,
      copyRole: "primary",
      restoreAttemptId: "00000000-0000-4000-8000-00000000d053",
      ownerId: "takeover-restore-worker",
      fencingToken: "00000000-0000-4000-8000-00000000d054",
      leaseMs: 60_000,
    });
    await expect(commitAgentBackupRestore(finalInput)).rejects.toThrow(
      "lost its exact live restore lease",
    );
    expect(takeover.authority.restoreAttemptId).not.toBe(acquired.authority.restoreAttemptId);
    expect(await dbWrite.select().from(agentBackupRestoreReceipts)).toHaveLength(0);
    const [uncommittedAuthority] = await dbWrite
      .select({ generation: agentBackupCatalogAuthorities.restore_generation })
      .from(agentBackupCatalogAuthorities)
      .where(eq(agentBackupCatalogAuthorities.agent_id, AGENT_ID));
    expect(uncommittedAuthority?.generation).toBe(0n);
    const [uncommittedBackup] = await dbWrite
      .select({
        state: agentSandboxBackups.catalog_state,
        generation: agentSandboxBackups.restore_generation,
        receiptDigest: agentSandboxBackups.restore_receipt_digest,
      })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, BACKUP_ID));
    expect(uncommittedBackup).toEqual({
      state: "protected",
      generation: null,
      receiptDigest: null,
    });

    // Rewind only the adversarial fixture so the original exact-authority happy path remains proven.
    await dbWrite
      .delete(agentBackupRestoreLeases)
      .where(eq(agentBackupRestoreLeases.id, takeover.authority.leaseId));
    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ released_at: null })
      .where(eq(agentBackupRestoreLeases.id, acquired.authority.leaseId));
    const [finalFirst, finalReplay] = await Promise.all([
      commitAgentBackupRestore(finalInput),
      commitAgentBackupRestore(finalInput),
    ]);
    expect([finalFirst.replayed, finalReplay.replayed].sort()).toEqual([false, true]);
    expect(finalFirst.receipt.restore_generation).toBe(1n);
    await expect(commitAgentBackupRestore({ ...finalInput, receiptDigest: SHA })).rejects.toThrow(
      "replay mismatch",
    );
    const [restoredBackup] = await dbWrite
      .select({
        state: agentSandboxBackups.catalog_state,
        generation: agentSandboxBackups.restore_generation,
        receiptDigest: agentSandboxBackups.restore_receipt_digest,
      })
      .from(agentSandboxBackups)
      .where(eq(agentSandboxBackups.id, BACKUP_ID));
    expect(restoredBackup).toEqual({
      state: "restore_verified",
      generation: 1n,
      receiptDigest: CIPHERTEXT_SHA,
    });
  });

  test("rechecks the live DB clock after expensive restore-source validation", async () => {
    const kms = new MemoryKmsAdapter({ seed: () => new Uint8Array(32).fill(0x93) });
    const generation = await createOrRotateAgentVaultKeyGeneration(
      {
        organizationId: ORG_ID,
        agentId: AGENT_ID,
        generationId: VAULT_GENERATION,
        sourceActivationGeneration: ACTIVATION_GENERATION,
        expectedCurrentGenerationId: null,
      },
      {
        kmsClient: kms,
        randomBytes: (size) => new Uint8Array(size).fill(0x43),
      },
    );
    generation.secret.release();
    const { exact } = await insertExactProtectedSource(generation.authority);
    const acquired = await acquireAgentBackupRestoreLease({
      organizationId: ORG_ID,
      backupId: BACKUP_ID,
      operationId: OPERATION_ID,
      sourceActivationGeneration: ACTIVATION_GENERATION,
      sourceLifecycleRevision: "7",
      expectedManifestSha256: exact.manifest.integrity.manifestSha256,
      copyRole: "primary",
      restoreAttemptId: "00000000-0000-4000-8000-00000000d040",
      ownerId: "delayed-restore-worker",
      leaseMs: 1_000,
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      await Bun.sleep(1_250);
      return originalDigest(algorithm, data);
    });
    try {
      await expect(loadAgentBackupRestoreSourceV3(acquired.authority)).rejects.toThrow(
        "expired during manifest and inventory validation",
      );
    } finally {
      digestSpy.mockRestore();
    }
  }, 10_000);

  test("locks vault target authority in backup-to-catalogue order before the DB clock", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "agent-vault-key-authority.ts"),
      "utf8",
    );
    const proof = source.slice(
      source.indexOf("async function proveAgentBackupRestoreVaultTargetAuthority"),
      source.indexOf("export async function withAgentBackupRestoreVaultPassphrase"),
    );
    expectTokensInOrder(proof, [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
      ".from(dockerNodes)",
      "proveUnambiguousAgentNodeIncarnationForLockedNode(",
      "lockAgentBackupCatalogAuthority(",
      "readPostLockDatabaseNow(",
    ]);
  });

  test("unwraps the manifest-retained vault generation after current authority rotates", async () => {
    const fixture = await acquireVaultPassphraseFixture(0x47);
    const rotated = await createOrRotateAgentVaultKeyGeneration(
      {
        organizationId: ORG_ID,
        agentId: AGENT_ID,
        generationId: ROTATED_VAULT_GENERATION,
        sourceActivationGeneration: ACTIVATION_GENERATION,
        expectedCurrentGenerationId: VAULT_GENERATION,
      },
      {
        kmsClient: fixture.kms,
        randomBytes: (size) => new Uint8Array(size).fill(0x48),
      },
    );
    rotated.secret.release();
    let borrowedPassphrase: Uint8Array | null = null;

    const passphraseText = await withAgentBackupRestoreVaultPassphrase(
      fixture.input,
      (passphrase) => {
        borrowedPassphrase = passphrase;
        return Buffer.from(passphrase).toString("ascii");
      },
      { kmsClient: fixture.kms },
    );

    expect(passphraseText).toBe("47".repeat(32));
    expect(isZeroized(borrowedPassphrase)).toBe(true);
    expect(
      await loadCurrentAgentVaultKeyAuthority({ organizationId: ORG_ID, agentId: AGENT_ID }),
    ).toEqual(rotated.authority);
  });

  test("rejects mismatched source, vault, claim, target, fence, and lease authority before KMS or use", async () => {
    const fixture = await acquireVaultPassphraseFixture();
    const decryptSpy = spyOn(fixture.kms, "decrypt");
    let useCalls = 0;
    const use = () => {
      useCalls += 1;
      return undefined;
    };
    const mismatches = [
      { ...fixture.input, expectedManifestSha256: "f".repeat(64) },
      { ...fixture.input, vaultKeyGenerationId: ROTATED_VAULT_GENERATION },
      { ...fixture.input, vaultKeyAuthorityReceiptDigest: "f".repeat(64) },
      { ...fixture.input, fencingToken: STALE_VAULT_GENERATION },
      { ...fixture.input, restoreOperationId: "00000000-0000-4000-8000-00000000d060" },
      { ...fixture.input, restoreClaimGeneration: "00000000-0000-4000-8000-00000000d061" },
      { ...fixture.input, targetNodeRecordId: "00000000-0000-4000-8000-00000000d062" },
      { ...fixture.input, targetNodeIncarnation: "00000000-0000-4000-8000-00000000d063" },
    ] as const;
    try {
      for (const input of mismatches) {
        await expect(
          withAgentBackupRestoreVaultPassphrase(input, use, { kmsClient: fixture.kms }),
        ).rejects.toBeInstanceOf(Error);
      }
      await releaseAgentBackupRestoreLease(fixture.input);
      await expect(
        withAgentBackupRestoreVaultPassphrase(fixture.input, use, { kmsClient: fixture.kms }),
      ).rejects.toThrow("expired, released, or fenced");

      expect(decryptSpy).toHaveBeenCalledTimes(0);
      expect(useCalls).toBe(0);
    } finally {
      decryptSpy.mockRestore();
    }
  });

  test("does not call KMS without the exact restore operation and persisted target", async () => {
    const fixture = await acquireVaultPassphraseFixture(0x43, { reserveTarget: false });
    const decryptSpy = spyOn(fixture.kms, "decrypt");
    let useCalls = 0;
    const use = () => {
      useCalls += 1;
    };
    try {
      await expect(
        withAgentBackupRestoreVaultPassphrase(
          {
            ...fixture.input,
            restoreOperationId: "00000000-0000-4000-8000-00000000d064",
          },
          use,
          { kmsClient: fixture.kms },
        ),
      ).rejects.toThrow("operation is missing");

      await expect(
        withAgentBackupRestoreVaultPassphrase(fixture.input, use, { kmsClient: fixture.kms }),
      ).rejects.toThrow("lacks its exact complete target authority");

      expect(decryptSpy).toHaveBeenCalledTimes(0);
      expect(useCalls).toBe(0);
    } finally {
      decryptSpy.mockRestore();
    }
  });

  test("rejects an invalid remote handoff bound before source proof or KMS", async () => {
    const fixture = await acquireVaultPassphraseFixture();
    const decryptSpy = spyOn(fixture.kms, "decrypt");
    try {
      for (const handoffTimeoutMs of [0, 60_001, 1.5, Number.NaN]) {
        await expect(
          withAgentBackupRestoreVaultPassphrase(fixture.input, () => undefined, {
            kmsClient: fixture.kms,
            handoffTimeoutMs,
          }),
        ).rejects.toMatchObject({ code: "AGENT_VAULT_KEY_INPUT_INVALID" });
      }
      expect(decryptSpy).toHaveBeenCalledTimes(0);
    } finally {
      decryptSpy.mockRestore();
    }
  });

  test("rejects a backdated target B history before KMS", async () => {
    const fixture = await acquireVaultPassphraseFixture();
    await rearmVaultTargetNodeThroughIncarnation(REARMED_TARGET_NODE_INCARNATION, "backdated");
    const decryptSpy = spyOn(fixture.kms, "decrypt");
    let useCalls = 0;
    try {
      await expect(
        withAgentBackupRestoreVaultPassphrase(
          fixture.input,
          () => {
            useCalls += 1;
          },
          { kmsClient: fixture.kms },
        ),
      ).rejects.toThrow("ambiguous multi-incarnation history");
      expect(decryptSpy).toHaveBeenCalledTimes(0);
      expect(useCalls).toBe(0);
    } finally {
      decryptSpy.mockRestore();
    }
  });

  test("fails while incarnation is NULL and resumes after exact host-key CAS re-attestation", async () => {
    const fixture = await acquireVaultPassphraseFixture(0x4a);
    const decryptSpy = spyOn(fixture.kms, "decrypt");
    let useCalls = 0;
    try {
      await dockerNodesRepository.invalidateNodeIncarnation({
        id: fixture.input.targetNodeRecordId,
        nodeId: "vault-restore-target-node",
        expectedIncarnation: TARGET_NODE_INCARNATION,
        expectedHostKeyFingerprint: `SHA256:${SHA}`,
      });
      await expect(
        withAgentBackupRestoreVaultPassphrase(
          fixture.input,
          () => {
            useCalls += 1;
          },
          { kmsClient: fixture.kms },
        ),
      ).rejects.toThrow("target node record or incarnation was lost");
      expect(decryptSpy).toHaveBeenCalledTimes(0);
      expect(useCalls).toBe(0);

      const reattested = await dockerNodesRepository.attestNodeIncarnation({
        id: fixture.input.targetNodeRecordId,
        nodeId: "vault-restore-target-node",
        expectedIncarnation: null,
        expectedHostKeyFingerprint: `SHA256:${SHA}`,
        observedIncarnation: TARGET_NODE_INCARNATION,
      });
      expect(reattested.id).toBe(TARGET_NODE_RECORD_ID);
      const result = await withAgentBackupRestoreVaultPassphrase(
        fixture.input,
        (passphrase) => {
          useCalls += 1;
          return Buffer.from(passphrase).toString("ascii");
        },
        { kmsClient: fixture.kms },
      );
      expect(result).toBe("4a".repeat(32));
      expect(decryptSpy).toHaveBeenCalledTimes(1);
      expect(useCalls).toBe(1);
    } finally {
      decryptSpy.mockRestore();
    }
  });

  test("revalidates after KMS and zeroizes plaintext when the lease is lost during decrypt", async () => {
    const fixture = await acquireVaultPassphraseFixture();
    const secretRelease = captureVaultRawKeyAtRelease();
    const originalDecrypt = fixture.kms.decrypt.bind(fixture.kms);
    let borrowedPlaintext: Uint8Array | null = null;
    let useCalls = 0;
    const decryptSpy = spyOn(fixture.kms, "decrypt").mockImplementation(
      async (keyId, ciphertext, nonce, authTag, aad, keyVersion) => {
        const plaintext = await originalDecrypt(keyId, ciphertext, nonce, authTag, aad, keyVersion);
        borrowedPlaintext = plaintext;
        await releaseAgentBackupRestoreLease(fixture.input);
        return plaintext;
      },
    );
    try {
      await expect(
        withAgentBackupRestoreVaultPassphrase(
          fixture.input,
          () => {
            useCalls += 1;
          },
          { kmsClient: fixture.kms },
        ),
      ).rejects.toThrow("expired, released, or fenced");

      expect(decryptSpy).toHaveBeenCalledTimes(1);
      expect(useCalls).toBe(0);
      expect(isZeroized(borrowedPlaintext)).toBe(true);
      expect(isZeroized(secretRelease.rawKey)).toBe(true);
    } finally {
      decryptSpy.mockRestore();
      secretRelease.restore();
    }
  });

  test("revalidates after KMS and zeroizes plaintext when the restore claim is lost", async () => {
    const fixture = await acquireVaultPassphraseFixture();
    const secretRelease = captureVaultRawKeyAtRelease();
    const originalDecrypt = fixture.kms.decrypt.bind(fixture.kms);
    let borrowedPlaintext: Uint8Array | null = null;
    let useCalls = 0;
    const decryptSpy = spyOn(fixture.kms, "decrypt").mockImplementation(
      async (keyId, ciphertext, nonce, authTag, aad, keyVersion) => {
        const plaintext = await originalDecrypt(keyId, ciphertext, nonce, authTag, aad, keyVersion);
        borrowedPlaintext = plaintext;
        await dbWrite
          .update(agentBackupRestoreOperations)
          .set({ claim_owner: null, claim_generation: null, claim_expires_at: null })
          .where(eq(agentBackupRestoreOperations.id, fixture.input.restoreOperationId));
        return plaintext;
      },
    );
    try {
      await expect(
        withAgentBackupRestoreVaultPassphrase(
          fixture.input,
          () => {
            useCalls += 1;
          },
          { kmsClient: fixture.kms },
        ),
      ).rejects.toThrow("claim is not live");

      expect(decryptSpy).toHaveBeenCalledTimes(1);
      expect(useCalls).toBe(0);
      expect(isZeroized(borrowedPlaintext)).toBe(true);
      expect(isZeroized(secretRelease.rawKey)).toBe(true);
    } finally {
      decryptSpy.mockRestore();
      secretRelease.restore();
    }
  });

  test("revalidates after KMS and zeroizes plaintext when the target incarnation is lost", async () => {
    const fixture = await acquireVaultPassphraseFixture();
    const secretRelease = captureVaultRawKeyAtRelease();
    const originalDecrypt = fixture.kms.decrypt.bind(fixture.kms);
    let borrowedPlaintext: Uint8Array | null = null;
    let useCalls = 0;
    const decryptSpy = spyOn(fixture.kms, "decrypt").mockImplementation(
      async (keyId, ciphertext, nonce, authTag, aad, keyVersion) => {
        const plaintext = await originalDecrypt(keyId, ciphertext, nonce, authTag, aad, keyVersion);
        borrowedPlaintext = plaintext;
        await dbWrite
          .update(dockerNodes)
          .set({ node_incarnation: "00000000-0000-4000-8000-00000000d065" })
          .where(eq(dockerNodes.id, fixture.input.targetNodeRecordId));
        return plaintext;
      },
    );
    try {
      await expect(
        withAgentBackupRestoreVaultPassphrase(
          fixture.input,
          () => {
            useCalls += 1;
          },
          { kmsClient: fixture.kms },
        ),
      ).rejects.toThrow("target node record or incarnation was lost");

      expect(decryptSpy).toHaveBeenCalledTimes(1);
      expect(useCalls).toBe(0);
      expect(isZeroized(borrowedPlaintext)).toBe(true);
      expect(isZeroized(secretRelease.rawKey)).toBe(true);
    } finally {
      decryptSpy.mockRestore();
      secretRelease.restore();
    }
  });

  test("revalidates after KMS and zeroizes plaintext after a backdated B history", async () => {
    const fixture = await acquireVaultPassphraseFixture();
    const secretRelease = captureVaultRawKeyAtRelease();
    const originalDecrypt = fixture.kms.decrypt.bind(fixture.kms);
    let borrowedPlaintext: Uint8Array | null = null;
    let useCalls = 0;
    const decryptSpy = spyOn(fixture.kms, "decrypt").mockImplementation(
      async (keyId, ciphertext, nonce, authTag, aad, keyVersion) => {
        const plaintext = await originalDecrypt(keyId, ciphertext, nonce, authTag, aad, keyVersion);
        borrowedPlaintext = plaintext;
        await rearmVaultTargetNodeThroughIncarnation(REARMED_TARGET_NODE_INCARNATION, "backdated");
        return plaintext;
      },
    );
    try {
      await expect(
        withAgentBackupRestoreVaultPassphrase(
          fixture.input,
          () => {
            useCalls += 1;
          },
          { kmsClient: fixture.kms },
        ),
      ).rejects.toThrow("ambiguous multi-incarnation history");

      expect(decryptSpy).toHaveBeenCalledTimes(1);
      expect(useCalls).toBe(0);
      expect(isZeroized(borrowedPlaintext)).toBe(true);
      expect(isZeroized(secretRelease.rawKey)).toBe(true);
    } finally {
      decryptSpy.mockRestore();
      secretRelease.restore();
    }
  });

  test("requires lease and claim authority to cover the configured remote handoff bound", async () => {
    const fixture = await acquireVaultPassphraseFixture();
    const decryptSpy = spyOn(fixture.kms, "decrypt");
    let useCalls = 0;
    const shortAuthorityExpiry = new Date(Date.now() + 5_000);
    await dbWrite
      .update(agentBackupRestoreLeases)
      .set({ expires_at: shortAuthorityExpiry })
      .where(eq(agentBackupRestoreLeases.id, fixture.input.leaseId));
    await dbWrite
      .update(agentBackupRestoreOperations)
      .set({ claim_expires_at: shortAuthorityExpiry })
      .where(eq(agentBackupRestoreOperations.id, fixture.input.restoreOperationId));
    try {
      await expect(
        withAgentBackupRestoreVaultPassphrase(
          fixture.input,
          () => {
            useCalls += 1;
          },
          { kmsClient: fixture.kms, handoffTimeoutMs: 10_000 },
        ),
      ).rejects.toThrow("do not cover the bounded remote handoff plus authority margin");
      expect(decryptSpy).toHaveBeenCalledTimes(0);
      expect(useCalls).toBe(0);
    } finally {
      decryptSpy.mockRestore();
    }
  });

  test("aborts a timed-out remote handoff and zeroizes borrowed secret material", async () => {
    const fixture = await acquireVaultPassphraseFixture(0x4b);
    const secretRelease = captureVaultRawKeyAtRelease();
    let borrowedPassphrase: Uint8Array | null = null;
    let handoffSignal: AbortSignal | null = null;
    const callbackFinished = Promise.withResolvers<void>();
    const startedAt = Date.now();
    try {
      await expect(
        withAgentBackupRestoreVaultPassphrase(
          fixture.input,
          async (passphrase, signal) => {
            borrowedPassphrase = passphrase;
            handoffSignal = signal;
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            await Bun.sleep(1);
            callbackFinished.resolve();
          },
          { kmsClient: fixture.kms, handoffTimeoutMs: 10 },
        ),
      ).rejects.toMatchObject({ code: "AGENT_VAULT_KEY_HANDOFF_TIMEOUT" });
      await callbackFinished.promise;
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(handoffSignal?.aborted).toBe(true);
      expect(isZeroized(borrowedPassphrase)).toBe(true);
      expect(isZeroized(secretRelease.rawKey)).toBe(true);
    } finally {
      secretRelease.restore();
    }
  });

  test("zeroizes callback passphrases on success and throw while preserving the callback error", async () => {
    const fixture = await acquireVaultPassphraseFixture(0x49);
    let successfulPassphrase: Uint8Array | null = null;

    const result = await withAgentBackupRestoreVaultPassphrase(
      fixture.input,
      (passphrase) => {
        successfulPassphrase = passphrase;
        return Buffer.from(passphrase).toString("ascii");
      },
      { kmsClient: fixture.kms },
    );

    expect(result).toBe("49".repeat(32));
    expect(isZeroized(successfulPassphrase)).toBe(true);

    const callbackError = new Error("vault restore callback failed");
    let failedPassphrase: Uint8Array | null = null;
    let thrown: unknown;
    try {
      await withAgentBackupRestoreVaultPassphrase(
        fixture.input,
        (passphrase) => {
          failedPassphrase = passphrase;
          throw callbackError;
        },
        { kmsClient: fixture.kms },
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(callbackError);
    expect(isZeroized(failedPassphrase)).toBe(true);
  });
});
