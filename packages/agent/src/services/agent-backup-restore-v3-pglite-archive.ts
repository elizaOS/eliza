/**
 * Bounded, strict reader for the physical PGlite archive captured by manifest-v3.
 * Consumers receive only normalized regular files and directories, never archive
 * links or extraction paths. Input is decompressed tar from an authenticated
 * component; this parser does not confer source authority or permit activation.
 */

import { Buffer } from "node:buffer";
import { ElizaError } from "@elizaos/core";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  assertActive,
  snapshotOperationControl,
  snapshotOwnDataRecord,
} from "./agent-backup-restore-v3-candidate-fs-control";

const BLOCK = 512;
const CHUNK = 256 * 1024;

export const AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_LIMITS = Object.freeze({
  maximumTarBytes: 8 * 1024 * 1024 * 1024,
  maximumFileBytes: 2 * 1024 * 1024 * 1024,
  maximumExtractedBytes: 8 * 1024 * 1024 * 1024,
  maximumFiles: 100_000,
  maximumDirectories: 16_384,
  maximumDepth: 32,
  maximumPathBytes: 1024,
});

export type AgentBackupRestoreV3PgliteArchiveLimits = {
  readonly [Key in keyof typeof AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_LIMITS]: number;
};

export interface AgentBackupRestoreV3PgliteArchiveEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly sizeBytes: number;
}

export class AgentBackupRestoreV3PgliteArchiveError extends ElizaError {
  override readonly name = "AgentBackupRestoreV3PgliteArchiveError";

  constructor(code: string, message: string, cause?: unknown) {
    super(message, {
      code: `AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_${code}`,
      severity: "fatal",
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

function invalid(code: string, message: string, cause?: unknown): never {
  throw new AgentBackupRestoreV3PgliteArchiveError(code, message, cause);
}

function limitsSnapshot(
  input: Partial<AgentBackupRestoreV3PgliteArchiveLimits> | undefined,
): AgentBackupRestoreV3PgliteArchiveLimits {
  const defaults = AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_LIMITS;
  const data = snapshotOwnDataRecord(
    input ?? {},
    Object.keys(defaults),
    [],
    "AGENT_BACKUP_RESTORE_V3_PGLITE_ARCHIVE_LIMIT_INVALID",
    "Archive limits require one plain data object",
  );
  const result: {
    -readonly [Key in keyof AgentBackupRestoreV3PgliteArchiveLimits]: number;
  } = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const value = data[key] === undefined ? defaults[key] : data[key];
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value <= 0 ||
      value > defaults[key]
    ) {
      invalid(
        "LIMIT_INVALID",
        "Archive limits must be positive and cannot widen policy",
      );
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

class ArchiveReader {
  readonly iterator: AsyncIterator<Uint8Array>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  readonly maximumBytes: number;
  totalBytes = 0;
  private current: Buffer | null = null;
  private offset = 0;
  private ended = false;

  constructor(
    source: AsyncIterable<Uint8Array>,
    control: Readonly<AgentBackupRestoreV3OperationControl>,
    maximumBytes: number,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
    this.control = control;
    this.maximumBytes = maximumBytes;
  }

  async pull(): Promise<boolean> {
    assertActive(this.control);
    if (this.current && this.offset === this.current.length) {
      this.current.fill(0);
      this.current = null;
      this.offset = 0;
    }
    while (!this.current && !this.ended) {
      const next = await this.iterator.next();
      assertActive(this.control);
      if (next.done) {
        this.ended = true;
        return false;
      }
      if (
        !(next.value instanceof Uint8Array) ||
        next.value.byteLength > CHUNK
      ) {
        invalid(
          "CHUNK_INVALID",
          "Archive decoder must produce bounded byte chunks",
        );
      }
      if (this.totalBytes > this.maximumBytes - next.value.byteLength) {
        invalid("TAR_LIMIT", "Archive exceeds its decompressed byte budget");
      }
      this.totalBytes += next.value.byteLength;
      if (next.value.byteLength !== 0) this.current = Buffer.from(next.value);
    }
    return this.current !== null;
  }

  async consume(
    length: number,
    visitor: (chunk: Uint8Array) => Promise<void>,
  ): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (!(await this.pull()) || !this.current)
        invalid("TRUNCATED", "Archive ended inside a record");
      const size = Math.min(remaining, this.current.length - this.offset);
      await visitor(
        new Uint8Array(
          this.current.buffer,
          this.current.byteOffset + this.offset,
          size,
        ),
      );
      assertActive(this.control);
      this.offset += size;
      remaining -= size;
    }
  }

  async header(): Promise<Buffer> {
    const bytes = Buffer.alloc(BLOCK);
    let offset = 0;
    try {
      await this.consume(BLOCK, async (chunk) => {
        bytes.set(chunk, offset);
        offset += chunk.length;
      });
      return bytes;
    } catch (cause) {
      // error-policy:J3 A partial untrusted header is cleared before propagation.
      bytes.fill(0);
      throw cause;
    }
  }

  async zeroes(length: number): Promise<void> {
    await this.consume(length, async (chunk) => {
      if (chunk.some((byte) => byte !== 0))
        invalid("PADDING_INVALID", "Archive padding is non-zero");
    });
  }

  async end(): Promise<void> {
    while (await this.pull()) {
      if (!this.current)
        invalid("TRUNCATED", "Archive decoder lost its current chunk");
      if (this.current.subarray(this.offset).some((byte) => byte !== 0))
        invalid("TRAILING_DATA", "Archive contains data after the end marker");
      this.offset = this.current.length;
    }
    if (this.totalBytes % BLOCK !== 0)
      invalid("TRUNCATED", "Archive ends with a partial padding block");
  }

  async close(): Promise<void> {
    this.current?.fill(0);
    this.current = null;
    if (!this.ended) await this.iterator.return?.();
  }
}

function octal(header: Buffer, start: number, length: number): number {
  const bytes = header.subarray(start, start + length);
  // Reject hidden values after a NUL, base-256 and embedded padding.
  let digits = "";
  let padding = false;
  for (const byte of bytes) {
    if (byte === 0 || byte === 32) {
      if (byte === 0 || digits.length > 0) padding = true;
    } else if (byte >= 48 && byte <= 55 && !padding) {
      digits += String.fromCharCode(byte);
    } else {
      invalid("HEADER_INVALID", "Archive numeric field is not canonical octal");
    }
  }
  const value = digits === "" ? 0 : Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value))
    invalid("HEADER_INVALID", "Archive integer is out of range");
  return value;
}

function field(header: Buffer, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const nul = bytes.indexOf(0);
  if (nul !== -1 && bytes.subarray(nul).some((byte) => byte !== 0))
    invalid("HEADER_INVALID", "Archive string has bytes after its terminator");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      nul === -1 ? bytes : bytes.subarray(0, nul),
    );
  } catch (cause) {
    // error-policy:J3 Reject invalid archive names instead of replacing bytes.
    invalid("PATH_INVALID", "Archive string is not UTF-8", cause);
  }
}

function parseHeader(
  header: Buffer,
  limits: AgentBackupRestoreV3PgliteArchiveLimits,
): Readonly<AgentBackupRestoreV3PgliteArchiveEntry> {
  let checksum = 0;
  for (let index = 0; index < BLOCK; index++)
    checksum += index >= 148 && index < 156 ? 32 : header.readUInt8(index);
  if (octal(header, 148, 8) !== checksum)
    invalid("CHECKSUM_MISMATCH", "Archive header checksum is invalid");
  if (
    !header.subarray(257, 262).equals(Buffer.from("ustar", "ascii")) ||
    ![0, 32].includes(header.readUInt8(262)) ||
    !header.subarray(263, 265).equals(Buffer.from("00", "ascii"))
  )
    invalid("HEADER_INVALID", "Archive must use PGlite USTAR 00 headers");
  const type =
    header[156] === 53
      ? "directory"
      : header[156] === 0 || header[156] === 48
        ? "file"
        : null;
  if (!type)
    invalid(
      "TYPE_FORBIDDEN",
      "Archive links, devices and extended headers are forbidden",
    );
  if (field(header, 157, 100) !== "")
    invalid(
      "TYPE_FORBIDDEN",
      "Archive regular entries cannot name a link target",
    );
  for (const [offset, length] of [
    [100, 8],
    [108, 8],
    [116, 8],
    [136, 12],
    [329, 8],
    [337, 8],
    [476, 12],
    [488, 12],
  ] as const)
    octal(header, offset, length);
  field(header, 265, 32);
  field(header, 297, 32);
  if (header.subarray(500).some((byte) => byte !== 0))
    invalid("HEADER_INVALID", "Archive reserved header bytes are non-zero");
  const sizeBytes = octal(header, 124, 12);
  if (type === "directory" && sizeBytes !== 0)
    invalid("HEADER_INVALID", "Archive directory cannot contain bytes");
  if (sizeBytes > limits.maximumFileBytes)
    invalid("FILE_LIMIT", "Archive file exceeds its byte budget");
  // PGlite's tinytar uses 131 prefix bytes, then atime and ctime, and emits
  // PGDATA-relative names with a single leading slash. Never resolve it as root.
  const prefix = field(header, 345, 131);
  let name = `${prefix ? `${prefix}/` : ""}${field(header, 0, 100)}`;
  if (name.startsWith("/")) name = name.slice(1);
  if (type === "directory" && name.endsWith("/")) name = name.slice(0, -1);
  const segments = name.split("/");
  if (
    !name ||
    name.includes("\\") ||
    Array.from(name).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    Buffer.byteLength(name) > limits.maximumPathBytes ||
    segments.length > limits.maximumDepth ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".restore-v3-") ||
        Buffer.byteLength(segment) > 255,
    )
  )
    invalid("PATH_INVALID", "Archive entry path is unsafe or oversized");
  return Object.freeze({ path: name, type, sizeBytes });
}

/**
 * The trusted consumer must await consume() exactly once per entry. Chunks are
 * borrowed until that callback settles and must not escape without a copy.
 * Partial output stays quarantined on failure; only the caller owns cleanup.
 */
export async function readAgentBackupRestoreV3PgliteArchive(input: {
  readonly tar: AsyncIterable<Uint8Array>;
  readonly control: Readonly<AgentBackupRestoreV3OperationControl>;
  readonly limits?: Partial<AgentBackupRestoreV3PgliteArchiveLimits>;
  readonly visit: (
    entry: Readonly<AgentBackupRestoreV3PgliteArchiveEntry>,
    consume: (visitor: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
  ) => Promise<void>;
}): Promise<
  Readonly<{
    tarBytes: number;
    extractedBytes: number;
    files: number;
    directories: number;
  }>
> {
  const control = snapshotOperationControl(input.control);
  const limits = limitsSnapshot(input.limits);
  const reader = new ArchiveReader(input.tar, control, limits.maximumTarBytes);
  const entries = new Set<string>();
  const files = new Set<string>();
  const directories = new Set<string>();
  let extractedBytes = 0;
  try {
    for (;;) {
      const header = await reader.header();
      let entry: Readonly<AgentBackupRestoreV3PgliteArchiveEntry>;
      try {
        if (header.every((byte) => byte === 0)) {
          await reader.zeroes(BLOCK);
          await reader.end();
          break;
        }
        entry = parseHeader(header, limits);
      } finally {
        header.fill(0);
      }
      const normalizedPath = entry.path.normalize("NFC");
      if (entries.has(normalizedPath))
        invalid("DUPLICATE", "Archive repeats a normalized path");
      entries.add(normalizedPath);
      const segments = entry.path.split("/");
      const directoryCount =
        entry.type === "directory" ? segments.length : segments.length - 1;
      for (let count = 1; count <= directoryCount; count++) {
        const name = segments.slice(0, count).join("/");
        if (files.has(name))
          invalid("PATH_COLLISION", "Archive directory collides with a file");
        directories.add(name);
        if (directories.size > limits.maximumDirectories)
          invalid("DIRECTORY_LIMIT", "Archive exceeds its directory budget");
      }
      if (entry.type === "file") {
        if (directories.has(entry.path))
          invalid("PATH_COLLISION", "Archive file collides with a directory");
        files.add(entry.path);
        if (files.size > limits.maximumFiles)
          invalid("FILE_COUNT_LIMIT", "Archive exceeds its file count budget");
        if (extractedBytes > limits.maximumExtractedBytes - entry.sizeBytes)
          invalid(
            "EXTRACTED_LIMIT",
            "Archive exceeds its extracted byte budget",
          );
        extractedBytes += entry.sizeBytes;
      }
      let consumed = false;
      let settled = false;
      let visiting = true;
      try {
        await input.visit(entry, async (visitor) => {
          if (consumed || !visiting)
            invalid(
              "CONSUMER_INVALID",
              "Archive entry must be consumed exactly once during its visit",
            );
          consumed = true;
          await reader.consume(entry.sizeBytes, visitor);
          settled = true;
        });
      } finally {
        visiting = false;
      }
      if (!settled)
        invalid(
          "CONSUMER_INVALID",
          "Archive consumer did not await the complete entry",
        );
      await reader.zeroes((BLOCK - (entry.sizeBytes % BLOCK)) % BLOCK);
    }
    if (!files.has("PG_VERSION") || !files.has("global/pg_control"))
      invalid(
        "DATABASE_MISSING",
        "Archive does not contain an existing physical database",
      );
    return Object.freeze({
      tarBytes: reader.totalBytes,
      extractedBytes,
      files: files.size,
      directories: directories.size,
    });
  } finally {
    await reader.close();
  }
}
