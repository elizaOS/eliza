/**
 * Fail-closed capture-v2 composer. It converts authenticated agent frames into
 * provider-neutral record-stream plaintext, bounded AES-GCM ciphertext chunks,
 * and a canonical manifest-v3 backed by one operation KMS key bundle. No
 * database, storage credential, or infrastructure provider is assumed.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  computeKmsAeadOperationKeyBundleLocalReceiptDigest,
  KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  KMS_AEAD_OPERATION_KEY_BUNDLE_V1,
  type KmsAeadOperationKeyBundleHandle,
  type KmsAeadOperationKeyBundleProvider,
  type KmsAeadOperationKeyBundleWrapped,
} from "@elizaos/core/security/kms";
import {
  AGENT_BACKUP_CHUNK_ENVELOPE_V1,
  AGENT_BACKUP_MANIFEST_FORMAT,
  AGENT_BACKUP_MANIFEST_V2_LIMITS,
  AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION,
  AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
  AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1,
  AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION,
  AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
  type AgentBackupCaptureV2ComponentDescriptor,
  type AgentBackupCaptureV2Frame,
  type AgentBackupCaptureV2Request,
  type AgentBackupManifestV3,
  type AgentBackupManifestV3Draft,
  type AgentBackupManifestV3KmsProvider,
  canonicalizeAgentBackupChunkAad,
  canonicalizeAgentBackupManifestV3,
  canonicalizeAgentBackupOperationKeyBundleContext,
  computeAgentBackupChunkAadDigest,
  createAgentBackupManifestV3,
  parseAgentBackupCaptureV2Request,
  parseAgentBackupManifestV3,
  serializeAgentBackupRecordStreamV1Magic,
  serializeAgentBackupRecordStreamV1Record,
} from "@elizaos/shared";
import {
  AgentBackupCaptureV3Spool,
  type AgentBackupCaptureV3SpoolChunk,
  type AgentBackupCaptureV3SpoolConfig,
} from "./agent-backup-capture-v2-spool";

const DEFAULT_CHUNK_PLAIN_BYTES = 4 * 1024 * 1024;
const MIN_CHUNK_PLAIN_BYTES = 256 * 1024;
const MAX_HEARTBEAT_BYTES = 4 * 1024 * 1024;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface AgentBackupCaptureV3ManifestAuthority {
  /** Durable reservation time, reused byte-for-byte across retries. */
  createdAt: string;
  organizationId: string;
  source: AgentBackupManifestV3["source"];
  runtime: AgentBackupManifestV3["runtime"];
  chain: AgentBackupManifestV3["chain"];
  watermarks: AgentBackupManifestV3["watermarks"];
  vaultKeyAuthority: AgentBackupManifestV3["vaultKeyAuthority"];
  kms: {
    provider: AgentBackupManifestV3KmsProvider;
    keyId: string;
    keyVersion: number;
  };
}

export interface AgentBackupCaptureV2DigestStream {
  update(bytes: Uint8Array): void | Promise<void>;
  digestHex(): string | Promise<string>;
}

export type AgentBackupCaptureV3KeyBundleProvider = Pick<
  KmsAeadOperationKeyBundleProvider,
  "acquire" | "unwrap" | "release"
>;

export interface AgentBackupCaptureV3CatalogManifest {
  canonicalManifestDraft: string;
  format: typeof AGENT_BACKUP_MANIFEST_FORMAT;
  version: typeof AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION;
  digest: string;
  objectCount: number;
  objectInventoryDigest: string;
  imageDigest: string;
  databaseSchemaVersion: string;
  pluginSetDigest: string;
  watermarkDigest: string;
  rawSizeBytes: number;
  compressedSizeBytes: number;
  encryptedSizeBytes: number;
  kmsKeyId: string;
  kmsKeyVersion: number;
  /** Bounded KMS envelope only; capture payloads are never base64 encoded. */
  wrappedKeyBundleCiphertextBase64: string;
  wrappedKeyBundleSha256: string;
  wrappedKeyBundleLocalReceiptDigest: string;
  wrappedKeyBundleGenerationId: string;
  vaultKeyGenerationId: string;
  vaultKeyAuthorityReceiptDigest: string;
}

export interface AgentBackupCaptureV3Artifacts {
  manifest: AgentBackupManifestV3;
  catalogManifest: AgentBackupCaptureV3CatalogManifest;
  wrappedKeyBundle: Uint8Array;
  chunks: readonly AgentBackupCaptureV3SpoolChunk[];
}

interface AgentBackupCaptureV2CatalogBoundary {
  recordCaptured(input: AgentBackupCaptureV3Artifacts): Promise<true>;
}

export interface AgentBackupCaptureV2CaptureOnlyBoundary
  extends AgentBackupCaptureV2CatalogBoundary {
  /** Persist the captured manifest, but leave every ciphertext chunk in the spool. */
  mode: "capture-only";
}

export interface AgentBackupCaptureV2UploadBoundary extends AgentBackupCaptureV2CatalogBoundary {
  /** Omitted for backwards compatibility with the original publish pipeline. */
  mode?: "capture-and-upload";
  uploadPrimary(input: {
    operationId: string;
    manifestSha256: string;
    component: string;
    chunkIndex: number;
    contentHmacSha256: string;
    ciphertextSha256: string;
    encryptedBytes: number;
    body: Uint8Array;
  }): Promise<true>;
}

export type AgentBackupCaptureV2PublicationBoundary =
  | AgentBackupCaptureV2CaptureOnlyBoundary
  | AgentBackupCaptureV2UploadBoundary;

export interface RunAgentBackupCaptureV2PipelineInput {
  /**
   * Durable catalogue identity request. Its `agentId` binds manifest, spool,
   * chunk AAD, and KMS contexts; it must never be replaced by a runtime
   * character ID used to open the HTTP stream.
   */
  request: AgentBackupCaptureV2Request;
  /** SHA-256 of the canonical wire-only runtime principal authority. */
  runtimePrincipalSha256: string;
  /** Durable job execution fence bound to exclusive spool ownership. */
  executionToken: string;
  authority: AgentBackupCaptureV3ManifestAuthority;
  /**
   * Opens a fresh authenticated HTTP framed stream for initial/partial replay.
   * The transport may verify a distinct runtime character identity; returned
   * frames are ingress data only and cannot redefine durable `request` authority.
   */
  openCapture(signal?: AbortSignal): AsyncIterable<AgentBackupCaptureV2Frame>;
  spool: AgentBackupCaptureV3SpoolConfig;
  keyBundle: AgentBackupCaptureV3KeyBundleProvider;
  publication: AgentBackupCaptureV2PublicationBoundary;
  /** Lease callback must return true for the same operation execution fence. */
  heartbeat(): true | Promise<true>;
  signal?: AbortSignal;
  now?: () => number;
  chunkPlainBytes?: number;
}

interface AgentBackupCaptureV2PipelineResultBase {
  operationId: string;
  manifestSha256: string;
  chunkCount: number;
  /** Capture-only returns this handle closed; publication must reopen it. */
  spool: AgentBackupCaptureV3Spool;
}

export type AgentBackupCaptureV2PipelineResult =
  | (AgentBackupCaptureV2PipelineResultBase & {
      state: "captured-upload-pending";
      /** The spool is the only ciphertext copy and must not be cleaned yet. */
      cleanup: "blocked-on-upload";
    })
  | (AgentBackupCaptureV2PipelineResultBase & {
      state: "published-cleanup-pending";
      cleanup: "pending";
    });

export class AgentBackupCaptureV2PipelineError extends Error {
  override readonly name = "AgentBackupCaptureV2PipelineError";

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function pipelineError(code: string, message: string, cause?: unknown): never {
  throw new AgentBackupCaptureV2PipelineError(code, message, { cause });
}

async function releaseAndZeroizeKeyBundle(
  provider: AgentBackupCaptureV3KeyBundleProvider,
  handle: KmsAeadOperationKeyBundleHandle,
  keyViews: Readonly<{
    dek: Uint8Array;
    contentHmacKey: Uint8Array;
  }>,
): Promise<void> {
  let releaseFailure: unknown;
  try {
    if (provider.release(handle) !== true || !handle.released) {
      releaseFailure = new AgentBackupCaptureV2PipelineError(
        "AGENT_BACKUP_V3_KEY_BUNDLE_RELEASE_UNCONFIRMED",
        "KMS provider did not acknowledge operation key-bundle release",
      );
    }
  } catch (cause) {
    // error-policy:J3 release is mandatory and its failure remains observable.
    releaseFailure = cause;
  } finally {
    // The two views cover the exact 64-byte bundle, so local zeroization still
    // succeeds even if a non-conforming provider throws before erasing it.
    keyViews.dek.fill(0);
    keyViews.contentHmacKey.fill(0);
  }
  if (releaseFailure !== undefined) throw releaseFailure;
}

function observableKeyBundleViews(handle: unknown): Uint8Array[] {
  const views: Uint8Array[] = [];
  if (!handle || typeof handle !== "object") return views;
  try {
    const dek = (handle as { dek?: unknown }).dek;
    if (dek instanceof Uint8Array) views.push(dek);
  } catch (_invalidHandle: unknown) {
    // error-policy:J5 continue to the other independently observable view.
  }
  try {
    const contentHmacKey = (handle as { contentHmacKey?: unknown }).contentHmacKey;
    if (contentHmacKey instanceof Uint8Array && !views.includes(contentHmacKey)) {
      views.push(contentHmacKey);
    }
  } catch (_invalidHandle: unknown) {
    // error-policy:J5 release and erase every other observable view.
  }
  return views;
}

function releaseInvalidKeyBundleHandle(
  provider: AgentBackupCaptureV3KeyBundleProvider,
  handle: KmsAeadOperationKeyBundleHandle,
): void {
  const views = observableKeyBundleViews(handle);
  let releaseFailure: unknown;
  try {
    if (provider.release(handle) !== true || !handle.released) {
      releaseFailure = new AgentBackupCaptureV2PipelineError(
        "AGENT_BACKUP_V3_KEY_BUNDLE_RELEASE_UNCONFIRMED",
        "KMS provider did not acknowledge invalid operation key-bundle release",
      );
    }
  } catch (cause) {
    releaseFailure = cause;
  } finally {
    for (const view of views) view.fill(0);
  }
  if (releaseFailure !== undefined) throw releaseFailure;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function compareCanonicalComponentNames(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      pipelineError(
        "AGENT_BACKUP_V2_AUTHORITY_INVALID",
        "Backup authority contains a non-canonical number",
      );
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value !== "object" || value === undefined) {
    pipelineError(
      "AGENT_BACKUP_V2_AUTHORITY_INVALID",
      "Backup authority contains a non-JSON value",
    );
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Exact durable catalogue-handoff bytes shared by capture and replay repair. */
export function canonicalAgentBackupCaptureV3CatalogManifestBytes(
  manifest: Readonly<AgentBackupCaptureV3CatalogManifest>,
): Uint8Array {
  return new TextEncoder().encode(canonicalJson(manifest));
}

function digestCanonical(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

/** Fence a partial spool to the exact `/api/snapshot/v2` character principal. */
export function deriveAgentBackupCaptureV3RuntimePrincipalSha256(runtimeAgentId: string): string {
  return digestCanonical({
    format: "elizaos.agent-backup.capture-v3-runtime-principal.v1",
    runtimeAgentId,
  });
}

/**
 * Immutable filesystem-spool authority shared by capture and post-capture
 * publication. The HTTP deadline is deliberately absent so a fresh catalogue
 * execution can reopen an interrupted operation without weakening its fence.
 */
export function deriveAgentBackupCaptureV3SpoolAuthorityDigests(params: {
  request: Pick<
    AgentBackupCaptureV2Request,
    | "format"
    | "schemaVersion"
    | "operationId"
    | "agentId"
    | "activationGeneration"
    | "lifecycleRevision"
  >;
  authority: Readonly<AgentBackupCaptureV3ManifestAuthority>;
}): { requestSha256: string; authoritySha256: string } {
  return {
    requestSha256: digestCanonical({
      format: params.request.format,
      schemaVersion: params.request.schemaVersion,
      operationId: params.request.operationId,
      agentId: params.request.agentId,
      activationGeneration: params.request.activationGeneration,
      lifecycleRevision: params.request.lifecycleRevision,
    }),
    authoritySha256: digestCanonical(params.authority),
  };
}

function uint64BigEndian(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    pipelineError(
      "AGENT_BACKUP_V2_BYTE_ACCOUNTING_INVALID",
      "Backup byte accounting exceeded its safe range",
    );
  }
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, BigInt(value), false);
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function boundedBase64(bytes: Uint8Array): string {
  if (bytes.byteLength > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxWrappedDekBytes) {
    pipelineError(
      "AGENT_BACKUP_V3_KEY_BUNDLE_TOO_LARGE",
      "Wrapped operation key bundle exceeds the manifest envelope bound",
    );
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

async function updateDigest(
  stream: AgentBackupCaptureV2DigestStream,
  bytes: Uint8Array,
): Promise<void> {
  await stream.update(bytes);
}

async function finishDigest(stream: AgentBackupCaptureV2DigestStream): Promise<string> {
  const digest = await stream.digestHex();
  if (!HEX_SHA256_PATTERN.test(digest)) {
    pipelineError(
      "AGENT_BACKUP_V2_HMAC_PROVIDER_INVALID",
      "Content HMAC provider returned a non-SHA-256 digest",
    );
  }
  return digest;
}

function createContentHmac(key: Uint8Array): AgentBackupCaptureV2DigestStream {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    pipelineError(
      "AGENT_BACKUP_V3_KEY_BUNDLE_INVALID",
      "Operation content-HMAC key must contain exactly 32 bytes",
    );
  }
  const hmac = createHmac("sha256", key);
  let finished = false;
  return {
    update(bytes) {
      if (finished) {
        pipelineError(
          "AGENT_BACKUP_V3_HMAC_STATE_INVALID",
          "Operation content HMAC was updated after finalization",
        );
      }
      hmac.update(bytes);
    },
    digestHex() {
      if (finished) {
        pipelineError(
          "AGENT_BACKUP_V3_HMAC_STATE_INVALID",
          "Operation content HMAC was finalized more than once",
        );
      }
      finished = true;
      return hmac.digest("hex");
    },
  };
}

function assertActive(input: RunAgentBackupCaptureV2PipelineInput): void {
  if (input.signal?.aborted) {
    pipelineError(
      "AGENT_BACKUP_V2_PIPELINE_ABORTED",
      "Backup capture pipeline was cancelled",
      input.signal.reason,
    );
  }
  if ((input.now ?? Date.now)() >= input.request.deadlineEpochMs) {
    pipelineError(
      "AGENT_BACKUP_V2_PIPELINE_DEADLINE_EXCEEDED",
      "Backup capture pipeline deadline exceeded",
    );
  }
}

async function awaitWithPipelineControl<T>(
  input: RunAgentBackupCaptureV2PipelineInput,
  label: string,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  assertActive(input);
  const remainingMs = input.request.deadlineEpochMs - (input.now ?? Date.now)();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AgentBackupCaptureV2PipelineError(
            "AGENT_BACKUP_V2_PIPELINE_DEADLINE_EXCEEDED",
            `${label} exceeded the backup operation deadline`,
          ),
        ),
      Math.min(remainingMs, 2_147_483_647),
    );
    if (input.signal) {
      abortListener = () =>
        reject(
          new AgentBackupCaptureV2PipelineError(
            "AGENT_BACKUP_V2_PIPELINE_ABORTED",
            `${label} was cancelled`,
            { cause: input.signal?.reason },
          ),
        );
      input.signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener) input.signal?.removeEventListener("abort", abortListener);
  }
}

async function heartbeat(input: RunAgentBackupCaptureV2PipelineInput): Promise<void> {
  assertActive(input);
  if (
    (await awaitWithPipelineControl(input, "Backup lease heartbeat", () => input.heartbeat())) !==
    true
  ) {
    pipelineError(
      "AGENT_BACKUP_V2_PIPELINE_LEASE_LOST",
      "Backup catalogue lease heartbeat was not acknowledged",
    );
  }
  assertActive(input);
}

class BoundedPlainChunkBuilder {
  private buffer: Uint8Array;
  private length = 0;

  constructor(private readonly limit: number) {
    this.buffer = new Uint8Array(limit);
  }

  async append(part: Uint8Array, flush: (chunk: Uint8Array) => Promise<void>): Promise<void> {
    let offset = 0;
    while (offset < part.byteLength) {
      const take = Math.min(part.byteLength - offset, this.limit - this.length);
      this.buffer.set(part.subarray(offset, offset + take), this.length);
      this.length += take;
      offset += take;
      if (this.length === this.limit) {
        const full = this.buffer;
        this.buffer = new Uint8Array(this.limit);
        this.length = 0;
        try {
          await flush(full);
        } finally {
          full.fill(0);
        }
      }
    }
  }

  async finish(flush: (chunk: Uint8Array) => Promise<void>): Promise<void> {
    if (this.length === 0) return;
    const final = this.buffer.subarray(0, this.length);
    this.buffer = new Uint8Array(this.limit);
    this.length = 0;
    try {
      await flush(final);
    } finally {
      final.fill(0);
    }
  }

  release(): void {
    this.buffer.fill(0);
    this.buffer = new Uint8Array(0);
    this.length = 0;
  }
}

function zeroizeCaptureFrame(frame: AgentBackupCaptureV2Frame): void {
  if (frame.header.kind === "data") frame.payload.fill(0);
}

async function nextCaptureFrame(
  input: RunAgentBackupCaptureV2PipelineInput,
  iterator: AsyncIterator<AgentBackupCaptureV2Frame>,
): Promise<IteratorResult<AgentBackupCaptureV2Frame>> {
  const pending = Promise.resolve().then(() => iterator.next());
  try {
    return await awaitWithPipelineControl(input, "Capture ingress read", () => pending);
  } catch (cause) {
    // error-policy:J5 the losing ingress read remains observed. If an
    // uncooperative iterator eventually yields plaintext, erase it immediately.
    void pending.then(
      (late) => {
        if (!late.done) zeroizeCaptureFrame(late.value);
      },
      (_lateFailure: unknown) => undefined,
    );
    throw cause;
  }
}

async function closeCaptureIterator(
  iterator: AsyncIterator<AgentBackupCaptureV2Frame>,
): Promise<void> {
  let close: Promise<IteratorResult<AgentBackupCaptureV2Frame> | undefined>;
  try {
    close = Promise.resolve(iterator.return?.());
  } catch (_closeFailure: unknown) {
    // error-policy:J5 capture failure/deadline is authoritative and the source
    // may already have torn down synchronously.
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 250);
  });
  try {
    await Promise.race([
      close.then(
        (result) => {
          if (result && !result.done) zeroizeCaptureFrame(result.value);
        },
        (_closeFailure: unknown) => undefined,
      ),
      bounded,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function encryptAndStoreChunk(input: {
  pipeline: RunAgentBackupCaptureV2PipelineInput;
  spool: AgentBackupCaptureV3Spool;
  dek: Uint8Array;
  contentHmacKey: Uint8Array;
  descriptor: AgentBackupCaptureV2ComponentDescriptor;
  componentHmac: AgentBackupCaptureV2DigestStream;
  componentIndex: number;
  chunkIndex: number;
  offsetBytes: number;
  plaintext: Uint8Array;
  nonceOwners: Map<string, string>;
}): Promise<AgentBackupCaptureV3SpoolChunk> {
  const { pipeline, spool, descriptor, plaintext } = input;
  assertActive(pipeline);
  const chunkHmac = createContentHmac(input.contentHmacKey);
  await updateDigest(chunkHmac, plaintext);
  const contentHmacSha256 = await finishDigest(chunkHmac);
  await updateDigest(input.componentHmac, plaintext);

  const replayNonce = await spool.loadCiphertextChunkNonceForReplay(
    descriptor.name,
    input.chunkIndex,
  );
  const nonce =
    replayNonce ?? new Uint8Array(randomBytes(AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes));
  const nonceHex = bytesToHex(nonce);
  const owner = `${descriptor.name}:${input.chunkIndex}`;
  const priorOwner = input.nonceOwners.get(nonceHex);
  if (priorOwner && priorOwner !== owner) {
    pipelineError(
      "AGENT_BACKUP_V2_NONCE_REUSE",
      "AES-GCM nonce is already owned by another chunk in this operation",
    );
  }
  input.nonceOwners.set(nonceHex, owner);

  const aadInput = {
    identity: {
      organizationId: pipeline.authority.organizationId,
      agentId: pipeline.request.agentId,
      activationGeneration: pipeline.request.activationGeneration,
      lifecycleRevision: pipeline.request.lifecycleRevision,
    },
    operationId: pipeline.request.operationId,
    component: {
      name: descriptor.name,
      format: AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
      compression: "none" as const,
    },
    chunk: {
      index: input.chunkIndex,
      offsetBytes: input.offsetBytes,
      plainBytes: plaintext.byteLength,
      compressedBytes: plaintext.byteLength,
      contentHmacSha256,
    },
  };
  const aad = new TextEncoder().encode(canonicalizeAgentBackupChunkAad(aadInput));
  const aadSha256 = await computeAgentBackupChunkAadDigest(aadInput);
  const cipher = createCipheriv("aes-256-gcm", input.dek, nonce);
  cipher.setAAD(aad);
  const ciphertext = cipher.update(plaintext);
  const final = cipher.final();
  const tag = cipher.getAuthTag();
  const encryptedBytes =
    nonce.byteLength + ciphertext.byteLength + final.byteLength + tag.byteLength;
  const ciphertextHash = createHash("sha256");
  ciphertextHash.update(nonce);
  ciphertextHash.update(ciphertext);
  if (final.byteLength > 0) ciphertextHash.update(final);
  ciphertextHash.update(tag);
  const metadata: AgentBackupCaptureV3SpoolChunk = {
    component: descriptor.name,
    index: input.chunkIndex,
    file: `chunk-${descriptor.name}-${String(input.chunkIndex).padStart(6, "0")}.bin`,
    nonceHex,
    plainBytes: plaintext.byteLength,
    compressedBytes: plaintext.byteLength,
    encryptedBytes,
    contentHmacSha256,
    aadSha256,
    ciphertextSha256: ciphertextHash.digest("hex"),
  };
  try {
    return await spool.storeCiphertextChunk(metadata, [
      nonce,
      ciphertext,
      ...(final.byteLength > 0 ? [final] : []),
      tag,
    ]);
  } finally {
    aad.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
    final.fill(0);
    tag.fill(0);
  }
}

interface ComposedComponent {
  manifest: AgentBackupManifestV3["components"][number];
  descriptor: AgentBackupCaptureV2ComponentDescriptor;
}

async function composeCapture(
  input: RunAgentBackupCaptureV2PipelineInput,
  spool: AgentBackupCaptureV3Spool,
  dek: Uint8Array,
  contentHmacKey: Uint8Array,
  chunkPlainBytes: number,
): Promise<readonly ComposedComponent[]> {
  const components: ComposedComponent[] = [];
  const nonceOwners = new Map<string, string>();
  for (const chunk of spool.chunks) {
    const owner = `${chunk.component}:${chunk.index}`;
    if (nonceOwners.has(chunk.nonceHex)) {
      pipelineError(
        "AGENT_BACKUP_V2_NONCE_REUSE",
        "Durable spool contains a duplicate AES-GCM nonce",
      );
    }
    nonceOwners.set(chunk.nonceHex, owner);
  }
  let active:
    | {
        index: number;
        descriptor: AgentBackupCaptureV2ComponentDescriptor;
        builder: BoundedPlainChunkBuilder;
        hmac: AgentBackupCaptureV2DigestStream;
        chunks: AgentBackupCaptureV3SpoolChunk[];
        plainBytes: number;
      }
    | undefined;
  let sawStart = false;
  let sawEnd = false;
  let expectedComponents = 0;
  let bytesSinceHeartbeat = 0;

  await heartbeat(input);
  const captureIterator = input.openCapture(input.signal)[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await nextCaptureFrame(input, captureIterator);
      if (next.done) break;
      const frame = next.value;
      try {
        assertActive(input);
        if (frame.header.kind === "capture-start") {
          if (sawStart) {
            pipelineError(
              "AGENT_BACKUP_V2_CAPTURE_STATE",
              "Capture stream repeated its start frame",
            );
          }
          sawStart = true;
          expectedComponents = frame.header.componentCount;
          continue;
        }
        if (!sawStart || sawEnd) {
          pipelineError(
            "AGENT_BACKUP_V2_CAPTURE_STATE",
            "Capture stream emitted a frame outside its active interval",
          );
        }
        if (frame.header.kind === "component-start") {
          const descriptor = frame.header.component;
          if (active) {
            pipelineError(
              "AGENT_BACKUP_V2_CAPTURE_STATE",
              "Capture stream overlapped two components",
            );
          }
          active = {
            index: frame.header.componentIndex,
            descriptor,
            builder: new BoundedPlainChunkBuilder(chunkPlainBytes),
            hmac: createContentHmac(contentHmacKey),
            chunks: [],
            plainBytes: 0,
          };
          for (const part of [
            serializeAgentBackupRecordStreamV1Magic(),
            ...serializeAgentBackupRecordStreamV1Record({
              kind: "component-start",
              descriptor,
            }),
          ]) {
            await active.builder.append(part, async (plaintext) => {
              if (!active) throw new Error("Component unexpectedly closed");
              const chunk = await encryptAndStoreChunk({
                pipeline: input,
                spool,
                dek,
                contentHmacKey,
                descriptor: active.descriptor,
                componentHmac: active.hmac,
                componentIndex: active.index,
                chunkIndex: active.chunks.length,
                offsetBytes: active.plainBytes,
                plaintext,
                nonceOwners,
              });
              active.chunks.push(chunk);
              active.plainBytes += plaintext.byteLength;
            });
          }
          continue;
        }
        if (frame.header.kind === "data") {
          if (!active || frame.header.componentIndex !== active.index) {
            pipelineError(
              "AGENT_BACKUP_V2_CAPTURE_STATE",
              "Capture data does not belong to the active component",
            );
          }
          for (const part of serializeAgentBackupRecordStreamV1Record({
            kind: "data",
            dataIndex: frame.header.dataIndex,
            offsetBytes: frame.header.offsetBytes,
            payloadBytes: frame.header.payloadBytes,
            entry: frame.header.entry ?? null,
            payload: frame.payload,
          })) {
            await active.builder.append(part, async (plaintext) => {
              if (!active) throw new Error("Component unexpectedly closed");
              const chunk = await encryptAndStoreChunk({
                pipeline: input,
                spool,
                dek,
                contentHmacKey,
                descriptor: active.descriptor,
                componentHmac: active.hmac,
                componentIndex: active.index,
                chunkIndex: active.chunks.length,
                offsetBytes: active.plainBytes,
                plaintext,
                nonceOwners,
              });
              active.chunks.push(chunk);
              active.plainBytes += plaintext.byteLength;
            });
          }
          bytesSinceHeartbeat += frame.payload.byteLength;
          if (bytesSinceHeartbeat >= MAX_HEARTBEAT_BYTES) {
            await heartbeat(input);
            bytesSinceHeartbeat = 0;
          }
          continue;
        }
        if (frame.header.kind === "component-end") {
          if (!active || frame.header.componentIndex !== active.index) {
            pipelineError(
              "AGENT_BACKUP_V2_CAPTURE_STATE",
              "Capture component-end does not match the active component",
            );
          }
          for (const part of serializeAgentBackupRecordStreamV1Record({
            kind: "component-end",
            dataFrameCount: frame.header.dataFrameCount,
            payloadBytes: frame.header.plainBytes,
            payloadSha256: frame.header.payloadSha256,
          })) {
            await active.builder.append(part, async (plaintext) => {
              if (!active) throw new Error("Component unexpectedly closed");
              const chunk = await encryptAndStoreChunk({
                pipeline: input,
                spool,
                dek,
                contentHmacKey,
                descriptor: active.descriptor,
                componentHmac: active.hmac,
                componentIndex: active.index,
                chunkIndex: active.chunks.length,
                offsetBytes: active.plainBytes,
                plaintext,
                nonceOwners,
              });
              active.chunks.push(chunk);
              active.plainBytes += plaintext.byteLength;
            });
          }
          await active.builder.finish(async (plaintext) => {
            if (!active) throw new Error("Component unexpectedly closed");
            const chunk = await encryptAndStoreChunk({
              pipeline: input,
              spool,
              dek,
              contentHmacKey,
              descriptor: active.descriptor,
              componentHmac: active.hmac,
              componentIndex: active.index,
              chunkIndex: active.chunks.length,
              offsetBytes: active.plainBytes,
              plaintext,
              nonceOwners,
            });
            active.chunks.push(chunk);
            active.plainBytes += plaintext.byteLength;
          });
          const componentContentHmac = await finishDigest(active.hmac);
          const totals = active.chunks.reduce(
            (sum, chunk) => ({
              plainBytes: sum.plainBytes + chunk.plainBytes,
              compressedBytes: sum.compressedBytes + chunk.compressedBytes,
              encryptedBytes: sum.encryptedBytes + chunk.encryptedBytes,
              chunkCount: sum.chunkCount + 1,
            }),
            { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
          );
          let manifestOffset = 0;
          const manifestChunks = active.chunks.map((chunk) => {
            const offsetBytes = manifestOffset;
            manifestOffset += chunk.plainBytes;
            return {
              index: chunk.index,
              offsetBytes,
              plainBytes: chunk.plainBytes,
              compressedBytes: chunk.compressedBytes,
              encryptedBytes: chunk.encryptedBytes,
              contentHmacSha256: chunk.contentHmacSha256,
              aadSha256: chunk.aadSha256,
              sha256: chunk.ciphertextSha256,
            };
          });
          components.push({
            descriptor: active.descriptor,
            manifest: {
              name: active.descriptor.name,
              format: AGENT_BACKUP_RECORD_STREAM_V1_FORMAT,
              compression: "none",
              payloadContentHmacSha256: componentContentHmac,
              state: { kind: "full", resultContentHmacSha256: componentContentHmac },
              totals,
              chunks: manifestChunks,
            },
          });
          active = undefined;
          await heartbeat(input);
          continue;
        }
        if (frame.header.kind === "capture-end") {
          if (active || frame.header.componentCount !== components.length) {
            pipelineError(
              "AGENT_BACKUP_V2_CAPTURE_STATE",
              "Capture terminal frame does not match completed components",
            );
          }
          sawEnd = true;
        }
      } finally {
        zeroizeCaptureFrame(frame);
      }
    }
  } finally {
    active?.builder.release();
    await closeCaptureIterator(captureIterator);
  }
  if (!sawStart || !sawEnd || components.length !== expectedComponents) {
    pipelineError(
      "AGENT_BACKUP_V2_CAPTURE_TRUNCATED",
      "Capture stream ended without its authenticated terminal state",
    );
  }
  const composedKeys = new Set(
    components.flatMap((component) =>
      component.manifest.chunks.map((chunk) => `${component.manifest.name}:${chunk.index}`),
    ),
  );
  if (
    spool.chunks.length !== composedKeys.size ||
    spool.chunks.some((chunk) => !composedKeys.has(`${chunk.component}:${chunk.index}`))
  ) {
    pipelineError(
      "AGENT_BACKUP_V2_SPOOL_REPLAY_CONFLICT",
      "Partial capture replay produced a different ciphertext inventory",
    );
  }
  return components;
}

async function computeFramedContentHmac(input: {
  pipeline: RunAgentBackupCaptureV2PipelineInput;
  spool: AgentBackupCaptureV3Spool;
  dek: Uint8Array;
  contentHmacKey: Uint8Array;
  components: readonly ComposedComponent[];
}): Promise<string> {
  const digest = createContentHmac(input.contentHmacKey);
  const encoder = new TextEncoder();
  await updateDigest(digest, encoder.encode(AGENT_BACKUP_PAYLOAD_DIGEST_DERIVATION));
  await updateDigest(digest, uint64BigEndian(input.components.length));
  const readBuffer = new Uint8Array(256 * 1024);

  for (const component of input.components) {
    const name = encoder.encode(component.manifest.name);
    await updateDigest(digest, uint64BigEndian(name.byteLength));
    await updateDigest(digest, name);
    await updateDigest(digest, uint64BigEndian(component.manifest.totals.plainBytes));
    for (const manifestChunk of component.manifest.chunks) {
      assertActive(input.pipeline);
      const spoolChunk = input.spool.chunks.find(
        (chunk) =>
          chunk.component === component.manifest.name && chunk.index === manifestChunk.index,
      );
      if (!spoolChunk) {
        pipelineError(
          "AGENT_BACKUP_V2_SPOOL_CHUNK_UNKNOWN",
          "Manifest references a missing ciphertext spool chunk",
        );
      }
      const handle = await input.spool.openCiphertextChunk(spoolChunk);
      const nonce = new Uint8Array(AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes);
      const tag = new Uint8Array(AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes);
      const ciphertextBytes = spoolChunk.encryptedBytes - nonce.byteLength - tag.byteLength;
      try {
        const nonceRead = await handle.read(nonce, 0, nonce.byteLength, 0);
        const tagRead = await handle.read(
          tag,
          0,
          tag.byteLength,
          spoolChunk.encryptedBytes - tag.byteLength,
        );
        if (nonceRead.bytesRead !== nonce.byteLength || tagRead.bytesRead !== tag.byteLength) {
          pipelineError(
            "AGENT_BACKUP_V2_SPOOL_TRUNCATED",
            "Ciphertext envelope nonce or tag is truncated",
          );
        }
        const aadInput = {
          identity: {
            organizationId: input.pipeline.authority.organizationId,
            agentId: input.pipeline.request.agentId,
            activationGeneration: input.pipeline.request.activationGeneration,
            lifecycleRevision: input.pipeline.request.lifecycleRevision,
          },
          operationId: input.pipeline.request.operationId,
          component: {
            name: component.manifest.name,
            format: component.manifest.format,
            compression: component.manifest.compression,
          },
          chunk: {
            index: manifestChunk.index,
            offsetBytes: manifestChunk.offsetBytes,
            plainBytes: manifestChunk.plainBytes,
            compressedBytes: manifestChunk.compressedBytes,
            contentHmacSha256: manifestChunk.contentHmacSha256,
          },
        };
        const decipher = createDecipheriv("aes-256-gcm", input.dek, nonce);
        decipher.setAAD(encoder.encode(canonicalizeAgentBackupChunkAad(aadInput)));
        decipher.setAuthTag(tag);
        let offset = 0;
        let plainBytes = 0;
        while (offset < ciphertextBytes) {
          const take = Math.min(readBuffer.byteLength, ciphertextBytes - offset);
          const read = await handle.read(readBuffer, 0, take, nonce.byteLength + offset);
          if (read.bytesRead === 0) {
            pipelineError("AGENT_BACKUP_V2_SPOOL_TRUNCATED", "Ciphertext envelope is truncated");
          }
          const plaintext = decipher.update(readBuffer.subarray(0, read.bytesRead));
          if (plaintext.byteLength > 0) {
            try {
              await updateDigest(digest, plaintext);
              plainBytes += plaintext.byteLength;
            } finally {
              plaintext.fill(0);
            }
          }
          offset += read.bytesRead;
        }
        const final = decipher.final();
        if (final.byteLength > 0) {
          try {
            await updateDigest(digest, final);
            plainBytes += final.byteLength;
          } finally {
            final.fill(0);
          }
        }
        if (plainBytes !== manifestChunk.plainBytes) {
          pipelineError(
            "AGENT_BACKUP_V2_SPOOL_CHUNK_INVALID",
            "Authenticated ciphertext plaintext length differs from its manifest",
          );
        }
      } finally {
        await handle.close();
        nonce.fill(0);
        tag.fill(0);
      }
    }
    await heartbeat(input.pipeline);
  }
  return finishDigest(digest);
}

function manifestTotals(components: readonly ComposedComponent[]): {
  plainBytes: number;
  compressedBytes: number;
  encryptedBytes: number;
  chunkCount: number;
} {
  return components.reduce(
    (total, component) => ({
      plainBytes: total.plainBytes + component.manifest.totals.plainBytes,
      compressedBytes: total.compressedBytes + component.manifest.totals.compressedBytes,
      encryptedBytes: total.encryptedBytes + component.manifest.totals.encryptedBytes,
      chunkCount: total.chunkCount + component.manifest.totals.chunkCount,
    }),
    { plainBytes: 0, compressedBytes: 0, encryptedBytes: 0, chunkCount: 0 },
  );
}

function draftFromManifest(manifest: AgentBackupManifestV3): AgentBackupManifestV3Draft {
  const { manifestSha256: _manifestSha256, ...integrity } = manifest.integrity;
  return { ...manifest, integrity };
}

async function inventoryDigest(manifest: AgentBackupManifestV3): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify({
        version: 3,
        objects: manifest.components
          .flatMap((component) =>
            component.chunks.map((chunk) => ({
              component: component.name,
              index: chunk.index,
              contentHmac: chunk.contentHmacSha256,
              cipherSha: chunk.sha256,
              encryptedBytes: chunk.encryptedBytes,
            })),
          )
          .sort(
            (left, right) =>
              compareCanonicalComponentNames(left.component, right.component) ||
              left.index - right.index,
          ),
      }),
    ),
  );
}

async function catalogManifest(
  manifest: AgentBackupManifestV3,
  wrappedKeyBundle: Uint8Array,
): Promise<AgentBackupCaptureV3CatalogManifest> {
  const draft = draftFromManifest(manifest);
  const bundle = manifest.encryption.operationKeyBundle;
  if (
    wrappedKeyBundle.byteLength !== bundle.wrapped.bytes ||
    sha256Hex(wrappedKeyBundle) !== bundle.wrapped.sha256
  ) {
    pipelineError(
      "AGENT_BACKUP_V3_KEY_BUNDLE_ENVELOPE_INVALID",
      "Wrapped operation key bundle differs from its manifest",
    );
  }
  return {
    canonicalManifestDraft: canonicalizeAgentBackupManifestV3(draft),
    format: manifest.format,
    version: manifest.schemaVersion,
    digest: manifest.integrity.manifestSha256,
    objectCount: manifest.totals.chunkCount,
    objectInventoryDigest: await inventoryDigest(manifest),
    imageDigest: manifest.runtime.imageDigest,
    databaseSchemaVersion: manifest.runtime.databaseSchemaVersion,
    pluginSetDigest: digestCanonical({ version: 1, plugins: manifest.runtime.plugins }),
    watermarkDigest: digestCanonical({ version: 1, watermarks: manifest.watermarks }),
    rawSizeBytes: manifest.totals.plainBytes,
    compressedSizeBytes: manifest.totals.compressedBytes,
    encryptedSizeBytes: manifest.totals.encryptedBytes,
    kmsKeyId: manifest.encryption.kms.keyId,
    kmsKeyVersion: manifest.encryption.kms.keyVersion,
    wrappedKeyBundleCiphertextBase64: boundedBase64(wrappedKeyBundle),
    wrappedKeyBundleSha256: bundle.wrapped.sha256,
    wrappedKeyBundleLocalReceiptDigest: bundle.wrapped.localReceiptDigest,
    wrappedKeyBundleGenerationId: bundle.generationId,
    vaultKeyGenerationId: manifest.vaultKeyAuthority.generationId,
    vaultKeyAuthorityReceiptDigest: manifest.vaultKeyAuthority.receiptDigest,
  };
}

function operationKeyBundleContext(
  request: AgentBackupCaptureV2Request,
  authority: AgentBackupCaptureV3ManifestAuthority,
  generationId: string,
): string {
  return canonicalizeAgentBackupOperationKeyBundleContext({
    organizationId: authority.organizationId,
    agentId: request.agentId,
    activationGeneration: request.activationGeneration,
    lifecycleRevision: request.lifecycleRevision,
    operationId: request.operationId,
    keyBundleGenerationId: generationId,
    sourceKind: authority.source.kind,
    sourceProvider: authority.source.provider,
    kmsProvider: authority.kms.provider,
    keyId: authority.kms.keyId,
    keyVersion: authority.kms.keyVersion,
  });
}

interface AcquiredOperationKeyBundle {
  handle: KmsAeadOperationKeyBundleHandle;
  dek: Uint8Array;
  contentHmacKey: Uint8Array;
  wrapped: KmsAeadOperationKeyBundleWrapped;
  generationId: string;
  canonicalContext: string;
}

function readKeyBundleViews(
  handle: KmsAeadOperationKeyBundleHandle,
): Pick<AcquiredOperationKeyBundle, "dek" | "contentHmacKey"> {
  if (!handle || handle.format !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format || handle.released) {
    pipelineError(
      "AGENT_BACKUP_V3_KEY_BUNDLE_INVALID",
      "KMS returned an inactive operation key-bundle handle",
    );
  }
  const dek = handle.dek;
  const contentHmacKey = handle.contentHmacKey;
  if (
    !(dek instanceof Uint8Array) ||
    dek.byteLength !== AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek.bytes ||
    !(contentHmacKey instanceof Uint8Array) ||
    contentHmacKey.byteLength !== AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes ||
    (dek.buffer === contentHmacKey.buffer &&
      dek.byteOffset < contentHmacKey.byteOffset + contentHmacKey.byteLength &&
      contentHmacKey.byteOffset < dek.byteOffset + dek.byteLength)
  ) {
    pipelineError(
      "AGENT_BACKUP_V3_KEY_BUNDLE_INVALID",
      "KMS operation key-bundle handle has invalid key slices",
    );
  }
  return { dek, contentHmacKey };
}

function assertWrappedKeyBundle(
  wrapped: KmsAeadOperationKeyBundleWrapped,
  authority: Pick<AgentBackupCaptureV3ManifestAuthority, "kms">,
  canonicalContext: string,
): void {
  if (
    !wrapped ||
    wrapped.format !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.format ||
    wrapped.keyId !== authority.kms.keyId ||
    wrapped.keyVersion !== authority.kms.keyVersion ||
    wrapped.plaintextBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.plaintextBytes ||
    wrapped.nonceBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.nonceBytes ||
    wrapped.authTagBytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.authTagBytes ||
    wrapped.bytes !== KMS_AEAD_OPERATION_KEY_BUNDLE_V1.wrappedBytes ||
    wrapped.localReceiptDerivation !== KMS_AEAD_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION ||
    !(wrapped.wrappedKeyBundle instanceof Uint8Array) ||
    wrapped.wrappedKeyBundle.byteLength !== wrapped.bytes ||
    !HEX_SHA256_PATTERN.test(wrapped.sha256) ||
    sha256Hex(wrapped.wrappedKeyBundle) !== wrapped.sha256 ||
    !HEX_SHA256_PATTERN.test(wrapped.localReceiptDigest)
  ) {
    pipelineError(
      "AGENT_BACKUP_V3_KEY_BUNDLE_ENVELOPE_INVALID",
      "KMS returned invalid operation key-bundle envelope metadata",
    );
  }
  const contextBytes = new TextEncoder().encode(canonicalContext);
  try {
    if (
      computeKmsAeadOperationKeyBundleLocalReceiptDigest({
        keyId: wrapped.keyId,
        keyVersion: wrapped.keyVersion,
        canonicalContext: contextBytes,
        wrappedKeyBundle: wrapped.wrappedKeyBundle,
      }) !== wrapped.localReceiptDigest
    ) {
      pipelineError(
        "AGENT_BACKUP_V3_KEY_BUNDLE_RECEIPT_INVALID",
        "KMS operation key-bundle envelope has an invalid local receipt",
      );
    }
  } finally {
    contextBytes.fill(0);
  }
}

function observeLateKeyBundleHandle(
  provider: AgentBackupCaptureV3KeyBundleProvider,
  pending: Promise<KmsAeadOperationKeyBundleHandle>,
): void {
  void pending.then(
    (handle) => {
      try {
        releaseInvalidKeyBundleHandle(provider, handle);
      } catch (_releaseFailure: unknown) {
        // error-policy:J5 the operation cancellation/deadline is authoritative;
        // local observable views were still erased by the release boundary.
      }
    },
    (_lateFailure: unknown) => undefined,
  );
}

function observeLateKeyBundleAcquisition(
  provider: AgentBackupCaptureV3KeyBundleProvider,
  pending: Promise<{
    handle: KmsAeadOperationKeyBundleHandle;
    wrapped: KmsAeadOperationKeyBundleWrapped;
  }>,
): void {
  void pending.then(
    (late) => {
      let wrappedKeyBundle: Uint8Array | undefined;
      try {
        if (late.wrapped.wrappedKeyBundle instanceof Uint8Array) {
          wrappedKeyBundle = late.wrapped.wrappedKeyBundle;
        }
      } catch (_invalidEnvelope: unknown) {
        // error-policy:J5 handle release remains independently mandatory.
      }
      try {
        releaseInvalidKeyBundleHandle(provider, late.handle);
      } catch (_releaseFailure: unknown) {
        // error-policy:J5 cancellation/deadline remains the primary failure.
      } finally {
        wrappedKeyBundle?.fill(0);
      }
    },
    (_lateFailure: unknown) => undefined,
  );
}

async function acquireOperationKeyBundle(
  input: RunAgentBackupCaptureV2PipelineInput,
  spool: AgentBackupCaptureV3Spool,
): Promise<AcquiredOperationKeyBundle> {
  const stored = spool.getOperationKeyBundleMetadata();
  if (stored) {
    const expectedContext = operationKeyBundleContext(
      input.request,
      input.authority,
      stored.generationId,
    );
    if (stored.canonicalContext !== expectedContext) {
      pipelineError(
        "AGENT_BACKUP_V3_KEY_BUNDLE_CONTEXT_MISMATCH",
        "Durable operation key-bundle context differs from current authority",
      );
    }
    const wrappedKeyBundle = await spool.loadOperationKeyBundle();
    const wrapped: KmsAeadOperationKeyBundleWrapped = {
      format: stored.format,
      keyId: input.authority.kms.keyId,
      keyVersion: input.authority.kms.keyVersion,
      plaintextBytes: stored.plaintextBytes,
      nonceBytes: stored.nonceBytes,
      authTagBytes: stored.authTagBytes,
      bytes: stored.bytes,
      sha256: stored.sha256,
      localReceiptDerivation: stored.localReceiptDerivation,
      localReceiptDigest: stored.localReceiptDigest,
      wrappedKeyBundle,
    };
    try {
      assertWrappedKeyBundle(wrapped, input.authority, expectedContext);
    } catch (cause) {
      wrappedKeyBundle.fill(0);
      throw cause;
    }
    const contextBytes = new TextEncoder().encode(expectedContext);
    let handle: KmsAeadOperationKeyBundleHandle;
    const unwrapPending = Promise.resolve().then(() =>
      input.keyBundle.unwrap({
        wrapped,
        canonicalContext: contextBytes,
      }),
    );
    try {
      handle = await awaitWithPipelineControl(
        input,
        "Operation key-bundle unwrap",
        () => unwrapPending,
      );
    } catch (cause) {
      observeLateKeyBundleHandle(input.keyBundle, unwrapPending);
      wrappedKeyBundle.fill(0);
      throw cause;
    } finally {
      contextBytes.fill(0);
    }
    let views: Pick<AcquiredOperationKeyBundle, "dek" | "contentHmacKey">;
    try {
      views = readKeyBundleViews(handle);
    } catch (cause) {
      wrappedKeyBundle.fill(0);
      try {
        releaseInvalidKeyBundleHandle(input.keyBundle, handle);
      } catch (releaseCause) {
        throw new AggregateError(
          [cause, releaseCause],
          "Stored key-bundle validation and release both failed",
        );
      }
      throw cause;
    }
    return {
      handle,
      ...views,
      wrapped,
      generationId: stored.generationId,
      canonicalContext: expectedContext,
    };
  }

  const generationId = randomUUID();
  const canonicalContext = operationKeyBundleContext(input.request, input.authority, generationId);
  const contextBytes = new TextEncoder().encode(canonicalContext);
  let acquired: Awaited<ReturnType<AgentBackupCaptureV3KeyBundleProvider["acquire"]>>;
  const acquirePending = Promise.resolve().then(() =>
    input.keyBundle.acquire({
      keyId: input.authority.kms.keyId,
      keyVersion: input.authority.kms.keyVersion,
      canonicalContext: contextBytes,
    }),
  );
  try {
    acquired = await awaitWithPipelineControl(
      input,
      "Fresh operation key-bundle wrap",
      () => acquirePending,
    );
  } catch (cause) {
    observeLateKeyBundleAcquisition(input.keyBundle, acquirePending);
    throw cause;
  } finally {
    contextBytes.fill(0);
  }
  let views: Pick<AcquiredOperationKeyBundle, "dek" | "contentHmacKey">;
  let wrappedKeyBundle: Uint8Array | undefined;
  let providerWrappedKeyBundle: Uint8Array | undefined;
  try {
    if (acquired.wrapped.wrappedKeyBundle instanceof Uint8Array) {
      providerWrappedKeyBundle = acquired.wrapped.wrappedKeyBundle;
    }
    views = readKeyBundleViews(acquired.handle);
    assertWrappedKeyBundle(acquired.wrapped, input.authority, canonicalContext);
    wrappedKeyBundle = Uint8Array.from(acquired.wrapped.wrappedKeyBundle);
    await spool.storeOperationKeyBundle(
      {
        generationId,
        format: acquired.wrapped.format,
        plaintextBytes: acquired.wrapped.plaintextBytes,
        nonceBytes: acquired.wrapped.nonceBytes,
        authTagBytes: acquired.wrapped.authTagBytes,
        bytes: acquired.wrapped.bytes,
        sha256: acquired.wrapped.sha256,
        localReceiptDerivation: acquired.wrapped.localReceiptDerivation,
        localReceiptDigest: acquired.wrapped.localReceiptDigest,
        canonicalContext,
      },
      wrappedKeyBundle,
    );
    providerWrappedKeyBundle?.fill(0);
  } catch (cause) {
    // error-policy:J3 an unpersisted operation bundle must be released and
    // zeroed before the capture source can be opened.
    let releaseFailure: unknown;
    try {
      releaseInvalidKeyBundleHandle(input.keyBundle, acquired.handle);
    } catch (releaseCause) {
      releaseFailure = releaseCause;
    } finally {
      wrappedKeyBundle?.fill(0);
      providerWrappedKeyBundle?.fill(0);
    }
    if (releaseFailure !== undefined) {
      throw new AggregateError(
        [cause, releaseFailure],
        "Operation key-bundle persistence and release both failed",
      );
    }
    throw cause;
  }
  if (!wrappedKeyBundle) {
    pipelineError(
      "AGENT_BACKUP_V3_KEY_BUNDLE_INCOMPLETE",
      "Fresh operation key bundle has no owned envelope bytes",
    );
  }
  return {
    handle: acquired.handle,
    ...views,
    wrapped: { ...acquired.wrapped, wrappedKeyBundle },
    generationId,
    canonicalContext,
  };
}

export async function loadAgentBackupCaptureV3SealedArtifacts(
  spool: AgentBackupCaptureV3Spool,
): Promise<AgentBackupCaptureV3Artifacts> {
  const manifestBytes = await spool.loadManifestBytes();
  let decoded: unknown;
  let manifestJson: string;
  try {
    manifestJson = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
    decoded = JSON.parse(manifestJson);
  } catch (cause) {
    pipelineError(
      "AGENT_BACKUP_V3_SPOOL_MANIFEST_INVALID",
      "Durable manifest is not valid UTF-8 JSON",
      cause,
    );
  }
  const manifest = await parseAgentBackupManifestV3(decoded);
  if (manifestJson !== canonicalJson(manifest)) {
    pipelineError(
      "AGENT_BACKUP_V3_SPOOL_MANIFEST_NON_CANONICAL",
      "Durable manifest bytes are not the canonical v3 wire",
    );
  }
  const wrappedKeyBundle = await spool.loadOperationKeyBundle();
  try {
    const wrapped = spool.getOperationKeyBundleMetadata();
    if (!wrapped) {
      pipelineError(
        "AGENT_BACKUP_V3_SPOOL_KEY_BUNDLE_MISSING",
        "Sealed backup operation is missing its operation key bundle",
      );
    }
    const expectedContext = canonicalizeAgentBackupOperationKeyBundleContext({
      organizationId: manifest.identity.organizationId,
      agentId: manifest.identity.agentId,
      activationGeneration: manifest.identity.activationGeneration,
      lifecycleRevision: manifest.identity.lifecycleRevision,
      operationId: manifest.operationId,
      keyBundleGenerationId: manifest.encryption.operationKeyBundle.generationId,
      sourceKind: manifest.source.kind,
      sourceProvider: manifest.source.provider,
      kmsProvider: manifest.encryption.kms.provider,
      keyId: manifest.encryption.kms.keyId,
      keyVersion: manifest.encryption.kms.keyVersion,
    });
    const bundle = manifest.encryption.operationKeyBundle;
    if (
      wrapped.canonicalContext !== expectedContext ||
      wrapped.generationId !== bundle.generationId ||
      wrapped.format !== bundle.format ||
      wrapped.plaintextBytes !== bundle.plaintextBytes ||
      wrapped.bytes !== bundle.wrapped.bytes ||
      wrapped.sha256 !== bundle.wrapped.sha256 ||
      wrapped.localReceiptDerivation !== bundle.wrapped.localReceiptDerivation ||
      wrapped.localReceiptDigest !== bundle.wrapped.localReceiptDigest
    ) {
      pipelineError(
        "AGENT_BACKUP_V3_KEY_BUNDLE_CONTEXT_MISMATCH",
        "Durable key-bundle context differs from its sealed manifest",
      );
    }
    assertWrappedKeyBundle(
      {
        format: wrapped.format,
        keyId: manifest.encryption.kms.keyId,
        keyVersion: manifest.encryption.kms.keyVersion,
        plaintextBytes: wrapped.plaintextBytes,
        nonceBytes: wrapped.nonceBytes,
        authTagBytes: wrapped.authTagBytes,
        bytes: wrapped.bytes,
        sha256: wrapped.sha256,
        localReceiptDerivation: wrapped.localReceiptDerivation,
        localReceiptDigest: wrapped.localReceiptDigest,
        wrappedKeyBundle,
      },
      { kms: manifest.encryption.kms },
      expectedContext,
    );
    const chunks = spool.chunks;
    const manifestChunks = manifest.components.flatMap((component) =>
      component.chunks.map((chunk) => ({ component: component.name, chunk })),
    );
    if (chunks.length !== manifestChunks.length) {
      pipelineError(
        "AGENT_BACKUP_V3_SPOOL_INVENTORY_CONFLICT",
        "Durable ciphertext inventory count differs from the sealed manifest",
      );
    }
    for (let index = 0; index < manifestChunks.length; index += 1) {
      const expected = manifestChunks[index];
      const observed = chunks[index];
      if (
        !expected ||
        !observed ||
        observed.component !== expected.component ||
        observed.index !== expected.chunk.index ||
        observed.file !==
          `chunk-${expected.component}-${String(expected.chunk.index).padStart(6, "0")}.bin` ||
        observed.plainBytes !== expected.chunk.plainBytes ||
        observed.compressedBytes !== expected.chunk.compressedBytes ||
        observed.encryptedBytes !== expected.chunk.encryptedBytes ||
        observed.contentHmacSha256 !== expected.chunk.contentHmacSha256 ||
        observed.aadSha256 !== expected.chunk.aadSha256 ||
        observed.ciphertextSha256 !== expected.chunk.sha256
      ) {
        pipelineError(
          "AGENT_BACKUP_V3_SPOOL_INVENTORY_CONFLICT",
          "Durable ciphertext mapping differs from the sealed manifest",
        );
      }
      const handle = await spool.openCiphertextChunk(observed);
      const nonce = new Uint8Array(AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes);
      try {
        const read = await handle.read(nonce, 0, nonce.byteLength, 0);
        if (read.bytesRead !== nonce.byteLength || bytesToHex(nonce) !== observed.nonceHex) {
          pipelineError(
            "AGENT_BACKUP_V3_SPOOL_INVENTORY_CONFLICT",
            "Durable ciphertext nonce differs from its spool mapping",
          );
        }
      } finally {
        nonce.fill(0);
        await handle.close();
      }
    }
    const artifacts: AgentBackupCaptureV3Artifacts = {
      manifest,
      catalogManifest: await catalogManifest(manifest, wrappedKeyBundle),
      wrappedKeyBundle,
      chunks,
    };
    if (spool.recordCaptured) {
      const durableCatalogBytes = await spool.loadCatalogManifestBytes();
      const expectedCatalogBytes = new TextEncoder().encode(
        canonicalJson(artifacts.catalogManifest),
      );
      if (!equalBytes(durableCatalogBytes, expectedCatalogBytes)) {
        pipelineError(
          "AGENT_BACKUP_V3_CATALOG_REPLAY_CONFLICT",
          "Durable catalogue handoff differs byte-for-byte from the sealed spool",
        );
      }
    }
    return artifacts;
  } catch (cause) {
    wrappedKeyBundle.fill(0);
    throw cause;
  }
}

async function publishArtifacts(
  input: RunAgentBackupCaptureV2PipelineInput,
  spool: AgentBackupCaptureV3Spool,
  artifacts: AgentBackupCaptureV3Artifacts,
): Promise<void> {
  const publication = input.publication;
  if (publication.mode !== "capture-only") {
    await spool.markPublishing();
  }
  if (!spool.recordCaptured) {
    await heartbeat(input);
    if (
      (await awaitWithPipelineControl(input, "Catalogue recordCaptured", () =>
        publication.recordCaptured(artifacts),
      )) !== true
    ) {
      pipelineError(
        "AGENT_BACKUP_V2_RECORD_CAPTURED_UNCONFIRMED",
        "Catalogue did not acknowledge the captured manifest",
      );
    }
    const catalogBytes = canonicalAgentBackupCaptureV3CatalogManifestBytes(
      artifacts.catalogManifest,
    );
    await spool.markRecordCaptured(catalogBytes, {
      bytes: catalogBytes.byteLength,
      sha256: sha256Hex(catalogBytes),
    });
  }
  if (publication.mode === "capture-only") return;
  for (const chunk of artifacts.chunks) {
    if (spool.isChunkUploaded(chunk)) continue;
    await heartbeat(input);
    const body = await spool.readCiphertextChunk(chunk);
    try {
      if (
        (await awaitWithPipelineControl(input, "Primary ciphertext upload", () =>
          publication.uploadPrimary({
            operationId: input.request.operationId,
            manifestSha256: artifacts.manifest.integrity.manifestSha256,
            component: chunk.component,
            chunkIndex: chunk.index,
            contentHmacSha256: chunk.contentHmacSha256,
            ciphertextSha256: chunk.ciphertextSha256,
            encryptedBytes: chunk.encryptedBytes,
            body,
          }),
        )) !== true
      ) {
        pipelineError(
          "AGENT_BACKUP_V2_UPLOAD_UNCONFIRMED",
          "Primary object upload was not durably acknowledged",
        );
      }
    } finally {
      body.fill(0);
    }
    await spool.markChunkUploaded(chunk);
  }
  await spool.markPublished();
}

/**
 * Capture (or resume), seal, and publish one exact operation. Local cleanup is
 * deliberately a separate explicit call on the returned spool; this function
 * can never erase the only response-loss replay evidence before its caller has
 * durably recorded completion.
 */
export async function runAgentBackupCaptureV2Pipeline(
  inputRaw: Readonly<RunAgentBackupCaptureV2PipelineInput>,
): Promise<AgentBackupCaptureV2PipelineResult> {
  const request = parseAgentBackupCaptureV2Request(inputRaw.request);
  let authority: AgentBackupCaptureV3ManifestAuthority;
  try {
    authority = JSON.parse(
      JSON.stringify(inputRaw.authority),
    ) as AgentBackupCaptureV3ManifestAuthority;
  } catch (cause) {
    pipelineError(
      "AGENT_BACKUP_V2_AUTHORITY_INVALID",
      "Manifest authority must be serializable immutable JSON",
      cause,
    );
  }
  const input: RunAgentBackupCaptureV2PipelineInput = {
    ...inputRaw,
    request,
    authority,
  };
  if (input.authority.chain.kind !== "full") {
    pipelineError(
      "AGENT_BACKUP_V3_INCREMENTAL_CAPTURE_UNSUPPORTED",
      "Manifest-v3 capture is full-only until a real delta producer and compactor are available",
    );
  }
  const chunkPlainBytes = input.chunkPlainBytes ?? DEFAULT_CHUNK_PLAIN_BYTES;
  if (
    !Number.isSafeInteger(chunkPlainBytes) ||
    chunkPlainBytes < MIN_CHUNK_PLAIN_BYTES ||
    chunkPlainBytes > AGENT_BACKUP_MANIFEST_V2_LIMITS.maxChunkPlainBytes
  ) {
    pipelineError(
      "AGENT_BACKUP_V2_CHUNK_BOUND_INVALID",
      "Plaintext chunk bound is outside the supported manifest range",
    );
  }
  assertActive(input);
  // A deadline is transport freshness, not durable operation identity. Binding
  // it into the spool would make an interrupted capture impossible to resume
  // with a fresh, valid HTTP deadline after the old one expires.
  const { requestSha256, authoritySha256 } = deriveAgentBackupCaptureV3SpoolAuthorityDigests({
    request,
    authority: input.authority,
  });
  const spool = await AgentBackupCaptureV3Spool.open(input.spool, {
    operationId: request.operationId,
    executionToken: input.executionToken,
    requestSha256,
    authoritySha256,
    runtimePrincipalSha256: input.runtimePrincipalSha256,
  });

  try {
    let artifacts: AgentBackupCaptureV3Artifacts;
    if (spool.phase === "sealed" || spool.phase === "publishing" || spool.phase === "published") {
      artifacts = await loadAgentBackupCaptureV3SealedArtifacts(spool);
    } else {
      const acquired = await acquireOperationKeyBundle(input, spool);
      let processingFailure: unknown;
      let composedArtifacts: AgentBackupCaptureV3Artifacts | undefined;
      try {
        const components = await composeCapture(
          input,
          spool,
          acquired.dek,
          acquired.contentHmacKey,
          chunkPlainBytes,
        );
        const framedContentHmacSha256 = await computeFramedContentHmac({
          pipeline: input,
          spool,
          dek: acquired.dek,
          contentHmacKey: acquired.contentHmacKey,
          components,
        });
        const totals = manifestTotals(components);
        const manifest = await createAgentBackupManifestV3({
          format: AGENT_BACKUP_MANIFEST_FORMAT,
          schemaVersion: AGENT_BACKUP_MANIFEST_V3_SCHEMA_VERSION,
          operationId: request.operationId,
          createdAt: input.authority.createdAt,
          identity: {
            organizationId: input.authority.organizationId,
            agentId: request.agentId,
            activationGeneration: request.activationGeneration,
            lifecycleRevision: request.lifecycleRevision,
          },
          source: input.authority.source,
          runtime: input.authority.runtime,
          chain: input.authority.chain,
          components: components.map((component) => component.manifest),
          watermarks: [...input.authority.watermarks],
          totals,
          vaultKeyAuthority: input.authority.vaultKeyAuthority,
          encryption: {
            algorithm: "AES-256-GCM",
            chunkEnvelope: AGENT_BACKUP_CHUNK_ENVELOPE_V1.name,
            nonceBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.nonceBytes,
            tagBytes: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagBytes,
            noncePlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.noncePlacement,
            tagPlacement: AGENT_BACKUP_CHUNK_ENVELOPE_V1.tagPlacement,
            aad: { version: 1, derivation: "elizaos.agent-backup.chunk-aad.v1" },
            kms: input.authority.kms,
            operationKeyBundle: {
              format: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.format,
              generationId: acquired.generationId,
              plaintextBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.plaintextBytes,
              dek: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.dek,
              contentHmac: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac,
              wrapped: {
                ref: `backup-key-bundle:${request.operationId}`,
                bytes: acquired.wrapped.bytes,
                sha256: acquired.wrapped.sha256,
                localReceiptDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_LOCAL_RECEIPT_DERIVATION,
                localReceiptDigest: acquired.wrapped.localReceiptDigest,
                contextDerivation: AGENT_BACKUP_OPERATION_KEY_BUNDLE_CONTEXT_DERIVATION,
              },
            },
          },
          integrity: {
            framedContentHmacSha256,
            contentAddressing: {
              algorithm: "HMAC-SHA-256",
              scope: "operation",
              derivation: AGENT_BACKUP_OPERATION_CONTENT_HMAC_DERIVATION,
              keyBundleFormat: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.format,
              keyOffsetBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.offsetBytes,
              keyBytes: AGENT_BACKUP_OPERATION_KEY_BUNDLE_V1.contentHmac.bytes,
            },
          },
        });
        const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
        await spool.sealManifest(manifestBytes, {
          bytes: manifestBytes.byteLength,
          sha256: sha256Hex(manifestBytes),
        });
        composedArtifacts = {
          manifest,
          catalogManifest: await catalogManifest(manifest, acquired.wrapped.wrappedKeyBundle),
          wrappedKeyBundle: Uint8Array.from(acquired.wrapped.wrappedKeyBundle),
          chunks: spool.chunks,
        };
      } catch (cause) {
        // error-policy:J3 retain processing failure until mandatory key release.
        processingFailure = cause;
      }
      let releaseFailure: unknown;
      try {
        await releaseAndZeroizeKeyBundle(input.keyBundle, acquired.handle, acquired);
      } catch (cause) {
        // error-policy:J3 retain mandatory release failure below.
        releaseFailure = cause;
      } finally {
        acquired.wrapped.wrappedKeyBundle.fill(0);
      }
      if (processingFailure !== undefined && releaseFailure !== undefined) {
        throw new AggregateError(
          [processingFailure, releaseFailure],
          "Backup processing and key-bundle release both failed",
        );
      }
      if (processingFailure !== undefined) throw processingFailure;
      if (releaseFailure !== undefined) throw releaseFailure;
      if (!composedArtifacts) {
        pipelineError(
          "AGENT_BACKUP_V2_PIPELINE_INCOMPLETE",
          "Backup composition completed without durable artifacts",
        );
      }
      artifacts = composedArtifacts;
    }

    const manifestSha256 = artifacts.manifest.integrity.manifestSha256;
    const chunkCount = artifacts.chunks.length;
    try {
      await publishArtifacts(input, spool, artifacts);
    } finally {
      artifacts.wrappedKeyBundle.fill(0);
    }
    if (input.publication.mode === "capture-only") {
      await spool.close();
      return {
        operationId: request.operationId,
        manifestSha256,
        chunkCount,
        state: "captured-upload-pending",
        cleanup: "blocked-on-upload",
        spool,
      };
    }
    return {
      operationId: request.operationId,
      manifestSha256,
      chunkCount,
      state: "published-cleanup-pending",
      cleanup: "pending",
      spool,
    };
  } catch (cause) {
    // error-policy:J3 a failed execution relinquishes only its lock and keeps
    // durable replay artifacts. Preserve a close failure alongside the cause.
    try {
      await spool.close();
    } catch (closeCause) {
      throw new AggregateError(
        [cause, closeCause],
        "Backup pipeline and spool lock release both failed",
      );
    }
    throw cause;
  }
}

export { AGENT_BACKUP_RECORD_STREAM_V1_FORMAT as AGENT_BACKUP_CAPTURE_V2_RECORD_STREAM_FORMAT };
