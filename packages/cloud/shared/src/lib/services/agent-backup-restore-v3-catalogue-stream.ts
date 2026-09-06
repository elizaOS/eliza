/**
 * Connects PRIMARY catalogue source authority to the existing exact stream.
 * Object keys and provider generations come only from the locked source loader;
 * callers supply trusted storage/KMS/staging capabilities, never an inventory.
 * This is private coordinator data, not an API DTO or a boot/routing grant.
 */

import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  AgentBackupRestoreV3SourceAuthorityObjectSchema,
  canonicalizeAgentBackupRestoreV3SourceAuthority,
  parseAgentBackupRestoreV3AuthorityFence,
  parseAgentBackupRestoreV3SourceAuthority,
} from "@elizaos/shared";
import {
  type AgentBackupRestoreSourceV3,
  type AgentBackupRestoreSourceV3Input,
  loadAgentBackupRestoreSourceV3,
} from "../../db/repositories/agent-backup-restore";
import { assertAgentBackupRestoreV3OperationControl } from "../../db/repositories/agent-backup-restore-v3-candidate-database-control";
import {
  type ExactObjectStorageBackend,
  getExactObjectAtBackend,
  ObjectLocatorReceipt,
} from "../storage/object-store";
import {
  type AgentBackupRestoreV3PreparedSource,
  type StreamAgentBackupRestoreV3Input,
  type StreamAgentBackupRestoreV3Result,
  streamAgentBackupRestoreV3,
} from "./agent-backup-restore-v3-stream";

const fingerprint = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const componentNames: readonly string[] = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS;

function projectSource(
  input: Readonly<AgentBackupRestoreSourceV3Input>,
  loaded: AgentBackupRestoreSourceV3,
): AgentBackupRestoreV3PreparedSource {
  const objects = loaded.objects.map((row) => {
    const authority = AgentBackupRestoreV3SourceAuthorityObjectSchema.parse({
      objectId: row.id,
      componentIndex: componentNames.indexOf(row.component),
      componentName: row.component,
      chunkIndex: row.chunk_index,
      copyRole: row.copy_role,
      contentHmacSha256: row.content_hmac_sha256,
      catalog: {
        transport: row.transport,
        provider: row.provider,
        endpointIdentityFingerprint: row.endpoint_identity_fingerprint,
        endpointAliasFingerprint: fingerprint(row.endpoint_alias),
        bucketFingerprint: fingerprint(row.bucket),
        regionFingerprint: fingerprint(row.region),
        keyFingerprint: `sha256:${row.key_fingerprint}`,
        providerVersionId: row.provider_version_id,
        providerEtag: row.provider_etag,
        providerChecksum: row.provider_checksum,
        uploadReceiptDigest: row.upload_receipt_digest,
        ciphertextSha256: row.ciphertext_sha256,
        sizeBytes: row.size_bytes,
      },
    });
    const catalog = authority.catalog;
    const version =
      catalog.providerVersionId !== null
        ? { version: catalog.providerVersionId, versionSource: "provider" as const }
        : catalog.providerEtag !== null
          ? { version: catalog.providerEtag, versionSource: "etag" as const }
          : catalog.providerChecksum !== null
            ? {
                version: catalog.providerChecksum.slice("sha256:base64:".length),
                versionSource: "checksum" as const,
              }
            : null;
    if (version === null)
      throw new ElizaError("Restore catalogue object has no exact provider generation", {
        code: "AGENT_BACKUP_RESTORE_V3_CATALOGUE_GENERATION_MISSING",
      });
    return Object.freeze({
      authority,
      locator: Object.freeze({
        key: row.object_key,
        receipt: new ObjectLocatorReceipt({
          transport: row.transport === "worker-r2" ? "worker-r2-binding" : "s3-compatible",
          provider: row.provider === "cloudflare-r2" ? "r2" : "s3",
          endpointAlias: row.endpoint_alias,
          backendIdentityFingerprint: row.endpoint_identity_fingerprint,
          bucket: row.bucket,
          region: row.region,
          keyFingerprint: authority.catalog.keyFingerprint,
          ...version,
        }),
      }),
    });
  });
  return Object.freeze({
    manifest: loaded.manifest,
    authority: parseAgentBackupRestoreV3AuthorityFence({
      ...input,
      leaseExpiresAtEpochMs: loaded.lease.expires_at.getTime(),
    }),
    sourceAuthority: parseAgentBackupRestoreV3SourceAuthority({
      derivation: AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
      organizationId: input.organizationId,
      agentId: input.agentId,
      backupId: input.backupId,
      operationId: input.operationId,
      sourceActivationGeneration: input.sourceActivationGeneration,
      sourceLifecycleRevision: input.sourceLifecycleRevision,
      expectedManifestSha256: input.expectedManifestSha256,
      copyRole: input.copyRole,
      catalogEpoch: input.catalogEpoch,
      objects: objects.map((object) => object.authority),
    }),
    operationKeyBundle: loaded.operationKeyBundle,
    objects: Object.freeze(objects),
  });
}

/** Stream only the exact catalogue-selected copy into explicitly supplied isolated staging. */
export async function streamAgentBackupRestoreV3FromCatalogue(
  input: Readonly<
    Omit<
      StreamAgentBackupRestoreV3Input,
      "source" | "openExactObject" | "revalidateAuthority" | "now"
    > & {
      enabled: boolean;
      source: Readonly<AgentBackupRestoreSourceV3Input>;
      backend: ExactObjectStorageBackend;
    }
  >,
): Promise<StreamAgentBackupRestoreV3Result | Readonly<{ status: "disabled" }>> {
  if (input.enabled !== true) return Object.freeze({ status: "disabled" });
  const { source: sourceInput, backend: backendInput } = input;
  const streamInput = Object.freeze({
    keyBundle: input.keyBundle,
    candidateSealAuthority: input.candidateSealAuthority,
    isolatedCandidateStaging: input.isolatedCandidateStaging,
    signal: input.signal,
    deadlineEpochMs: input.deadlineEpochMs,
    reportDetachedFailure: input.reportDetachedFailure,
  });
  const sourceIdentity = Object.freeze({ ...sourceInput });
  const backend = Object.freeze({
    ...backendInput,
    locator: Object.freeze({ ...backendInput.locator }),
  });
  const control = Object.freeze({
    signal: streamInput.signal,
    deadlineEpochMs: streamInput.deadlineEpochMs,
  });
  assertAgentBackupRestoreV3OperationControl(control, "Catalogue restore stream");
  const source = projectSource(
    sourceIdentity,
    await loadAgentBackupRestoreSourceV3(sourceIdentity, control),
  );
  const canonical = canonicalizeAgentBackupRestoreV3SourceAuthority(source.sourceAuthority);
  return streamAgentBackupRestoreV3({
    ...streamInput,
    source,
    openExactObject: (object, readControl) =>
      getExactObjectAtBackend({
        backend,
        input: {
          locator: object.locator,
          expectedSize: object.authority.catalog.sizeBytes,
          expectedCipherSha256: object.authority.catalog.ciphertextSha256,
          signal: readControl.signal,
          deadline: new Date(readControl.deadlineEpochMs),
        },
      }),
    revalidateAuthority: async (_expected, readControl) => {
      const current = projectSource(
        sourceIdentity,
        await loadAgentBackupRestoreSourceV3(sourceIdentity, readControl),
      );
      if (canonicalizeAgentBackupRestoreV3SourceAuthority(current.sourceAuthority) !== canonical)
        throw new ElizaError("Restore catalogue object generation changed during streaming", {
          code: "AGENT_BACKUP_RESTORE_V3_CATALOGUE_SOURCE_CHANGED",
        });
      return Object.freeze({ current: true as const, authority: current.authority });
    },
  });
}
