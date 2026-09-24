/**
 * Crash-safe append-only JSONL storage shared by public audit and private replay
 * artifacts. Every newline-terminated record is hash-linked and fsynced; startup
 * removes only an unterminated tail and treats committed corruption as fatal.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname } from "node:path";
import { stableJson } from "./canonical.js";
import type { JsonObject, JsonValue } from "./types.js";

const PRIVATE_FILE_MODE = 0o600;
const GENESIS_HASH = "0".repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface HashChainedJsonlOptions {
  sequenceField: string;
  previousHashField?: string;
  recordHashField?: string;
  maxRecordBytes?: number;
}

export interface HashChainedJsonlCursor {
  offset: number;
  pending: Buffer;
}

export class HashChainCorruptionError extends Error {
  readonly code = "hash_chain_corruption";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HashChainCorruptionError";
  }
}

export class HashChainedJsonl {
  private sequence = 0;
  private previousHash = GENESIS_HASH;
  private totalRecords = 0;
  private appendTail: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly file: FileHandle,
    private readonly options: Required<HashChainedJsonlOptions>,
  ) {}

  static async open(
    target: string,
    options: HashChainedJsonlOptions,
    onRecord?: (record: JsonObject) => void,
  ): Promise<HashChainedJsonl> {
    const normalized: Required<HashChainedJsonlOptions> = {
      sequenceField: options.sequenceField,
      previousHashField: options.previousHashField ?? "previous_record_sha256",
      recordHashField: options.recordHashField ?? "record_sha256",
      maxRecordBytes: options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
    };
    if (!normalized.sequenceField.trim()) {
      throw new TypeError("Hash-chain sequence field must be non-empty.");
    }
    if (
      !Number.isSafeInteger(normalized.maxRecordBytes) ||
      normalized.maxRecordBytes <= 0
    ) {
      throw new TypeError(
        "Hash-chain record limit must be a positive integer.",
      );
    }
    const file = await open(
      target,
      constants.O_CREAT | constants.O_RDWR | constants.O_APPEND,
      PRIVATE_FILE_MODE,
    );
    try {
      const fileStat = await file.stat();
      if (!fileStat.isFile()) {
        throw new HashChainCorruptionError(
          "Hash-chain target is not a regular file.",
        );
      }
      if ((Number(fileStat.mode) & 0o777) !== PRIVATE_FILE_MODE) {
        throw new HashChainCorruptionError(
          "Hash-chain target does not have private 0600 permissions.",
        );
      }
      const store = new HashChainedJsonl(file, normalized);
      await store.scanAndRepair(onRecord);
      const directory = await open(dirname(target), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return store;
    } catch (error: unknown) {
      await file.close();
      throw error;
    }
  }

  append(payload: JsonObject): Promise<JsonObject> {
    if (this.closed) {
      return Promise.reject(new Error("Hash-chain store is closed."));
    }
    let appended: JsonObject | null = null;
    const operation = this.appendTail.then(async () => {
      assertNoReservedFields(payload, this.options);
      const unsigned: JsonObject = {
        ...payload,
        [this.options.sequenceField]: this.sequence,
        [this.options.previousHashField]: this.previousHash,
      };
      const recordHash = sha256(stableJson(unsigned));
      appended = {
        ...unsigned,
        [this.options.recordHashField]: recordHash,
      };
      const line = `${stableJson(appended)}\n`;
      if (Buffer.byteLength(line, "utf8") > this.options.maxRecordBytes) {
        throw new RangeError("Hash-chain record exceeds the configured limit.");
      }
      await this.file.write(line, null, "utf8");
      await this.file.sync();
      this.sequence += 1;
      this.totalRecords += 1;
      this.previousHash = recordHash;
    });
    this.appendTail = operation;
    return operation.then(() => {
      if (appended === null)
        throw new Error("Hash-chain append did not commit.");
      return appended;
    });
  }

  async findLast(
    predicate: (record: JsonObject) => boolean,
  ): Promise<JsonObject | null> {
    await this.appendTail;
    let match: JsonObject | null = null;
    await this.scanCommittedRecords((record) => {
      if (predicate(record)) match = record;
    });
    return match;
  }

  createCursor(): HashChainedJsonlCursor {
    return { offset: 0, pending: Buffer.alloc(0) };
  }

  async readNext(cursor: HashChainedJsonlCursor): Promise<JsonObject | null> {
    await this.appendTail;
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
      throw new TypeError(
        "Hash-chain read offset must be a non-negative integer.",
      );
    }
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (cursor.pending.length <= this.options.maxRecordBytes) {
      const newline = cursor.pending.indexOf(0x0a);
      if (newline >= 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(
            cursor.pending.subarray(0, newline).toString("utf8"),
          );
        } catch (error: unknown) {
          throw new HashChainCorruptionError(
            "Hash-chain cursor encountered invalid committed JSON.",
            { cause: error },
          );
        }
        cursor.pending = cursor.pending.subarray(newline + 1);
        if (!isJsonObject(parsed)) {
          throw new HashChainCorruptionError(
            "Hash-chain cursor encountered a non-object record.",
          );
        }
        return parsed;
      }
      const { bytesRead } = await this.file.read(
        buffer,
        0,
        buffer.length,
        cursor.offset,
      );
      if (bytesRead === 0) return null;
      cursor.offset += bytesRead;
      cursor.pending = Buffer.concat([
        cursor.pending,
        buffer.subarray(0, bytesRead),
      ]);
    }
    throw new HashChainCorruptionError(
      "Hash-chain cursor encountered an oversized record.",
    );
  }

  stats(): { total: number } {
    return { total: this.totalRecords };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.appendTail;
    await this.file.close();
  }

  private async scanAndRepair(
    onRecord?: (record: JsonObject) => void,
  ): Promise<void> {
    const result = await this.scanCommittedRecords(onRecord);
    if (result.unterminatedBytes > 0) {
      await this.file.truncate(result.committedBytes);
      await this.file.sync();
    }
  }

  private async scanCommittedRecords(
    onRecord?: (record: JsonObject) => void,
  ): Promise<{ committedBytes: number; unterminatedBytes: number }> {
    let offset = 0;
    let committedBytes = 0;
    let pending = Buffer.alloc(0);
    let expectedSequence = 0;
    let expectedPreviousHash = GENESIS_HASH;
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (true) {
      const { bytesRead } = await this.file.read(
        buffer,
        0,
        buffer.length,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
      pending = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
      if (pending.length > this.options.maxRecordBytes) {
        throw new HashChainCorruptionError(
          "Hash-chain contains an oversized or unterminated record.",
        );
      }
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        committedBytes += line.length + 1;
        if (line.length === 0) {
          throw new HashChainCorruptionError(
            "Hash-chain contains an empty committed record.",
          );
        }
        const record = this.parseAndValidateRecord(
          line,
          expectedSequence,
          expectedPreviousHash,
        );
        expectedPreviousHash = requiredStringField(
          record,
          this.options.recordHashField,
        );
        expectedSequence += 1;
        onRecord?.(record);
        newline = pending.indexOf(0x0a);
      }
    }
    this.sequence = expectedSequence;
    this.totalRecords = expectedSequence;
    this.previousHash = expectedPreviousHash;
    return { committedBytes, unterminatedBytes: pending.length };
  }

  private parseAndValidateRecord(
    line: Buffer,
    expectedSequence: number,
    expectedPreviousHash: string,
  ): JsonObject {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch (error: unknown) {
      throw new HashChainCorruptionError(
        "Hash-chain contains invalid committed JSON.",
        { cause: error },
      );
    }
    if (!isJsonObject(parsed)) {
      throw new HashChainCorruptionError(
        "Hash-chain committed record is not a JSON object.",
      );
    }
    if (parsed[this.options.sequenceField] !== expectedSequence) {
      throw new HashChainCorruptionError(
        "Hash-chain sequence is not contiguous.",
      );
    }
    const previousHash = requiredStringField(
      parsed,
      this.options.previousHashField,
    );
    const recordHash = requiredStringField(
      parsed,
      this.options.recordHashField,
    );
    if (
      previousHash !== expectedPreviousHash ||
      !HASH_PATTERN.test(previousHash) ||
      !HASH_PATTERN.test(recordHash)
    ) {
      throw new HashChainCorruptionError("Hash-chain link is invalid.");
    }
    const unsigned = { ...parsed };
    delete unsigned[this.options.recordHashField];
    if (sha256(stableJson(unsigned)) !== recordHash) {
      throw new HashChainCorruptionError(
        "Hash-chain committed record digest does not match its content.",
      );
    }
    return parsed;
  }
}

function assertNoReservedFields(
  payload: JsonObject,
  options: Required<HashChainedJsonlOptions>,
): void {
  for (const field of [
    options.sequenceField,
    options.previousHashField,
    options.recordHashField,
  ]) {
    if (field in payload) {
      throw new TypeError(
        `Hash-chain payload contains reserved field ${field}.`,
      );
    }
  }
}

function requiredStringField(record: JsonObject, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new HashChainCorruptionError(
      `Hash-chain record is missing required field ${field}.`,
    );
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isJsonValue)
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
