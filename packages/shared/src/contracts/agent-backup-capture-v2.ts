/**
 * Defines the portable framed wire contract between an agent sandbox and the
 * control-plane backup composer. Frames are independently authenticated,
 * strictly ordered, bounded to one small payload, and contain no infrastructure
 * provider, object-storage, encryption-key, or credential metadata.
 */

import z from "zod";

export const AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT =
  "elizaos.agent-backup.capture-request" as const;
export const AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT =
  "elizaos.agent-backup.capture-frame" as const;
export const AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION = 2 as const;
export const AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE =
  "application/vnd.elizaos.agent-backup-capture-v2" as const;
export const AGENT_BACKUP_CAPTURE_V2_MAGIC = "ELZ2" as const;

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;
const FRAME_PREFIX_BYTES = 12;
const FRAME_DIGEST_BYTES = 32;
const ITERATOR_CLOSE_GRACE_MS = 250;
const UTF8_ENCODER = new TextEncoder();

/** Source- and ingress-side limits shared by every capture-v2 participant. */
export const AGENT_BACKUP_CAPTURE_V2_LIMITS = Object.freeze({
  maxRequestBytes: 4 * KIB,
  maxHeaderBytes: 16 * KIB,
  maxFramePayloadBytes: 256 * KIB,
  maxIngressChunkBytes: 512 * KIB,
  maxPlainBytes: GIB,
  maxComponents: 64,
  maxDataFrames: 16_384,
  maxFiles: 16_384,
  maxPathBytes: 1_024,
  maxDeadlineAheadMs: 15 * 60 * 1000,
  framePrefixBytes: FRAME_PREFIX_BYTES,
  frameDigestBytes: FRAME_DIGEST_BYTES,
  maxWireFrameBytes:
    FRAME_PREFIX_BYTES + 16 * KIB + 256 * KIB + FRAME_DIGEST_BYTES,
});

const UUIDSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), "UUID must be lowercase");
const CanonicalUint64StringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,19})$/, "Expected a canonical uint64 decimal")
  .refine(
    (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
    "Expected a uint64 decimal",
  );
const SafeNonNegativeIntegerSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .refine((value) => !Object.is(value, -0), "Expected a canonical integer");
const SafePositiveIntegerSchema = z.number().int().safe().positive();
const Sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a lowercase sha256 hex digest");
const ComponentNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9-]{0,63}$/);
const ComponentFormatSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._+-]{0,127}$/);
const CanonicalTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const epoch = Date.parse(value);
    return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
  }, "Expected a real canonical UTC timestamp");
const RelativeFilePathSchema = z
  .string()
  .min(1)
  .max(AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPathBytes)
  .refine(
    (value) =>
      UTF8_ENCODER.encode(value).length <=
      AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPathBytes,
    "Relative path exceeds its UTF-8 byte limit",
  )
  .refine(
    (value) =>
      new TextDecoder("utf-8", { fatal: true }).decode(
        UTF8_ENCODER.encode(value),
      ) === value,
    "Relative path must round-trip through canonical UTF-8",
  )
  .refine((value) => !value.includes("\\") && !value.includes("\0"))
  .refine((value) => !value.startsWith("/"))
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !value
        .split("/")
        .some(
          (segment) => segment === "." || segment === ".." || segment === "",
        ),
    "Expected a normalized relative path",
  );

export const AgentBackupCaptureV2RequestSchema = z.strictObject({
  format: z.literal(AGENT_BACKUP_CAPTURE_V2_REQUEST_FORMAT),
  schemaVersion: z.literal(AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION),
  operationId: UUIDSchema,
  agentId: UUIDSchema,
  activationGeneration: UUIDSchema,
  lifecycleRevision: CanonicalUint64StringSchema,
  deadlineEpochMs: SafePositiveIntegerSchema,
});

export type AgentBackupCaptureV2Request = z.infer<
  typeof AgentBackupCaptureV2RequestSchema
>;

/** Locale-independent unsigned UTF-8 byte order for every file-set path. */
export function compareAgentBackupCaptureV2FilePaths(
  left: string,
  right: string,
): number {
  if (left === right) return 0;
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

const HeaderBaseShape = {
  format: z.literal(AGENT_BACKUP_CAPTURE_V2_FRAME_FORMAT),
  schemaVersion: z.literal(AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION),
  sequence: SafeNonNegativeIntegerSchema,
} as const;

export const AgentBackupCaptureV2ComponentDescriptorSchema = z.strictObject({
  name: ComponentNameSchema,
  format: ComponentFormatSchema,
  compression: z.enum(["none", "gzip", "zstd"]),
  contentKind: z.enum(["opaque", "file-set", "records"]),
  consistency: z.enum(["transactional", "crash-consistent", "best-effort"]),
});

export const AgentBackupCaptureV2FileEntrySchema = z.strictObject({
  path: RelativeFilePathSchema,
  fileOffsetBytes: SafeNonNegativeIntegerSchema,
  fileSizeBytes: SafeNonNegativeIntegerSchema,
  mode: SafeNonNegativeIntegerSchema.max(0o777),
  mtimeMs: SafeNonNegativeIntegerSchema,
});

const CaptureStartHeaderSchema = z.strictObject({
  ...HeaderBaseShape,
  kind: z.literal("capture-start"),
  operationId: UUIDSchema,
  agentId: UUIDSchema,
  activationGeneration: UUIDSchema,
  lifecycleRevision: CanonicalUint64StringSchema,
  createdAt: CanonicalTimestampSchema,
  componentCount: SafePositiveIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxComponents,
  ),
  maxFramePayloadBytes: z.literal(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
  ),
});

const ComponentStartHeaderSchema = z.strictObject({
  ...HeaderBaseShape,
  kind: z.literal("component-start"),
  componentIndex: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxComponents - 1,
  ),
  component: AgentBackupCaptureV2ComponentDescriptorSchema,
});

const DataHeaderSchema = z.strictObject({
  ...HeaderBaseShape,
  kind: z.literal("data"),
  componentIndex: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxComponents - 1,
  ),
  componentName: ComponentNameSchema,
  dataIndex: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames - 1,
  ),
  offsetBytes: SafeNonNegativeIntegerSchema,
  payloadBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
  ),
  entry: AgentBackupCaptureV2FileEntrySchema.optional(),
});

const ComponentEndHeaderSchema = z.strictObject({
  ...HeaderBaseShape,
  kind: z.literal("component-end"),
  componentIndex: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxComponents - 1,
  ),
  componentName: ComponentNameSchema,
  dataFrameCount: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames,
  ),
  plainBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes,
  ),
  payloadSha256: Sha256Schema,
});

const CaptureEndHeaderSchema = z.strictObject({
  ...HeaderBaseShape,
  kind: z.literal("capture-end"),
  componentCount: SafePositiveIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxComponents,
  ),
  dataFrameCount: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames,
  ),
  plainBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes,
  ),
  frameDigestChainSha256: Sha256Schema,
});

export const AgentBackupCaptureV2FrameHeaderSchema = z.discriminatedUnion(
  "kind",
  [
    CaptureStartHeaderSchema,
    ComponentStartHeaderSchema,
    DataHeaderSchema,
    ComponentEndHeaderSchema,
    CaptureEndHeaderSchema,
  ],
);

export type AgentBackupCaptureV2ComponentDescriptor = z.infer<
  typeof AgentBackupCaptureV2ComponentDescriptorSchema
>;
export type AgentBackupCaptureV2FileEntry = z.infer<
  typeof AgentBackupCaptureV2FileEntrySchema
>;
export type AgentBackupCaptureV2FrameHeader = z.infer<
  typeof AgentBackupCaptureV2FrameHeaderSchema
>;
export type AgentBackupCaptureV2DataHeader = z.infer<typeof DataHeaderSchema>;

export interface AgentBackupCaptureV2Frame {
  header: AgentBackupCaptureV2FrameHeader;
  payload: Uint8Array;
  /** Digest of the exact prefix + JSON header + payload bytes. */
  frameSha256: string;
}

export type AgentBackupCaptureV2Sha256Digest = (
  bytes: Uint8Array,
) => Uint8Array | Promise<Uint8Array>;

export interface AgentBackupCaptureV2Sha256Stream {
  update(bytes: Uint8Array): void;
  digestHex(): string;
}

export type AgentBackupCaptureV2Sha256StreamFactory =
  () => AgentBackupCaptureV2Sha256Stream;

export class AgentBackupCaptureV2ProtocolError extends Error {
  override readonly name = "AgentBackupCaptureV2ProtocolError";

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const FRAME_KIND_CODES = Object.freeze({
  "capture-start": 1,
  "component-start": 2,
  data: 3,
  "component-end": 4,
  "capture-end": 5,
} satisfies Record<AgentBackupCaptureV2FrameHeader["kind"], number>);

const FRAME_CODE_KINDS = new Map<
  number,
  AgentBackupCaptureV2FrameHeader["kind"]
>(
  Object.entries(FRAME_KIND_CODES).map(([kind, code]) => [
    code,
    kind as AgentBackupCaptureV2FrameHeader["kind"],
  ]),
);
const MAGIC_BYTES = new TextEncoder().encode(AGENT_BACKUP_CAPTURE_V2_MAGIC);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function protocolError(code: string, message: string, cause?: unknown): never {
  throw new AgentBackupCaptureV2ProtocolError(code, message, { cause });
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function defaultSha256Digest(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    protocolError(
      "CAPTURE_V2_SHA256_UNAVAILABLE",
      "Web Crypto SHA-256 is unavailable in this runtime",
    );
  }
  const owned = new Uint8Array(bytes);
  return new Uint8Array(await subtle.digest("SHA-256", owned));
}

function assertPayloadMatchesHeader(
  header: AgentBackupCaptureV2FrameHeader,
  payload: Uint8Array,
): void {
  if (header.kind !== "data" && payload.length !== 0) {
    protocolError(
      "CAPTURE_V2_CONTROL_FRAME_PAYLOAD",
      `${header.kind} frames cannot carry payload bytes`,
    );
  }
  if (header.kind !== "data") return;
  if (header.payloadBytes !== payload.length) {
    protocolError(
      "CAPTURE_V2_PAYLOAD_LENGTH_MISMATCH",
      "Data header payloadBytes does not match the wire payload",
    );
  }
  if (payload.length === 0) {
    if (
      header.entry?.fileSizeBytes !== 0 ||
      header.entry.fileOffsetBytes !== 0
    ) {
      protocolError(
        "CAPTURE_V2_ZERO_PROGRESS",
        "A zero-byte data frame is valid only as one explicit empty-file entry",
      );
    }
  }
}

/** Parse and freeze an untrusted capture request before opening any source. */
export function parseAgentBackupCaptureV2Request(
  input: unknown,
): Readonly<AgentBackupCaptureV2Request> {
  return Object.freeze(AgentBackupCaptureV2RequestSchema.parse(input));
}

/** Serialize one independently authenticated, bounded capture frame. */
export async function serializeAgentBackupCaptureV2Frame(
  frame: Readonly<{
    header: AgentBackupCaptureV2FrameHeader;
    payload?: Uint8Array;
  }>,
  digest: AgentBackupCaptureV2Sha256Digest = defaultSha256Digest,
): Promise<Uint8Array> {
  const header = AgentBackupCaptureV2FrameHeaderSchema.parse(frame.header);
  const payload = frame.payload ?? new Uint8Array(0);
  assertPayloadMatchesHeader(header, payload);
  const headerBytes = textEncoder.encode(JSON.stringify(header));
  if (headerBytes.length > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxHeaderBytes) {
    protocolError(
      "CAPTURE_V2_HEADER_TOO_LARGE",
      "Capture frame header exceeds its wire limit",
    );
  }

  const prefix = new Uint8Array(FRAME_PREFIX_BYTES);
  prefix.set(MAGIC_BYTES, 0);
  prefix[4] = AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION;
  prefix[5] = FRAME_KIND_CODES[header.kind];
  const view = new DataView(prefix.buffer);
  view.setUint16(6, headerBytes.length, false);
  view.setUint32(8, payload.length, false);
  const digestOffset = prefix.length + headerBytes.length + payload.length;
  const wire = new Uint8Array(digestOffset + FRAME_DIGEST_BYTES);
  wire.set(prefix, 0);
  wire.set(headerBytes, prefix.length);
  wire.set(payload, prefix.length + headerBytes.length);
  const checksum = await digest(wire.subarray(0, digestOffset));
  if (checksum.length !== FRAME_DIGEST_BYTES) {
    protocolError(
      "CAPTURE_V2_INVALID_SHA256_IMPLEMENTATION",
      "SHA-256 implementation returned a non-32-byte digest",
    );
  }
  wire.set(checksum, digestOffset);
  return wire;
}

/** Extract the raw checksum appended to a frame produced by the serializer. */
export function readAgentBackupCaptureV2FrameDigest(
  wireFrame: Uint8Array,
): Uint8Array {
  if (wireFrame.length < FRAME_PREFIX_BYTES + FRAME_DIGEST_BYTES) {
    protocolError("CAPTURE_V2_TRUNCATED_FRAME", "Capture frame is truncated");
  }
  return wireFrame.slice(wireFrame.length - FRAME_DIGEST_BYTES);
}

class BoundedByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array = new Uint8Array(0);
  private currentOffset = 0;
  private ended = false;
  private closing = false;

  constructor(
    source: AsyncIterable<Uint8Array>,
    private readonly maxIngressChunkBytes: number,
    private readonly control: Readonly<{
      signal?: AbortSignal;
      deadlineEpochMs?: number;
      now: () => number;
    }>,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private assertActive(): void {
    if (this.control.signal?.aborted) {
      protocolError(
        "CAPTURE_V2_ABORTED",
        "Capture stream parsing was cancelled",
        this.control.signal.reason,
      );
    }
    if (
      this.control.deadlineEpochMs !== undefined &&
      this.control.now() >= this.control.deadlineEpochMs
    ) {
      protocolError(
        "CAPTURE_V2_DEADLINE_EXCEEDED",
        "Capture stream parsing exceeded its operation deadline",
      );
    }
  }

  checkActive(): void {
    this.assertActive();
  }

  async runControlled<T>(
    operation: () => T | PromiseLike<T>,
    eraseLateResult?: (value: T) => void,
  ): Promise<T> {
    this.assertActive();
    const pending = Promise.resolve().then(operation);
    const remainingMs =
      this.control.deadlineEpochMs === undefined
        ? undefined
        : this.control.deadlineEpochMs - this.control.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      if (remainingMs !== undefined) {
        timer = setTimeout(
          () =>
            reject(
              new AgentBackupCaptureV2ProtocolError(
                "CAPTURE_V2_DEADLINE_EXCEEDED",
                "Capture stream operation exceeded its deadline",
              ),
            ),
          Math.min(remainingMs, 2_147_483_647),
        );
      }
      if (this.control.signal) {
        abortListener = () =>
          reject(
            new AgentBackupCaptureV2ProtocolError(
              "CAPTURE_V2_ABORTED",
              "Capture stream operation was cancelled",
              { cause: this.control.signal?.reason },
            ),
          );
        this.control.signal.addEventListener("abort", abortListener, {
          once: true,
        });
      }
    });
    try {
      return await Promise.race([pending, interrupted]);
    } catch (cause) {
      // error-policy:J5 the losing operation remains observed and any late
      // sensitive result is erased through the caller-supplied handler.
      void pending.then(
        (late) => {
          try {
            eraseLateResult?.(late);
          } catch (_eraseFailure: unknown) {
            // Cancellation/deadline remains authoritative.
          }
        },
        (_lateFailure: unknown) => undefined,
      );
      throw cause;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortListener) {
        this.control.signal?.removeEventListener("abort", abortListener);
      }
    }
  }

  private next(): Promise<IteratorResult<Uint8Array>> {
    return this.runControlled(
      () => this.iterator.next(),
      (late) => {
        if (!late.done && late.value instanceof Uint8Array) {
          late.value.fill(0);
        }
      },
    );
  }

  private async load(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    if (!(next.value instanceof Uint8Array)) {
      protocolError(
        "CAPTURE_V2_INVALID_INGRESS_CHUNK",
        "Capture ingress yielded a non-Uint8Array chunk",
      );
    }
    if (next.value.length === 0) {
      protocolError(
        "CAPTURE_V2_ZERO_PROGRESS",
        "Capture ingress yielded an empty chunk",
      );
    }
    if (next.value.length > this.maxIngressChunkBytes) {
      protocolError(
        "CAPTURE_V2_INGRESS_CHUNK_TOO_LARGE",
        "Capture ingress chunk exceeds its memory bound",
      );
    }
    this.current.fill(0);
    this.current = Uint8Array.from(next.value);
    this.currentOffset = 0;
    return true;
  }

  async readExact(
    length: number,
    allowCleanEof = false,
  ): Promise<Uint8Array | null> {
    this.assertActive();
    if (length === 0) return new Uint8Array(0);
    const result = new Uint8Array(length);
    try {
      let written = 0;
      while (written < length) {
        if (this.currentOffset >= this.current.length && !(await this.load())) {
          if (allowCleanEof && written === 0) return null;
          protocolError(
            "CAPTURE_V2_TRUNCATED_FRAME",
            "Capture stream ended in the middle of a frame",
          );
        }
        const available = this.current.length - this.currentOffset;
        const take = Math.min(available, length - written);
        result.set(
          this.current.subarray(this.currentOffset, this.currentOffset + take),
          written,
        );
        this.currentOffset += take;
        written += take;
      }
      return result;
    } catch (cause) {
      result.fill(0);
      throw cause;
    }
  }

  async close(): Promise<void> {
    this.current.fill(0);
    this.current = new Uint8Array(0);
    this.currentOffset = 0;
    if (this.closing) return;
    this.closing = true;
    let close: Promise<unknown>;
    try {
      close = Promise.resolve(this.iterator.return?.());
    } catch (_closeFailure: unknown) {
      // error-policy:J5 parser failure/cancellation is authoritative; a source
      // iterator may already have torn itself down synchronously.
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ITERATOR_CLOSE_GRACE_MS);
    });
    try {
      await Promise.race([
        close.then(
          () => undefined,
          (_closeFailure: unknown) => undefined,
        ),
        bounded,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

interface ActiveFileState {
  path: string;
  nextOffset: number;
  size: number;
  mode: number;
  mtimeMs: number;
}

interface ActiveComponentState {
  index: number;
  descriptor: AgentBackupCaptureV2ComponentDescriptor;
  dataFrameCount: number;
  plainBytes: number;
  payloadHash?: AgentBackupCaptureV2Sha256Stream;
  activeFile?: ActiveFileState;
  lastFilePath?: string;
}

function assertActiveFileComplete(active: ActiveComponentState): void {
  if (
    active.activeFile &&
    active.activeFile.nextOffset !== active.activeFile.size
  ) {
    protocolError(
      "CAPTURE_V2_TRUNCATED_FILE",
      `File ${active.activeFile.path} ended before its declared size`,
    );
  }
}

function validateFileEntry(
  active: ActiveComponentState,
  header: AgentBackupCaptureV2DataHeader,
  payloadLength: number,
): void {
  const entry = header.entry;
  if (active.descriptor.contentKind === "file-set" && !entry) {
    protocolError(
      "CAPTURE_V2_FILE_ENTRY_REQUIRED",
      "File-set data frames require file metadata",
    );
  }
  if (active.descriptor.contentKind !== "file-set" && entry) {
    protocolError(
      "CAPTURE_V2_UNEXPECTED_FILE_ENTRY",
      "Only file-set components may carry file metadata",
    );
  }
  if (!entry) return;

  if (!active.activeFile || active.activeFile.path !== entry.path) {
    assertActiveFileComplete(active);
    if (
      active.lastFilePath &&
      compareAgentBackupCaptureV2FilePaths(entry.path, active.lastFilePath) <= 0
    ) {
      protocolError(
        "CAPTURE_V2_FILE_ORDER",
        "File entries must be unique and lexicographically ordered",
      );
    }
    if (entry.fileOffsetBytes !== 0) {
      protocolError(
        "CAPTURE_V2_FILE_OFFSET",
        "The first frame for a file must start at offset zero",
      );
    }
    active.activeFile = {
      path: entry.path,
      nextOffset: 0,
      size: entry.fileSizeBytes,
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
    };
    active.lastFilePath = entry.path;
  }

  const file = active.activeFile;
  if (
    file.nextOffset !== entry.fileOffsetBytes ||
    file.size !== entry.fileSizeBytes ||
    file.mode !== entry.mode ||
    file.mtimeMs !== entry.mtimeMs
  ) {
    protocolError(
      "CAPTURE_V2_FILE_METADATA_DRIFT",
      `File metadata or offset changed while streaming ${entry.path}`,
    );
  }
  if (payloadLength > file.size - file.nextOffset) {
    protocolError(
      "CAPTURE_V2_FILE_SIZE_EXCEEDED",
      `File payload exceeds the declared size for ${entry.path}`,
    );
  }
  file.nextOffset += payloadLength;
}

export interface ParseAgentBackupCaptureV2FramesOptions {
  digest?: AgentBackupCaptureV2Sha256Digest;
  sha256StreamFactory?: AgentBackupCaptureV2Sha256StreamFactory;
  maxIngressChunkBytes?: number;
  /** Cancels a pending ingress read even when the source never settles. */
  signal?: AbortSignal;
  /** Absolute operation deadline shared with capture orchestration. */
  deadlineEpochMs?: number;
  /** Injected only for deterministic deadline tests. */
  now?: () => number;
}

/**
 * Parse and authenticate an arbitrarily fragmented capture stream.
 *
 * Supplying `sha256StreamFactory` additionally verifies each component's
 * terminal payload digest without materializing component bytes.
 */
export async function* parseAgentBackupCaptureV2Frames(
  source: AsyncIterable<Uint8Array>,
  options: Readonly<ParseAgentBackupCaptureV2FramesOptions> = {},
): AsyncGenerator<AgentBackupCaptureV2Frame> {
  const digest = options.digest ?? defaultSha256Digest;
  const now = options.now ?? Date.now;
  const maxIngressChunkBytes =
    options.maxIngressChunkBytes ??
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxIngressChunkBytes;
  if (
    !Number.isSafeInteger(maxIngressChunkBytes) ||
    maxIngressChunkBytes < 1 ||
    maxIngressChunkBytes > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxIngressChunkBytes
  ) {
    protocolError(
      "CAPTURE_V2_INGRESS_BOUND_INVALID",
      "Capture ingress chunk bound is outside its supported range",
    );
  }
  if (
    options.deadlineEpochMs !== undefined &&
    (!Number.isSafeInteger(options.deadlineEpochMs) ||
      options.deadlineEpochMs < 1)
  ) {
    protocolError(
      "CAPTURE_V2_DEADLINE_INVALID",
      "Capture stream operation deadline is invalid",
    );
  }
  const reader = new BoundedByteReader(source, maxIngressChunkBytes, {
    signal: options.signal,
    deadlineEpochMs: options.deadlineEpochMs,
    now,
  });
  let expectedSequence = 0;
  let captureStarted = false;
  let captureEnded = false;
  let expectedComponentCount = 0;
  let completedComponentCount = 0;
  let totalDataFrames = 0;
  let totalPlainBytes = 0;
  let active: ActiveComponentState | undefined;
  let lastComponentName: string | undefined;
  const frameDigests: Uint8Array[] = [];

  try {
    for (;;) {
      reader.checkActive();
      const prefix = await reader.readExact(FRAME_PREFIX_BYTES, true);
      if (!prefix) break;
      if (!equalBytes(prefix.subarray(0, 4), MAGIC_BYTES)) {
        protocolError("CAPTURE_V2_BAD_MAGIC", "Capture frame magic mismatch");
      }
      if (prefix[4] !== AGENT_BACKUP_CAPTURE_V2_SCHEMA_VERSION) {
        protocolError(
          "CAPTURE_V2_UNSUPPORTED_VERSION",
          "Unsupported capture frame version",
        );
      }
      const kind = FRAME_CODE_KINDS.get(prefix[5] ?? -1);
      if (!kind) {
        protocolError(
          "CAPTURE_V2_UNKNOWN_FRAME_KIND",
          "Unknown frame kind code",
        );
      }
      const prefixView = new DataView(
        prefix.buffer,
        prefix.byteOffset,
        prefix.byteLength,
      );
      const headerLength = prefixView.getUint16(6, false);
      const payloadLength = prefixView.getUint32(8, false);
      if (
        headerLength === 0 ||
        headerLength > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxHeaderBytes
      ) {
        protocolError(
          "CAPTURE_V2_HEADER_LENGTH",
          "Capture frame header length is outside its bound",
        );
      }
      if (payloadLength > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes) {
        protocolError(
          "CAPTURE_V2_PAYLOAD_TOO_LARGE",
          "Capture frame payload exceeds its bound",
        );
      }
      const headerBytes = await reader.readExact(headerLength);
      const payload = await reader.readExact(payloadLength);
      const wireDigest = await reader.readExact(FRAME_DIGEST_BYTES);
      if (!headerBytes || !payload || !wireDigest) {
        protocolError(
          "CAPTURE_V2_TRUNCATED_FRAME",
          "Capture frame is truncated",
        );
      }
      const digestInput = concatBytes([prefix, headerBytes, payload]);
      let expectedDigest: Uint8Array;
      try {
        expectedDigest = await reader.runControlled(
          () => digest(digestInput),
          (late) => late.fill(0),
        );
      } finally {
        digestInput.fill(0);
      }
      if (!equalBytes(wireDigest, expectedDigest)) {
        protocolError(
          "CAPTURE_V2_FRAME_TAMPERED",
          "Capture frame checksum mismatch",
        );
      }

      let decodedHeader: unknown;
      try {
        decodedHeader = JSON.parse(textDecoder.decode(headerBytes));
      } catch (error) {
        // error-policy:J3 frame JSON is untrusted transport input and invalid
        // syntax is translated into one explicit protocol failure.
        protocolError(
          "CAPTURE_V2_INVALID_HEADER_JSON",
          `Capture frame header is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const parsed =
        AgentBackupCaptureV2FrameHeaderSchema.safeParse(decodedHeader);
      if (!parsed.success) {
        protocolError(
          "CAPTURE_V2_INVALID_HEADER",
          `Capture frame header is invalid: ${parsed.error.issues[0]?.message ?? "unknown validation error"}`,
        );
      }
      const header = parsed.data;
      if (header.kind !== kind) {
        protocolError(
          "CAPTURE_V2_KIND_MISMATCH",
          "Capture frame kind code does not match its header",
        );
      }
      if (header.sequence !== expectedSequence) {
        protocolError(
          "CAPTURE_V2_SEQUENCE",
          `Expected capture frame sequence ${expectedSequence}`,
        );
      }
      expectedSequence += 1;
      assertPayloadMatchesHeader(header, payload);

      if (header.kind === "capture-start") {
        if (captureStarted || header.sequence !== 0) {
          protocolError(
            "CAPTURE_V2_STATE",
            "capture-start must be the first and only start frame",
          );
        }
        captureStarted = true;
        expectedComponentCount = header.componentCount;
      } else if (!captureStarted || captureEnded) {
        protocolError(
          "CAPTURE_V2_STATE",
          "Capture frame appeared outside an active capture",
        );
      } else if (header.kind === "component-start") {
        if (active || header.componentIndex !== completedComponentCount) {
          protocolError(
            "CAPTURE_V2_COMPONENT_STATE",
            "Components must be sequential and non-overlapping",
          );
        }
        if (
          completedComponentCount >= expectedComponentCount ||
          (lastComponentName && header.component.name <= lastComponentName)
        ) {
          protocolError(
            "CAPTURE_V2_COMPONENT_ORDER",
            "Components must be unique and lexicographically ordered",
          );
        }
        active = {
          index: header.componentIndex,
          descriptor: header.component,
          dataFrameCount: 0,
          plainBytes: 0,
          payloadHash: options.sha256StreamFactory?.(),
        };
        lastComponentName = header.component.name;
      } else if (header.kind === "data") {
        if (
          !active ||
          header.componentIndex !== active.index ||
          header.componentName !== active.descriptor.name ||
          header.dataIndex !== active.dataFrameCount ||
          header.offsetBytes !== active.plainBytes
        ) {
          protocolError(
            "CAPTURE_V2_DATA_STATE",
            "Data frame does not continue the active component",
          );
        }
        validateFileEntry(active, header, payload.length);
        if (
          totalPlainBytes >
          AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes - payload.length
        ) {
          protocolError(
            "CAPTURE_V2_PLAIN_BYTES_LIMIT",
            "Capture exceeds its plaintext byte limit",
          );
        }
        active.payloadHash?.update(payload);
        active.plainBytes += payload.length;
        active.dataFrameCount += 1;
        totalPlainBytes += payload.length;
        totalDataFrames += 1;
        if (totalDataFrames > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames) {
          protocolError(
            "CAPTURE_V2_DATA_FRAME_LIMIT",
            "Capture exceeds its data-frame limit",
          );
        }
      } else if (header.kind === "component-end") {
        if (
          !active ||
          header.componentIndex !== active.index ||
          header.componentName !== active.descriptor.name ||
          header.dataFrameCount !== active.dataFrameCount ||
          header.plainBytes !== active.plainBytes
        ) {
          protocolError(
            "CAPTURE_V2_COMPONENT_TOTALS",
            "Component terminal totals do not match streamed data",
          );
        }
        assertActiveFileComplete(active);
        const payloadSha256 = active.payloadHash?.digestHex();
        if (payloadSha256 && payloadSha256 !== header.payloadSha256) {
          protocolError(
            "CAPTURE_V2_COMPONENT_DIGEST",
            `Component payload digest mismatch for ${header.componentName}`,
          );
        }
        active = undefined;
        completedComponentCount += 1;
      } else {
        if (
          active ||
          completedComponentCount !== expectedComponentCount ||
          header.componentCount !== completedComponentCount ||
          header.dataFrameCount !== totalDataFrames ||
          header.plainBytes !== totalPlainBytes
        ) {
          protocolError(
            "CAPTURE_V2_CAPTURE_TOTALS",
            "Capture terminal totals do not match streamed components",
          );
        }
        const digestInput = concatBytes(frameDigests);
        let chainedDigest: Uint8Array;
        try {
          chainedDigest = await reader.runControlled(
            () => digest(digestInput),
            (late) => late.fill(0),
          );
        } finally {
          digestInput.fill(0);
        }
        const chained = bytesToHex(chainedDigest);
        if (chained !== header.frameDigestChainSha256) {
          protocolError(
            "CAPTURE_V2_CHAIN_DIGEST",
            "Capture terminal frame-digest chain does not match",
          );
        }
        captureEnded = true;
      }

      const frame: AgentBackupCaptureV2Frame = {
        header,
        payload,
        frameSha256: bytesToHex(wireDigest),
      };
      if (header.kind !== "capture-end") frameDigests.push(wireDigest.slice());
      reader.checkActive();
      yield frame;
      if (header.kind === "capture-end") {
        const trailing = await reader.readExact(1, true);
        if (trailing) {
          protocolError(
            "CAPTURE_V2_TRAILING_BYTES",
            "Capture stream contains bytes after capture-end",
          );
        }
        break;
      }
    }

    if (!captureEnded) {
      protocolError(
        "CAPTURE_V2_INCOMPLETE",
        "Capture stream ended without capture-end",
      );
    }
  } finally {
    await reader.close();
  }
}
