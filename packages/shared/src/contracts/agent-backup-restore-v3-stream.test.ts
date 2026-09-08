/** Exercises the runtime-neutral restore-v3 isolated-candidate contract. */

import { describe, expect, test } from "vitest";
import {
  AGENT_BACKUP_CHUNK_AAD_DERIVATION,
  AGENT_BACKUP_CHUNK_ENVELOPE_V1,
  AGENT_BACKUP_MANIFEST_FORMAT,
  computeAgentBackupChunkAadDigest,
} from "./agent-backup-manifest.js";
import {
  AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION,
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
  type AgentBackupManifestV3,
  type AgentBackupManifestV3Draft,
  createAgentBackupManifestV3,
} from "./agent-backup-manifest-v3.js";
import { AGENT_BACKUP_RECORD_STREAM_V1_FORMAT } from "./agent-backup-record-stream-v1.js";
import {
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
  type AgentBackupRestoreV3AuthorityFence,
  type AgentBackupRestoreV3CandidateReceipt,
  type AgentBackupRestoreV3ExactReadReceiptProof,
  type AgentBackupRestoreV3SourceAuthority,
  canonicalizeAgentBackupRestoreV3AuthorityFence,
  canonicalizeAgentBackupRestoreV3CandidateReceipt,
  canonicalizeAgentBackupRestoreV3CandidateSealAuthorizationRequest,
  canonicalizeAgentBackupRestoreV3ExactReadReceiptProof,
  canonicalizeAgentBackupRestoreV3SourceAuthority,
  computeAgentBackupRestoreV3CandidateReceiptSha256,
  computeAgentBackupRestoreV3CandidateSealAuthorizationRequestSha256,
  computeAgentBackupRestoreV3ExactReadReceiptSha256,
  computeAgentBackupRestoreV3SourceAuthoritySha256,
  createAgentBackupRestoreV3CandidateSealAuthorizationRequest,
  parseAgentBackupRestoreV3AuthorityFence,
  parseAgentBackupRestoreV3CandidateReceipt,
  parseAgentBackupRestoreV3ExactReadReceiptProof,
  parseAgentBackupRestoreV3StagingSession,
  validateAgentBackupRestoreV3CandidateContext,
  validateAgentBackupRestoreV3CandidateSealAuthorization,
} from "./agent-backup-restore-v3-stream.js";

const IDS = Object.freeze({
  organization: "00000000-0000-4000-8000-000000000001",
  agent: "00000000-0000-4000-8000-000000000002",
  backup: "00000000-0000-4000-8000-000000000003",
  operation: "00000000-0000-4000-8000-000000000004",
  activation: "00000000-0000-4000-8000-000000000005",
  restoreAttempt: "00000000-0000-4000-8000-000000000006",
  lease: "00000000-0000-4000-8000-000000000007",
  fencing: "00000000-0000-4000-8000-000000000008",
  keyBundle: "00000000-0000-4000-8000-000000000009",
  authorization: "00000000-0000-4000-8000-00000000000a",
  nodeRecord: "00000000-0000-4000-8000-00000000000b",
  nodeIncarnation: "00000000-0000-4000-8000-00000000000c",
  vaultKey: "00000000-0000-4000-8000-00000000000d",
} as const);
const MANIFEST_SHA256 = "a".repeat(64);
const SOURCE_AUTHORITY_SHA256 = "b".repeat(64);
const CANDIDATE_SHA256 = "c".repeat(64);
const WIRE_COMPONENT_DESCRIPTORS = Object.freeze([
  Object.freeze({
    name: "character",
    format: "runtime-character-json-v1",
    compression: "none",
    contentKind: "opaque",
    consistency: "best-effort",
  }),
  Object.freeze({
    name: "database",
    format: "pglite-data-dir-tar-gzip-v1",
    compression: "gzip",
    contentKind: "opaque",
    consistency: "transactional",
  }),
  Object.freeze({
    name: "media",
    format: "file-set-v1",
    compression: "none",
    contentKind: "file-set",
    consistency: "best-effort",
  }),
  Object.freeze({
    name: "state-files",
    format: "file-set-v1",
    compression: "none",
    contentKind: "file-set",
    consistency: "best-effort",
  }),
  Object.freeze({
    name: "vault",
    format: "file-set-v1",
    compression: "none",
    contentKind: "file-set",
    consistency: "best-effort",
  }),
] as const);

function authority(): AgentBackupRestoreV3AuthorityFence {
  return {
    organizationId: IDS.organization,
    agentId: IDS.agent,
    backupId: IDS.backup,
    operationId: IDS.operation,
    sourceActivationGeneration: IDS.activation,
    sourceLifecycleRevision: "18",
    expectedManifestSha256: MANIFEST_SHA256,
    copyRole: "primary",
    restoreAttemptId: IDS.restoreAttempt,
    leaseId: IDS.lease,
    ownerId: "restore-worker",
    fencingToken: IDS.fencing,
    catalogEpoch: "42",
    leaseExpiresAtEpochMs: 1_800_000_001_000,
  };
}

function candidateReceipt(): AgentBackupRestoreV3CandidateReceipt {
  const components = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map(
    (name, index) => ({
      componentIndex: index,
      componentName: name,
      descriptor: WIRE_COMPONENT_DESCRIPTORS[index],
      dataFrameCount: 1,
      payloadBytes: index + 1,
      payloadSha256: String(index + 1).repeat(64),
      recordStreamContentHmacSha256: String(index + 5).repeat(64),
    }),
  );
  const sourceObjects = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map(
    (name, index) => ({
      componentIndex: index,
      componentName: name,
      chunkIndex: 0,
      copyRole: "primary" as const,
      objectId: `00000000-0000-4000-8000-${String(index + 16).padStart(12, "0")}`,
      exactReadReceiptDerivation:
        AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
      exactReadReceiptSha256: String(index + 2).repeat(64),
      ciphertextSha256: String(index + 3).repeat(64),
      sizeBytes: 100 + index,
    }),
  );
  return {
    format: AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT,
    restoreAttemptId: IDS.restoreAttempt,
    operationId: IDS.operation,
    expectedManifestSha256: MANIFEST_SHA256,
    keyBundleGenerationId: IDS.keyBundle,
    sourceCopyRole: "primary",
    sourceAuthorityDerivation:
      AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
    sourceAuthoritySha256: SOURCE_AUTHORITY_SHA256,
    objectCount: sourceObjects.length,
    stagedPayloadBytes: 15,
    stagedDataRecordCount: 5,
    sourceObjects,
    components,
    authorityRevalidated: true,
  };
}

function exactReadProof(): AgentBackupRestoreV3ExactReadReceiptProof {
  return {
    derivation: AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
    sourceAuthoritySha256: SOURCE_AUTHORITY_SHA256,
    organizationId: IDS.organization,
    backupId: IDS.backup,
    objectId: "00000000-0000-4000-8000-000000000016",
    componentIndex: 0,
    componentName: "character",
    chunkIndex: 0,
    copyRole: "primary",
    catalog: {
      transport: "worker-r2",
      provider: "cloudflare-r2",
      endpointIdentityFingerprint: `sha256:${"d".repeat(64)}`,
      endpointAliasFingerprint: `sha256:${"2".repeat(64)}`,
      bucketFingerprint: `sha256:${"3".repeat(64)}`,
      regionFingerprint: `sha256:${"4".repeat(64)}`,
      keyFingerprint: `sha256:${"e".repeat(64)}`,
      providerVersionId: "provider-version-1",
      providerEtag: null,
      providerChecksum: null,
      uploadReceiptDigest: "f".repeat(64),
      ciphertextSha256: "1".repeat(64),
      sizeBytes: 128,
    },
    completion: {
      transport: "worker-r2-binding",
      provider: "r2",
      backendIdentityFingerprint: `sha256:${"d".repeat(64)}`,
      endpointAliasFingerprint: `sha256:${"2".repeat(64)}`,
      bucketFingerprint: `sha256:${"3".repeat(64)}`,
      regionFingerprint: `sha256:${"4".repeat(64)}`,
      keyFingerprint: `sha256:${"e".repeat(64)}`,
      version: "provider-version-1",
      versionSource: "provider",
      sizeBytes: 128,
      checksumSha256Base64: Buffer.from("1".repeat(64), "hex").toString(
        "base64",
      ),
      ciphertextSha256: "1".repeat(64),
      verifiedComplete: true,
    },
  };
}

function hexDigest(character: string): string {
  return character.repeat(64);
}

async function manifestFixture(): Promise<AgentBackupManifestV3> {
  const identity = {
    organizationId: IDS.organization,
    agentId: IDS.agent,
    activationGeneration: IDS.activation,
    lifecycleRevision: "18",
  } as const;
  const cipherDigests = ["1", "2", "3", "4", "5", "6"];
  let digestIndex = 0;
  const components = await Promise.all(
    AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map(async (name, index) => {
      const contentHmacSha256 = String(index + 5).repeat(64);
      const chunkCount = name === "vault" ? 2 : 1;
      const chunks = await Promise.all(
        Array.from({ length: chunkCount }, async (_, chunkIndex) => {
          const ciphertextSha256 = hexDigest(
            cipherDigests[digestIndex++] ?? "f",
          );
          return {
            index: chunkIndex,
            offsetBytes: chunkIndex,
            plainBytes: 1,
            compressedBytes: 1,
            encryptedBytes:
              1 +
              AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes +
              AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
            contentHmacSha256,
            aadSha256: await computeAgentBackupChunkAadDigest({
              identity,
              operationId: IDS.operation,
              component: {
                name,
                format: AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
                compression: "none",
              },
              chunk: {
                index: chunkIndex,
                offsetBytes: chunkIndex,
                plainBytes: 1,
                compressedBytes: 1,
                contentHmacSha256,
              },
            }),
            sha256: ciphertextSha256,
          };
        }),
      );
      return {
        name,
        format: AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
        compression: "none" as const,
        payloadContentHmacSha256: contentHmacSha256,
        state: {
          kind: "full" as const,
          resultContentHmacSha256: contentHmacSha256,
        },
        totals: {
          plainBytes: chunks.length,
          compressedBytes: chunks.length,
          encryptedBytes: chunks.reduce(
            (total, chunk) => total + chunk.encryptedBytes,
            0,
          ),
          chunkCount: chunks.length,
        },
        chunks,
      };
    }),
  );
  const draft: AgentBackupManifestV3Draft = {
    format: AGENT_BACKUP_MANIFEST_FORMAT,
    schemaVersion: AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION,
    operationId: IDS.operation,
    createdAt: "2026-08-29T00:00:00.000Z",
    identity,
    source: {
      kind: "robot",
      provider: "hetzner",
      nodeRecordId: IDS.nodeRecord,
      nodeIncarnation: IDS.nodeIncarnation,
      nodeId: "robot-restore-source",
      containerId: "container-restore-source",
    },
    runtime: {
      imageDigest: `sha256:${hexDigest("a")}`,
      agentSchemaVersion: "1",
      databaseSchemaVersion: "1",
      plugins: [],
    },
    chain: {
      kind: "full",
      baseOperationId: null,
      parentOperationId: null,
      depth: 0,
    },
    components,
    watermarks: [{ namespace: "database", value: "18" }],
    totals: {
      plainBytes: 6,
      compressedBytes: 6,
      encryptedBytes: components.reduce(
        (total, component) => total + component.totals.encryptedBytes,
        0,
      ),
      chunkCount: 6,
    },
    vaultKeyAuthority: {
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      generationId: IDS.vaultKey,
      receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      receiptDigest: hexDigest("b"),
    },
    encryption: {
      algorithm: "AES-256-GCM",
      chunkEnvelope: AGENT_BACKUP_CHUNK_ENVELOPE_V1.name,
      nonceBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes,
      tagBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
      noncePlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.noncePlacement,
      tagPlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagPlacement,
      aad: { version: 1, derivation: AGENT_BACKUP_CHUNK_AAD_DERIVATION },
      kms: {
        provider: "local",
        keyId: `org:${IDS.organization}/dek/v1`,
        keyVersion: 1,
      },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        generationId: IDS.keyBundle,
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: { ...AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek },
        contentHmac: { ...AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac },
        wrapped: {
          ref: `backup-key-bundle:${IDS.operation}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256: hexDigest("c"),
          localReceiptDerivation:
            AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest: hexDigest("d"),
          contextDerivation:
            AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
    integrity: {
      framedContentHmacSha256: hexDigest("e"),
      contentAddressing: {
        algorithm: "HMAC-SHA-256",
        scope: "operation",
        derivation: AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
        keyBundleFormat: AGENT_BACKUP_OPERATION_KEY_BUNDLE_FORMAT,
        keyOffsetBytes:
          AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
        keyBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes,
      },
    },
  };
  return createAgentBackupManifestV3(draft);
}

async function candidateContextFixture() {
  const manifest = await manifestFixture();
  const exactAuthority = {
    ...authority(),
    expectedManifestSha256: manifest.integrity.manifestSha256,
  };
  let objectIndex = 0;
  const objects = manifest.components.flatMap((component, componentIndex) => {
    const componentName =
      AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[componentIndex];
    if (!componentName)
      throw new Error("Fixture has an extra manifest component");
    return component.chunks.map((chunk) => {
      const index = objectIndex++;
      return {
        objectId: `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
        componentIndex,
        componentName,
        chunkIndex: chunk.index,
        copyRole: "primary" as const,
        contentHmacSha256: chunk.contentHmacSha256,
        catalog: {
          transport: "worker-r2" as const,
          provider: "cloudflare-r2" as const,
          endpointIdentityFingerprint: `sha256:${hexDigest("7")}`,
          endpointAliasFingerprint: `sha256:${hexDigest("4")}`,
          bucketFingerprint: `sha256:${hexDigest("5")}`,
          regionFingerprint: `sha256:${hexDigest("6")}`,
          keyFingerprint: `sha256:${hexDigest(String((index + 8) % 10))}`,
          providerVersionId: `provider-version-${index}`,
          providerEtag: null,
          providerChecksum: null,
          uploadReceiptDigest: hexDigest("8"),
          ciphertextSha256: chunk.sha256,
          sizeBytes: chunk.encryptedBytes,
        },
      };
    });
  });
  const sourceAuthority: AgentBackupRestoreV3SourceAuthority = {
    derivation: AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
    organizationId: IDS.organization,
    agentId: IDS.agent,
    backupId: IDS.backup,
    operationId: IDS.operation,
    sourceActivationGeneration: IDS.activation,
    sourceLifecycleRevision: "18",
    expectedManifestSha256: manifest.integrity.manifestSha256,
    copyRole: "primary",
    catalogEpoch: "42",
    objects,
  };
  const sourceAuthoritySha256 =
    await computeAgentBackupRestoreV3SourceAuthoritySha256(sourceAuthority);
  const exactReadProofs = objects.map((object) => ({
    derivation: AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
    sourceAuthoritySha256,
    organizationId: IDS.organization,
    backupId: IDS.backup,
    objectId: object.objectId,
    componentIndex: object.componentIndex,
    componentName: object.componentName,
    chunkIndex: object.chunkIndex,
    copyRole: object.copyRole,
    catalog: object.catalog,
    completion: {
      transport: "worker-r2-binding" as const,
      provider: "r2" as const,
      backendIdentityFingerprint: object.catalog.endpointIdentityFingerprint,
      endpointAliasFingerprint: object.catalog.endpointAliasFingerprint,
      bucketFingerprint: object.catalog.bucketFingerprint,
      regionFingerprint: object.catalog.regionFingerprint,
      keyFingerprint: object.catalog.keyFingerprint,
      version: object.catalog.providerVersionId,
      versionSource: "provider" as const,
      sizeBytes: object.catalog.sizeBytes,
      checksumSha256Base64: Buffer.from(
        object.catalog.ciphertextSha256,
        "hex",
      ).toString("base64"),
      ciphertextSha256: object.catalog.ciphertextSha256,
      verifiedComplete: true as const,
    },
  }));
  const exactReadDigests = await Promise.all(
    exactReadProofs.map((proof) =>
      computeAgentBackupRestoreV3ExactReadReceiptSha256(proof),
    ),
  );
  const baseReceipt = candidateReceipt();
  const receipt: AgentBackupRestoreV3CandidateReceipt = {
    ...baseReceipt,
    expectedManifestSha256: manifest.integrity.manifestSha256,
    sourceAuthoritySha256,
    objectCount: objects.length,
    sourceObjects: objects.map((object, index) => ({
      componentIndex: object.componentIndex,
      componentName: object.componentName,
      chunkIndex: object.chunkIndex,
      copyRole: object.copyRole,
      objectId: object.objectId,
      exactReadReceiptDerivation:
        AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
      exactReadReceiptSha256: exactReadDigests[index] ?? hexDigest("f"),
      ciphertextSha256: object.catalog.ciphertextSha256,
      sizeBytes: object.catalog.sizeBytes,
    })),
  };
  return {
    authority: exactAuthority,
    manifest,
    sourceAuthority,
    exactReadProofs,
    receipt,
  };
}

describe("agent backup restore-v3 stream contract", () => {
  test("fixes one immutable full-component order and receipt format", () => {
    expect(AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS).toEqual([
      "character",
      "database",
      "media",
      "state-files",
      "vault",
    ]);
    expect(AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS).toEqual(
      WIRE_COMPONENT_DESCRIPTORS,
    );
    expect(Object.isFrozen(AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS)).toBe(
      true,
    );
    expect(AGENT_BACKUP_RESTORE_V3_STREAM_RECEIPT_FORMAT).toBe(
      "elizaos.agent-backup.restore-v3-stream-candidate.v1",
    );
  });

  test("parses, deeply freezes, and canonicalizes the exact source ledger", () => {
    const receipt = candidateReceipt();
    const parsed = parseAgentBackupRestoreV3CandidateReceipt(receipt);
    const reordered = {
      components: receipt.components,
      sourceObjects: receipt.sourceObjects,
      authorityRevalidated: receipt.authorityRevalidated,
      stagedDataRecordCount: receipt.stagedDataRecordCount,
      stagedPayloadBytes: receipt.stagedPayloadBytes,
      objectCount: receipt.objectCount,
      sourceAuthoritySha256: receipt.sourceAuthoritySha256,
      sourceAuthorityDerivation: receipt.sourceAuthorityDerivation,
      sourceCopyRole: receipt.sourceCopyRole,
      keyBundleGenerationId: receipt.keyBundleGenerationId,
      expectedManifestSha256: receipt.expectedManifestSha256,
      operationId: receipt.operationId,
      restoreAttemptId: receipt.restoreAttemptId,
      format: receipt.format,
    };

    expect(canonicalizeAgentBackupRestoreV3CandidateReceipt(receipt)).toBe(
      canonicalizeAgentBackupRestoreV3CandidateReceipt(reordered),
    );
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.components)).toBe(true);
    expect(Object.isFrozen(parsed.components[0]?.descriptor)).toBe(true);
    expect(Object.isFrozen(parsed.sourceObjects[0])).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain("bucket");
    expect(JSON.stringify(parsed)).not.toContain("object_key");
    expect(JSON.stringify(parsed)).not.toContain("credential");
  });

  test("strictly rejects extra fields and non-canonical numeric totals", () => {
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...candidateReceipt(),
        secretLocator: "must-not-enter-the-receipt",
      }),
    ).toThrow();
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...candidateReceipt(),
        objectCount: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...candidateReceipt(),
        stagedPayloadBytes: -0,
      }),
    ).toThrow();
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...candidateReceipt(),
        sourceAuthoritySha256: undefined,
      }),
    ).toThrow();
  });

  test("canonicalizes one privacy-safe exact GET proof and rejects locator drift", () => {
    const proof = exactReadProof();
    const parsed = parseAgentBackupRestoreV3ExactReadReceiptProof(proof);
    const canonical =
      canonicalizeAgentBackupRestoreV3ExactReadReceiptProof(parsed);
    expect(Object.isFrozen(parsed.completion)).toBe(true);
    expect(canonical).toContain(
      AGENT_BACKUP_RESTORE_V3_EXACT_READ_RECEIPT_DERIVATION,
    );
    expect(canonical).not.toContain('"bucket":');
    expect(canonical).not.toContain('"objectKey":');
    expect(canonical).not.toContain('"endpointAlias":');

    const checksumAuthority = {
      ...proof,
      catalog: {
        ...proof.catalog,
        providerVersionId: null,
        providerChecksum: `sha256:base64:${proof.completion.checksumSha256Base64}`,
      },
      completion: {
        ...proof.completion,
        version: proof.completion.checksumSha256Base64,
        versionSource: "checksum" as const,
      },
    };
    expect(
      parseAgentBackupRestoreV3ExactReadReceiptProof(checksumAuthority),
    ).toEqual(checksumAuthority);

    const contradictoryChecksum = {
      ...proof,
      catalog: {
        ...proof.catalog,
        providerChecksum: `sha256:base64:${Buffer.from(
          "2".repeat(64),
          "hex",
        ).toString("base64")}`,
      },
    };
    expect(() =>
      parseAgentBackupRestoreV3ExactReadReceiptProof(contradictoryChecksum),
    ).toThrow("differs from its immutable catalogue authority");

    for (const invalid of [
      {
        ...proof,
        completion: {
          ...proof.completion,
          sizeBytes: proof.completion.sizeBytes + 1,
        },
      },
      {
        ...proof,
        completion: { ...proof.completion, version: "different-version" },
      },
      {
        ...proof,
        completion: { ...proof.completion, provider: "s3" },
      },
      {
        ...proof,
        completion: {
          ...proof.completion,
          backendIdentityFingerprint: `sha256:${"9".repeat(64)}`,
        },
      },
      {
        ...proof,
        completion: {
          ...proof.completion,
          endpointAliasFingerprint: `sha256:${"9".repeat(64)}`,
        },
      },
      {
        ...proof,
        completion: {
          ...proof.completion,
          bucketFingerprint: `sha256:${"9".repeat(64)}`,
        },
      },
      {
        ...proof,
        completion: {
          ...proof.completion,
          regionFingerprint: `sha256:${"9".repeat(64)}`,
        },
      },
      {
        ...proof,
        completion: {
          ...proof.completion,
          keyFingerprint: `sha256:${"9".repeat(64)}`,
        },
      },
      {
        ...proof,
        completion: { ...proof.completion, versionSource: "etag" as const },
      },
      { ...proof, componentIndex: 1 },
      {
        ...proof,
        completion: { ...proof.completion, ciphertextSha256: "2".repeat(64) },
      },
    ]) {
      expect(() =>
        parseAgentBackupRestoreV3ExactReadReceiptProof(invalid),
      ).toThrow("differs from its immutable catalogue authority");
    }
  });

  test("accepts secondary Hetzner S3 ETag authority and rejects crossed provider roles", () => {
    const primary = exactReadProof();
    const secondary = {
      ...primary,
      copyRole: "secondary" as const,
      catalog: {
        ...primary.catalog,
        transport: "s3-compatible" as const,
        provider: "hetzner-object-storage" as const,
        providerVersionId: null,
        providerEtag: "hetzner-etag-1",
        providerChecksum: `sha256:base64:${primary.completion.checksumSha256Base64}`,
      },
      completion: {
        ...primary.completion,
        transport: "s3-compatible" as const,
        provider: "s3" as const,
        version: "hetzner-etag-1",
        versionSource: "etag" as const,
      },
    };
    expect(parseAgentBackupRestoreV3ExactReadReceiptProof(secondary)).toEqual(
      secondary,
    );

    for (const invalid of [
      { ...primary, copyRole: "secondary" as const },
      { ...secondary, copyRole: "primary" as const },
      {
        ...secondary,
        catalog: { ...secondary.catalog, transport: "worker-r2" as const },
        completion: {
          ...secondary.completion,
          transport: "worker-r2-binding" as const,
        },
      },
      {
        ...secondary,
        completion: {
          ...secondary.completion,
          transport: "worker-r2-binding" as const,
        },
      },
      {
        ...secondary,
        completion: { ...secondary.completion, provider: "r2" as const },
      },
      {
        ...secondary,
        catalog: {
          ...secondary.catalog,
          providerChecksum: `sha256:base64:${Buffer.from(
            "2".repeat(64),
            "hex",
          ).toString("base64")}`,
        },
      },
    ]) {
      expect(() =>
        parseAgentBackupRestoreV3ExactReadReceiptProof(invalid),
      ).toThrow("differs from its immutable catalogue authority");
    }
  });

  test("requires all five components in exact order with exact aggregate totals", () => {
    const receipt = candidateReceipt();
    const firstDescriptor = receipt.components[0]?.descriptor;
    if (!firstDescriptor)
      throw new Error("Fixture omitted its first component descriptor");
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...receipt,
        components: receipt.components.slice(0, 4),
      }),
    ).toThrow();
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...receipt,
        components: receipt.components.map((component, index) =>
          index === 1
            ? {
                ...component,
                componentName: "character",
                descriptor: firstDescriptor,
              }
            : component,
        ),
      }),
    ).toThrow("exact full-component order");
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...receipt,
        stagedPayloadBytes: receipt.stagedPayloadBytes + 1,
      }),
    ).toThrow("payload total");
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...receipt,
        stagedDataRecordCount: receipt.stagedDataRecordCount + 1,
      }),
    ).toThrow("data-record total");
  });

  test("requires a complete, role-bound, uniquely ordered exact-read ledger", () => {
    const receipt = candidateReceipt();
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...receipt,
        objectCount: receipt.objectCount + 1,
      }),
    ).toThrow("object count");
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...receipt,
        sourceObjects: receipt.sourceObjects.map((source, index) =>
          index === 0 ? { ...source, copyRole: "secondary" } : source,
        ),
      }),
    ).toThrow("copy role");
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...receipt,
        sourceObjects: receipt.sourceObjects.map((source, index) =>
          index === 1 ? { ...source, chunkIndex: 1 } : source,
        ),
      }),
    ).toThrow("unique and contiguous");
    expect(() =>
      parseAgentBackupRestoreV3CandidateReceipt({
        ...receipt,
        sourceObjects: [...receipt.sourceObjects].reverse(),
      }),
    ).toThrow("unique and contiguous");
  });

  test("joins every manifest slot to canonical catalogue and exact-read authority", async () => {
    const fixture = await candidateContextFixture();
    const validated =
      await validateAgentBackupRestoreV3CandidateContext(fixture);
    const request = createAgentBackupRestoreV3CandidateSealAuthorizationRequest(
      validated,
      "execution-token",
    );

    expect(validated.binding.objectCount).toBe(6);
    expect(validated.binding.candidateReceiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(request.candidate).toEqual(validated.binding);
    const reorderedRequest = {
      candidate: request.candidate,
      sessionExecutionToken: request.sessionExecutionToken,
      authority: request.authority,
    };
    expect(
      canonicalizeAgentBackupRestoreV3CandidateSealAuthorizationRequest(
        request,
      ),
    ).toBe(
      canonicalizeAgentBackupRestoreV3CandidateSealAuthorizationRequest(
        reorderedRequest,
      ),
    );
    expect(Object.isFrozen(validated.sourceAuthority.objects)).toBe(true);
    const canonical = canonicalizeAgentBackupRestoreV3SourceAuthority(
      validated.sourceAuthority,
    );
    expect(canonical).not.toContain('"bucket":');
    expect(canonical).not.toContain('"objectKey":');
    expect(canonical).not.toContain('"endpointAlias":');
  });

  test("pins the four canonical wire digests to stable literal goldens", async () => {
    const fixture = await candidateContextFixture();
    const validated =
      await validateAgentBackupRestoreV3CandidateContext(fixture);
    const request = createAgentBackupRestoreV3CandidateSealAuthorizationRequest(
      validated,
      "execution-token",
    );
    const firstProof = fixture.exactReadProofs[0];
    if (!firstProof)
      throw new Error("Fixture omitted its first exact-read proof");

    await expect(
      computeAgentBackupRestoreV3SourceAuthoritySha256(fixture.sourceAuthority),
    ).resolves.toBe(
      "cc9dcaded2a444a7e7efdcb41e7d2b1b3a78761971c51834ee75a698b95f6f19",
    );
    await expect(
      computeAgentBackupRestoreV3ExactReadReceiptSha256(firstProof),
    ).resolves.toBe(
      "a173a6939505bc6e5b17877d90c61f49ed719d1bfbb530109af1838639ee8381",
    );
    await expect(
      computeAgentBackupRestoreV3CandidateReceiptSha256(fixture.receipt),
    ).resolves.toBe(
      "f9c5855a91551f65b5504bfc0e19d8affb7eabc055b3dca8a86fc76ff52e69a0",
    );
    await expect(
      computeAgentBackupRestoreV3CandidateSealAuthorizationRequestSha256(
        request,
      ),
    ).resolves.toBe(
      "93b9ce39e2407035b1a913933394500979c360f145196f67f67ae925f4e9ccdc",
    );
  });

  test("rejects provider-checksum contradiction in the complete candidate context", async () => {
    const fixture = await candidateContextFixture();
    const contradictoryChecksum = `sha256:base64:${Buffer.from(
      "f".repeat(64),
      "hex",
    ).toString("base64")}`;

    await expect(
      validateAgentBackupRestoreV3CandidateContext({
        ...fixture,
        exactReadProofs: fixture.exactReadProofs.map((proof, index) =>
          index === 0
            ? {
                ...proof,
                catalog: {
                  ...proof.catalog,
                  providerChecksum: contradictoryChecksum,
                },
              }
            : proof,
        ),
      }),
    ).rejects.toThrow("differs from its immutable catalogue authority");
  });

  test("rejects staged ciphertext that differs from its exact catalogue proof", async () => {
    const fixture = await candidateContextFixture();

    await expect(
      validateAgentBackupRestoreV3CandidateContext({
        ...fixture,
        receipt: {
          ...fixture.receipt,
          sourceObjects: fixture.receipt.sourceObjects.map((source, index) =>
            index === 0
              ? { ...source, ciphertextSha256: "a".repeat(64) }
              : source,
          ),
        },
      }),
    ).rejects.toThrow("differs from its exact proof");
  });

  test("rejects staged size that differs from its exact catalogue proof", async () => {
    const fixture = await candidateContextFixture();

    await expect(
      validateAgentBackupRestoreV3CandidateContext({
        ...fixture,
        receipt: {
          ...fixture.receipt,
          sourceObjects: fixture.receipt.sourceObjects.map((source, index) =>
            index === 0
              ? { ...source, sizeBytes: source.sizeBytes + 1 }
              : source,
          ),
        },
      }),
    ).rejects.toThrow("differs from its exact proof");
  });

  test("rejects principal identity mutations across the complete context", async () => {
    const fixture = await candidateContextFixture();
    const alternateId = "00000000-0000-4000-8000-0000000000ff";
    const rebindSourceAuthority = async (
      nextAuthority: AgentBackupRestoreV3AuthorityFence,
      nextSourceAuthority: AgentBackupRestoreV3SourceAuthority,
      nextReceipt: AgentBackupRestoreV3CandidateReceipt = fixture.receipt,
      proofIdentity: Readonly<{
        organizationId?: string;
        backupId?: string;
      }> = {},
    ) => {
      const sourceAuthoritySha256 =
        await computeAgentBackupRestoreV3SourceAuthoritySha256(
          nextSourceAuthority,
        );
      const exactReadProofs: AgentBackupRestoreV3ExactReadReceiptProof[] =
        fixture.exactReadProofs.map((proof) => ({
          ...proof,
          sourceAuthoritySha256,
          organizationId: proofIdentity.organizationId ?? proof.organizationId,
          backupId: proofIdentity.backupId ?? proof.backupId,
        }));
      const exactReadReceiptSha256 = await Promise.all(
        exactReadProofs.map((proof) =>
          computeAgentBackupRestoreV3ExactReadReceiptSha256(proof),
        ),
      );
      return {
        ...fixture,
        authority: nextAuthority,
        sourceAuthority: nextSourceAuthority,
        exactReadProofs,
        receipt: {
          ...nextReceipt,
          sourceAuthoritySha256,
          sourceObjects: nextReceipt.sourceObjects.map((source, index) => ({
            ...source,
            exactReadReceiptSha256:
              exactReadReceiptSha256[index] ?? hexDigest("f"),
          })),
        },
      };
    };
    const mutations = [
      {
        label: "authority organizationId versus manifest identity",
        input: await rebindSourceAuthority(
          { ...fixture.authority, organizationId: alternateId },
          { ...fixture.sourceAuthority, organizationId: alternateId },
          fixture.receipt,
          { organizationId: alternateId },
        ),
      },
      {
        label: "authority agentId versus manifest identity",
        input: await rebindSourceAuthority(
          { ...fixture.authority, agentId: alternateId },
          { ...fixture.sourceAuthority, agentId: alternateId },
        ),
      },
      {
        label: "authority operationId versus manifest operation",
        input: await rebindSourceAuthority(
          { ...fixture.authority, operationId: alternateId },
          { ...fixture.sourceAuthority, operationId: alternateId },
          { ...fixture.receipt, operationId: alternateId },
        ),
      },
      {
        label: "authority activation generation versus manifest identity",
        input: await rebindSourceAuthority(
          {
            ...fixture.authority,
            sourceActivationGeneration: alternateId,
          },
          {
            ...fixture.sourceAuthority,
            sourceActivationGeneration: alternateId,
          },
        ),
      },
      {
        label: "authority lifecycle revision versus manifest identity",
        input: await rebindSourceAuthority(
          { ...fixture.authority, sourceLifecycleRevision: "19" },
          { ...fixture.sourceAuthority, sourceLifecycleRevision: "19" },
        ),
      },
      {
        label: "source authority backupId versus durable authority",
        input: await rebindSourceAuthority(fixture.authority, {
          ...fixture.sourceAuthority,
          backupId: alternateId,
        }),
      },
      {
        label: "source authority catalog epoch versus durable authority",
        input: await rebindSourceAuthority(fixture.authority, {
          ...fixture.sourceAuthority,
          catalogEpoch: "43",
        }),
      },
      {
        label: "candidate restore attempt versus durable authority",
        input: {
          ...fixture,
          receipt: { ...fixture.receipt, restoreAttemptId: alternateId },
        },
      },
      {
        label: "candidate key bundle versus manifest encryption",
        input: {
          ...fixture,
          receipt: { ...fixture.receipt, keyBundleGenerationId: alternateId },
        },
      },
    ];

    for (const { label, input } of mutations) {
      await expect(
        validateAgentBackupRestoreV3CandidateContext(input),
        label,
      ).rejects.toThrow(
        "Restore candidate differs from its exact manifest or durable authority",
      );
    }
  });

  test("rejects stale context, omitted chunks, duplicate identities, and proof drift", async () => {
    const fixture = await candidateContextFixture();
    await expect(
      validateAgentBackupRestoreV3CandidateContext({
        ...fixture,
        receipt: {
          ...fixture.receipt,
          restoreAttemptId: "00000000-0000-4000-8000-0000000000ff",
        },
      }),
    ).rejects.toThrow("manifest or durable authority");

    await expect(
      validateAgentBackupRestoreV3CandidateContext({
        ...fixture,
        receipt: {
          ...fixture.receipt,
          objectCount: fixture.receipt.objectCount - 1,
          sourceObjects: fixture.receipt.sourceObjects.slice(0, -1),
        },
      }),
    ).rejects.toThrow("incomplete for its exact manifest");

    const firstObject = fixture.sourceAuthority.objects[0];
    if (!firstObject)
      throw new Error("Fixture omitted its first source object");
    await expect(
      validateAgentBackupRestoreV3CandidateContext({
        ...fixture,
        sourceAuthority: {
          ...fixture.sourceAuthority,
          objects: fixture.sourceAuthority.objects.map((object, index) =>
            index === 1
              ? { ...object, objectId: firstObject.objectId }
              : object,
          ),
        },
      }),
    ).rejects.toThrow("exact, unique, and contiguous");

    await expect(
      validateAgentBackupRestoreV3CandidateContext({
        ...fixture,
        exactReadProofs: fixture.exactReadProofs.map((proof, index) =>
          index === 0
            ? {
                ...proof,
                catalog: {
                  ...proof.catalog,
                  uploadReceiptDigest: "f".repeat(64),
                },
              }
            : proof,
        ),
      }),
    ).rejects.toThrow("source slot 0 differs from its exact proof");
  });

  test("strictly validates and canonicalizes the durable authority fence", () => {
    const parsed = parseAgentBackupRestoreV3AuthorityFence(authority());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(canonicalizeAgentBackupRestoreV3AuthorityFence(parsed)).toContain(
      `"expectedManifestSha256":"${MANIFEST_SHA256}"`,
    );
    for (const invalid of [
      {
        ...authority(),
        organizationId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      },
      { ...authority(), expectedManifestSha256: `sha256:${MANIFEST_SHA256}` },
      { ...authority(), sourceLifecycleRevision: "018" },
      { ...authority(), catalogEpoch: "18446744073709551616" },
      { ...authority(), leaseExpiresAtEpochMs: 0 },
    ]) {
      expect(() => parseAgentBackupRestoreV3AuthorityFence(invalid)).toThrow();
    }
  });

  test("requires cleanup registration and isolation before accepting a session", () => {
    const session = {
      restoreAttemptId: IDS.restoreAttempt,
      operationId: IDS.operation,
      expectedManifestSha256: MANIFEST_SHA256,
      stagingHandle: "candidate/staging/opaque",
      cleanupHandle: "candidate/cleanup/opaque",
      executionToken: "execution-token",
      cleanupRegistered: true,
      isolatedCandidate: true,
    } as const;
    expect(parseAgentBackupRestoreV3StagingSession(session)).toEqual(session);
    expect(() =>
      parseAgentBackupRestoreV3StagingSession({
        ...session,
        cleanupRegistered: false,
      }),
    ).toThrow();
    expect(() =>
      parseAgentBackupRestoreV3StagingSession({
        ...session,
        isolatedCandidate: false,
      }),
    ).toThrow();
  });

  test("accepts only a live one-shot seal authorization for the exact request", () => {
    const candidate = {
      restoreAttemptId: IDS.restoreAttempt,
      operationId: IDS.operation,
      expectedManifestSha256: MANIFEST_SHA256,
      keyBundleGenerationId: IDS.keyBundle,
      sourceCopyRole: "primary" as const,
      sourceAuthoritySha256: SOURCE_AUTHORITY_SHA256,
      objectCount: 5,
      candidateReceiptSha256: CANDIDATE_SHA256,
    };
    const request = {
      authority: authority(),
      sessionExecutionToken: "execution-token",
      candidate,
    };
    const authorization = {
      current: true,
      authority: authority(),
      authorizationId: IDS.authorization,
      sessionExecutionToken: "execution-token",
      candidate,
      expiresAtEpochMs: 1_800_000_000_500,
      proofToken: "one-shot-proof-token",
    } as const;
    const first = validateAgentBackupRestoreV3CandidateSealAuthorization(
      request,
      authorization,
      1_800_000_000_000,
    );
    const replay = validateAgentBackupRestoreV3CandidateSealAuthorization(
      request,
      authorization,
      1_800_000_000_001,
    );
    expect(replay).toEqual(first);
    expect(Object.isFrozen(replay.authority)).toBe(true);

    for (const invalid of [
      { ...authorization, sessionExecutionToken: "different-execution" },
      {
        ...authorization,
        candidate: {
          ...authorization.candidate,
          candidateReceiptSha256: "d".repeat(64),
        },
      },
      {
        ...authorization,
        authority: { ...authorization.authority, catalogEpoch: "43" },
      },
      { ...authorization, expiresAtEpochMs: 1_800_000_000_000 },
      {
        ...authorization,
        expiresAtEpochMs: authority().leaseExpiresAtEpochMs + 1,
      },
    ]) {
      expect(() =>
        validateAgentBackupRestoreV3CandidateSealAuthorization(
          request,
          invalid,
          1_800_000_000_000,
        ),
      ).toThrow("differs from its exact request");
    }
  });
});
