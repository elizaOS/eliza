/**
 * Defines the canonical plaintext component stream sealed inside sandbox backup
 * chunks. The codec preserves the original `ELZ2REC1` wire byte-for-byte while
 * giving capture and restore one bounded, runtime-neutral encoder/parser.
 */

import z from "zod";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  type AgentBackupCaptureV2ComponentDescriptor,
  AgentBackupCaptureV2ComponentDescriptorSchema,
  type AgentBackupCaptureV2FileEntry,
  AgentBackupCaptureV2FileEntrySchema,
  compareAgentBackupCaptureV2FilePaths,
} from "./agent-backup-capture-v2.js";

export const AGENT_BACKUP_RECORD_STREAM_V1_FORMAT =
  "elizaos.capture-v2-record-stream.v1" as const;
export const AGENT_BACKUP_RECORD_STREAM_V1_MAGIC = "ELZ2REC1" as const;
export const AGENT_BACKUP_RECORD_STREAM_V1_VERSION = 1 as const;

const RECORD_PREFIX_BYTES = 9;
const ITERATOR_CLOSE_GRACE_MS = 250;
const MAGIC_BYTES = new TextEncoder().encode(
  AGENT_BACKUP_RECORD_STREAM_V1_MAGIC,
);
const MAX_RECORDS = AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames + 2;

export const AGENT_BACKUP_RECORD_STREAM_V1_LIMITS = Object.freeze({
  magicBytes: MAGIC_BYTES.byteLength,
  recordPrefixBytes: RECORD_PREFIX_BYTES,
  maxHeaderBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxHeaderBytes,
  maxPayloadBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
  maxIngressChunkBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxIngressChunkBytes,
  maxPayloadTotalBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes,
  maxRecords: MAX_RECORDS,
  maxStreamBytes:
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes +
    MAX_RECORDS *
      (RECORD_PREFIX_BYTES + AGENT_BACKUP_CAPTURE_V2_LIMITS.maxHeaderBytes) +
    MAGIC_BYTES.byteLength,
});

const SafeNonNegativeIntegerSchema = z
  .number()
  .int()
  .safe()
  .nonnegative()
  .refine((value) => !Object.is(value, -0), "Expected a canonical integer");
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const AgentBackupRecordStreamV1ComponentStartHeaderSchema =
  z.strictObject({
    descriptor: AgentBackupCaptureV2ComponentDescriptorSchema,
  });

export const AgentBackupRecordStreamV1DataHeaderSchema = z.strictObject({
  dataIndex: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames - 1,
  ),
  offsetBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes,
  ),
  payloadBytes: SafeNonNegativeIntegerSchema.max(
    AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
  ),
  entry: AgentBackupCaptureV2FileEntrySchema.nullable(),
});

export const AgentBackupRecordStreamV1ComponentEndHeaderSchema = z.strictObject(
  {
    dataFrameCount: SafeNonNegativeIntegerSchema.max(
      AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDataFrames,
    ),
    payloadBytes: SafeNonNegativeIntegerSchema.max(
      AGENT_BACKUP_CAPTURE_V2_LIMITS.maxPlainBytes,
    ),
    payloadSha256: Sha256Schema,
  },
);

type ComponentStartHeader = z.infer<
  typeof AgentBackupRecordStreamV1ComponentStartHeaderSchema
>;
type DataHeader = z.infer<typeof AgentBackupRecordStreamV1DataHeaderSchema>;
type ComponentEndHeader = z.infer<
  typeof AgentBackupRecordStreamV1ComponentEndHeaderSchema
>;

export type AgentBackupRecordStreamV1Record =
  | ({ kind: "component-start" } & ComponentStartHeader)
  | ({ kind: "data"; payload: Uint8Array } & DataHeader)
  | ({ kind: "component-end" } & ComponentEndHeader);

export interface AgentBackupRecordStreamV1Sha256Stream {
  update(bytes: Uint8Array): void | Promise<void>;
  digestHex(): string | Promise<string>;
}

export type AgentBackupRecordStreamV1Sha256StreamFactory =
  () => AgentBackupRecordStreamV1Sha256Stream;

export interface ParseAgentBackupRecordStreamV1Options {
  /** Required so a bounded parser never buffers the component to hash it. */
  sha256StreamFactory: AgentBackupRecordStreamV1Sha256StreamFactory;
  maxIngressChunkBytes?: number;
  maxPayloadTotalBytes?: number;
  maxStreamBytes?: number;
  /** Cancels an ingress read even when the source iterator never settles. */
  signal?: AbortSignal;
  /** Absolute operation deadline shared with capture/restore orchestration. */
  deadlineEpochMs?: number;
  /** Injected only for deterministic deadline tests. */
  now?: () => number;
}

export class AgentBackupRecordStreamV1Error extends Error {
  override readonly name = "AgentBackupRecordStreamV1Error";

  constructor(
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function recordStreamError(
  code: string,
  message: string,
  cause?: unknown,
): never {
  throw new AgentBackupRecordStreamV1Error(code, message, { cause });
}

function uint32BigEndian(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_LENGTH_INVALID",
      "Record length is outside uint32",
    );
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    // error-policy:J3 record headers are untrusted restore input and never
    // receive a fallback value.
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_HEADER_INVALID",
      "Record header is not valid UTF-8 JSON",
      cause,
    );
  }
}

function canonicalHeader(record: AgentBackupRecordStreamV1Record): {
  code: 1 | 2 | 3;
  header: ComponentStartHeader | DataHeader | ComponentEndHeader;
  payload: Uint8Array;
} {
  if (record.kind === "component-start") {
    return {
      code: 1,
      header: AgentBackupRecordStreamV1ComponentStartHeaderSchema.parse({
        descriptor: record.descriptor,
      }),
      payload: new Uint8Array(0),
    };
  }
  if (record.kind === "data") {
    if (!(record.payload instanceof Uint8Array)) {
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_PAYLOAD_INVALID",
        "Data record payload must be Uint8Array",
      );
    }
    const header = AgentBackupRecordStreamV1DataHeaderSchema.parse({
      dataIndex: record.dataIndex,
      offsetBytes: record.offsetBytes,
      payloadBytes: record.payloadBytes,
      entry: record.entry,
    });
    if (header.payloadBytes !== record.payload.byteLength) {
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_PAYLOAD_LENGTH_MISMATCH",
        "Data payload length differs from its canonical header",
      );
    }
    return { code: 2, header, payload: record.payload };
  }
  return {
    code: 3,
    header: AgentBackupRecordStreamV1ComponentEndHeaderSchema.parse({
      dataFrameCount: record.dataFrameCount,
      payloadBytes: record.payloadBytes,
      payloadSha256: record.payloadSha256,
    }),
    payload: new Uint8Array(0),
  };
}

/** Return an owned copy of the exact stream prefix. */
export function serializeAgentBackupRecordStreamV1Magic(): Uint8Array {
  return Uint8Array.from(MAGIC_BYTES);
}

/** Serialize one canonical record without joining its bounded byte fragments. */
export function serializeAgentBackupRecordStreamV1Record(
  record: Readonly<AgentBackupRecordStreamV1Record>,
): readonly Uint8Array[] {
  const normalized = canonicalHeader(record as AgentBackupRecordStreamV1Record);
  const headerBytes = new TextEncoder().encode(
    JSON.stringify(normalized.header),
  );
  if (
    headerBytes.byteLength > AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxHeaderBytes
  ) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_HEADER_TOO_LARGE",
      "Record header exceeds its wire bound",
    );
  }
  if (
    normalized.payload.byteLength >
    AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxPayloadBytes
  ) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_PAYLOAD_TOO_LARGE",
      "Record payload exceeds its wire bound",
    );
  }
  return [
    Uint8Array.of(normalized.code),
    uint32BigEndian(headerBytes.byteLength),
    uint32BigEndian(normalized.payload.byteLength),
    headerBytes,
    ...(normalized.payload.byteLength > 0 ? [normalized.payload] : []),
  ];
}

class BoundedByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current = new Uint8Array(0);
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
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_ABORTED",
        "Record stream parsing was cancelled",
        this.control.signal.reason,
      );
    }
    if (
      this.control.deadlineEpochMs !== undefined &&
      this.control.now() >= this.control.deadlineEpochMs
    ) {
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_DEADLINE_EXCEEDED",
        "Record stream parsing exceeded its operation deadline",
      );
    }
  }

  private async next(): Promise<IteratorResult<Uint8Array>> {
    this.assertActive();
    const pending = Promise.resolve().then(() => this.iterator.next());
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
              new AgentBackupRecordStreamV1Error(
                "BACKUP_RECORD_STREAM_V1_DEADLINE_EXCEEDED",
                "Record stream ingress read exceeded its operation deadline",
              ),
            ),
          Math.min(remainingMs, 2_147_483_647),
        );
      }
      if (this.control.signal) {
        abortListener = () =>
          reject(
            new AgentBackupRecordStreamV1Error(
              "BACKUP_RECORD_STREAM_V1_ABORTED",
              "Record stream ingress read was cancelled",
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
      // error-policy:J5 the losing iterator read is observed and any plaintext
      // it eventually yields is erased; cancellation remains the primary error.
      void pending.then(
        (late) => {
          if (!late.done && late.value instanceof Uint8Array) {
            late.value.fill(0);
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

  private async load(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0) {
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_INGRESS_INVALID",
        "Record stream ingress must yield non-empty Uint8Array chunks",
      );
    }
    if (next.value.byteLength > this.maxIngressChunkBytes) {
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_INGRESS_TOO_LARGE",
        "Record stream ingress chunk exceeds its memory bound",
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
    if (length === 0) return new Uint8Array(0);
    const output = new Uint8Array(length);
    try {
      let written = 0;
      while (written < length) {
        if (
          this.currentOffset >= this.current.byteLength &&
          !(await this.load())
        ) {
          if (allowCleanEof && written === 0) return null;
          recordStreamError(
            "BACKUP_RECORD_STREAM_V1_TRUNCATED",
            "Record stream ended inside a framed value",
          );
        }
        const available = this.current.byteLength - this.currentOffset;
        const take = Math.min(available, length - written);
        output.set(
          this.current.subarray(this.currentOffset, this.currentOffset + take),
          written,
        );
        this.currentOffset += take;
        written += take;
      }
      return output;
    } catch (cause) {
      output.fill(0);
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

interface ActiveFile {
  path: string;
  nextOffset: number;
  size: number;
  mode: number;
  mtimeMs: number;
  records: number;
}

function assertFileEntry(
  descriptor: AgentBackupCaptureV2ComponentDescriptor,
  entry: AgentBackupCaptureV2FileEntry | null,
  payloadBytes: number,
  state: { activeFile?: ActiveFile; lastFilePath?: string },
): void {
  if (descriptor.contentKind === "file-set" && !entry) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_FILE_ENTRY_REQUIRED",
      "File-set record is missing file metadata",
    );
  }
  if (descriptor.contentKind !== "file-set" && entry) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_FILE_ENTRY_UNEXPECTED",
      "Only file-set records may contain file metadata",
    );
  }
  if (!entry) return;
  if (!state.activeFile || state.activeFile.path !== entry.path) {
    if (
      state.activeFile &&
      state.activeFile.nextOffset !== state.activeFile.size
    ) {
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_FILE_TRUNCATED",
        "File record ended before its declared size",
      );
    }
    if (
      state.lastFilePath &&
      compareAgentBackupCaptureV2FilePaths(entry.path, state.lastFilePath) <= 0
    ) {
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_FILE_ORDER_INVALID",
        "File paths must be unique and lexicographically ordered",
      );
    }
    if (entry.fileOffsetBytes !== 0) {
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_FILE_OFFSET_INVALID",
        "A new file must begin at offset zero",
      );
    }
    state.activeFile = {
      path: entry.path,
      nextOffset: 0,
      size: entry.fileSizeBytes,
      mode: entry.mode,
      mtimeMs: entry.mtimeMs,
      records: 0,
    };
    state.lastFilePath = entry.path;
  }
  const active = state.activeFile;
  if (
    entry.fileSizeBytes !== active.size ||
    entry.mode !== active.mode ||
    entry.mtimeMs !== active.mtimeMs ||
    entry.fileOffsetBytes !== active.nextOffset ||
    payloadBytes > active.size - active.nextOffset
  ) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_FILE_METADATA_CHANGED",
      "File metadata or offset changed inside one file",
    );
  }
  if (
    payloadBytes === 0 &&
    (active.size !== 0 || active.nextOffset !== 0 || active.records !== 0)
  ) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_ZERO_PROGRESS",
      "Only one explicit empty-file record may have zero payload bytes",
    );
  }
  active.nextOffset += payloadBytes;
  active.records += 1;
}

function readBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_BOUND_INVALID",
      `${field} is outside its supported range`,
    );
  }
  return resolved;
}

/**
 * Parse one component stream with bounded ingress and a caller-owned streaming
 * SHA-256 implementation. Every JSON header must already use canonical bytes.
 */
export async function* parseAgentBackupRecordStreamV1(
  source: AsyncIterable<Uint8Array>,
  options: Readonly<ParseAgentBackupRecordStreamV1Options>,
): AsyncGenerator<AgentBackupRecordStreamV1Record> {
  if (typeof options?.sha256StreamFactory !== "function") {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_SHA256_REQUIRED",
      "A streaming SHA-256 factory is required",
    );
  }
  const maxIngressChunkBytes = readBound(
    options.maxIngressChunkBytes,
    AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxIngressChunkBytes,
    AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxIngressChunkBytes,
    "maxIngressChunkBytes",
  );
  const maxPayloadTotalBytes = readBound(
    options.maxPayloadTotalBytes,
    AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxPayloadTotalBytes,
    AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxPayloadTotalBytes,
    "maxPayloadTotalBytes",
  );
  const maxStreamBytes = readBound(
    options.maxStreamBytes,
    AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxStreamBytes,
    AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxStreamBytes,
    "maxStreamBytes",
  );
  const now = options.now ?? Date.now;
  if (
    options.deadlineEpochMs !== undefined &&
    (!Number.isSafeInteger(options.deadlineEpochMs) ||
      options.deadlineEpochMs < 1)
  ) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_DEADLINE_INVALID",
      "Record stream operation deadline is invalid",
    );
  }
  const reader = new BoundedByteReader(source, maxIngressChunkBytes, {
    signal: options.signal,
    deadlineEpochMs: options.deadlineEpochMs,
    now,
  });
  let streamBytes = 0;
  let descriptor: AgentBackupCaptureV2ComponentDescriptor | undefined;
  let dataFrameCount = 0;
  let payloadBytes = 0;
  let sawEnd = false;
  const fileState: { activeFile?: ActiveFile; lastFilePath?: string } = {};
  const payloadHash = options.sha256StreamFactory();
  if (
    !payloadHash ||
    typeof payloadHash.update !== "function" ||
    typeof payloadHash.digestHex !== "function"
  ) {
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_SHA256_INVALID",
      "Streaming SHA-256 factory returned an invalid stream",
    );
  }

  try {
    const magic = await reader.readExact(MAGIC_BYTES.byteLength);
    if (!magic || !equalBytes(magic, MAGIC_BYTES)) {
      recordStreamError(
        "BACKUP_RECORD_STREAM_V1_MAGIC_INVALID",
        "Component record stream magic is invalid",
      );
    }
    streamBytes += MAGIC_BYTES.byteLength;

    for (let recordIndex = 0; recordIndex < MAX_RECORDS; recordIndex += 1) {
      const codeBytes = await reader.readExact(1, sawEnd);
      if (codeBytes === null) {
        if (!sawEnd) {
          recordStreamError(
            "BACKUP_RECORD_STREAM_V1_TRUNCATED",
            "Component record stream has no terminal record",
          );
        }
        return;
      }
      if (sawEnd) {
        recordStreamError(
          "BACKUP_RECORD_STREAM_V1_TRAILING_DATA",
          "Component record stream contains bytes after its terminal record",
        );
      }
      const prefixTail = await reader.readExact(8);
      if (!prefixTail) throw new Error("Record prefix unexpectedly absent");
      const prefix = new DataView(
        prefixTail.buffer,
        prefixTail.byteOffset,
        prefixTail.byteLength,
      );
      const headerBytesLength = prefix.getUint32(0, false);
      const payloadBytesLength = prefix.getUint32(4, false);
      if (
        headerBytesLength === 0 ||
        headerBytesLength > AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxHeaderBytes
      ) {
        recordStreamError(
          "BACKUP_RECORD_STREAM_V1_HEADER_TOO_LARGE",
          "Record header is empty or exceeds its wire bound",
        );
      }
      if (
        payloadBytesLength >
        AGENT_BACKUP_RECORD_STREAM_V1_LIMITS.maxPayloadBytes
      ) {
        recordStreamError(
          "BACKUP_RECORD_STREAM_V1_PAYLOAD_TOO_LARGE",
          "Record payload exceeds its wire bound",
        );
      }
      const nextStreamBytes =
        streamBytes +
        RECORD_PREFIX_BYTES +
        headerBytesLength +
        payloadBytesLength;
      if (
        !Number.isSafeInteger(nextStreamBytes) ||
        nextStreamBytes > maxStreamBytes
      ) {
        recordStreamError(
          "BACKUP_RECORD_STREAM_V1_STREAM_TOO_LARGE",
          "Component record stream exceeds its byte bound",
        );
      }
      streamBytes = nextStreamBytes;
      const headerBytes = await reader.readExact(headerBytesLength);
      const payload = await reader.readExact(payloadBytesLength);
      if (!headerBytes || !payload)
        throw new Error("Record body unexpectedly absent");

      let record: AgentBackupRecordStreamV1Record;
      try {
        if (codeBytes[0] === 1) {
          if (recordIndex !== 0 || descriptor) {
            recordStreamError(
              "BACKUP_RECORD_STREAM_V1_STATE_INVALID",
              "Component-start must be the first and only start record",
            );
          }
          if (payload.byteLength !== 0) {
            recordStreamError(
              "BACKUP_RECORD_STREAM_V1_CONTROL_PAYLOAD",
              "Component-start cannot contain payload bytes",
            );
          }
          const header =
            AgentBackupRecordStreamV1ComponentStartHeaderSchema.parse(
              parseJson(headerBytes),
            );
          descriptor = header.descriptor;
          record = { kind: "component-start", ...header };
        } else if (codeBytes[0] === 2) {
          if (!descriptor) {
            recordStreamError(
              "BACKUP_RECORD_STREAM_V1_STATE_INVALID",
              "Data record appeared before component-start",
            );
          }
          const header = AgentBackupRecordStreamV1DataHeaderSchema.parse(
            parseJson(headerBytes),
          );
          if (
            header.dataIndex !== dataFrameCount ||
            header.offsetBytes !== payloadBytes ||
            header.payloadBytes !== payload.byteLength
          ) {
            recordStreamError(
              "BACKUP_RECORD_STREAM_V1_SEQUENCE_INVALID",
              "Data record index, offset, or payload length is non-contiguous",
            );
          }
          if (payloadBytes > maxPayloadTotalBytes - payload.byteLength) {
            recordStreamError(
              "BACKUP_RECORD_STREAM_V1_PAYLOAD_TOTAL_TOO_LARGE",
              "Component payload exceeds its byte bound",
            );
          }
          assertFileEntry(
            descriptor,
            header.entry,
            payload.byteLength,
            fileState,
          );
          await payloadHash.update(payload);
          payloadBytes += payload.byteLength;
          dataFrameCount += 1;
          record = { kind: "data", ...header, payload };
        } else if (codeBytes[0] === 3) {
          if (!descriptor || payload.byteLength !== 0) {
            recordStreamError(
              "BACKUP_RECORD_STREAM_V1_STATE_INVALID",
              "Component-end is missing authority or carries payload bytes",
            );
          }
          const header =
            AgentBackupRecordStreamV1ComponentEndHeaderSchema.parse(
              parseJson(headerBytes),
            );
          if (
            header.dataFrameCount !== dataFrameCount ||
            header.payloadBytes !== payloadBytes
          ) {
            recordStreamError(
              "BACKUP_RECORD_STREAM_V1_TERMINAL_MISMATCH",
              "Component-end accounting differs from the parsed records",
            );
          }
          if (
            fileState.activeFile &&
            fileState.activeFile.nextOffset !== fileState.activeFile.size
          ) {
            recordStreamError(
              "BACKUP_RECORD_STREAM_V1_FILE_TRUNCATED",
              "Terminal file record ended before its declared size",
            );
          }
          const digest = await payloadHash.digestHex();
          if (
            !Sha256Schema.safeParse(digest).success ||
            digest !== header.payloadSha256
          ) {
            recordStreamError(
              "BACKUP_RECORD_STREAM_V1_PAYLOAD_DIGEST_MISMATCH",
              "Component payload digest differs from component-end",
            );
          }
          sawEnd = true;
          record = { kind: "component-end", ...header };
        } else {
          recordStreamError(
            "BACKUP_RECORD_STREAM_V1_KIND_INVALID",
            "Record kind code is unsupported",
          );
        }
      } catch (cause) {
        // error-policy:J3 schema failures remain explicit invalid-stream errors.
        if (cause instanceof AgentBackupRecordStreamV1Error) throw cause;
        recordStreamError(
          "BACKUP_RECORD_STREAM_V1_HEADER_INVALID",
          "Record header failed its strict schema",
          cause,
        );
      }

      const canonical = serializeAgentBackupRecordStreamV1Record(record);
      const canonicalHeaderBytes = canonical[3];
      if (
        !canonicalHeaderBytes ||
        !equalBytes(headerBytes, canonicalHeaderBytes)
      ) {
        recordStreamError(
          "BACKUP_RECORD_STREAM_V1_HEADER_NON_CANONICAL",
          "Record header JSON is not byte-canonical",
        );
      }
      yield record;
      if (record.kind === "component-end") {
        const trailing = await reader.readExact(1, true);
        if (trailing !== null) {
          recordStreamError(
            "BACKUP_RECORD_STREAM_V1_TRAILING_DATA",
            "Component record stream contains bytes after its terminal record",
          );
        }
        return;
      }
    }
    recordStreamError(
      "BACKUP_RECORD_STREAM_V1_RECORD_LIMIT_EXCEEDED",
      "Component record stream exceeds its record-count bound",
    );
  } finally {
    await reader.close();
  }
}
