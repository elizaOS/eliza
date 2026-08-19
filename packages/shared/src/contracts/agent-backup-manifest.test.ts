/**
 * Exercises the deterministic v2 backup-manifest boundary with in-memory
 * metadata only. The suite covers canonical hashing, replay identity,
 * tenant fencing, chunk topology, numeric bounds, and explicit legacy parsing;
 * no capture, storage provider, KMS, database, or live sandbox is mocked.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
} from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_BACKUP_CHUNK_ENVELOPE_V1,
  AGENT_BACKUP_MANIFEST_FORMAT,
  AGENT_BACKUP_MANIFEST_V2_LIMITS,
  AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION,
  type AgentBackupManifestV2,
  type AgentBackupManifestV2Chunk,
  type AgentBackupManifestV2Component,
  type AgentBackupManifestV2Draft,
  type AgentBackupManifestV2RestoreAuthority,
  type AgentBackupManifestV2RestoreCapabilities,
  type AgentBackupManifestV2RestoreProviders,
  type AgentBackupSha256StreamFactory,
  abortAgentBackupManifestV2Restore,
  assertAgentBackupManifestV2Replay,
  assertAgentBackupManifestV2WireBytes,
  canonicalizeAgentBackupChunkAad,
  canonicalizeAgentBackupManifestV2,
  commitAgentBackupManifestV2Restore,
  computeAgentBackupChunkAadDigest,
  computeAgentBackupManifestV2Digest,
  createAgentBackupManifestV2,
  createAgentBackupManifestV2WireIngressBudget,
  parseAgentBackupManifestV2,
  parseAgentBackupManifestV2Json,
  parseAgentBackupManifestV2JsonStream,
  parseLegacyAgentBackupManifestV1,
  parseLegacyAgentBackupManifestV1Json,
  queryAgentBackupManifestV2RestoreCommitOutcome,
  reapAgentBackupManifestV2StagingCleanup,
  reconcileAgentBackupManifestV2RestoreCommit,
  verifyAgentBackupManifestV2ForRestore,
  verifyAgentBackupManifestV2Payload,
} from "./agent-backup-manifest.js";

const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  otherOrganization: "11111111-1111-4111-8111-111111111112",
  agent: "22222222-2222-4222-8222-222222222222",
  otherAgent: "22222222-2222-4222-8222-222222222223",
  operation: "33333333-3333-4333-8333-333333333333",
  nextOperation: "33333333-3333-4333-8333-333333333334",
  thirdOperation: "33333333-3333-4333-8333-333333333335",
  fourthOperation: "33333333-3333-4333-8333-333333333336",
  fifthOperation: "33333333-3333-4333-8333-333333333337",
  activationGeneration: "33333333-3333-4333-8333-333333333338",
  otherActivationGeneration: "33333333-3333-4333-8333-333333333339",
  nodeRecord: "44444444-4444-4444-8444-444444444444",
  cloudNodeRecord: "44444444-4444-4444-8444-444444444445",
  robotNodeIncarnation: "44444444-4444-4444-8444-444444444446",
  cloudNodeIncarnation: "44444444-4444-4444-8444-444444444447",
  staleNodeIncarnation: "44444444-4444-4444-8444-444444444448",
  restoreLease: "55555555-5555-4555-8555-555555555555",
  restoreFence: "55555555-5555-4555-8555-555555555556",
  publication: "66666666-6666-4666-8666-666666666666",
};

let restoreAttemptSequence = 0;

function restoreAttempt(): { restoreAttemptId: string } {
  restoreAttemptSequence += 1;
  return {
    restoreAttemptId: `77777777-7777-4777-8777-${restoreAttemptSequence
      .toString(16)
      .padStart(12, "0")}`,
  };
}

const TEST_WRAPPED_DEK = Buffer.alloc(64, 0x42);
const TEST_CONTENT_HMAC_KEY = Buffer.alloc(32, 0x63);

const hashes = {
  character: contentHmac(""),
  database: "c".repeat(64),
  media: contentHmac(""),
  payload: "e".repeat(64),
  stateFiles: contentHmac(""),
  vault: contentHmac(""),
};

function postgresLsn(value: string): bigint | undefined {
  const match = /^([0-9A-F]+)\/([0-9A-F]+)$/.exec(value);
  if (!match) return undefined;
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
}

const restoreCapabilities: AgentBackupManifestV2RestoreCapabilities = {
  components: {
    character: { fullFormats: ["raw-v1"], deltaFormats: ["raw-v1"] },
    database: { fullFormats: ["raw-v1"], deltaFormats: ["raw-v1"] },
    media: { fullFormats: ["raw-v1"], deltaFormats: ["raw-v1"] },
    "state-files": { fullFormats: ["raw-v1"], deltaFormats: ["raw-v1"] },
    vault: { fullFormats: ["raw-v1"], deltaFormats: ["raw-v1"] },
  },
  watermarks: {
    "database.lsn": (value, context) => {
      const current = postgresLsn(value);
      const previous = context.previousValue
        ? postgresLsn(context.previousValue)
        : undefined;
      const minimum = context.minimumValue
        ? postgresLsn(context.minimumValue)
        : undefined;
      return (
        current !== undefined &&
        (previous === undefined || current >= previous) &&
        (minimum === undefined || current >= minimum)
      );
    },
    "messages.sequence": (value, context) =>
      /^\d+$/.test(value) &&
      (context.previousValue === undefined ||
        BigInt(value) >= BigInt(context.previousValue)) &&
      (context.minimumValue === undefined ||
        BigInt(value) >= BigInt(context.minimumValue)),
  },
  requiredWatermarkNamespaces: ["database.lsn"],
  environment: "production",
  kmsProviders: ["steward"],
};

const nodeSha256Factory: AgentBackupSha256StreamFactory = () => {
  const hash = createHash("sha256");
  return {
    update(bytes) {
      hash.update(bytes);
    },
    digestHex() {
      return hash.digest("hex");
    },
  };
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentHmac(bytes: Uint8Array | string): string {
  return createHmac("sha256", TEST_CONTENT_HMAC_KEY)
    .update(bytes)
    .digest("hex");
}

function uint64(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function framedPayloadDigest(
  components: readonly AgentBackupManifestV2Component[],
  plaintext: ReadonlyMap<string, Uint8Array>,
): string {
  const digest = createHmac("sha256", TEST_CONTENT_HMAC_KEY);
  digest.update(AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION, "utf8");
  digest.update(uint64(components.length));
  for (const entry of components) {
    const name = Buffer.from(entry.name, "utf8");
    digest.update(uint64(name.byteLength));
    digest.update(name);
    digest.update(uint64(entry.totals.plainBytes));
    for (const descriptor of entry.chunks) {
      const bytes = plaintext.get(`${entry.name}:${descriptor.index}`);
      if (!bytes) throw new Error("test fixture is missing plaintext");
      digest.update(bytes);
    }
  }
  return digest.digest("hex");
}

function chunk(
  index: number,
  offsetBytes: number,
  plainBytes: number,
): AgentBackupManifestV2Chunk {
  return {
    index,
    offsetBytes,
    plainBytes,
    compressedBytes: plainBytes,
    encryptedBytes:
      plainBytes +
      AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes +
      AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
    contentHmacSha256: (index + 8192).toString(16).padStart(64, "0"),
    aadSha256: "0".repeat(64),
    sha256: (index + 2).toString(16).padStart(64, "0"),
  };
}

function chunksForSizes(
  sizes: readonly number[],
): AgentBackupManifestV2Chunk[] {
  let offsetBytes = 0;
  return sizes.map((plainBytes, index) => {
    const descriptor = chunk(index, offsetBytes, plainBytes);
    offsetBytes += plainBytes;
    return descriptor;
  });
}

function component(
  name: string,
  sizes: readonly number[],
  payloadContentHmacSha256: string,
): AgentBackupManifestV2Component {
  const chunks = chunksForSizes(sizes);
  return {
    name,
    format: "raw-v1",
    compression: "none",
    payloadContentHmacSha256,
    state: { kind: "full", resultContentHmacSha256: payloadContentHmacSha256 },
    totals: {
      plainBytes: chunks.reduce((total, entry) => total + entry.plainBytes, 0),
      compressedBytes: chunks.reduce(
        (total, entry) => total + entry.compressedBytes,
        0,
      ),
      encryptedBytes: chunks.reduce(
        (total, entry) => total + entry.encryptedBytes,
        0,
      ),
      chunkCount: chunks.length,
    },
    chunks,
  };
}

function totalsForComponents(
  components: readonly AgentBackupManifestV2Component[],
): AgentBackupManifestV2Draft["totals"] {
  return components.reduce<AgentBackupManifestV2Draft["totals"]>(
    (totals, entry) => ({
      plainBytes: totals.plainBytes + entry.totals.plainBytes,
      compressedBytes: totals.compressedBytes + entry.totals.compressedBytes,
      encryptedBytes: totals.encryptedBytes + entry.totals.encryptedBytes,
      chunkCount: totals.chunkCount + entry.totals.chunkCount,
    }),
    { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
  );
}

async function refreshChunkAad(
  draft: AgentBackupManifestV2Draft,
): Promise<AgentBackupManifestV2Draft> {
  draft.encryption.wrappedDek.ref = `backup-dek:${draft.operationId}`;
  draft.encryption.dekGenerationId = draft.operationId;
  await Promise.all(
    draft.components.flatMap((entry) =>
      entry.chunks.map(async (descriptor) => {
        descriptor.aadSha256 = await computeAgentBackupChunkAadDigest({
          identity: draft.identity,
          operationId: draft.operationId,
          component: {
            name: entry.name,
            format: entry.format,
            compression: entry.compression,
          },
          chunk: {
            index: descriptor.index,
            offsetBytes: descriptor.offsetBytes,
            plainBytes: descriptor.plainBytes,
            compressedBytes: descriptor.compressedBytes,
            contentHmacSha256: descriptor.contentHmacSha256,
          },
        });
      }),
    ),
  );
  return draft;
}

async function fixtureDraft(
  databaseSizes: readonly number[] = [4, 3],
): Promise<AgentBackupManifestV2Draft> {
  const components = [
    component("character", [], hashes.character),
    component("database", databaseSizes, hashes.database),
    component("media", [], hashes.media),
    component("state-files", [], hashes.stateFiles),
    component("vault", [], hashes.vault),
  ];
  return refreshChunkAad({
    format: AGENT_BACKUP_MANIFEST_FORMAT,
    schemaVersion: 2,
    operationId: ids.operation,
    createdAt: "2026-08-15T03:25:00.000Z",
    identity: {
      organizationId: ids.organization,
      agentId: ids.agent,
      activationGeneration: ids.activationGeneration,
      lifecycleRevision: "7",
    },
    source: {
      kind: "robot",
      provider: "hetzner",
      nodeRecordId: ids.nodeRecord,
      nodeIncarnation: ids.robotNodeIncarnation,
      nodeId: "robot-node-01",
      containerId: "container-01",
    },
    runtime: {
      imageDigest: `sha256:${"9".repeat(64)}`,
      agentSchemaVersion: "2.0.0",
      databaseSchemaVersion: "200",
      plugins: [
        { id: "@elizaos/plugin-discord", version: "2.0.0" },
        { id: "@elizaos/plugin-telegram", version: "2.0.1" },
      ],
    },
    chain: {
      kind: "full",
      baseOperationId: null,
      parentOperationId: null,
      depth: 0,
    },
    components,
    watermarks: [
      { namespace: "database.lsn", value: "0/16B6C50" },
      { namespace: "messages.sequence", value: "42001" },
    ],
    totals: totalsForComponents(components),
    encryption: {
      algorithm: "AES-256-GCM",
      dekGenerationId: ids.operation,
      envelopeVersion: 1,
      chunkEnvelope: "aes-256-gcm-v1",
      nonceBytes: 12,
      tagBytes: 16,
      noncePlacement: "prefix",
      tagPlacement: "suffix",
      aad: {
        version: 1,
        derivation: "elizaos.agent-backup.chunk-aad.v1",
      },
      kms: {
        provider: "steward",
        keyId: `org:${ids.organization}/dek/v7`,
        keyVersion: 7,
      },
      wrappedDek: {
        format: "kms-aead-envelope-v1",
        ref: `backup-dek:${ids.operation}`,
        bytes: 64,
        sha256: sha256(TEST_WRAPPED_DEK),
        contextDerivation: "elizaos.agent-backup.dek-context.v1",
      },
    },
    integrity: {
      framedContentHmacSha256: hashes.payload,
      contentAddressing: {
        algorithm: "HMAC-SHA-256",
        scope: "organization",
        derivation: "elizaos.agent-backup.content-hmac.v1",
        keyId: `org:${ids.organization}/backup-content/v7`,
        keyVersion: 7,
      },
    },
  });
}

async function encryptedPayloadFixture(options?: {
  reuseNonce?: boolean;
  framedContentHmacSha256?: string;
  contentHmacSha256?: string;
  tamperEnvelope?: "nonce" | "ciphertext" | "tag";
  tamperAad?: boolean;
}): Promise<{
  manifest: AgentBackupManifestV2;
  plaintext: Map<string, Uint8Array>;
  envelopes: Map<string, Uint8Array>;
  key: Buffer;
}> {
  const draft = await fixtureDraft([3, 3]);
  const plaintext = new Map<string, Uint8Array>([
    ["database:0", new TextEncoder().encode("abc")],
    ["database:1", new TextEncoder().encode("def")],
  ]);
  const database = draft.components[1];
  for (const descriptor of database.chunks) {
    const bytes = plaintext.get(`database:${descriptor.index}`);
    if (!bytes) throw new Error("test fixture is missing plaintext");
    descriptor.contentHmacSha256 =
      options?.contentHmacSha256 ?? contentHmac(bytes);
  }
  database.payloadContentHmacSha256 = contentHmac("abcdef");
  database.state = {
    kind: "full",
    resultContentHmacSha256: database.payloadContentHmacSha256,
  };
  draft.integrity.framedContentHmacSha256 =
    options?.framedContentHmacSha256 ??
    framedPayloadDigest(draft.components, plaintext);
  await refreshChunkAad(draft);

  const key = Buffer.alloc(32, 0x24);
  const envelopes = new Map<string, Uint8Array>();
  for (const descriptor of database.chunks) {
    const bytes = plaintext.get(`database:${descriptor.index}`);
    if (!bytes) throw new Error("test fixture is missing plaintext");
    const nonce = Buffer.alloc(AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes);
    nonce.writeUInt32BE(options?.reuseNonce ? 1 : descriptor.index + 1, 8);
    const aad = Buffer.from(
      canonicalizeAgentBackupChunkAad({
        identity: draft.identity,
        operationId: draft.operationId,
        component: {
          name: database.name,
          format: database.format,
          compression: database.compression,
        },
        chunk: {
          index: descriptor.index,
          offsetBytes: descriptor.offsetBytes,
          plainBytes: descriptor.plainBytes,
          compressedBytes: descriptor.compressedBytes,
          contentHmacSha256: descriptor.contentHmacSha256,
        },
      }),
      "utf8",
    );
    const cipher = createCipheriv("aes-256-gcm", key, nonce, {
      authTagLength: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const envelope = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
    if (options?.tamperEnvelope) {
      const tamperIndex =
        options.tamperEnvelope === "nonce"
          ? 0
          : options.tamperEnvelope === "tag"
            ? envelope.byteLength - 1
            : AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes;
      envelope[tamperIndex] ^= 1;
    }
    descriptor.sha256 = sha256(envelope);
    envelopes.set(`database:${descriptor.index}`, envelope);
  }
  if (options?.tamperAad) {
    draft.operationId = ids.nextOperation;
    await refreshChunkAad(draft);
  }
  return {
    manifest: await createAgentBackupManifestV2(draft),
    plaintext,
    envelopes,
    key,
  };
}

async function incrementalFixture(options: {
  operationId: string;
  parentOperationId: string;
  baseOperationId: string;
  depth: number;
  baseContentHmacSha256: string;
  resultContentHmacSha256: string;
  createdAt: string;
  sequence: string;
  activationGeneration?: string;
  lifecycleRevision?: string;
  contentKeyVersion?: number;
  dekGenerationId?: string;
  databaseSizes?: readonly number[];
}): Promise<AgentBackupManifestV2> {
  const draft = await fixtureDraft(options.databaseSizes);
  draft.operationId = options.operationId;
  draft.createdAt = options.createdAt;
  draft.identity.activationGeneration =
    options.activationGeneration ?? ids.activationGeneration;
  draft.identity.lifecycleRevision = options.lifecycleRevision ?? "7";
  if (options.contentKeyVersion !== undefined) {
    draft.integrity.contentAddressing.keyVersion = options.contentKeyVersion;
    draft.integrity.contentAddressing.keyId = `org:${ids.organization}/backup-content/v${options.contentKeyVersion}`;
  }
  draft.chain = {
    kind: "incremental",
    baseOperationId: options.baseOperationId,
    parentOperationId: options.parentOperationId,
    depth: options.depth,
  };
  draft.components = [
    asDelta(
      draft.components[1],
      options.baseContentHmacSha256,
      options.resultContentHmacSha256,
    ),
  ];
  draft.watermarks[1].value = options.sequence;
  draft.totals = totalsForComponents(draft.components);
  await refreshChunkAad(draft);
  if (options.dekGenerationId) {
    draft.encryption.dekGenerationId = options.dekGenerationId;
  }
  return createAgentBackupManifestV2(draft);
}

function replaceComponents(
  draft: AgentBackupManifestV2Draft,
  replacements: ReadonlyMap<string, AgentBackupManifestV2Component>,
): void {
  draft.components = draft.components.map(
    (entry) => replacements.get(entry.name) ?? entry,
  );
  draft.totals = totalsForComponents(draft.components);
}

function restoreAuthority(
  manifest: AgentBackupManifestV2,
  overrides: Partial<AgentBackupManifestV2RestoreAuthority> = {},
): AgentBackupManifestV2RestoreAuthority {
  const restoreLease = {
    leaseId: ids.restoreLease,
    fencingToken: ids.restoreFence,
    catalogEpoch: "17",
    expiresAt: "2026-08-15T05:00:00.000Z",
  };
  return {
    organizationId: manifest.identity.organizationId,
    agentId: manifest.identity.agentId,
    activationGeneration: manifest.identity.activationGeneration,
    lifecycleRevision: manifest.identity.lifecycleRevision,
    operationId: manifest.operationId,
    expectedManifestSha256: manifest.integrity.manifestSha256,
    expectedSource: manifest.source,
    expectedRuntime: manifest.runtime,
    minimumWatermarks: [manifest.watermarks[0]],
    clock: {
      trustedNow: "2026-08-15T04:00:00.000Z",
      maxFutureSkewMs: 60_000,
    },
    restoreLease,
    control: { deadlineEpochMs: Date.now() + 60_000 },
    resolveCatalogManifest: () => null,
    resolveCommitAuthority: () => ({
      restoreLease,
      trustedNow: "2026-08-15T04:01:00.000Z",
    }),
    capabilities: restoreCapabilities,
    ...overrides,
  };
}

function catalogRecord(manifest: AgentBackupManifestV2) {
  return {
    manifest,
    expectedManifestSha256: manifest.integrity.manifestSha256,
    expectedSource: manifest.source,
    expectedRuntime: manifest.runtime,
    minimumWatermarks: [manifest.watermarks[0]],
  };
}

interface TestStagingTransaction {
  session: {
    restoreAttemptId: string;
    operationId: string;
    expectedManifestSha256: string;
    stagingHandle: string;
    cleanupHandle: string;
    executionToken: string;
  };
  fragments: string[];
  finalized: string[];
  aborted: boolean;
  committed: boolean;
  commitReceipt?: {
    committed: true;
    restoreAttemptId: string;
    operationId: string;
    expectedManifestSha256: string;
    publicationId: string;
    restoreGeneration: string;
    committedAt: string;
    restoreLease: AgentBackupManifestV2RestoreAuthority["restoreLease"];
  };
}

function restoreProvidersFor(fixture: {
  envelopes: ReadonlyMap<string, Uint8Array>;
  key: Buffer;
}): {
  providers: AgentBackupManifestV2RestoreProviders;
  live: string[];
  transactions: TestStagingTransaction[];
  calls: {
    unwrap: number;
    release: number;
    commit: number;
    query: number;
    abort: number;
    reap: number;
  };
} {
  const live: string[] = [];
  const transactions: TestStagingTransaction[] = [];
  const calls = {
    unwrap: 0,
    release: 0,
    commit: 0,
    query: 0,
    abort: 0,
    reap: 0,
  };
  const byStagingHandle = new Map<string, TestStagingTransaction>();
  const byAttempt = new Map<string, TestStagingTransaction>();
  const transaction = (value: {
    stagingHandle: string;
  }): TestStagingTransaction => {
    const found = byStagingHandle.get(value.stagingHandle);
    if (!found) throw new Error("missing test staging transaction");
    return found;
  };
  const providers: AgentBackupManifestV2RestoreProviders = {
    sha256Factory: nodeSha256Factory,
    contentHmacFactory: () => {
      const hmac = createHmac("sha256", TEST_CONTENT_HMAC_KEY);
      return {
        update(bytes) {
          hmac.update(bytes);
        },
        digestHex() {
          return hmac.digest("hex");
        },
      };
    },
    loadWrappedDek: () => Uint8Array.from(TEST_WRAPPED_DEK),
    unwrapDek: () => {
      calls.unwrap += 1;
      return fixture.key;
    },
    releaseDek: () => {
      calls.release += 1;
      return true;
    },
    loadEncryptedChunk: ({ component, chunk }) => {
      const envelope = fixture.envelopes.get(
        `${component.name}:${chunk.index}`,
      );
      if (!envelope) throw new Error("test fixture is missing an envelope");
      return Uint8Array.from(envelope);
    },
    decryptChunk: (input) => {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        fixture.key,
        input.nonce,
        { authTagLength: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes },
      );
      decipher.setAAD(input.aad);
      decipher.setAuthTag(input.tag);
      return Buffer.concat([
        decipher.update(input.ciphertext),
        decipher.final(),
      ]);
    },
    decompressChunk: ({ compressedPlaintext }) => [
      Uint8Array.from(compressedPlaintext),
    ],
    staging: {
      begin: ({ restoreAttemptId, restore }) => {
        if (byAttempt.has(restoreAttemptId)) {
          throw new Error("durable restore attempt is already claimed");
        }
        const suffix = (transactions.length + 1).toString(16).padStart(12, "0");
        const session = {
          restoreAttemptId,
          operationId: restore.manifest.operationId,
          expectedManifestSha256: restore.manifest.integrity.manifestSha256,
          stagingHandle: `88888888-8888-4888-8888-${suffix}`,
          cleanupHandle: `99999999-9999-4999-8999-${suffix}`,
          executionToken: `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`,
        };
        const value: TestStagingTransaction = {
          session,
          fragments: [],
          finalized: [],
          aborted: false,
          committed: false,
        };
        transactions.push(value);
        byStagingHandle.set(session.stagingHandle, value);
        byAttempt.set(session.restoreAttemptId, value);
        return session;
      },
      stagePlaintextFragment: (value, fragment) => {
        transaction(value).fragments.push(
          `${fragment.manifest.operationId}:${fragment.component.name}:${fragment.chunk.index}:${Buffer.from(fragment.plaintext).toString("utf8")}`,
        );
        return true;
      },
      finalizeComponent: (value, request) => {
        transaction(value).finalized.push(
          `${request.manifest.operationId}:${request.component.name}`,
        );
        return {
          accepted: true,
          resultContentHmacSha256:
            request.component.state.resultContentHmacSha256,
          tombstoneCount:
            request.component.state.kind === "delta"
              ? request.component.state.tombstoneCount
              : 0,
          emptyPayloadValidated: true,
        };
      },
      seal: (_value, receipt) => receipt,
      commit: (value, request) => {
        calls.commit += 1;
        const staged = transaction(value);
        if (!staged.committed) live.push(...staged.fragments);
        staged.committed = true;
        staged.commitReceipt ??= {
          committed: true,
          restoreAttemptId: value.restoreAttemptId,
          operationId: value.operationId,
          expectedManifestSha256: value.expectedManifestSha256,
          publicationId: ids.publication,
          restoreGeneration: "18",
          committedAt: "2026-08-15T04:02:00.000Z",
          restoreLease: request.commitAuthority.restoreLease,
        };
        return staged.commitReceipt;
      },
      queryCommitOutcome: (value) => {
        calls.query += 1;
        const staged = transaction(value);
        return staged.commitReceipt
          ? { status: "committed" as const, receipt: staged.commitReceipt }
          : { status: "not-committed" as const };
      },
      abort: (value) => {
        calls.abort += 1;
        const staged = transaction(value);
        staged.fragments.length = 0;
        staged.aborted = true;
        byAttempt.delete(value.restoreAttemptId);
        return {
          restoreAttemptId: value.restoreAttemptId,
          cleanupHandle: value.cleanupHandle,
          status: "complete" as const,
        };
      },
      reapCleanup: (request) => {
        calls.reap += 1;
        const staged = transactions.find(
          (entry) => entry.session.cleanupHandle === request.cleanupHandle,
        );
        if (staged) {
          staged.fragments.length = 0;
          staged.aborted = true;
          byAttempt.delete(request.restoreAttemptId);
        }
        return { ...request, status: "complete" as const };
      },
    },
  };
  return { providers, live, transactions, calls };
}

function asDelta(
  componentValue: AgentBackupManifestV2Component,
  baseContentHmacSha256: string,
  resultContentHmacSha256: string,
): AgentBackupManifestV2Component {
  return {
    ...componentValue,
    state: {
      kind: "delta",
      baseContentHmacSha256,
      resultContentHmacSha256,
      tombstoneCount: 0,
      overlayOrder: "delete-then-upsert",
    },
  };
}

describe("agent backup manifest v2", () => {
  it("seals and parses a provider-neutral full Robot manifest", async () => {
    const manifest = await createAgentBackupManifestV2(await fixtureDraft());

    await expect(parseAgentBackupManifestV2(manifest)).resolves.toEqual(
      manifest,
    );
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest),
      ),
    ).resolves.toMatchObject({ manifest, chain: [{ manifest }] });
    expect(manifest.integrity.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(manifest)).not.toContain("ciphertext");
    expect(JSON.stringify(manifest)).not.toMatch(
      /plaintextSha256|payloadSha256|resultPlaintextSha256/,
    );
  });

  it("freezes authenticated manifests and snapshots policy before validators", async () => {
    const manifest = await createAgentBackupManifestV2(await fixtureDraft());
    let mutationSucceeded = true;
    const capabilities: AgentBackupManifestV2RestoreCapabilities = {
      ...restoreCapabilities,
      components: { ...restoreCapabilities.components },
      watermarks: {
        "database.lsn": (_value, context) => {
          mutationSucceeded = Reflect.set(
            context.manifest.identity,
            "agentId",
            ids.otherAgent,
          );
          (
            capabilities.components as Record<
              string,
              AgentBackupManifestV2RestoreCapabilities["components"][string]
            >
          ).database = {
            fullFormats: ["attacker-format"],
            deltaFormats: [],
          };
          return context.manifest.identity.agentId === ids.agent;
        },
        "messages.sequence": () => true,
      },
    };

    const verified = await verifyAgentBackupManifestV2ForRestore(
      manifest,
      restoreAuthority(manifest, { capabilities }),
    );
    expect(mutationSucceeded).toBe(false);
    expect(verified.manifest.identity.agentId).toBe(ids.agent);
    expect(Object.isFrozen(verified.manifest.identity)).toBe(true);
  });

  it("applies the authority deadline to watermark decoders", async () => {
    const manifest = await createAgentBackupManifestV2(await fixtureDraft());
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, {
          capabilities: {
            ...restoreCapabilities,
            watermarks: {
              ...restoreCapabilities.watermarks,
              "database.lsn": () => new Promise(() => undefined),
            },
          },
          control: { deadlineEpochMs: Date.now() + 20 },
        }),
      ),
    ).rejects.toThrow(/deadline/);
  });

  it("requires UUID ledger and boot identities while leaving runtime handles opaque", async () => {
    const invalidAgent = await fixtureDraft();
    invalidAgent.identity.agentId = "agent-not-a-uuid";
    await expect(createAgentBackupManifestV2(invalidAgent)).rejects.toThrow(
      /UUID|uuid/,
    );

    const invalidNodeRecord = await fixtureDraft();
    invalidNodeRecord.source.nodeRecordId = "robot-node-not-a-uuid";
    await expect(
      createAgentBackupManifestV2(invalidNodeRecord),
    ).rejects.toThrow(/UUID|uuid/);

    const invalidNodeIncarnation = await fixtureDraft();
    invalidNodeIncarnation.source.nodeIncarnation = 3 as unknown as string;
    await expect(
      createAgentBackupManifestV2(invalidNodeIncarnation),
    ).rejects.toThrow(/nodeIncarnation|expected string/);

    const opaqueRuntimeHandles = await fixtureDraft();
    opaqueRuntimeHandles.source.nodeId = "robot-node-handle";
    opaqueRuntimeHandles.source.containerId = "docker-container-handle";
    await expect(
      createAgentBackupManifestV2(opaqueRuntimeHandles),
    ).resolves.toMatchObject({
      source: {
        nodeId: "robot-node-handle",
        containerId: "docker-container-handle",
      },
    });
  });

  it("defines a recoverable nonce-prefix and tag-suffix AES-GCM envelope", async () => {
    const manifest = await createAgentBackupManifestV2(await fixtureDraft());
    expect(manifest.encryption).toMatchObject({
      chunkEnvelope: AGENT_BACKUP_CHUNK_ENVELOPE_V1.name,
      nonceBytes: 12,
      tagBytes: 16,
      noncePlacement: "prefix",
      tagPlacement: "suffix",
      aad: {
        version: 1,
        derivation: "elizaos.agent-backup.chunk-aad.v1",
      },
    });
    const firstChunk = manifest.components[1].chunks[0];
    expect(firstChunk.encryptedBytes).toBe(
      firstChunk.compressedBytes +
        AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes +
        AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
    );
    expect(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkEncryptedBytes).toBe(
      17_825_820,
    );
    expect(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkEncryptedBytes,
    ).toBeLessThanOrEqual(32 * 1024 * 1024);

    const truncatedEnvelope = await fixtureDraft();
    truncatedEnvelope.components[1].chunks[0].encryptedBytes -= 1;
    truncatedEnvelope.components[1].totals.encryptedBytes -= 1;
    truncatedEnvelope.totals.encryptedBytes -= 1;
    await expect(
      createAgentBackupManifestV2(truncatedEnvelope),
    ).rejects.toThrow(/nonce and tag/);
  });

  it("stages a real AES-GCM restore before one atomic commit", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    );

    expect(harness.live).toEqual([]);
    expect(harness.calls).toMatchObject({ unwrap: 1, release: 1, commit: 0 });
    expect(harness.transactions[0].finalized).toHaveLength(5);
    expect(staged.componentResults).toHaveLength(5);
    await expect(
      commitAgentBackupManifestV2Restore(staged),
    ).resolves.toMatchObject({
      committed: true,
      restore: verified,
      receipt: {
        restoreAttemptId: staged.session.restoreAttemptId,
        restoreLease: verified.restoreLease,
      },
    });
    expect(harness.live).toHaveLength(2);
    expect(harness.calls.commit).toBe(1);
    await expect(commitAgentBackupManifestV2Restore(staged)).rejects.toThrow(
      /live validated staging result/,
    );

    const abandoned = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    );
    await abortAgentBackupManifestV2Restore(abandoned);
    expect(harness.transactions[1]).toMatchObject({
      fragments: [],
      aborted: true,
      committed: false,
    });
    expect(harness.live).toHaveLength(2);
  });

  it("binds one wrapped DEK unwrap to tenant, provider, and operation", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const unwrapDek = harness.providers.unwrapDek;
    let context = "";
    harness.providers.unwrapDek = (request) => {
      context = new TextDecoder().decode(request.context);
      return unwrapDek(request);
    };
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    );
    expect(JSON.parse(context)).toMatchObject({
      derivation: "elizaos.agent-backup.dek-context.v1",
      organizationId: ids.organization,
      operationId: ids.operation,
      sourceKind: "robot",
      sourceProvider: "hetzner",
      kmsProvider: "steward",
    });
    expect(harness.calls.unwrap).toBe(1);
    await abortAgentBackupManifestV2Restore(staged);

    const corrupted = restoreProvidersFor(fixture);
    corrupted.providers.loadWrappedDek = () => {
      const bytes = Uint8Array.from(TEST_WRAPPED_DEK);
      bytes[0] ^= 1;
      return bytes;
    };
    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        corrupted.providers,
        {
          deadlineEpochMs: Date.now() + 60_000,
        },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/Wrapped DEK envelope digest mismatch/);
    expect(corrupted.calls).toMatchObject({ unwrap: 0, release: 0, abort: 1 });
  });

  it("rolls back chunk N corruption after chunk N-1 was isolated", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const loadEncryptedChunk = harness.providers.loadEncryptedChunk;
    harness.providers.loadEncryptedChunk = async (context) => {
      const bytes = Uint8Array.from(await loadEncryptedChunk(context));
      if (context.chunk.index === 1) bytes[13] ^= 1;
      return bytes;
    };

    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        harness.providers,
        {
          deadlineEpochMs: Date.now() + 60_000,
        },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/Encrypted chunk digest mismatch/);
    expect(harness.transactions[0]).toMatchObject({
      fragments: [],
      aborted: true,
      committed: false,
    });
    expect(harness.calls).toMatchObject({ commit: 0, abort: 1 });
    expect(harness.live).toEqual([]);
  });

  it("rolls back decoder throws, global tamper, and nonce reuse", async () => {
    const cases = [
      {
        fixture: await encryptedPayloadFixture(),
        expected: /Backup plaintext fragment staging failed/,
      },
      {
        fixture: await encryptedPayloadFixture({
          framedContentHmacSha256: "0".repeat(64),
        }),
        expected: /Framed plaintext payload digest mismatch/,
      },
      {
        fixture: await encryptedPayloadFixture({ reuseNonce: true }),
        expected: /nonce reuse/,
      },
      {
        fixture: await encryptedPayloadFixture({
          contentHmacSha256: "0".repeat(64),
        }),
        expected: /Tenant content HMAC mismatch/,
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const verified = await verifyAgentBackupManifestV2ForRestore(
        testCase.fixture.manifest,
        restoreAuthority(testCase.fixture.manifest),
      );
      const harness = restoreProvidersFor(testCase.fixture);
      if (index === 0) {
        const staging = harness.providers.staging;
        harness.providers.staging = {
          ...staging,
          stagePlaintextFragment: async (transaction, fragment) => {
            await staging.stagePlaintextFragment(transaction, fragment);
            if (fragment.chunk.index === 1) throw new Error("decoder failed");
            return true as const;
          },
        };
      }
      await expect(
        verifyAgentBackupManifestV2Payload(
          verified,
          harness.providers,
          {
            deadlineEpochMs: Date.now() + 60_000,
          },
          restoreAttempt(),
        ),
      ).rejects.toThrow(testCase.expected);
      expect(harness.transactions[0]).toMatchObject({
        fragments: [],
        aborted: true,
        committed: false,
      });
      expect(harness.live).toEqual([]);
      expect(harness.calls.commit).toBe(0);
    }
  });

  it("redacts provider callback failures and closes a cancelled iterator", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const secretHarness = restoreProvidersFor(fixture);
    secretHarness.providers.loadEncryptedChunk = () => {
      throw new Error("token=super-secret signed-url=https://private.invalid");
    };
    const secretError = await verifyAgentBackupManifestV2Payload(
      verified,
      secretHarness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    ).catch((error: unknown) => error);
    expect(secretError).toBeInstanceOf(Error);
    expect((secretError as Error).message).toBe(
      "Encrypted backup chunk load failed",
    );
    expect(String(secretError)).not.toContain("super-secret");
    expect(secretHarness.transactions[0]).toMatchObject({ aborted: true });

    const iteratorHarness = restoreProvidersFor(fixture);
    let returned = 0;
    const cancelledIterator: AsyncIterator<Uint8Array> = {
      async next() {
        return { done: false as const, value: new Uint8Array(0) };
      },
      async return() {
        returned += 1;
        return { done: true as const, value: undefined };
      },
    };
    const cancelledStream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return cancelledIterator;
      },
    };
    iteratorHarness.providers.decompressChunk = () => cancelledStream;
    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        iteratorHarness.providers,
        { deadlineEpochMs: Date.now() + 60_000 },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/zero-length fragment/);
    expect(returned).toBe(1);
    expect(iteratorHarness.transactions[0]).toMatchObject({ aborted: true });
  });

  it("requires the decoder to validate zero-chunk full components", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const staging = harness.providers.staging;
    harness.providers.staging = {
      ...staging,
      finalizeComponent: async (transaction, request) => ({
        ...(await staging.finalizeComponent(transaction, request)),
        emptyPayloadValidated: false,
      }),
    };
    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        harness.providers,
        {
          deadlineEpochMs: Date.now() + 60_000,
        },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/Empty full component was not explicitly validated/);
    expect(harness.transactions[0]).toMatchObject({ aborted: true });
    expect(harness.live).toEqual([]);
  });

  it("rejects authenticated nonce, ciphertext, tag, and AAD tampering", async () => {
    const fixtures = [
      await encryptedPayloadFixture({ tamperEnvelope: "nonce" }),
      await encryptedPayloadFixture({ tamperEnvelope: "ciphertext" }),
      await encryptedPayloadFixture({ tamperEnvelope: "tag" }),
      await encryptedPayloadFixture({ tamperAad: true }),
    ];
    for (const fixture of fixtures) {
      const verified = await verifyAgentBackupManifestV2ForRestore(
        fixture.manifest,
        restoreAuthority(fixture.manifest),
      );
      const harness = restoreProvidersFor(fixture);
      await expect(
        verifyAgentBackupManifestV2Payload(
          verified,
          harness.providers,
          {
            deadlineEpochMs: Date.now() + 60_000,
          },
          restoreAttempt(),
        ),
      ).rejects.toThrow();
      expect(harness.transactions[0]).toMatchObject({ aborted: true });
      expect(harness.live).toEqual([]);
    }
  });

  it("keeps a durably-not-applied commit staged until explicit abort", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const staging = harness.providers.staging;
    harness.providers.staging = {
      ...staging,
      commit: () => {
        harness.calls.commit += 1;
        throw new Error("atomic publish failed");
      },
    };
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    );

    await expect(commitAgentBackupManifestV2Restore(staged)).rejects.toThrow(
      /durably recorded as not applied/,
    );
    expect(harness.transactions[0]).toMatchObject({
      fragments: expect.any(Array),
      aborted: false,
      committed: false,
    });
    expect(harness.calls).toMatchObject({ commit: 1, query: 1, abort: 0 });
    expect(harness.live).toEqual([]);
    await abortAgentBackupManifestV2Restore(staged);
    expect(harness.transactions[0]).toMatchObject({
      fragments: [],
      aborted: true,
      committed: false,
    });
  });

  it("reconciles a lost commit response to the one durable publication receipt", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const staging = harness.providers.staging;
    harness.providers.staging = {
      ...staging,
      commit: async (session, request) => {
        await staging.commit(session, request);
        throw new Error("signed-url=secret commit response was lost");
      },
    };
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    );

    await expect(
      commitAgentBackupManifestV2Restore(staged),
    ).resolves.toMatchObject({
      committed: true,
      receipt: {
        restoreAttemptId: staged.session.restoreAttemptId,
        publicationId: ids.publication,
      },
    });
    await expect(
      queryAgentBackupManifestV2RestoreCommitOutcome(
        harness.providers.staging,
        staged.session,
        { deadlineEpochMs: Date.now() + 60_000 },
      ),
    ).resolves.toMatchObject({
      status: "committed",
      receipt: { publicationId: ids.publication },
    });
    expect(harness.calls).toMatchObject({ commit: 1, query: 2, abort: 0 });
    expect(harness.live).toHaveLength(2);
  });

  it("never aborts while the durable commit outcome remains ambiguous", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    harness.providers.staging = {
      ...harness.providers.staging,
      commit: () => {
        harness.calls.commit += 1;
        throw new Error("transport failed after dispatch");
      },
      queryCommitOutcome: () => {
        harness.calls.query += 1;
        return { status: "pending" as const };
      },
    };
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    );

    await expect(commitAgentBackupManifestV2Restore(staged)).rejects.toThrow(
      /pending reconciliation/,
    );
    await expect(
      reconcileAgentBackupManifestV2RestoreCommit(staged, {
        deadlineEpochMs: Date.now() + 60_000,
      }),
    ).resolves.toEqual({ status: "pending" });
    await expect(abortAgentBackupManifestV2Restore(staged)).rejects.toThrow(
      /cannot be aborted/,
    );
    expect(harness.calls.abort).toBe(0);
    expect(harness.transactions[0]).toMatchObject({
      aborted: false,
      committed: false,
    });
  });

  it("revalidates the restore lease and catalog epoch before commit invocation", async () => {
    const fixture = await encryptedPayloadFixture();
    let revalidations = 0;
    const authority = restoreAuthority(fixture.manifest);
    authority.resolveCommitAuthority = (request) => {
      revalidations += 1;
      expect(request).toMatchObject({
        organizationId: fixture.manifest.identity.organizationId,
        agentId: fixture.manifest.identity.agentId,
        activationGeneration: fixture.manifest.identity.activationGeneration,
        lifecycleRevision: fixture.manifest.identity.lifecycleRevision,
        expectedRestoreLease: authority.restoreLease,
      });
      return {
        restoreLease: {
          ...authority.restoreLease,
          catalogEpoch: "18",
        },
        trustedNow: "2026-08-15T04:01:00.000Z",
      };
    };
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      authority,
    );
    const harness = restoreProvidersFor(fixture);
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    );

    await expect(commitAgentBackupManifestV2Restore(staged)).rejects.toThrow(
      /lease or catalog epoch changed/,
    );
    expect(revalidations).toBe(1);
    expect(harness.calls.commit).toBe(0);
    await abortAgentBackupManifestV2Restore(staged);
  });

  it("does not invoke commit authority or publication after the deadline", async () => {
    const fixture = await encryptedPayloadFixture();
    let revalidations = 0;
    const authority = restoreAuthority(fixture.manifest);
    const resolve = authority.resolveCommitAuthority;
    authority.resolveCommitAuthority = (...args) => {
      revalidations += 1;
      return resolve(...args);
    };
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      authority,
    );
    const harness = restoreProvidersFor(fixture);
    const deadlineEpochMs = Date.now() + 60_000;
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs },
      restoreAttempt(),
    );
    const now = vi.spyOn(Date, "now").mockReturnValue(deadlineEpochMs);
    try {
      await expect(commitAgentBackupManifestV2Restore(staged)).rejects.toThrow(
        /deadline/,
      );
    } finally {
      now.mockRestore();
    }
    expect(revalidations).toBe(0);
    expect(harness.calls.commit).toBe(0);
    await abortAgentBackupManifestV2Restore(staged);
  });

  it("durably fences concurrent workers by restoreAttemptId", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const attempt = restoreAttempt();
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      attempt,
    );
    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        harness.providers,
        { deadlineEpochMs: Date.now() + 60_000 },
        attempt,
      ),
    ).rejects.toThrow(/attempt acquisition failed/);
    expect(harness.transactions).toHaveLength(1);
    await abortAgentBackupManifestV2Restore(staged);
  });

  it("cleans up a valid durable session whose authority mismatches", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const staging = harness.providers.staging;
    harness.providers.staging = {
      ...staging,
      begin: async (request) => {
        const session = await staging.begin(request);
        return { ...session, operationId: ids.nextOperation };
      },
    };

    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        harness.providers,
        { deadlineEpochMs: Date.now() + 60_000 },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/mismatched durable session/);
    expect(harness.calls.abort).toBe(1);
    expect(harness.transactions).toHaveLength(1);
    expect(harness.transactions[0]).toMatchObject({
      fragments: [],
      aborted: true,
      committed: false,
    });
  });

  it("retains a cleanup handle until the durable reaper succeeds", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const staging = harness.providers.staging;
    harness.providers.staging = {
      ...staging,
      abort: (session) => {
        harness.calls.abort += 1;
        return {
          restoreAttemptId: session.restoreAttemptId,
          cleanupHandle: session.cleanupHandle,
          status: "pending" as const,
        };
      },
    };
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    );

    await expect(
      abortAgentBackupManifestV2Restore(staged),
    ).rejects.toMatchObject({
      restoreAttemptId: staged.session.restoreAttemptId,
      cleanupHandle: staged.session.cleanupHandle,
    });
    await expect(
      reapAgentBackupManifestV2StagingCleanup(
        staging,
        {
          restoreAttemptId: staged.session.restoreAttemptId,
          cleanupHandle: staged.session.cleanupHandle,
        },
        { deadlineEpochMs: Date.now() + 60_000 },
      ),
    ).resolves.toMatchObject({ status: "complete" });
    expect(harness.transactions[0]).toMatchObject({
      aborted: true,
      fragments: [],
    });
  });

  it("keeps failed rollback state retryable and forbids duplicate publication", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const staging = harness.providers.staging;
    let abortAttempts = 0;
    harness.providers.staging = {
      ...staging,
      abort: (transaction, reason, control) => {
        abortAttempts += 1;
        if (abortAttempts === 1) {
          harness.calls.abort += 1;
          throw new Error("transient rollback failure");
        }
        return staging.abort(transaction, reason, control);
      },
    };
    const staged = await verifyAgentBackupManifestV2Payload(
      verified,
      harness.providers,
      { deadlineEpochMs: Date.now() + 60_000 },
      restoreAttempt(),
    );

    await expect(abortAgentBackupManifestV2Restore(staged)).rejects.toThrow(
      /Backup staging rollback failed/,
    );
    await expect(
      abortAgentBackupManifestV2Restore(staged),
    ).resolves.toMatchObject({
      restoreAttemptId: staged.session.restoreAttemptId,
      status: "complete",
    });
    await expect(commitAgentBackupManifestV2Restore(staged)).rejects.toThrow(
      /live validated staging result/,
    );
    expect(harness.calls.abort).toBe(2);
    expect(harness.live).toEqual([]);
  });

  it("aborts isolated staging on cancellation and deadline", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );

    const cancelled = restoreProvidersFor(fixture);
    const controller = new AbortController();
    const loadEncryptedChunk = cancelled.providers.loadEncryptedChunk;
    cancelled.providers.loadEncryptedChunk = async (context) => {
      controller.abort();
      return loadEncryptedChunk(context);
    };
    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        cancelled.providers,
        {
          deadlineEpochMs: Date.now() + 60_000,
          signal: controller.signal,
        },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/cancelled|aborted/);
    expect(cancelled.transactions[0]).toMatchObject({ aborted: true });
    expect(cancelled.live).toEqual([]);

    const expired = restoreProvidersFor(fixture);
    expired.providers.decompressChunk = () => ({
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      }),
    });
    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        expired.providers,
        {
          deadlineEpochMs: Date.now() + 20,
        },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/deadline/);
    expect(expired.transactions[0]).toMatchObject({ aborted: true });
    expect(expired.live).toEqual([]);
  });

  it("releases a data key whose unwrap finishes after the deadline", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    let finishUnwrap: ((dataKey: Buffer) => void) | undefined;
    harness.providers.unwrapDek = () =>
      new Promise<Buffer>((resolve) => {
        finishUnwrap = resolve;
      });

    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        harness.providers,
        { deadlineEpochMs: Date.now() + 20 },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/deadline/);
    expect(harness.transactions[0]).toMatchObject({ aborted: true });
    expect(harness.calls.release).toBe(0);

    finishUnwrap?.(fixture.key);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.calls.release).toBe(1);
    expect(harness.live).toEqual([]);
  });

  it("releases a data key returned while its unwrap cancels the operation", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    const controller = new AbortController();
    harness.providers.unwrapDek = () => {
      controller.abort();
      return fixture.key;
    };

    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        harness.providers,
        {
          deadlineEpochMs: Date.now() + 60_000,
          signal: controller.signal,
        },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.calls.release).toBe(1);
    expect(harness.transactions[0]).toMatchObject({ aborted: true });
    expect(harness.live).toEqual([]);
  });

  it("supports a bounded incremental manifest sourced from a Cloud node", async () => {
    const draft = await fixtureDraft();
    draft.operationId = ids.nextOperation;
    draft.source = {
      kind: "cloud",
      provider: "hetzner",
      nodeRecordId: ids.cloudNodeRecord,
      nodeIncarnation: ids.cloudNodeIncarnation,
      nodeId: "cloud-node-02",
      containerId: "container-02",
      providerServerId: "4242",
    };
    draft.chain = {
      kind: "incremental",
      baseOperationId: ids.operation,
      parentOperationId: ids.operation,
      depth: 1,
    };
    draft.components = [
      asDelta(draft.components[1], hashes.database, "a".repeat(64)),
    ];
    draft.totals = totalsForComponents(draft.components);
    await refreshChunkAad(draft);

    const parsed = await createAgentBackupManifestV2(draft);

    expect(parsed.chain).toEqual({
      kind: "incremental",
      baseOperationId: ids.operation,
      parentOperationId: ids.operation,
      depth: 1,
    });
    expect(parsed.source).toMatchObject({
      kind: "cloud",
      providerServerId: "4242",
    });

    const nonCanonicalServer = structuredClone(draft);
    (
      nonCanonicalServer.source as Extract<
        AgentBackupManifestV2Draft["source"],
        { kind: "cloud" }
      >
    ).providerServerId = "server-4242";
    await expect(
      createAgentBackupManifestV2(nonCanonicalServer),
    ).rejects.toThrow(/uint64|decimal/);
  });

  it("returns one immutable, trusted oldest-to-newest catalog chain", async () => {
    const full = await createAgentBackupManifestV2(await fixtureDraft());
    const depthOne = await incrementalFixture({
      operationId: ids.nextOperation,
      parentOperationId: ids.operation,
      baseOperationId: ids.operation,
      depth: 1,
      baseContentHmacSha256: hashes.database,
      resultContentHmacSha256: "a".repeat(64),
      createdAt: "2026-08-15T03:26:00.000Z",
      sequence: "42002",
    });
    const depthTwo = await incrementalFixture({
      operationId: ids.thirdOperation,
      parentOperationId: ids.nextOperation,
      baseOperationId: ids.operation,
      depth: 2,
      baseContentHmacSha256: "a".repeat(64),
      resultContentHmacSha256: "b".repeat(64),
      createdAt: "2026-08-15T03:27:00.000Z",
      sequence: "42003",
    });
    const catalog = new Map([
      [full.operationId, catalogRecord(full)],
      [depthOne.operationId, catalogRecord(depthOne)],
    ]);
    const verified = await verifyAgentBackupManifestV2ForRestore(
      depthTwo,
      restoreAuthority(depthTwo, {
        resolveCatalogManifest: (operationId) =>
          catalog.get(operationId) ?? null,
      }),
    );

    expect(verified.chain.map((entry) => entry.manifest.operationId)).toEqual([
      ids.operation,
      ids.nextOperation,
      ids.thirdOperation,
    ]);
    expect(verified.chain.map((entry) => entry.expectedManifestSha256)).toEqual(
      [
        full.integrity.manifestSha256,
        depthOne.integrity.manifestSha256,
        depthTwo.integrity.manifestSha256,
      ],
    );
    expect(Object.isFrozen(verified.chain)).toBe(true);
    expect(Object.isFrozen(verified.chain[0].manifest.components)).toBe(true);
  });

  it("requires exact depth/base/parent lineage and a complete trusted catalog", async () => {
    const depthOneWrongParent = await fixtureDraft();
    depthOneWrongParent.operationId = ids.thirdOperation;
    depthOneWrongParent.chain = {
      kind: "incremental",
      baseOperationId: ids.operation,
      parentOperationId: ids.nextOperation,
      depth: 1,
    };
    depthOneWrongParent.components = [
      asDelta(
        depthOneWrongParent.components[1],
        hashes.database,
        "a".repeat(64),
      ),
    ];
    depthOneWrongParent.totals = totalsForComponents(
      depthOneWrongParent.components,
    );
    await refreshChunkAad(depthOneWrongParent);
    await expect(
      createAgentBackupManifestV2(depthOneWrongParent),
    ).rejects.toThrow(/Depth-1 incremental parent/);

    const depthTwoSkipsParent = structuredClone(depthOneWrongParent);
    depthTwoSkipsParent.chain = {
      kind: "incremental",
      baseOperationId: ids.operation,
      parentOperationId: ids.operation,
      depth: 2,
    };
    await expect(
      createAgentBackupManifestV2(depthTwoSkipsParent),
    ).rejects.toThrow(/must not skip directly/);

    const full = await createAgentBackupManifestV2(await fixtureDraft());
    const incremental = await incrementalFixture({
      operationId: ids.nextOperation,
      parentOperationId: ids.operation,
      baseOperationId: ids.operation,
      depth: 1,
      baseContentHmacSha256: hashes.database,
      resultContentHmacSha256: "a".repeat(64),
      createdAt: "2026-08-15T03:26:00.000Z",
      sequence: "42002",
    });
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        incremental,
        restoreAuthority(incremental),
      ),
    ).rejects.toThrow(/missing from the trusted catalog/);
    const privateCatalogError = await verifyAgentBackupManifestV2ForRestore(
      incremental,
      restoreAuthority(incremental),
    ).catch((cause: unknown) => String(cause));
    expect(privateCatalogError).not.toContain(ids.operation);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        incremental,
        restoreAuthority(incremental, {
          resolveCatalogManifest: () => ({
            ...catalogRecord(full),
            expectedManifestSha256: "0".repeat(64),
          }),
        }),
      ),
    ).rejects.toThrow(/digest does not match trusted authority/);
  });

  it("enforces delta-only payloads, explicit overlay order, and compaction depth", async () => {
    const fullWithDelta = await fixtureDraft();
    fullWithDelta.components[1] = asDelta(
      fullWithDelta.components[1],
      hashes.database,
      "a".repeat(64),
    );
    await expect(createAgentBackupManifestV2(fullWithDelta)).rejects.toThrow(
      /Full manifests require full component snapshots/,
    );

    const emptyDelta = await fixtureDraft();
    emptyDelta.operationId = ids.nextOperation;
    emptyDelta.chain = {
      kind: "incremental",
      baseOperationId: ids.operation,
      parentOperationId: ids.operation,
      depth: 1,
    };
    emptyDelta.components = [
      asDelta(
        component("database", [], contentHmac("")),
        hashes.database,
        "a".repeat(64),
      ),
    ];
    emptyDelta.totals = totalsForComponents(emptyDelta.components);
    await expect(createAgentBackupManifestV2(emptyDelta)).rejects.toThrow(
      /Delta components must encode/,
    );

    const badOverlayOrder = await fixtureDraft();
    badOverlayOrder.operationId = ids.nextOperation;
    badOverlayOrder.chain = {
      kind: "incremental",
      baseOperationId: ids.operation,
      parentOperationId: ids.operation,
      depth: 1,
    };
    badOverlayOrder.components = [
      asDelta(badOverlayOrder.components[1], hashes.database, "a".repeat(64)),
    ];
    (
      badOverlayOrder.components[0].state as {
        overlayOrder: string;
      }
    ).overlayOrder = "upsert-then-delete";
    badOverlayOrder.totals = totalsForComponents(badOverlayOrder.components);
    await expect(
      createAgentBackupManifestV2(badOverlayOrder),
    ).rejects.toThrow();

    const overDepth = await fixtureDraft();
    overDepth.operationId = ids.thirdOperation;
    overDepth.chain = {
      kind: "incremental",
      baseOperationId: ids.operation,
      parentOperationId: ids.nextOperation,
      depth: AGENT_BACKUP_MANIFEST_V2_LIMITS.maxIncrementalDepth + 1,
    };
    overDepth.components = [
      asDelta(overDepth.components[1], hashes.database, "a".repeat(64)),
    ];
    overDepth.totals = totalsForComponents(overDepth.components);
    await expect(createAgentBackupManifestV2(overDepth)).rejects.toThrow();
  });

  it("rejects non-monotone time/watermarks, broken overlay, and generation changes", async () => {
    const full = await createAgentBackupManifestV2(await fixtureDraft());
    const record = catalogRecord(full);
    const cases = [
      await incrementalFixture({
        operationId: ids.nextOperation,
        parentOperationId: ids.operation,
        baseOperationId: ids.operation,
        depth: 1,
        baseContentHmacSha256: "0".repeat(64),
        resultContentHmacSha256: "a".repeat(64),
        createdAt: "2026-08-15T03:26:00.000Z",
        sequence: "42002",
      }),
      await incrementalFixture({
        operationId: ids.nextOperation,
        parentOperationId: ids.operation,
        baseOperationId: ids.operation,
        depth: 1,
        baseContentHmacSha256: hashes.database,
        resultContentHmacSha256: "a".repeat(64),
        createdAt: "2026-08-15T03:24:00.000Z",
        sequence: "42002",
      }),
      await incrementalFixture({
        operationId: ids.nextOperation,
        parentOperationId: ids.operation,
        baseOperationId: ids.operation,
        depth: 1,
        baseContentHmacSha256: hashes.database,
        resultContentHmacSha256: "a".repeat(64),
        createdAt: "2026-08-15T03:26:00.000Z",
        sequence: "1",
      }),
      await incrementalFixture({
        operationId: ids.nextOperation,
        parentOperationId: ids.operation,
        baseOperationId: ids.operation,
        depth: 1,
        baseContentHmacSha256: hashes.database,
        resultContentHmacSha256: "a".repeat(64),
        createdAt: "2026-08-15T03:26:00.000Z",
        sequence: "42002",
        lifecycleRevision: "8",
      }),
      await incrementalFixture({
        operationId: ids.nextOperation,
        parentOperationId: ids.operation,
        baseOperationId: ids.operation,
        depth: 1,
        baseContentHmacSha256: hashes.database,
        resultContentHmacSha256: "a".repeat(64),
        createdAt: "2026-08-15T03:26:00.000Z",
        sequence: "42002",
        activationGeneration: ids.otherActivationGeneration,
      }),
    ];

    await expect(
      verifyAgentBackupManifestV2ForRestore(
        cases[0],
        restoreAuthority(cases[0], { resolveCatalogManifest: () => record }),
      ),
    ).rejects.toThrow(/does not overlay/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        cases[1],
        restoreAuthority(cases[1], { resolveCatalogManifest: () => record }),
      ),
    ).rejects.toThrow(/createdAt/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        cases[2],
        restoreAuthority(cases[2], { resolveCatalogManifest: () => record }),
      ),
    ).rejects.toThrow(/rejected watermark/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        cases[3],
        restoreAuthority(cases[3], { resolveCatalogManifest: () => record }),
      ),
    ).rejects.toThrow(/lifecycle revision/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        cases[4],
        restoreAuthority(cases[4], { resolveCatalogManifest: () => record }),
      ),
    ).rejects.toThrow(/activation generation/);
  });

  it("requires a new full backup when the tenant content-HMAC key rotates", async () => {
    const full = await createAgentBackupManifestV2(await fixtureDraft());
    const incremental = await incrementalFixture({
      operationId: ids.nextOperation,
      parentOperationId: ids.operation,
      baseOperationId: ids.operation,
      depth: 1,
      baseContentHmacSha256: hashes.database,
      resultContentHmacSha256: "a".repeat(64),
      createdAt: "2026-08-15T03:26:00.000Z",
      sequence: "42001",
      contentKeyVersion: 8,
    });
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        incremental,
        restoreAuthority(incremental, {
          resolveCatalogManifest: () => catalogRecord(full),
        }),
      ),
    ).rejects.toThrow(/key rotation requires compaction/);
  });

  it("rejects reuse of one DEK generation across backup operations", async () => {
    const full = await createAgentBackupManifestV2(await fixtureDraft());
    const incremental = await incrementalFixture({
      operationId: ids.nextOperation,
      parentOperationId: ids.operation,
      baseOperationId: ids.operation,
      depth: 1,
      baseContentHmacSha256: hashes.database,
      resultContentHmacSha256: "a".repeat(64),
      createdAt: "2026-08-15T03:26:00.000Z",
      sequence: "42002",
      dekGenerationId: full.encryption.dekGenerationId,
    });
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        incremental,
        restoreAuthority(incremental, {
          resolveCatalogManifest: () => catalogRecord(full),
        }),
      ),
    ).rejects.toThrow(/reused a per-operation DEK generation/);
  });

  it("rejects a catalog chain whose cumulative plaintext exceeds its cap", async () => {
    const chunkSizes = Array.from(
      { length: 64 },
      () => AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkPlainBytes,
    );
    const full = await createAgentBackupManifestV2(
      await fixtureDraft(chunkSizes),
    );
    const operations = [
      ids.nextOperation,
      ids.thirdOperation,
      ids.fourthOperation,
      ids.fifthOperation,
    ];
    const results = ["a", "b", "d", "f"].map((value) => value.repeat(64));
    const chain: AgentBackupManifestV2[] = [full];
    let previousOperationId = full.operationId;
    let previousDigest = hashes.database;
    for (const [index, operationId] of operations.entries()) {
      const manifest = await incrementalFixture({
        operationId,
        parentOperationId: previousOperationId,
        baseOperationId: full.operationId,
        depth: index + 1,
        baseContentHmacSha256: previousDigest,
        resultContentHmacSha256: results[index],
        createdAt: `2026-08-15T03:${String(26 + index).padStart(2, "0")}:00.000Z`,
        sequence: String(42_001 + index),
        databaseSizes: chunkSizes,
      });
      chain.push(manifest);
      previousOperationId = operationId;
      previousDigest = results[index];
    }
    const target = chain.at(-1);
    if (!target) throw new Error("test chain is empty");
    const catalog = new Map(
      chain
        .slice(0, -1)
        .map((manifest) => [manifest.operationId, catalogRecord(manifest)]),
    );
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        target,
        restoreAuthority(target, {
          resolveCatalogManifest: (operationId) =>
            catalog.get(operationId) ?? null,
        }),
      ),
    ).rejects.toThrow(/cumulative limits/);
  }, 30_000);

  it("returns the authoritative result for the same operation and canonical payload", async () => {
    const draft = await fixtureDraft();
    const reordered: AgentBackupManifestV2Draft = {
      integrity: draft.integrity,
      encryption: draft.encryption,
      totals: draft.totals,
      watermarks: draft.watermarks,
      components: draft.components,
      chain: draft.chain,
      runtime: draft.runtime,
      source: draft.source,
      identity: {
        lifecycleRevision: draft.identity.lifecycleRevision,
        activationGeneration: draft.identity.activationGeneration,
        agentId: draft.identity.agentId,
        organizationId: draft.identity.organizationId,
      },
      createdAt: draft.createdAt,
      operationId: draft.operationId,
      schemaVersion: draft.schemaVersion,
      format: draft.format,
    };
    const [authoritative, replay] = await Promise.all([
      createAgentBackupManifestV2(draft),
      createAgentBackupManifestV2(reordered),
    ]);

    await expect(
      assertAgentBackupManifestV2Replay(authoritative, replay),
    ).resolves.toEqual(authoritative);
  });

  it("fails a different payload carrying the same operation id", async () => {
    const original = await fixtureDraft();
    const changed = await fixtureDraft();
    changed.integrity.framedContentHmacSha256 = "2".repeat(64);
    const [authoritative, conflicting] = await Promise.all([
      createAgentBackupManifestV2(original),
      createAgentBackupManifestV2(changed),
    ]);

    await expect(
      assertAgentBackupManifestV2Replay(authoritative, conflicting),
    ).rejects.toThrow(
      /same operation id carries a different canonical backup payload/i,
    );
  });

  it("rejects re-encryption under the same operation id", async () => {
    const original = await fixtureDraft();
    const reEncrypted = await fixtureDraft();
    reEncrypted.components[1].chunks[0].sha256 = "7".repeat(64);
    const [authoritative, conflicting] = await Promise.all([
      createAgentBackupManifestV2(original),
      createAgentBackupManifestV2(reEncrypted),
    ]);

    await expect(
      assertAgentBackupManifestV2Replay(authoritative, conflicting),
    ).rejects.toThrow(/different canonical backup payload/i);
  });

  it("binds each tenant-scoped plaintext content digest into normative AAD", async () => {
    const draft = await fixtureDraft();
    const firstChunk = draft.components[1].chunks[0];
    expect(firstChunk.contentHmacSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(firstChunk.aadSha256).toBe(
      await computeAgentBackupChunkAadDigest({
        identity: draft.identity,
        operationId: draft.operationId,
        component: {
          name: draft.components[1].name,
          format: draft.components[1].format,
          compression: draft.components[1].compression,
        },
        chunk: {
          index: firstChunk.index,
          offsetBytes: firstChunk.offsetBytes,
          plainBytes: firstChunk.plainBytes,
          compressedBytes: firstChunk.compressedBytes,
          contentHmacSha256: firstChunk.contentHmacSha256,
        },
      }),
    );

    firstChunk.contentHmacSha256 = "8".repeat(64);
    await expect(createAgentBackupManifestV2(draft)).rejects.toThrow(
      /Chunk AAD digest mismatch/,
    );

    const tamperedAad = await fixtureDraft();
    tamperedAad.components[1].chunks[0].aadSha256 = "9".repeat(64);
    await expect(createAgentBackupManifestV2(tamperedAad)).rejects.toThrow(
      /Chunk AAD digest mismatch/,
    );
  });

  it("uses length-prefixed global payload framing over manifest order", async () => {
    const fixture = await encryptedPayloadFixture();
    expect(fixture.manifest.integrity.framedContentHmacSha256).toBe(
      framedPayloadDigest(fixture.manifest.components, fixture.plaintext),
    );
  });

  it("validates keyed empty payloads and stops a zero-progress plaintext source", async () => {
    const fixture = await encryptedPayloadFixture();
    const verified = await verifyAgentBackupManifestV2ForRestore(
      fixture.manifest,
      restoreAuthority(fixture.manifest),
    );
    const harness = restoreProvidersFor(fixture);
    function* zeroProgress(): Generator<Uint8Array> {
      while (true) yield new Uint8Array(0);
    }
    harness.providers.decompressChunk = () => zeroProgress();
    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        harness.providers,
        {
          deadlineEpochMs: Date.now() + 60_000,
        },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/zero-length fragment/);
    expect(harness.transactions[0]).toMatchObject({ aborted: true });

    const overflow = restoreProvidersFor(fixture);
    overflow.providers.decompressChunk = ({ chunk }) => [
      new Uint8Array(chunk.plainBytes + 1),
    ];
    await expect(
      verifyAgentBackupManifestV2Payload(
        verified,
        overflow.providers,
        {
          deadlineEpochMs: Date.now() + 60_000,
        },
        restoreAttempt(),
      ),
    ).rejects.toThrow(/exceeds its output cap/);
    expect(overflow.transactions[0]).toMatchObject({ aborted: true });
  });

  it("rejects chunk removal without matching byte authority", async () => {
    const draft = await fixtureDraft();
    draft.components[1].chunks.pop();

    await expect(createAgentBackupManifestV2(draft)).rejects.toThrow(
      /does not match its chunk descriptors|does not match its chunks/,
    );
  });

  it("rejects reordered chunks", async () => {
    const draft = await fixtureDraft();
    draft.components[1].chunks.reverse();

    await expect(createAgentBackupManifestV2(draft)).rejects.toThrow(
      /Chunk index must be contiguous|Chunk offset must be contiguous/,
    );
  });

  it("rejects a duplicated chunk descriptor", async () => {
    const draft = await fixtureDraft();
    const database = draft.components[1];
    database.chunks = [
      database.chunks[0],
      database.chunks[0],
      database.chunks[1],
    ];

    await expect(createAgentBackupManifestV2(draft)).rejects.toThrow(
      /Chunk index must be contiguous|Chunk offset must be contiguous|chunkCount/,
    );
  });

  it("rejects non-canonical ordering and incomplete full component coverage", async () => {
    const reorderedWatermarks = await fixtureDraft();
    reorderedWatermarks.watermarks.reverse();
    await expect(
      createAgentBackupManifestV2(reorderedWatermarks),
    ).rejects.toThrow(/Watermarks must be unique and sorted/);

    const incompleteFull = await fixtureDraft();
    incompleteFull.components = incompleteFull.components.filter(
      (entry) => entry.name !== "vault",
    );
    incompleteFull.totals = totalsForComponents(incompleteFull.components);
    await expect(createAgentBackupManifestV2(incompleteFull)).rejects.toThrow(
      /missing required component vault/,
    );
  });

  it("fences cross-organization and cross-agent restores", async () => {
    const manifest = await createAgentBackupManifestV2(await fixtureDraft());

    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, {
          organizationId: ids.otherOrganization,
        }),
      ),
    ).rejects.toThrow(/another organization/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, { agentId: ids.otherAgent }),
      ),
    ).rejects.toThrow(/another agent/);
  });

  it("requires trusted provenance, runtime, ledger floors, and clock authority", async () => {
    const manifest = await createAgentBackupManifestV2(await fixtureDraft());
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, {
          expectedSource: {
            ...manifest.source,
            nodeIncarnation: ids.staleNodeIncarnation,
          },
        }),
      ),
    ).rejects.toThrow(/source provenance/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, {
          expectedRuntime: {
            ...manifest.runtime,
            imageDigest: `sha256:${"f".repeat(64)}`,
          },
        }),
      ),
    ).rejects.toThrow(/runtime/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, {
          minimumWatermarks: [
            { namespace: "database.lsn", value: "0/FFFFFFFF" },
          ],
        }),
      ),
    ).rejects.toThrow(/rejected watermark namespace/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, {
          clock: {
            trustedNow: "2026-08-15T03:23:00.000Z",
            maxFutureSkewMs: 0,
          },
        }),
      ),
    ).rejects.toThrow(/clock skew/);
  });

  it("requires every trusted restore authority field, especially catalog digest", async () => {
    const manifest = await createAgentBackupManifestV2(await fixtureDraft());
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, {
          expectedManifestSha256: "0".repeat(64),
        }),
      ),
    ).rejects.toThrow(/digest does not match trusted authority/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, { operationId: ids.nextOperation }),
      ),
    ).rejects.toThrow(/operation id/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, { lifecycleRevision: "8" }),
      ),
    ).rejects.toThrow(/lifecycle revision/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        manifest,
        restoreAuthority(manifest, {
          activationGeneration: ids.otherActivationGeneration,
        }),
      ),
    ).rejects.toThrow(/activation generation/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(manifest, {
        ...restoreAuthority(manifest),
        resolveCatalogManifest: undefined,
      } as unknown as AgentBackupManifestV2RestoreAuthority),
    ).rejects.toThrow(/trusted catalog resolver/);
  });

  it("keeps arbitrary formats/watermarks self-consistent but not restorable", async () => {
    const futureFormat = await fixtureDraft();
    futureFormat.components[1].format = "future-v9";
    await refreshChunkAad(futureFormat);
    const futureManifest = await createAgentBackupManifestV2(futureFormat);
    await expect(parseAgentBackupManifestV2(futureManifest)).resolves.toEqual(
      futureManifest,
    );
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        futureManifest,
        restoreAuthority(futureManifest),
      ),
    ).rejects.toThrow(/does not support full format future-v9/);

    const unsupportedWatermark = await fixtureDraft();
    unsupportedWatermark.watermarks.push({
      namespace: "runtime.cursor",
      value: "42",
    });
    unsupportedWatermark.watermarks.sort((left, right) =>
      left.namespace.localeCompare(right.namespace),
    );
    const unsupportedManifest =
      await createAgentBackupManifestV2(unsupportedWatermark);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        unsupportedManifest,
        restoreAuthority(unsupportedManifest),
      ),
    ).rejects.toThrow(/does not support watermark namespace runtime.cursor/);

    const missingRequiredWatermark = await fixtureDraft();
    missingRequiredWatermark.watermarks = [
      { namespace: "messages.sequence", value: "42001" },
    ];
    const missingManifest = await createAgentBackupManifestV2(
      missingRequiredWatermark,
    );
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        missingManifest,
        restoreAuthority(missingManifest),
      ),
    ).rejects.toThrow(/requires watermark namespace database.lsn/);

    const emptyWatermarks = await fixtureDraft();
    emptyWatermarks.watermarks = [];
    await expect(
      createAgentBackupManifestV2(emptyWatermarks),
    ).rejects.toThrow();
  });

  it("uses the real org DEK namespace and rejects ephemeral KMS creation", async () => {
    for (const provider of ["memory", "ephemeral", "arbitrary-kms"]) {
      const draft = await fixtureDraft();
      (draft.encryption.kms as { provider: string }).provider = provider;
      await expect(createAgentBackupManifestV2(draft)).rejects.toThrow();
    }

    const systemKey = await fixtureDraft();
    systemKey.encryption.kms.keyId = "system:backup/v7";
    await expect(createAgentBackupManifestV2(systemKey)).rejects.toThrow();
    const crossOrgKey = await fixtureDraft();
    crossOrgKey.encryption.kms.keyId =
      "org:11111111-1111-4111-8111-111111111112/dek/v7";
    await expect(createAgentBackupManifestV2(crossOrgKey)).rejects.toThrow(
      /scoped to identity.organizationId/,
    );
    const wrongVersion = await fixtureDraft();
    wrongVersion.encryption.kms.keyVersion = 8;
    await expect(createAgentBackupManifestV2(wrongVersion)).rejects.toThrow(
      /must match the version embedded/,
    );
    const zeroVersion = await fixtureDraft();
    zeroVersion.encryption.kms.keyVersion = 0;
    await expect(createAgentBackupManifestV2(zeroVersion)).rejects.toThrow();
    const crossOrgContentKey = await fixtureDraft();
    crossOrgContentKey.integrity.contentAddressing.keyId = `org:${ids.otherOrganization}/backup-content/v7`;
    await expect(
      createAgentBackupManifestV2(crossOrgContentKey),
    ).rejects.toThrow(/content HMAC key must be scoped/i);
    const wrongContentVersion = await fixtureDraft();
    wrongContentVersion.integrity.contentAddressing.keyVersion = 8;
    await expect(
      createAgentBackupManifestV2(wrongContentVersion),
    ).rejects.toThrow(/Content HMAC keyVersion must match/);

    const localDraft = await fixtureDraft();
    localDraft.encryption.kms.provider = "local";
    const localManifest = await createAgentBackupManifestV2(localDraft);
    await expect(parseAgentBackupManifestV2(localManifest)).resolves.toEqual(
      localManifest,
    );
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        localManifest,
        restoreAuthority(localManifest),
      ),
    ).rejects.toThrow(/does not allow KMS provider local/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        localManifest,
        restoreAuthority(localManifest, {
          capabilities: {
            ...restoreCapabilities,
            environment: "production",
            kmsProviders: ["local", "steward"],
          },
        }),
      ),
    ).rejects.toThrow(/Local KMS requires.*development/);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        localManifest,
        restoreAuthority(localManifest, {
          capabilities: {
            ...restoreCapabilities,
            environment: "development",
            kmsProviders: ["local", "steward"],
          },
        }),
      ),
    ).resolves.toMatchObject({ manifest: localManifest });

    const cloudLocalDraft = await fixtureDraft();
    cloudLocalDraft.source = {
      kind: "cloud",
      provider: "hetzner",
      nodeRecordId: ids.cloudNodeRecord,
      nodeIncarnation: ids.cloudNodeIncarnation,
      nodeId: "cloud-node-02",
      containerId: "container-02",
      providerServerId: "4242",
    };
    cloudLocalDraft.encryption.kms.provider = "local";
    const cloudLocal = await createAgentBackupManifestV2(cloudLocalDraft);
    await expect(
      verifyAgentBackupManifestV2ForRestore(
        cloudLocal,
        restoreAuthority(cloudLocal, {
          capabilities: {
            ...restoreCapabilities,
            environment: "development",
            kmsProviders: ["local", "steward"],
          },
        }),
      ),
    ).rejects.toThrow(/Cloud restores require a remote durable KMS/);
  });

  it("enforces the JSON ingress wire cap before parsing", async () => {
    const manifest = await createAgentBackupManifestV2(await fixtureDraft());
    await expect(
      parseAgentBackupManifestV2Json(JSON.stringify(manifest)),
    ).resolves.toEqual(manifest);
    const wireBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const midpoint = Math.floor(wireBytes.byteLength / 2);
          controller.enqueue(wireBytes.slice(0, midpoint));
          controller.enqueue(wireBytes.slice(midpoint));
          controller.close();
        },
      }),
    );
    await expect(
      parseAgentBackupManifestV2JsonStream(
        response.body as ReadableStream<Uint8Array>,
        wireBytes.byteLength,
      ),
    ).resolves.toEqual(manifest);
    expect(() =>
      assertAgentBackupManifestV2WireBytes(
        AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes,
      ),
    ).not.toThrow();
    expect(() =>
      assertAgentBackupManifestV2WireBytes(
        AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes + 1,
      ),
    ).toThrow(/wire payload exceeds/);
    expect(() =>
      createAgentBackupManifestV2WireIngressBudget(
        AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes + 1,
      ),
    ).toThrow(/wire payload exceeds/);
    const ingress = createAgentBackupManifestV2WireIngressBudget(7);
    expect(ingress.acceptFragment(3)).toBe(3);
    expect(ingress.acceptFragment(4)).toBe(7);
    expect(ingress.finish()).toBe(7);
    const truncated = createAgentBackupManifestV2WireIngressBudget(7);
    truncated.acceptFragment(6);
    expect(() => truncated.finish()).toThrow(/Content-Length mismatch/);
    const chunked = createAgentBackupManifestV2WireIngressBudget();
    chunked.acceptFragment(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes,
    );
    expect(() => chunked.acceptFragment(1)).toThrow(/wire payload exceeds/);
    expect(() => chunked.acceptFragment(0)).toThrow();
    let wireReturnCalls = 0;
    const oversizedStream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            index += 1;
            return index === 1
              ? {
                  done: false as const,
                  value: new Uint8Array(
                    AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes,
                  ),
                }
              : { done: false as const, value: new Uint8Array(1) };
          },
          async return() {
            wireReturnCalls += 1;
            return { done: true as const, value: undefined };
          },
        };
      },
    };
    await expect(
      parseAgentBackupManifestV2JsonStream(oversizedStream),
    ).rejects.toThrow(/wire payload exceeds/);
    expect(wireReturnCalls).toBe(1);
    await expect(
      parseAgentBackupManifestV2Json(
        " ".repeat(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes + 1),
      ),
    ).rejects.toThrow(/wire payload exceeds/);

    const oversizedObject = {
      ...manifest,
      attackerControlledUnknownField: "x".repeat(
        AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes,
      ),
    };
    await expect(parseAgentBackupManifestV2(oversizedObject)).rejects.toThrow(
      /Unrecognized key|unrecognized/i,
    );
  });

  it("rejects non-canonical lifecycle revision overflow", async () => {
    const draft = await fixtureDraft();
    draft.identity.lifecycleRevision = "18446744073709551616";

    await expect(createAgentBackupManifestV2(draft)).rejects.toThrow();
    const leadingZero = await fixtureDraft();
    leadingZero.identity.lifecycleRevision = "07";
    await expect(createAgentBackupManifestV2(leadingZero)).rejects.toThrow(
      /canonical uint64 decimal/,
    );
  });

  it("accepts the official plaintext ceiling and rejects one byte more", async () => {
    const exact = await fixtureDraft();
    const chunkCount =
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxPlainBytes /
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkPlainBytes;
    const exactDatabase = component(
      "database",
      Array.from(
        { length: chunkCount },
        () => AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkPlainBytes,
      ),
      hashes.database,
    );
    replaceComponents(exact, new Map([["database", exactDatabase]]));
    await refreshChunkAad(exact);

    await expect(createAgentBackupManifestV2(exact)).resolves.toMatchObject({
      totals: { plainBytes: AGENT_BACKUP_MANIFEST_V2_LIMITS.maxPlainBytes },
    });

    const oversized = await fixtureDraft();
    const oversizedDatabase = component(
      "database",
      [
        ...Array.from(
          { length: chunkCount },
          () => AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkPlainBytes,
        ),
        1,
      ],
      hashes.database,
    );
    replaceComponents(oversized, new Map([["database", oversizedDatabase]]));
    await refreshChunkAad(oversized);

    await expect(createAgentBackupManifestV2(oversized)).rejects.toThrow();
  });

  it("accepts the global chunk ceiling and rejects one descriptor more", async () => {
    const atLimit = await fixtureDraft();
    const perComponent = AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunksPerComponent;
    replaceComponents(
      atLimit,
      new Map([
        [
          "character",
          component(
            "character",
            new Array(perComponent).fill(1),
            hashes.character,
          ),
        ],
        [
          "database",
          component(
            "database",
            new Array(perComponent).fill(1),
            hashes.database,
          ),
        ],
      ]),
    );
    await refreshChunkAad(atLimit);

    await expect(createAgentBackupManifestV2(atLimit)).resolves.toMatchObject({
      totals: { chunkCount: AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunks },
    });

    const tooMany = await fixtureDraft();
    replaceComponents(
      tooMany,
      new Map([
        [
          "character",
          component(
            "character",
            new Array(perComponent).fill(1),
            hashes.character,
          ),
        ],
        [
          "database",
          component(
            "database",
            new Array(perComponent).fill(1),
            hashes.database,
          ),
        ],
        ["media", component("media", [1], hashes.media)],
      ]),
    );
    await refreshChunkAad(tooMany);

    const digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest");

    await expect(createAgentBackupManifestV2(tooMany)).rejects.toThrow(
      /chunk limit/,
    );
    expect(digestSpy).not.toHaveBeenCalled();
    digestSpy.mockRestore();
  }, 120_000);

  it("bounds asynchronous AAD digest concurrency", async () => {
    const draft = await fixtureDraft();
    replaceComponents(
      draft,
      new Map([
        [
          "database",
          component("database", new Array(65).fill(1), hashes.database),
        ],
      ]),
    );
    await refreshChunkAad(draft);

    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let active = 0;
    let peak = 0;
    const digestSpy = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockImplementation(async (algorithm, data) => {
        active += 1;
        peak = Math.max(peak, active);
        try {
          await Promise.resolve();
          return await originalDigest(algorithm, data);
        } finally {
          active -= 1;
        }
      });
    await createAgentBackupManifestV2(draft);
    digestSpy.mockRestore();

    expect(peak).toBeLessThanOrEqual(
      AGENT_BACKUP_MANIFEST_V2_LIMITS.maxDigestConcurrency,
    );
    expect(peak).toBeGreaterThan(1);
  });

  it("produces a stable canonical digest independent of object insertion order", async () => {
    const draft = await fixtureDraft();
    const reordered: AgentBackupManifestV2Draft = {
      integrity: draft.integrity,
      encryption: draft.encryption,
      totals: draft.totals,
      watermarks: draft.watermarks,
      components: draft.components,
      chain: draft.chain,
      runtime: draft.runtime,
      source: draft.source,
      identity: {
        lifecycleRevision: draft.identity.lifecycleRevision,
        activationGeneration: draft.identity.activationGeneration,
        agentId: draft.identity.agentId,
        organizationId: draft.identity.organizationId,
      },
      createdAt: draft.createdAt,
      operationId: draft.operationId,
      schemaVersion: 2,
      format: AGENT_BACKUP_MANIFEST_FORMAT,
    };

    expect(canonicalizeAgentBackupManifestV2(reordered)).toBe(
      canonicalizeAgentBackupManifestV2(draft),
    );
    const digest = await computeAgentBackupManifestV2Digest(draft);
    expect(digest).toBe(
      "3df7da28d746f062e7f5e19983368d1a8299952a1a3a47a1cc01af6c883c3f28",
    );
    await expect(computeAgentBackupManifestV2Digest(reordered)).resolves.toBe(
      digest,
    );
  });

  it("rejects tampered canonical digests and secret-shaped encryption fields", async () => {
    const manifest = await createAgentBackupManifestV2(await fixtureDraft());
    const tampered: AgentBackupManifestV2 = {
      ...manifest,
      integrity: {
        ...manifest.integrity,
        manifestSha256: "0".repeat(64),
      },
    };
    await expect(parseAgentBackupManifestV2(tampered)).rejects.toThrow(
      /Canonical manifest digest mismatch/,
    );

    const withCiphertext = await fixtureDraft();
    Object.assign(withCiphertext.encryption, { ciphertext: "not-allowed" });
    await expect(createAgentBackupManifestV2(withCiphertext)).rejects.toThrow(
      /Unrecognized key|unrecognized/i,
    );
  });

  it("requires explicit legacy parsing and never promotes v1 to v2", async () => {
    const legacy = {
      schemaVersion: 1,
      format: AGENT_BACKUP_MANIFEST_FORMAT,
      createdAt: "2026-08-15T03:25:00.000Z",
      agentId: ids.agent,
      components: {
        database: {},
        media: {},
        vault: {},
        character: {},
        stateFiles: {},
      },
      integrity: {
        componentHashes: {
          database: hashes.database,
          media: hashes.media,
          vault: hashes.vault,
          character: hashes.character,
          stateFiles: hashes.stateFiles,
        },
      },
    };

    const parsedLegacy = parseLegacyAgentBackupManifestV1(legacy);
    expect(parsedLegacy).toMatchObject({
      restorable: false,
      manifest: { schemaVersion: 1 },
    });
    expect(Object.isFrozen(parsedLegacy.manifest)).toBe(true);
    expect(
      parseLegacyAgentBackupManifestV1Json(JSON.stringify(legacy)).restorable,
    ).toBe(false);
    expect(() =>
      parseLegacyAgentBackupManifestV1Json(
        " ".repeat(AGENT_BACKUP_MANIFEST_V2_LIMITS.maxManifestWireBytes + 1),
      ),
    ).toThrow(/wire payload exceeds/);
    await expect(parseAgentBackupManifestV2(legacy)).rejects.toThrow();
  });
});
