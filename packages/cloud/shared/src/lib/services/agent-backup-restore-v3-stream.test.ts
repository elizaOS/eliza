/**
 * Exercises the restore-v3 stream kernel with canonical five-component record
 * streams and real AES-256-GCM objects. Durable authority, KMS, exact storage,
 * and isolated staging remain deterministic contract-faithful adapters.
 */

import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createCipheriv, createHash, createHmac } from "node:crypto";
import {
  computeKmsAeadOperationKeyBundleLocalReceiptDigest,
  KMS_AEAD_OPERATION_KEY_BUNDLE_V1,
  type KmsAeadOperationKeyBundleHandle,
} from "@elizaos/core/security/kms";
import {
  AGENT_BACKUP_CHUNK_AAD_DERIVATION,
  AGENT_BACKUP_CHUNK_ENVELOPE_V1,
  AGENT_BACKUP_MANIFEST_FORMAT,
  AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION,
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION,
  AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
  AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS,
  AGENT_BACKUP_RESTORE_V3_SOURCE_AUTHORITY_DERIVATION,
  AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
  AGENT_VAULT_KEY_AUTHORITY_FORMAT,
  AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
  type AgentBackupManifestV3,
  type AgentBackupManifestV3Draft,
  type AgentBackupRestoreV3AuthorityFence,
  type AgentBackupRestoreV3CandidateReceipt,
  type AgentBackupRestoreV3CandidateSealAuthority,
  type AgentBackupRestoreV3IsolatedCandidateStaging,
  type AgentBackupRestoreV3SourceAuthority,
  type AgentBackupRestoreV3SourceAuthorityObject,
  type AgentBackupRestoreV3StagingSession,
  canonicalizeAgentBackupChunkAad,
  canonicalizeAgentBackupOperationKeyBundleContext,
  createAgentBackupManifestV3,
  serializeAgentBackupRecordStreamV1Magic,
  serializeAgentBackupRecordStreamV1Record,
} from "@elizaos/shared";
import { type ExactObjectRead, ObjectLocatorReceipt } from "../storage/object-store";
import {
  type AgentBackupRestoreV3KeyBundleProvider,
  type AgentBackupRestoreV3OperationKeyBundleAuthority,
} from "./agent-backup-restore-v3-key-bundle";
import {
  type AgentBackupRestoreV3PreparedObject,
  AgentBackupRestoreV3StreamError,
  type StreamAgentBackupRestoreV3Input,
  streamAgentBackupRestoreV3,
} from "./agent-backup-restore-v3-stream";

const IDS = Object.freeze({
  organization: "10000000-0000-4000-8000-000000000001",
  agent: "20000000-0000-4000-8000-000000000002",
  backup: "30000000-0000-4000-8000-000000000003",
  operation: "40000000-0000-4000-8000-000000000004",
  activation: "50000000-0000-4000-8000-000000000005",
  restoreAttempt: "60000000-0000-4000-8000-000000000006",
  lease: "70000000-0000-4000-8000-000000000007",
  fencing: "80000000-0000-4000-8000-000000000008",
  keyBundle: "90000000-0000-4000-8000-000000000009",
  authorization: "a0000000-0000-4000-8000-00000000000a",
  nodeRecord: "b0000000-0000-4000-8000-00000000000b",
  nodeIncarnation: "c0000000-0000-4000-8000-00000000000c",
  vaultKey: "d0000000-0000-4000-8000-00000000000d",
} as const);
const NOW_EPOCH_MS = 1_800_000_000_000;
const DEADLINE_EPOCH_MS = NOW_EPOCH_MS + 10_000;
const LEASE_EXPIRES_AT_EPOCH_MS = NOW_EPOCH_MS + 100_000;
const ENDPOINT_ALIAS = "restore-primary-fixture";
const BUCKET = "restore-v3-fixture";
const REGION = "auto";
const BACKEND_FINGERPRINT = fingerprint("fixture-r2-backend");
const KEY_ID = `org:${IDS.organization}/dek/v1`;

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(value: string): `sha256:${string}` {
  return `sha256:${sha256Hex(value)}`;
}

function checksumBase64(hex: string): string {
  return Buffer.from(hex, "hex").toString("base64");
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function uint64BigEndian(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
  return bytes;
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

function objectId(index: number): string {
  return `e0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function componentWire(componentIndex: number, payload: Uint8Array): Uint8Array {
  const descriptor = AGENT_BACKUP_RESTORE_V3_COMPONENT_DESCRIPTORS[componentIndex];
  if (!descriptor) throw new Error("Fixture component descriptor is absent");
  const entry =
    descriptor.contentKind === "file-set"
      ? {
          path: `${descriptor.name}.bin`,
          fileOffsetBytes: 0,
          fileSizeBytes: payload.byteLength,
          mode: 0o600,
          mtimeMs: 1_700_000_000_000,
        }
      : null;
  return joinBytes([
    serializeAgentBackupRecordStreamV1Magic(),
    ...serializeAgentBackupRecordStreamV1Record({
      kind: "component-start",
      descriptor,
    }),
    ...serializeAgentBackupRecordStreamV1Record({
      kind: "data",
      dataIndex: 0,
      offsetBytes: 0,
      payloadBytes: payload.byteLength,
      entry,
      payload,
    }),
    ...serializeAgentBackupRecordStreamV1Record({
      kind: "component-end",
      dataFrameCount: 1,
      payloadBytes: payload.byteLength,
      payloadSha256: sha256Hex(payload),
    }),
  ]);
}

function framedContentHmacSha256(
  contentHmacKey: Uint8Array,
  wires: readonly Readonly<{ name: string; wire: Uint8Array }>[],
): string {
  const hmac = createHmac("sha256", contentHmacKey);
  const encoder = new TextEncoder();
  hmac.update(encoder.encode(AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION));
  hmac.update(uint64BigEndian(wires.length));
  for (const component of wires) {
    const name = encoder.encode(component.name);
    hmac.update(uint64BigEndian(name.byteLength));
    hmac.update(name);
    hmac.update(uint64BigEndian(component.wire.byteLength));
    hmac.update(component.wire);
  }
  return hmac.digest("hex");
}

interface EncryptedComponentFixture {
  readonly index: number;
  readonly name: (typeof AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS)[number];
  readonly wire: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly contentHmacSha256: string;
  readonly aadSha256: string;
}

interface FixtureOptions {
  readonly loseAuthorityAtFinalRead?: boolean;
  readonly loseSealResponse?: boolean;
}

interface RestoreFixture {
  readonly input: StreamAgentBackupRestoreV3Input;
  readonly manifest: AgentBackupManifestV3;
  readonly events: string[];
  readonly counts: {
    begin: number;
    revalidate: number;
    unwrap: number;
    release: number;
    open: number;
    stage: number;
    finish: number;
    authorize: number;
    seal: number;
    abort: number;
  };
  readonly keyViews: {
    readonly dek: Uint8Array;
    readonly contentHmacKey: Uint8Array;
    readonly released: () => boolean;
  };
  readonly finalAuthorityKeyState: Array<{
    readonly released: boolean;
    readonly dekZeroized: boolean;
    readonly contentHmacKeyZeroized: boolean;
  }>;
  readonly stagedPayloadCopies: Uint8Array[];
  readonly ephemeralStagingViews: Uint8Array[];
  readonly sourcePayloads: readonly Uint8Array[];
  readonly preparedObjects: readonly AgentBackupRestoreV3PreparedObject[];
  readonly session: AgentBackupRestoreV3StagingSession;
  readonly state: () => "idle" | "active" | "sealed" | "aborted";
  readonly sealedReceipt: () => AgentBackupRestoreV3CandidateReceipt | undefined;
  readonly consumedProofTokens: ReadonlySet<string>;
  readonly abortExecutionTokens: readonly string[];
}

async function createFixture(options: FixtureOptions = {}): Promise<RestoreFixture> {
  const events: string[] = [];
  const counts = {
    begin: 0,
    revalidate: 0,
    unwrap: 0,
    release: 0,
    open: 0,
    stage: 0,
    finish: 0,
    authorize: 0,
    seal: 0,
    abort: 0,
  };
  const identity = {
    organizationId: IDS.organization,
    agentId: IDS.agent,
    activationGeneration: IDS.activation,
    lifecycleRevision: "18",
  } as const;
  const dek = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const contentHmacKey = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const sourcePayloads = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS.map((name, index) =>
    new TextEncoder().encode(`restore-v3:${index}:${name}:isolated-state`),
  );
  const wires = sourcePayloads.map((payload, index) => {
    const name = AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS[index];
    if (!name) throw new Error("Fixture component name is absent");
    return { name, wire: componentWire(index, payload) };
  });
  const wrappedEnvelope = Uint8Array.from(
    { length: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes },
    (_, index) => (index * 17 + 9) & 0xff,
  );
  const canonicalContext = canonicalizeAgentBackupOperationKeyBundleContext({
    organizationId: IDS.organization,
    agentId: IDS.agent,
    activationGeneration: IDS.activation,
    lifecycleRevision: "18",
    operationId: IDS.operation,
    keyBundleGenerationId: IDS.keyBundle,
    sourceKind: "robot",
    sourceProvider: "hetzner",
    kmsProvider: "local",
    keyId: KEY_ID,
    keyVersion: 1,
  });
  const contextBytes = new TextEncoder().encode(canonicalContext);
  const wrappedSha256 = sha256Hex(wrappedEnvelope);
  const localReceiptDigest = computeKmsAeadOperationKeyBundleLocalReceiptDigest({
    keyId: KEY_ID,
    keyVersion: 1,
    canonicalContext: contextBytes,
    wrappedKeyBundle: wrappedEnvelope,
  });
  contextBytes.fill(0);

  const encryptedComponents: EncryptedComponentFixture[] = wires.map(({ name, wire }, index) => {
    const contentHmacSha256 = createHmac("sha256", contentHmacKey).update(wire).digest("hex");
    const aad = new TextEncoder().encode(
      canonicalizeAgentBackupChunkAad({
        identity,
        operationId: IDS.operation,
        component: {
          name,
          format: AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
          compression: "none",
        },
        chunk: {
          index: 0,
          offsetBytes: 0,
          plainBytes: wire.byteLength,
          compressedBytes: wire.byteLength,
          contentHmacSha256,
        },
      }),
    );
    const nonce = new Uint8Array(AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes);
    new DataView(nonce.buffer).setUint32(nonce.byteLength - 4, index + 1, false);
    const cipher = createCipheriv("aes-256-gcm", dek, nonce, {
      authTagLength: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
    });
    cipher.setAAD(aad);
    const ciphertext = joinBytes([nonce, cipher.update(wire), cipher.final(), cipher.getAuthTag()]);
    return {
      index,
      name,
      wire,
      ciphertext,
      contentHmacSha256,
      aadSha256: sha256Hex(aad),
    };
  });

  const components: AgentBackupManifestV3Draft["components"] = encryptedComponents.map(
    (component) => {
      return {
        name: component.name,
        format: AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
        compression: "none",
        payloadContentHmacSha256: component.contentHmacSha256,
        state: {
          kind: "full",
          resultContentHmacSha256: component.contentHmacSha256,
        },
        totals: {
          plainBytes: component.wire.byteLength,
          compressedBytes: component.wire.byteLength,
          encryptedBytes: component.ciphertext.byteLength,
          chunkCount: 1,
        },
        chunks: [
          {
            index: 0,
            offsetBytes: 0,
            plainBytes: component.wire.byteLength,
            compressedBytes: component.wire.byteLength,
            encryptedBytes: component.ciphertext.byteLength,
            contentHmacSha256: component.contentHmacSha256,
            aadSha256: component.aadSha256,
            sha256: sha256Hex(component.ciphertext),
          },
        ],
      };
    },
  );
  const manifestDraft: AgentBackupManifestV3Draft = {
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
      imageDigest: `sha256:${sha256Hex("restore-v3-image")}`,
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
      plainBytes: components.reduce((total, component) => total + component.totals.plainBytes, 0),
      compressedBytes: components.reduce(
        (total, component) => total + component.totals.compressedBytes,
        0,
      ),
      encryptedBytes: components.reduce(
        (total, component) => total + component.totals.encryptedBytes,
        0,
      ),
      chunkCount: components.length,
    },
    vaultKeyAuthority: {
      format: AGENT_VAULT_KEY_AUTHORITY_FORMAT,
      generationId: IDS.vaultKey,
      receiptDerivation: AGENT_VAULT_KEY_AUTHORITY_RECEIPT_DERIVATION,
      receiptDigest: sha256Hex("fixture-vault-key-authority"),
    },
    encryption: {
      algorithm: "AES-256-GCM",
      chunkEnvelope: AGENT_BACKUP_CHUNK_ENVELOPE_V1.name,
      nonceBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes,
      tagBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
      noncePlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.noncePlacement,
      tagPlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagPlacement,
      aad: { version: 1, derivation: AGENT_BACKUP_CHUNK_AAD_DERIVATION },
      kms: { provider: "local", keyId: KEY_ID, keyVersion: 1 },
      operationKeyBundle: {
        format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.format,
        generationId: IDS.keyBundle,
        plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
        dek: { ...AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek },
        contentHmac: { ...AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac },
        wrapped: {
          ref: `backup-key-bundle:${IDS.operation}`,
          bytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.wrappedBytes,
          sha256: wrappedSha256,
          localReceiptDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
          localReceiptDigest,
          contextDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
        },
      },
    },
    integrity: {
      framedContentHmacSha256: framedContentHmacSha256(contentHmacKey, wires),
      contentAddressing: {
        algorithm: "HMAC-SHA-256",
        scope: "operation",
        derivation: AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
        keyBundleFormat: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.format,
        keyOffsetBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
        keyBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes,
      },
    },
  };
  const manifest = await createAgentBackupManifestV3(manifestDraft);
  const authority: AgentBackupRestoreV3AuthorityFence = {
    organizationId: IDS.organization,
    agentId: IDS.agent,
    backupId: IDS.backup,
    operationId: IDS.operation,
    sourceActivationGeneration: IDS.activation,
    sourceLifecycleRevision: "18",
    expectedManifestSha256: manifest.integrity.manifestSha256,
    copyRole: "primary",
    restoreAttemptId: IDS.restoreAttempt,
    leaseId: IDS.lease,
    ownerId: "restore-v3-fixture-worker",
    fencingToken: IDS.fencing,
    catalogEpoch: "9",
    leaseExpiresAtEpochMs: LEASE_EXPIRES_AT_EPOCH_MS,
  };
  const sourceObjects: AgentBackupRestoreV3SourceAuthorityObject[] = encryptedComponents.map(
    (component) => {
      const chunk = manifest.components[component.index]?.chunks[0];
      if (!chunk) throw new Error("Fixture manifest chunk is absent");
      const key = `backups/${IDS.backup}/${component.name}/0.enc`;
      return {
        objectId: objectId(component.index),
        componentIndex: component.index,
        componentName: component.name,
        chunkIndex: 0,
        copyRole: "primary",
        contentHmacSha256: chunk.contentHmacSha256,
        catalog: {
          transport: "worker-r2",
          provider: "cloudflare-r2",
          endpointIdentityFingerprint: BACKEND_FINGERPRINT,
          endpointAliasFingerprint: fingerprint(ENDPOINT_ALIAS),
          bucketFingerprint: fingerprint(BUCKET),
          regionFingerprint: fingerprint(REGION),
          keyFingerprint: fingerprint(key),
          providerVersionId: `fixture-version-${component.index + 1}`,
          providerEtag: null,
          providerChecksum: null,
          uploadReceiptDigest: sha256Hex(`fixture-upload-receipt-${component.index}`),
          ciphertextSha256: chunk.sha256,
          sizeBytes: chunk.encryptedBytes,
        },
      };
    },
  );
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
    catalogEpoch: "9",
    objects: sourceObjects,
  };
  const preparedObjects: AgentBackupRestoreV3PreparedObject[] = sourceObjects.map(
    (sourceObject) => {
      const key = `backups/${IDS.backup}/${sourceObject.componentName}/0.enc`;
      return {
        authority: sourceObject,
        locator: {
          key,
          receipt: new ObjectLocatorReceipt({
            transport: "worker-r2-binding",
            provider: "r2",
            endpointAlias: ENDPOINT_ALIAS,
            backendIdentityFingerprint: BACKEND_FINGERPRINT,
            bucket: BUCKET,
            region: REGION,
            keyFingerprint: fingerprint(key),
            version: sourceObject.catalog.providerVersionId,
            versionSource: "provider",
          }),
        },
      };
    },
  );
  const operationKeyBundle: AgentBackupRestoreV3OperationKeyBundleAuthority = {
    generationId: IDS.keyBundle,
    format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
    ref: `backup-key-bundle:${IDS.operation}`,
    keyId: KEY_ID,
    keyVersion: 1,
    canonicalContext,
    ciphertextBase64: Buffer.from(wrappedEnvelope).toString("base64"),
    sha256: wrappedSha256,
    sizeBytes: wrappedEnvelope.byteLength,
    localReceiptDigest,
  };

  let released = false;
  const handle: KmsAeadOperationKeyBundleHandle = {
    format: KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format,
    dek,
    contentHmacKey,
    get released() {
      return released;
    },
  };
  const keyBundle: AgentBackupRestoreV3KeyBundleProvider = {
    unwrap(input) {
      counts.unwrap += 1;
      events.push("kms:unwrap");
      expect(Buffer.from(input.wrapped.wrappedKeyBundle).toString("base64")).toBe(
        operationKeyBundle.ciphertextBase64,
      );
      expect(new TextDecoder().decode(input.canonicalContext)).toBe(canonicalContext);
      return handle;
    },
    release(releasedHandle) {
      counts.release += 1;
      events.push("kms:release");
      expect(releasedHandle).toBe(handle);
      released = true;
      return true;
    },
  };

  const session: AgentBackupRestoreV3StagingSession = {
    restoreAttemptId: IDS.restoreAttempt,
    operationId: IDS.operation,
    expectedManifestSha256: manifest.integrity.manifestSha256,
    stagingHandle: "fixture-staging-handle",
    cleanupHandle: "fixture-cleanup-handle",
    executionToken: "fixture-execution-token",
    cleanupRegistered: true,
    isolatedCandidate: true,
  };
  let candidateState: "idle" | "active" | "sealed" | "aborted" = "idle";
  let durableSealedReceipt: AgentBackupRestoreV3CandidateReceipt | undefined;
  let lostSealResponse = false;
  const stagedPayloadCopies: Uint8Array[] = [];
  const ephemeralStagingViews: Uint8Array[] = [];
  const consumedProofTokens = new Set<string>();
  const abortExecutionTokens: string[] = [];
  const staging: AgentBackupRestoreV3IsolatedCandidateStaging = {
    begin(request) {
      counts.begin += 1;
      events.push("staging:begin");
      expect(candidateState).toBe("idle");
      expect(request.authority).toEqual(authority);
      expect(request.manifest.integrity.manifestSha256).toBe(manifest.integrity.manifestSha256);
      candidateState = "active";
      return session;
    },
    stageRecord(stagingSession, record) {
      counts.stage += 1;
      events.push(`staging:record:${record.componentName}`);
      expect(candidateState).toBe("active");
      expect(stagingSession.executionToken).toBe(session.executionToken);
      ephemeralStagingViews.push(record.payload);
      stagedPayloadCopies.push(Uint8Array.from(record.payload));
      return {
        componentIndex: record.componentIndex,
        componentName: record.componentName,
        dataIndex: record.dataIndex,
        offsetBytes: record.offsetBytes,
        entry: record.entry ? { ...record.entry } : null,
        payloadBytes: record.payload.byteLength,
        payloadSha256: sha256Hex(record.payload),
      };
    },
    finishComponent(stagingSession, receipt) {
      counts.finish += 1;
      events.push(`staging:finish:${receipt.componentName}`);
      expect(candidateState).toBe("active");
      expect(stagingSession.executionToken).toBe(session.executionToken);
      return receipt;
    },
    seal(stagingSession, receipt, authorization) {
      counts.seal += 1;
      expect(stagingSession.executionToken).toBe(session.executionToken);
      expect(authorization.sessionExecutionToken).toBe(session.executionToken);
      expect(authorization.candidate.expectedManifestSha256).toBe(receipt.expectedManifestSha256);
      expect(released).toBe(true);
      expect(allZero(dek)).toBe(true);
      expect(allZero(contentHmacKey)).toBe(true);
      if (candidateState === "sealed") {
        events.push("staging:seal-exact-replay");
        expect(durableSealedReceipt).toEqual(receipt);
        expect(consumedProofTokens.has(authorization.proofToken)).toBe(true);
        return durableSealedReceipt;
      }
      events.push("staging:seal");
      expect(candidateState).toBe("active");
      expect(consumedProofTokens.has(authorization.proofToken)).toBe(false);
      consumedProofTokens.add(authorization.proofToken);
      candidateState = "sealed";
      durableSealedReceipt = receipt;
      if (options.loseSealResponse && !lostSealResponse) {
        lostSealResponse = true;
        throw new Error("synthetic seal response loss after durable commit");
      }
      return receipt;
    },
    abort(stagingSession) {
      counts.abort += 1;
      abortExecutionTokens.push(stagingSession.executionToken);
      expect(stagingSession.executionToken).toBe(session.executionToken);
      if (candidateState === "active") {
        events.push("staging:abort-active");
        candidateState = "aborted";
      } else {
        events.push("staging:abort-terminal-noop");
      }
      return true;
    },
  };

  const finalAuthorityKeyState: RestoreFixture["finalAuthorityKeyState"] = [];
  const candidateSealAuthority: AgentBackupRestoreV3CandidateSealAuthority = {
    authorize(request) {
      counts.authorize += 1;
      events.push("authority:authorize-seal");
      expect(counts.authorize).toBe(1);
      expect(released).toBe(true);
      expect(allZero(dek)).toBe(true);
      expect(allZero(contentHmacKey)).toBe(true);
      return {
        current: true,
        authority,
        authorizationId: IDS.authorization,
        sessionExecutionToken: request.sessionExecutionToken,
        candidate: request.candidate,
        expiresAtEpochMs: NOW_EPOCH_MS + 5_000,
        proofToken: "fixture-one-shot-seal-proof",
      };
    },
  };
  const abortController = new AbortController();
  const input: StreamAgentBackupRestoreV3Input = {
    source: {
      manifest,
      authority,
      sourceAuthority,
      operationKeyBundle,
      objects: preparedObjects,
    },
    openExactObject(prepared, control) {
      counts.open += 1;
      events.push(`storage:open:${prepared.authority.componentName}`);
      expect(control.signal).toBeInstanceOf(AbortSignal);
      expect(control.signal.aborted).toBe(false);
      expect(control.deadlineEpochMs).toBe(DEADLINE_EPOCH_MS);
      const component = encryptedComponents[prepared.authority.componentIndex];
      if (!component) throw new Error("Fixture ciphertext slot is absent");
      expect(prepared.locator.key).toBe(`backups/${IDS.backup}/${component.name}/0.enc`);
      const body = component.ciphertext;
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= body.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(body.byteLength, offset + 11 + component.index);
          controller.enqueue(body.slice(offset, end));
          offset = end;
        },
      });
      const read: ExactObjectRead = {
        body: stream,
        declaredMetadata: {
          sizeBytes: body.byteLength,
          checksum: {
            algorithm: "sha256",
            encoding: "base64",
            value: checksumBase64(sha256Hex(body)),
          },
        },
        completion: Promise.resolve({
          locator: prepared.locator.receipt,
          metadata: {
            sizeBytes: body.byteLength,
            checksum: {
              algorithm: "sha256",
              encoding: "base64",
              value: checksumBase64(sha256Hex(body)),
            },
          },
          verifiedComplete: true,
        }),
      };
      return read;
    },
    keyBundle,
    revalidateAuthority(observedAuthority) {
      counts.revalidate += 1;
      const readNumber = counts.revalidate;
      events.push(`authority:read:${readNumber}`);
      expect(observedAuthority).toEqual(authority);
      if (readNumber === 2) {
        finalAuthorityKeyState.push({
          released,
          dekZeroized: allZero(dek),
          contentHmacKeyZeroized: allZero(contentHmacKey),
        });
        if (options.loseAuthorityAtFinalRead) {
          return {
            current: true,
            authority: { ...authority, catalogEpoch: "10" },
          };
        }
      }
      if (readNumber > 2) throw new Error("Unexpected third authority read");
      return { current: true, authority };
    },
    candidateSealAuthority,
    isolatedCandidateStaging: staging,
    signal: abortController.signal,
    deadlineEpochMs: DEADLINE_EPOCH_MS,
    now: () => NOW_EPOCH_MS,
  };
  return {
    input,
    manifest,
    events,
    counts,
    keyViews: { dek, contentHmacKey, released: () => released },
    finalAuthorityKeyState,
    stagedPayloadCopies,
    ephemeralStagingViews,
    sourcePayloads,
    preparedObjects,
    session,
    state: () => candidateState,
    sealedReceipt: () => durableSealedReceipt,
    consumedProofTokens,
    abortExecutionTokens,
  };
}

async function captureFailure(operation: PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected restore-v3 streaming to fail");
}

function expectBefore(events: readonly string[], first: string, second: string): void {
  expect(events.indexOf(first)).toBeGreaterThanOrEqual(0);
  expect(events.indexOf(second)).toBeGreaterThan(events.indexOf(first));
}

describe("streamAgentBackupRestoreV3", () => {
  test("authenticates five real exact objects and releases keys before final authority and seal", async () => {
    const fixture = await createFixture();

    const result = await streamAgentBackupRestoreV3(fixture.input);

    expect(result.sealed).toBe(true);
    expect(result.receipt.expectedManifestSha256).toBe(fixture.manifest.integrity.manifestSha256);
    expect(result.receipt.components.map((component) => component.componentName)).toEqual(
      AGENT_BACKUP_RESTORE_V3_STREAM_COMPONENTS,
    );
    expect(result.receipt.objectCount).toBe(5);
    expect(fixture.stagedPayloadCopies).toEqual(fixture.sourcePayloads);
    expect(fixture.ephemeralStagingViews.every((payload) => allZero(payload))).toBe(true);
    expect(fixture.counts).toEqual({
      begin: 1,
      revalidate: 2,
      unwrap: 1,
      release: 1,
      open: 5,
      stage: 5,
      finish: 5,
      authorize: 1,
      seal: 1,
      abort: 0,
    });
    expect(fixture.finalAuthorityKeyState).toEqual([
      {
        released: true,
        dekZeroized: true,
        contentHmacKeyZeroized: true,
      },
    ]);
    expect(fixture.keyViews.released()).toBe(true);
    expect(allZero(fixture.keyViews.dek)).toBe(true);
    expect(allZero(fixture.keyViews.contentHmacKey)).toBe(true);
    expect(fixture.state()).toBe("sealed");
    expect(fixture.sealedReceipt()).toEqual(result.receipt);
    expect(fixture.consumedProofTokens).toEqual(new Set(["fixture-one-shot-seal-proof"]));
    expectBefore(fixture.events, "kms:release", "authority:read:2");
    expectBefore(fixture.events, "authority:read:2", "authority:authorize-seal");
    expectBefore(fixture.events, "authority:authorize-seal", "staging:seal");
  });

  test("rejects a private locator mismatch before acquiring staging or any collaborator effect", async () => {
    const fixture = await createFixture();
    const first = fixture.preparedObjects[0];
    if (!first) throw new Error("Fixture first prepared object is absent");
    const mismatched = {
      ...first,
      locator: {
        key: first.locator.key,
        receipt: new ObjectLocatorReceipt({
          transport: first.locator.receipt.transport,
          provider: first.locator.receipt.provider,
          endpointAlias: first.locator.receipt.endpointAlias,
          backendIdentityFingerprint: first.locator.receipt.backendIdentityFingerprint,
          bucket: `${first.locator.receipt.bucket}-mismatch`,
          region: first.locator.receipt.region,
          keyFingerprint: first.locator.receipt.keyFingerprint,
          version: first.locator.receipt.version,
          versionSource: first.locator.receipt.versionSource,
        }),
      },
    };
    const failure = await captureFailure(
      streamAgentBackupRestoreV3({
        ...fixture.input,
        source: {
          ...fixture.input.source,
          objects: [mismatched, ...fixture.preparedObjects.slice(1)],
        },
      }),
    );

    expect(failure).toBeInstanceOf(AgentBackupRestoreV3StreamError);
    expect((failure as AgentBackupRestoreV3StreamError).code).toBe(
      "AGENT_BACKUP_RESTORE_V3_LOCATOR_MISMATCH",
    );
    expect(fixture.events).toEqual([]);
    expect(fixture.counts).toEqual({
      begin: 0,
      revalidate: 0,
      unwrap: 0,
      release: 0,
      open: 0,
      stage: 0,
      finish: 0,
      authorize: 0,
      seal: 0,
      abort: 0,
    });
    expect(fixture.state()).toBe("idle");
  });

  test("aborts isolated staging when durable authority is lost on the final read", async () => {
    const fixture = await createFixture({ loseAuthorityAtFinalRead: true });

    const failure = await captureFailure(streamAgentBackupRestoreV3(fixture.input));

    expect(failure).toBeInstanceOf(AgentBackupRestoreV3StreamError);
    expect((failure as AgentBackupRestoreV3StreamError).code).toBe(
      "AGENT_BACKUP_RESTORE_V3_AUTHORITY_STALE",
    );
    expect(fixture.counts.revalidate).toBe(2);
    expect(fixture.counts.release).toBe(1);
    expect(fixture.counts.authorize).toBe(0);
    expect(fixture.counts.seal).toBe(0);
    expect(fixture.counts.abort).toBe(1);
    expect(fixture.finalAuthorityKeyState).toEqual([
      {
        released: true,
        dekZeroized: true,
        contentHmacKeyZeroized: true,
      },
    ]);
    expect(fixture.state()).toBe("aborted");
    expectBefore(fixture.events, "kms:release", "authority:read:2");
    expectBefore(fixture.events, "authority:read:2", "staging:abort-active");
  });

  test("recovers a durably sealed candidate by exact replay when its first response is lost", async () => {
    const fixture = await createFixture({ loseSealResponse: true });

    const result = await streamAgentBackupRestoreV3(fixture.input);

    expect(result.sealed).toBe(true);
    expect(result.receipt).toEqual(fixture.sealedReceipt());
    expect(fixture.counts.authorize).toBe(1);
    expect(fixture.counts.seal).toBe(2);
    expect(fixture.counts.abort).toBe(0);
    expect(fixture.abortExecutionTokens).toEqual([]);
    expect(fixture.consumedProofTokens).toEqual(new Set(["fixture-one-shot-seal-proof"]));
    expect(fixture.state()).toBe("sealed");
    expect(fixture.sealedReceipt()).toBeDefined();
    expectBefore(fixture.events, "staging:seal", "staging:seal-exact-replay");
  });
});
