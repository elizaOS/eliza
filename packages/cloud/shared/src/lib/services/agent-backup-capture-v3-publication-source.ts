/**
 * Concrete bridge from one authenticated manifest-v3 capture spool to the
 * manifest-agnostic primary publication executor. Every catalogue and spool
 * authority is re-derived before a filesystem lock is returned to callers.
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ElizaError } from "@elizaos/core/edge";
import {
  AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
  AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
  AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION,
  type AgentBackupManifestV3,
  type AgentBackupManifestV3Draft,
  canonicalizeAgentBackupManifestV3,
  canonicalizeAgentBackupOperationKeyBundleContext,
  computeAgentBackupManifestV3Digest,
} from "@elizaos/shared";
import type {
  AgentBackupOperationClaim,
  AgentBackupOperationExecution,
} from "../../db/repositories/agent-backup-catalog";
import type { StoredAgentSandboxBackup } from "../../db/schemas/agent-sandboxes";
import { MAX_IMMUTABLE_SINGLE_PUT_BYTES } from "../storage/object-store";
import {
  type AgentBackupCaptureV3CatalogManifest,
  type AgentBackupCaptureV3ManifestAuthority,
  canonicalAgentBackupCaptureV3CatalogManifestBytes,
  deriveAgentBackupCaptureV3SpoolAuthorityDigests,
  loadAgentBackupCaptureV3SealedArtifacts,
} from "./agent-backup-capture-v2-pipeline";
import {
  AgentBackupCaptureV3Spool,
  type AgentBackupCaptureV3SpoolChunk,
  type AgentBackupCaptureV3SpoolConfig,
} from "./agent-backup-capture-v2-spool";
import type {
  AgentBackupCapturedPublicationChunk,
  AgentBackupCapturedPublicationSource,
  ResolveAgentBackupCapturedPublicationSource,
} from "./agent-backup-publication-executor";

const PUBLICATION_SOURCE_STATES = ["captured", "uploading", "primary_uploaded"] as const;

export interface AgentBackupCaptureV3SpoolAuthority {
  organizationId: string;
  agentId: string;
  backupId: string;
  operationId: string;
  activationGeneration: string;
  lifecycleRevision: string;
  manifestDigest: string;
  objectInventoryDigest: string;
  requestSha256: string;
  authoritySha256: string;
}

export interface AgentBackupCaptureV3PublicationSourceConfig {
  spool: Readonly<AgentBackupCaptureV3SpoolConfig>;
  now?: () => number;
}

function sourceError(code: string, message: string, cause?: unknown): never {
  throw new ElizaError(message, {
    code,
    cause,
    severity: "fatal",
  });
}

function parseCanonicalDraft(value: string | null): AgentBackupManifestV3Draft {
  if (!value) {
    sourceError(
      "AGENT_BACKUP_V3_PUBLICATION_AUTHORITY_INCOMPLETE",
      "Catalogue has no canonical manifest-v3 draft",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    sourceError(
      "AGENT_BACKUP_V3_PUBLICATION_AUTHORITY_INVALID",
      "Catalogue manifest-v3 draft is not valid JSON",
      cause,
    );
  }
  let canonical: string;
  try {
    canonical = canonicalizeAgentBackupManifestV3(parsed as AgentBackupManifestV3Draft);
  } catch (cause) {
    sourceError(
      "AGENT_BACKUP_V3_PUBLICATION_AUTHORITY_INVALID",
      "Catalogue manifest-v3 draft is invalid",
      cause,
    );
  }
  if (canonical !== value) {
    sourceError(
      "AGENT_BACKUP_V3_PUBLICATION_AUTHORITY_INVALID",
      "Catalogue manifest-v3 draft is not canonical",
    );
  }
  return parsed as AgentBackupManifestV3Draft;
}

function manifestAuthority(
  draft: AgentBackupManifestV3Draft,
): AgentBackupCaptureV3ManifestAuthority {
  return {
    createdAt: draft.createdAt,
    organizationId: draft.identity.organizationId,
    source: draft.source,
    runtime: draft.runtime,
    chain: draft.chain,
    watermarks: draft.watermarks,
    kms: draft.encryption.kms,
    vaultKeyAuthority: draft.vaultKeyAuthority,
  };
}

function assertExecutionAuthority(params: {
  claim: Readonly<AgentBackupOperationClaim>;
  execution: Readonly<AgentBackupOperationExecution>;
  now: number;
}): void {
  const backup = params.claim.backup;
  if (
    params.execution.ownerId !== params.claim.ownerId ||
    params.execution.generation !== params.claim.generation ||
    backup.catalog_lease_owner !== params.execution.ownerId ||
    backup.catalog_lease_generation !== params.execution.generation ||
    !(backup.catalog_lease_expires_at instanceof Date) ||
    !Number.isFinite(backup.catalog_lease_expires_at.getTime()) ||
    backup.catalog_lease_expires_at.getTime() <= params.now
  ) {
    sourceError(
      "AGENT_BACKUP_V3_PUBLICATION_EXECUTION_STALE",
      "Capture spool publication requires the exact live catalogue execution",
    );
  }
}

function assertManifestIdentity(params: {
  backup: Readonly<StoredAgentSandboxBackup>;
  draft: AgentBackupManifestV3Draft;
}): void {
  const backup = params.backup;
  const draft = params.draft;
  const expectedSourceProvider =
    draft.source.kind === "robot" ? "operator-onboarded" : "hetzner-cloud";
  if (
    backup.catalog_version !== 2 ||
    backup.manifest_version !== AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION ||
    !backup.catalog_organization_id ||
    !backup.catalog_agent_id ||
    !backup.backup_operation_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null ||
    backup.manifest_digest === null ||
    backup.object_inventory_digest === null ||
    backup.vault_key_generation_id === null ||
    backup.vault_key_authority_receipt_digest === null ||
    draft.operationId !== backup.backup_operation_id ||
    draft.identity.organizationId !== backup.catalog_organization_id ||
    draft.identity.agentId !== backup.catalog_agent_id ||
    draft.identity.activationGeneration !== backup.lifecycle_generation ||
    draft.identity.lifecycleRevision !== backup.lifecycle_revision.toString() ||
    draft.vaultKeyAuthority.generationId !== backup.vault_key_generation_id ||
    draft.vaultKeyAuthority.receiptDigest !== backup.vault_key_authority_receipt_digest ||
    draft.source.provider !== "hetzner" ||
    backup.source_provider !== expectedSourceProvider ||
    draft.source.nodeRecordId !== backup.source_node_record_id ||
    draft.source.nodeId !== backup.source_node_id ||
    draft.source.nodeIncarnation !== backup.source_node_incarnation ||
    draft.source.containerId !== backup.source_container_id ||
    (draft.source.kind === "cloud" ? draft.source.providerServerId : null) !==
      backup.source_provider_server_id ||
    !(backup.created_at instanceof Date) ||
    draft.createdAt !== backup.created_at.toISOString()
  ) {
    sourceError(
      "AGENT_BACKUP_V3_PUBLICATION_AUTHORITY_MISMATCH",
      "Catalogue manifest-v3 identity differs from the owned backup operation",
    );
  }
}

/**
 * Re-derive the immutable spool locator from one authoritative catalogue row.
 * Cleanup reconciliation uses the same derivation as publication; neither
 * caller may supply request or manifest-authority digests independently.
 */
export async function deriveAgentBackupCaptureV3SpoolAuthorityFromCatalogBackup(
  backup: Readonly<StoredAgentSandboxBackup>,
): Promise<AgentBackupCaptureV3SpoolAuthority> {
  const draft = parseCanonicalDraft(backup.manifest_canonical_draft);
  assertManifestIdentity({ backup, draft });
  const computedManifestDigest = await computeAgentBackupManifestV3Digest(draft);
  if (
    computedManifestDigest !== backup.manifest_digest ||
    !backup.object_inventory_digest ||
    !backup.catalog_organization_id ||
    !backup.catalog_agent_id ||
    !backup.backup_operation_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null
  ) {
    sourceError(
      "AGENT_BACKUP_V3_PUBLICATION_AUTHORITY_MISMATCH",
      "Catalogue manifest digest differs from its canonical draft",
    );
  }
  const digests = deriveAgentBackupCaptureV3SpoolAuthorityDigests({
    request: {
      format: AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT,
      schemaVersion: AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION,
      operationId: draft.operationId,
      agentId: draft.identity.agentId,
      activationGeneration: draft.identity.activationGeneration,
      lifecycleRevision: draft.identity.lifecycleRevision,
    },
    authority: manifestAuthority(draft),
  });
  return Object.freeze({
    organizationId: backup.catalog_organization_id,
    agentId: backup.catalog_agent_id,
    backupId: backup.id,
    operationId: backup.backup_operation_id,
    activationGeneration: backup.lifecycle_generation,
    lifecycleRevision: backup.lifecycle_revision.toString(),
    manifestDigest: computedManifestDigest,
    objectInventoryDigest: backup.object_inventory_digest,
    ...digests,
  });
}

function assertCatalogManifest(params: {
  claim: Readonly<AgentBackupOperationClaim>;
  manifest: AgentBackupManifestV3;
  catalog: AgentBackupCaptureV3CatalogManifest;
}): void {
  const backup = params.claim.backup;
  const bundle = params.manifest.encryption.operationKeyBundle;
  const context = canonicalizeAgentBackupOperationKeyBundleContext({
    organizationId: params.manifest.identity.organizationId,
    agentId: params.manifest.identity.agentId,
    activationGeneration: params.manifest.identity.activationGeneration,
    lifecycleRevision: params.manifest.identity.lifecycleRevision,
    operationId: params.manifest.operationId,
    keyBundleGenerationId: bundle.generationId,
    sourceKind: params.manifest.source.kind,
    sourceProvider: params.manifest.source.provider,
    kmsProvider: params.manifest.encryption.kms.provider,
    keyId: params.manifest.encryption.kms.keyId,
    keyVersion: params.manifest.encryption.kms.keyVersion,
  });
  if (
    params.manifest.encryption.kms.provider !== "steward" ||
    params.catalog.canonicalManifestDraft !== backup.manifest_canonical_draft ||
    params.catalog.format !== backup.manifest_format ||
    params.catalog.version !== backup.manifest_version ||
    params.catalog.digest !== backup.manifest_digest ||
    params.catalog.objectCount !== backup.manifest_object_count ||
    params.catalog.objectInventoryDigest !== backup.object_inventory_digest ||
    params.catalog.imageDigest !== backup.image_digest ||
    params.catalog.databaseSchemaVersion !== backup.database_schema_version ||
    params.catalog.pluginSetDigest !== backup.plugin_set_digest ||
    params.catalog.watermarkDigest !== backup.watermark_digest ||
    params.catalog.rawSizeBytes !== backup.raw_size_bytes ||
    params.catalog.compressedSizeBytes !== backup.compressed_size_bytes ||
    params.catalog.encryptedSizeBytes !== backup.encrypted_size_bytes ||
    params.catalog.kmsKeyId !== backup.kms_key_id ||
    params.catalog.kmsKeyVersion !== backup.kms_key_version ||
    params.catalog.wrappedKeyBundleGenerationId !== backup.operation_key_bundle_generation_id ||
    bundle.format !== backup.operation_key_bundle_format ||
    bundle.wrapped.ref !== backup.operation_key_bundle_ref ||
    params.catalog.wrappedKeyBundleCiphertextBase64 !==
      backup.operation_key_bundle_ciphertext_base64 ||
    params.catalog.wrappedKeyBundleSha256 !== backup.operation_key_bundle_sha256 ||
    bundle.wrapped.bytes !== backup.operation_key_bundle_size_bytes ||
    context !== backup.operation_key_bundle_context ||
    bundle.wrapped.contextDerivation !== backup.operation_key_bundle_context_derivation ||
    bundle.wrapped.localReceiptDerivation !==
      backup.operation_key_bundle_local_receipt_derivation ||
    params.catalog.wrappedKeyBundleLocalReceiptDigest !==
      backup.operation_key_bundle_local_receipt_digest ||
    params.catalog.vaultKeyGenerationId !== backup.vault_key_generation_id ||
    params.catalog.vaultKeyAuthorityReceiptDigest !== backup.vault_key_authority_receipt_digest ||
    params.manifest.vaultKeyAuthority.generationId !== backup.vault_key_generation_id ||
    params.manifest.vaultKeyAuthority.receiptDigest !== backup.vault_key_authority_receipt_digest ||
    backup.wrapped_dek_ref !== null ||
    backup.wrapped_dek_ciphertext_base64 !== null ||
    backup.wrapped_dek_sha256 !== null ||
    backup.wrapped_dek_size_bytes !== null ||
    backup.wrapped_dek_receipt_digest !== null
  ) {
    sourceError(
      "AGENT_BACKUP_V3_PUBLICATION_CATALOG_MISMATCH",
      "Durable capture spool differs from catalogue manifest-v3 authority",
    );
  }
}

function publicationChunk(
  chunk: AgentBackupCaptureV3SpoolChunk,
): AgentBackupCapturedPublicationChunk {
  return Object.freeze({
    component: chunk.component,
    chunkIndex: chunk.index,
    contentHmacSha256: chunk.contentHmacSha256,
    ciphertextSha256: chunk.ciphertextSha256,
    sizeBytes: chunk.encryptedBytes,
  });
}

function publicationChunkKey(
  chunk: Pick<AgentBackupCapturedPublicationChunk, "component" | "chunkIndex">,
): string {
  return `${chunk.component}:${chunk.chunkIndex}`;
}

class CaptureV3PublicationSource implements AgentBackupCapturedPublicationSource {
  readonly chunks: readonly AgentBackupCapturedPublicationChunk[];
  private readonly spoolChunks = new Map<string, AgentBackupCaptureV3SpoolChunk>();

  constructor(
    readonly organizationId: string,
    readonly agentId: string,
    readonly backupId: string,
    readonly operationId: string,
    readonly manifestDigest: string,
    readonly objectInventoryDigest: string,
    private readonly spool: AgentBackupCaptureV3Spool,
  ) {
    this.chunks = Object.freeze(
      spool.chunks.map((chunk) => {
        this.spoolChunks.set(
          publicationChunkKey({ component: chunk.component, chunkIndex: chunk.index }),
          chunk,
        );
        return publicationChunk(chunk);
      }),
    );
  }

  async beginPrimaryPublication(): Promise<void> {
    await this.spool.markPublishing();
  }

  async readCiphertextChunk(
    chunk: Readonly<AgentBackupCapturedPublicationChunk>,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    const stored = this.spoolChunks.get(publicationChunkKey(chunk));
    if (
      !stored ||
      chunk.contentHmacSha256 !== stored.contentHmacSha256 ||
      chunk.ciphertextSha256 !== stored.ciphertextSha256 ||
      chunk.sizeBytes !== stored.encryptedBytes ||
      stored.encryptedBytes > MAX_IMMUTABLE_SINGLE_PUT_BYTES
    ) {
      sourceError(
        "AGENT_BACKUP_V3_PUBLICATION_CHUNK_MISMATCH",
        "Requested publication chunk differs from the sealed spool inventory",
      );
    }
    const bytes = await this.spool.readCiphertextChunk(stored);
    if (signal?.aborted) {
      bytes.fill(0);
      signal.throwIfAborted();
    }
    return bytes;
  }

  async markPrimaryChunkUploaded(
    chunk: Readonly<AgentBackupCapturedPublicationChunk>,
  ): Promise<void> {
    const stored = this.spoolChunks.get(publicationChunkKey(chunk));
    if (
      !stored ||
      chunk.contentHmacSha256 !== stored.contentHmacSha256 ||
      chunk.ciphertextSha256 !== stored.ciphertextSha256 ||
      chunk.sizeBytes !== stored.encryptedBytes
    ) {
      sourceError(
        "AGENT_BACKUP_V3_PUBLICATION_CHUNK_MISMATCH",
        "Publication receipt differs from the sealed spool inventory",
      );
    }
    await this.spool.markChunkUploaded(stored);
  }

  async markPrimaryPublished(): Promise<void> {
    await this.spool.markPublished();
  }

  async close(): Promise<void> {
    await this.spool.close();
  }
}

/**
 * Resolve and lock an exact capture spool for primary publication. Secondary
 * replication never calls this resolver, and closing the returned source only
 * releases its lock.
 */
export function createAgentBackupCaptureV3PublicationSourceResolver(
  config: Readonly<AgentBackupCaptureV3PublicationSourceConfig>,
): ResolveAgentBackupCapturedPublicationSource {
  const now = config.now ?? Date.now;
  return async ({ claim, execution, signal }) => {
    signal?.throwIfAborted();
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
      sourceError(
        "AGENT_BACKUP_V3_PUBLICATION_CLOCK_INVALID",
        "Publication resolver clock is invalid",
      );
    }
    assertExecutionAuthority({ claim, execution, now: nowMs });
    if (
      !PUBLICATION_SOURCE_STATES.includes(
        claim.backup.catalog_state as (typeof PUBLICATION_SOURCE_STATES)[number],
      )
    ) {
      sourceError(
        "AGENT_BACKUP_V3_PUBLICATION_AUTHORITY_MISMATCH",
        "Catalogue operation is not in a primary publication state",
      );
    }
    const draft = parseCanonicalDraft(claim.backup.manifest_canonical_draft);
    const spoolAuthority = await deriveAgentBackupCaptureV3SpoolAuthorityFromCatalogBackup(
      claim.backup,
    );
    const spool = await AgentBackupCaptureV3Spool.openExisting(config.spool, {
      operationId: draft.operationId,
      executionToken: execution.generation,
      requestSha256: spoolAuthority.requestSha256,
      authoritySha256: spoolAuthority.authoritySha256,
    });
    if (!spool) {
      sourceError(
        "AGENT_BACKUP_V3_PUBLICATION_HANDOFF_MISSING",
        "Capture spool is absent; publication cannot recreate captured authority",
      );
    }
    let failure: unknown;
    try {
      const artifacts = await loadAgentBackupCaptureV3SealedArtifacts(spool);
      try {
        if (!isDeepStrictEqual(artifacts.manifest.source, draft.source)) {
          sourceError(
            "AGENT_BACKUP_V3_PUBLICATION_AUTHORITY_MISMATCH",
            "Sealed spool source differs from catalogue authority",
          );
        }
        assertCatalogManifest({
          claim,
          manifest: artifacts.manifest,
          catalog: artifacts.catalogManifest,
        });
        if (!spool.recordCaptured) {
          signal?.throwIfAborted();
          const catalogBytes = canonicalAgentBackupCaptureV3CatalogManifestBytes(
            artifacts.catalogManifest,
          );
          await spool.markRecordCaptured(catalogBytes, {
            bytes: catalogBytes.byteLength,
            sha256: createHash("sha256").update(catalogBytes).digest("hex"),
          });
        }
      } finally {
        artifacts.wrappedKeyBundle.fill(0);
      }
      signal?.throwIfAborted();
      return new CaptureV3PublicationSource(
        draft.identity.organizationId,
        draft.identity.agentId,
        claim.backup.id,
        draft.operationId,
        claim.backup.manifest_digest as string,
        claim.backup.object_inventory_digest as string,
        spool,
      );
    } catch (cause) {
      failure = cause;
    }
    try {
      await spool.close();
    } catch (closeCause) {
      throw new AggregateError(
        [failure, closeCause],
        "Capture-v3 publication source validation and close both failed",
      );
    }
    throw failure;
  };
}
