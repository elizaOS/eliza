/**
 * Primary-DB authority for reading one manifest-v3 backup under an exact,
 * live restore lease. Callers never supply object locators or an inventory.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  type AgentBackupManifestV3,
  type AgentBackupManifestV3Draft,
  canonicalizeAgentBackupManifestV3,
  canonicalizeAgentBackupOperationKeyBundleContext,
  parseAgentBackupManifestV3,
} from "@elizaos/shared";
import { and, eq } from "drizzle-orm";
import {
  requireBoundedIdentity,
  requireSha256Hex,
} from "../../lib/services/agent-backup-catalog-state";
import { isValidUUID } from "../../lib/utils/validation";
import { dbWrite } from "../helpers";
import {
  type AgentBackupCopyRole,
  type AgentBackupObject,
  type AgentBackupRestoreLease,
  agentBackupObjects,
  agentBackupRestoreLeases,
} from "../schemas/agent-backup-catalog";
import { agentSandboxBackups } from "../schemas/agent-sandboxes";
import {
  agentVaultKeyBackupBindings,
  agentVaultKeyGenerations,
} from "../schemas/agent-vault-key-authority";
import {
  AgentBackupCatalogConflictError,
  agentBackupObjectInventoryDigest,
  lockAgentBackupCatalogAuthority,
} from "./agent-backup-catalog";
import { hasAgentBackupRestoreAuthority } from "./agent-backup-restore-authority";
import { readPostLockDatabaseNow } from "./primary-database-clock";

const UINT64_MAX = 18_446_744_073_709_551_615n;

function requireUuid(value: string, field: string): string {
  if (!isValidUUID(value) || value !== value.toLowerCase()) {
    throw new Error(`${field} must be a canonical lowercase UUID`);
  }
  return value;
}

function requireCanonicalUint64(value: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${field} must be a canonical unsigned decimal integer`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) throw new Error(`${field} must fit uint64`);
  return parsed;
}

function parseCanonicalBase64(value: string, expectedBytes: number): Uint8Array {
  if (value.length === 0 || value.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new AgentBackupCatalogConflictError(
      "Restore source operation key bundle is not canonical base64",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new AgentBackupCatalogConflictError(
      "Restore source operation key bundle has an invalid encoded length",
    );
  }
  try {
    return Uint8Array.from(decoded);
  } finally {
    decoded.fill(0);
  }
}

function manifestWithDigest(canonicalDraft: string, manifestSha256: string): unknown {
  let draft: unknown;
  try {
    draft = JSON.parse(canonicalDraft);
  } catch (cause) {
    throw new AgentBackupCatalogConflictError("Restore source manifest is not valid JSON", {
      cause,
    });
  }
  if (typeof draft !== "object" || draft === null || Array.isArray(draft)) {
    throw new AgentBackupCatalogConflictError("Restore source manifest draft is not an object");
  }
  const integrity = (draft as { integrity?: unknown }).integrity;
  if (typeof integrity !== "object" || integrity === null || Array.isArray(integrity)) {
    throw new AgentBackupCatalogConflictError(
      "Restore source manifest integrity authority is missing",
    );
  }
  return {
    ...draft,
    integrity: { ...integrity, manifestSha256 },
  };
}

function frozenManifest(manifest: AgentBackupManifestV3): AgentBackupManifestV3 {
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) visit(child);
    Object.freeze(value);
  };
  visit(manifest);
  return manifest;
}

export interface AgentBackupRestoreSourceV3Input {
  organizationId: string;
  agentId: string;
  backupId: string;
  operationId: string;
  sourceActivationGeneration: string;
  sourceLifecycleRevision: string;
  expectedManifestSha256: string;
  restoreAttemptId: string;
  leaseId: string;
  ownerId: string;
  fencingToken: string;
  catalogEpoch: string;
  copyRole: AgentBackupCopyRole;
}

export interface AgentBackupRestoreOperationKeyBundleV3 {
  readonly generationId: string;
  readonly format: typeof AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT;
  readonly ref: string;
  readonly keyId: string;
  readonly keyVersion: number;
  readonly canonicalContext: string;
  readonly ciphertextBase64: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly localReceiptDigest: string;
}

export interface AgentBackupRestoreSourceV3 {
  readonly manifest: AgentBackupManifestV3;
  readonly canonicalManifestDraft: string;
  readonly operationKeyBundle: Readonly<AgentBackupRestoreOperationKeyBundleV3>;
  readonly vaultKeyAuthority: Readonly<{
    generationId: string;
    authorityReceiptDigest: string;
  }>;
  readonly objects: readonly Readonly<AgentBackupObject>[];
  readonly lease: Readonly<AgentBackupRestoreLease>;
  readonly copyRole: AgentBackupCopyRole;
}

function validateInput(input: Readonly<AgentBackupRestoreSourceV3Input>): {
  sourceLifecycleRevision: bigint;
  catalogEpoch: bigint;
} {
  requireUuid(input.organizationId, "organizationId");
  requireUuid(input.agentId, "agentId");
  requireUuid(input.backupId, "backupId");
  requireUuid(input.operationId, "operationId");
  requireUuid(input.sourceActivationGeneration, "sourceActivationGeneration");
  requireSha256Hex(input.expectedManifestSha256, "expectedManifestSha256");
  requireUuid(input.restoreAttemptId, "restoreAttemptId");
  requireUuid(input.leaseId, "leaseId");
  requireBoundedIdentity(input.ownerId, "ownerId");
  requireUuid(input.fencingToken, "fencingToken");
  if (input.copyRole !== "primary" && input.copyRole !== "secondary") {
    throw new Error("copyRole must be primary or secondary");
  }
  return {
    sourceLifecycleRevision: requireCanonicalUint64(
      input.sourceLifecycleRevision,
      "sourceLifecycleRevision",
    ),
    catalogEpoch: requireCanonicalUint64(input.catalogEpoch, "catalogEpoch"),
  };
}

/**
 * Return an immutable, catalogue-derived restore source. The transaction uses
 * the primary DB and rejects an expired/released lease, a changed catalogue
 * epoch, a non-v3 manifest, or incomplete copy coverage.
 */
export async function loadAgentBackupRestoreSourceV3(
  input: Readonly<AgentBackupRestoreSourceV3Input>,
): Promise<AgentBackupRestoreSourceV3> {
  const validated = validateInput(input);
  return dbWrite.transaction(async (tx) => {
    const [backup] = await tx
      .select()
      .from(agentSandboxBackups)
      .where(
        and(
          eq(agentSandboxBackups.id, input.backupId),
          eq(agentSandboxBackups.catalog_organization_id, input.organizationId),
          eq(agentSandboxBackups.catalog_agent_id, input.agentId),
          eq(agentSandboxBackups.backup_operation_id, input.operationId),
          eq(agentSandboxBackups.lifecycle_generation, input.sourceActivationGeneration),
          eq(agentSandboxBackups.lifecycle_revision, validated.sourceLifecycleRevision),
          eq(agentSandboxBackups.manifest_digest, input.expectedManifestSha256),
        ),
      )
      .for("update")
      .limit(1);
    if (!backup || !hasAgentBackupRestoreAuthority(backup.catalog_state)) {
      throw new AgentBackupCatalogConflictError(
        "Restore source backup is absent or no longer restorable",
      );
    }
    if (
      backup.manifest_version !== 3 ||
      !backup.manifest_canonical_draft ||
      !backup.manifest_object_count ||
      !backup.object_inventory_digest ||
      !backup.operation_key_bundle_generation_id ||
      !backup.operation_key_bundle_format ||
      !backup.operation_key_bundle_ref ||
      !backup.operation_key_bundle_ciphertext_base64 ||
      !backup.operation_key_bundle_sha256 ||
      !backup.operation_key_bundle_size_bytes ||
      !backup.operation_key_bundle_context ||
      !backup.operation_key_bundle_context_derivation ||
      !backup.operation_key_bundle_local_receipt_derivation ||
      !backup.operation_key_bundle_local_receipt_digest ||
      !backup.vault_key_generation_id ||
      !backup.vault_key_authority_receipt_digest ||
      !backup.kms_key_id ||
      !backup.kms_key_version
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore source is missing its complete manifest-v3 authority",
      );
    }

    const authority = await lockAgentBackupCatalogAuthority(
      tx,
      input.organizationId,
      input.agentId,
    );
    if (authority.catalog_revision !== validated.catalogEpoch) {
      throw new AgentBackupCatalogConflictError(
        "Restore source catalogue epoch has been invalidated",
      );
    }
    const [lease] = await tx
      .select()
      .from(agentBackupRestoreLeases)
      .where(
        and(
          eq(agentBackupRestoreLeases.id, input.leaseId),
          eq(agentBackupRestoreLeases.organization_id, input.organizationId),
          eq(agentBackupRestoreLeases.agent_id, input.agentId),
          eq(agentBackupRestoreLeases.backup_id, input.backupId),
          eq(agentBackupRestoreLeases.operation_id, input.operationId),
          eq(agentBackupRestoreLeases.activation_generation, input.sourceActivationGeneration),
          eq(agentBackupRestoreLeases.lifecycle_revision, validated.sourceLifecycleRevision),
          eq(agentBackupRestoreLeases.expected_manifest_sha256, input.expectedManifestSha256),
          eq(agentBackupRestoreLeases.copy_role, input.copyRole),
          eq(agentBackupRestoreLeases.restore_attempt_id, input.restoreAttemptId),
          eq(agentBackupRestoreLeases.owner_id, input.ownerId),
          eq(agentBackupRestoreLeases.generation, input.fencingToken),
          eq(agentBackupRestoreLeases.catalog_epoch, validated.catalogEpoch),
        ),
      )
      .for("update")
      .limit(1);
    const databaseNow = await readPostLockDatabaseNow(tx);
    if (
      !lease ||
      lease.released_at !== null ||
      lease.expires_at.getTime() <= databaseNow.getTime()
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore source lease is absent, expired, released, or fenced",
      );
    }
    const manifestInput = manifestWithDigest(
      backup.manifest_canonical_draft,
      input.expectedManifestSha256,
    );
    let manifest: AgentBackupManifestV3;
    try {
      manifest = await parseAgentBackupManifestV3(manifestInput);
    } catch (cause) {
      throw new AgentBackupCatalogConflictError("Restore source manifest-v3 validation failed", {
        cause,
      });
    }
    const { manifestSha256: _manifestSha256, ...draftIntegrity } = manifest.integrity;
    const canonicalDraft = canonicalizeAgentBackupManifestV3({
      ...manifest,
      integrity: draftIntegrity,
    } as AgentBackupManifestV3Draft);
    if (
      canonicalDraft !== backup.manifest_canonical_draft ||
      manifest.integrity.manifestSha256 !== input.expectedManifestSha256 ||
      manifest.operationId !== input.operationId ||
      manifest.identity.organizationId !== input.organizationId ||
      manifest.identity.agentId !== input.agentId ||
      manifest.identity.activationGeneration !== input.sourceActivationGeneration ||
      manifest.identity.lifecycleRevision !== input.sourceLifecycleRevision ||
      manifest.schemaVersion !== 3 ||
      manifest.encryption.kms.keyId !== backup.kms_key_id ||
      manifest.encryption.kms.keyVersion !== backup.kms_key_version ||
      manifest.vaultKeyAuthority.generationId !== backup.vault_key_generation_id ||
      manifest.vaultKeyAuthority.receiptDigest !== backup.vault_key_authority_receipt_digest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore source manifest-v3 differs from its catalogue authority",
      );
    }

    const bundle = manifest.encryption.operationKeyBundle;
    const expectedContext = canonicalizeAgentBackupOperationKeyBundleContext({
      organizationId: manifest.identity.organizationId,
      agentId: manifest.identity.agentId,
      activationGeneration: manifest.identity.activationGeneration,
      lifecycleRevision: manifest.identity.lifecycleRevision,
      operationId: manifest.operationId,
      keyBundleGenerationId: bundle.generationId,
      sourceKind: manifest.source.kind,
      sourceProvider: manifest.source.provider,
      kmsProvider: manifest.encryption.kms.provider,
      keyId: manifest.encryption.kms.keyId,
      keyVersion: manifest.encryption.kms.keyVersion,
    });
    const wrappedBytes = parseCanonicalBase64(
      backup.operation_key_bundle_ciphertext_base64,
      bundle.wrapped.bytes,
    );
    const wrappedSha256 = createHash("sha256").update(wrappedBytes).digest("hex");
    wrappedBytes.fill(0);
    if (
      backup.operation_key_bundle_generation_id !== bundle.generationId ||
      backup.operation_key_bundle_format !== AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT ||
      backup.operation_key_bundle_format !== bundle.format ||
      backup.operation_key_bundle_ref !== bundle.wrapped.ref ||
      backup.operation_key_bundle_sha256 !== bundle.wrapped.sha256 ||
      wrappedSha256 !== bundle.wrapped.sha256 ||
      backup.operation_key_bundle_size_bytes !== bundle.wrapped.bytes ||
      backup.operation_key_bundle_size_bytes !==
        AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes ||
      backup.operation_key_bundle_context !== expectedContext ||
      backup.operation_key_bundle_context_derivation !==
        AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION ||
      backup.operation_key_bundle_context_derivation !== bundle.wrapped.contextDerivation ||
      backup.operation_key_bundle_local_receipt_derivation !==
        AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION ||
      backup.operation_key_bundle_local_receipt_derivation !==
        bundle.wrapped.localReceiptDerivation ||
      backup.operation_key_bundle_local_receipt_digest !== bundle.wrapped.localReceiptDigest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore source operation key bundle differs from its manifest-v3 authority",
      );
    }

    const [vaultKeyBinding] = await tx
      .select({
        generationId: agentVaultKeyGenerations.generation_id,
        authorityReceiptDigest: agentVaultKeyGenerations.authority_receipt_digest,
      })
      .from(agentVaultKeyBackupBindings)
      .innerJoin(
        agentVaultKeyGenerations,
        and(
          eq(agentVaultKeyGenerations.organization_id, agentVaultKeyBackupBindings.organization_id),
          eq(agentVaultKeyGenerations.agent_id, agentVaultKeyBackupBindings.agent_id),
          eq(
            agentVaultKeyGenerations.generation_id,
            agentVaultKeyBackupBindings.vault_key_generation_id,
          ),
          eq(
            agentVaultKeyGenerations.authority_receipt_digest,
            agentVaultKeyBackupBindings.vault_key_authority_receipt_digest,
          ),
        ),
      )
      .where(
        and(
          eq(agentVaultKeyBackupBindings.organization_id, input.organizationId),
          eq(agentVaultKeyBackupBindings.agent_id, input.agentId),
          eq(agentVaultKeyBackupBindings.backup_id, input.backupId),
          eq(agentVaultKeyBackupBindings.operation_id, input.operationId),
          eq(
            agentVaultKeyBackupBindings.source_activation_generation,
            input.sourceActivationGeneration,
          ),
          eq(
            agentVaultKeyBackupBindings.source_lifecycle_revision,
            validated.sourceLifecycleRevision,
          ),
          eq(agentVaultKeyBackupBindings.manifest_sha256, input.expectedManifestSha256),
          eq(
            agentVaultKeyBackupBindings.vault_key_generation_id,
            manifest.vaultKeyAuthority.generationId,
          ),
          eq(
            agentVaultKeyBackupBindings.vault_key_authority_receipt_digest,
            manifest.vaultKeyAuthority.receiptDigest,
          ),
        ),
      )
      .limit(1);
    if (!vaultKeyBinding) {
      throw new AgentBackupCatalogConflictError(
        "Restore source is missing its exact retained vault-key generation",
      );
    }

    const objects = await tx
      .select()
      .from(agentBackupObjects)
      .where(
        and(
          eq(agentBackupObjects.organization_id, input.organizationId),
          eq(agentBackupObjects.backup_id, input.backupId),
          eq(agentBackupObjects.copy_role, input.copyRole),
          eq(agentBackupObjects.state, "verified"),
        ),
      );
    const bySlot = new Map(
      objects.map((object) => [`${object.component}:${object.chunk_index}`, object]),
    );
    const orderedObjects = manifest.components.flatMap((component) =>
      component.chunks.map((chunk) => {
        const object = bySlot.get(`${component.name}:${chunk.index}`);
        if (
          !object ||
          object.content_hmac_sha256 !== chunk.contentHmacSha256 ||
          object.ciphertext_sha256 !== chunk.sha256 ||
          object.size_bytes !== chunk.encryptedBytes
        ) {
          throw new AgentBackupCatalogConflictError(
            "Restore source object coverage differs from manifest-v3",
          );
        }
        return object;
      }),
    );
    if (
      orderedObjects.length !== backup.manifest_object_count ||
      objects.length !== orderedObjects.length ||
      (await agentBackupObjectInventoryDigest(
        orderedObjects.map((object) => ({
          component: object.component,
          chunkIndex: object.chunk_index,
          contentHmacSha256: object.content_hmac_sha256,
          ciphertextSha256: object.ciphertext_sha256,
          sizeBytes: object.size_bytes,
        })),
      )) !== backup.object_inventory_digest
    ) {
      throw new AgentBackupCatalogConflictError(
        "Restore source copy is incomplete or has a different authenticated inventory",
      );
    }
    const finalDatabaseNow = await readPostLockDatabaseNow(tx);
    if (lease.released_at !== null || lease.expires_at.getTime() <= finalDatabaseNow.getTime()) {
      throw new AgentBackupCatalogConflictError(
        "Restore source lease expired during manifest and inventory validation",
      );
    }

    return Object.freeze({
      manifest: frozenManifest(manifest),
      canonicalManifestDraft: canonicalDraft,
      operationKeyBundle: Object.freeze({
        generationId: bundle.generationId,
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        ref: bundle.wrapped.ref,
        keyId: manifest.encryption.kms.keyId,
        keyVersion: manifest.encryption.kms.keyVersion,
        canonicalContext: expectedContext,
        ciphertextBase64: backup.operation_key_bundle_ciphertext_base64,
        sha256: bundle.wrapped.sha256,
        sizeBytes: bundle.wrapped.bytes,
        localReceiptDigest: bundle.wrapped.localReceiptDigest,
      }),
      vaultKeyAuthority: Object.freeze({
        generationId: vaultKeyBinding.generationId,
        authorityReceiptDigest: vaultKeyBinding.authorityReceiptDigest,
      }),
      objects: Object.freeze(orderedObjects.map((object) => Object.freeze({ ...object }))),
      lease: Object.freeze({ ...lease }),
      copyRole: input.copyRole,
    });
  });
}
