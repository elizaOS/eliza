/**
 * Resumable upload session state for large conversation imports.
 *
 * The cloud transport can persist this shape between requests, but the rules
 * stay pure here: validate chunk index/range/hash, make duplicate chunk retries
 * idempotent, report missing ranges, and expose deterministic progress.
 */

import { createHash } from "node:crypto";

export interface ResumableUploadSession {
  sessionId: string;
  uploadBytes: number;
  chunkSize: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
  status: "open" | "complete";
  chunks: Record<number, ResumableUploadChunk>;
}

export interface ResumableUploadChunk {
  index: number;
  offset: number;
  byteLength: number;
  sha256: string;
  receivedAt: number;
}

export interface CreateResumableUploadSessionOptions {
  sessionId: string;
  uploadBytes: number;
  chunkSize: number;
  now?: () => number;
}

export interface RecordResumableChunkOptions {
  index: number;
  offset: number;
  bytes: Uint8Array | string;
  /** Optional caller-supplied digest; when present it must match the bytes. */
  sha256?: string;
  now?: () => number;
}

export interface ResumableUploadProgress {
  receivedBytes: number;
  uploadBytes: number;
  receivedChunks: number;
  chunkCount: number;
  complete: boolean;
}

export interface MissingUploadRange {
  start: number;
  endExclusive: number;
  chunkIndex: number;
}

export type RecordResumableChunkResult =
  | {
      status: "accepted";
      session: ResumableUploadSession;
      chunk: ResumableUploadChunk;
      progress: ResumableUploadProgress;
    }
  | {
      status: "duplicate";
      session: ResumableUploadSession;
      chunk: ResumableUploadChunk;
      progress: ResumableUploadProgress;
    };

const DEFAULT_NOW = () => Date.now();
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function createResumableUploadSession(
  options: CreateResumableUploadSessionOptions,
): ResumableUploadSession {
  const sessionId = safeSessionId(options.sessionId);
  assertPositiveInteger(options.uploadBytes, "uploadBytes");
  assertPositiveInteger(options.chunkSize, "chunkSize");

  const now = options.now ?? DEFAULT_NOW;
  const timestamp = now();
  return {
    sessionId,
    uploadBytes: options.uploadBytes,
    chunkSize: options.chunkSize,
    chunkCount: Math.ceil(options.uploadBytes / options.chunkSize),
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "open",
    chunks: {},
  };
}

export function recordResumableChunk(
  session: ResumableUploadSession,
  options: RecordResumableChunkOptions,
): RecordResumableChunkResult {
  const validSession = validateResumableUploadSession(session);
  const expected = expectedChunkRange(validSession, options.index);
  if (options.offset !== expected.start) {
    throw new Error(
      `recordResumableChunk: chunk ${options.index} offset ${options.offset} does not match expected ${expected.start}`,
    );
  }

  const byteLength = resumableByteLength(options.bytes);
  const expectedLength = expected.endExclusive - expected.start;
  if (byteLength !== expectedLength) {
    throw new Error(
      `recordResumableChunk: chunk ${options.index} length ${byteLength} does not match expected ${expectedLength}`,
    );
  }

  const sha256 = resumableSha256Hex(options.bytes);
  if (options.sha256 !== undefined && options.sha256 !== sha256) {
    throw new Error(
      `recordResumableChunk: chunk ${options.index} sha256 mismatch`,
    );
  }

  const existing = validSession.chunks[options.index];
  if (existing) {
    if (
      existing.offset !== options.offset ||
      existing.byteLength !== byteLength ||
      existing.sha256 !== sha256
    ) {
      throw new Error(
        `recordResumableChunk: chunk ${options.index} conflicts with previously received bytes`,
      );
    }
    return {
      status: "duplicate",
      session: validSession,
      chunk: existing,
      progress: getResumableUploadProgress(validSession),
    };
  }

  if (validSession.status !== "open") {
    throw new Error("recordResumableChunk: session is already complete");
  }

  const receivedAt = (options.now ?? DEFAULT_NOW)();
  const chunk: ResumableUploadChunk = {
    index: options.index,
    offset: options.offset,
    byteLength,
    sha256,
    receivedAt,
  };
  const chunks = { ...validSession.chunks, [options.index]: chunk };
  const complete = Object.keys(chunks).length === validSession.chunkCount;
  const next: ResumableUploadSession = {
    ...validSession,
    chunks,
    updatedAt: receivedAt,
    status: complete ? "complete" : "open",
  };

  return {
    status: "accepted",
    session: next,
    chunk,
    progress: getResumableUploadProgress(next),
  };
}

export function getResumableUploadProgress(
  session: ResumableUploadSession,
): ResumableUploadProgress {
  const validSession = validateResumableUploadSession(session);
  const chunks = Object.values(validSession.chunks);
  return {
    receivedBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    uploadBytes: validSession.uploadBytes,
    receivedChunks: chunks.length,
    chunkCount: validSession.chunkCount,
    complete: chunks.length === validSession.chunkCount,
  };
}

export function findMissingResumableUploadRanges(
  session: ResumableUploadSession,
): MissingUploadRange[] {
  const validSession = validateResumableUploadSession(session);
  const ranges: MissingUploadRange[] = [];
  for (let index = 0; index < validSession.chunkCount; index += 1) {
    if (validSession.chunks[index]) continue;
    const range = expectedChunkRange(validSession, index);
    ranges.push({
      start: range.start,
      endExclusive: range.endExclusive,
      chunkIndex: index,
    });
  }
  return ranges;
}

export function validateResumableUploadSession(
  value: unknown,
): ResumableUploadSession {
  if (!isRecord(value)) {
    throw new Error(
      "validateResumableUploadSession: session must be an object",
    );
  }
  const sessionId = safeSessionId(readString(value, "sessionId"));
  const uploadBytes = readPositiveInteger(value, "uploadBytes");
  const chunkSize = readPositiveInteger(value, "chunkSize");
  const chunkCount = readPositiveInteger(value, "chunkCount");
  const expectedChunkCount = Math.ceil(uploadBytes / chunkSize);
  if (chunkCount !== expectedChunkCount) {
    throw new Error(
      `validateResumableUploadSession: chunkCount ${chunkCount} does not match expected ${expectedChunkCount}`,
    );
  }
  const createdAt = readNonNegativeInteger(value, "createdAt");
  const updatedAt = readNonNegativeInteger(value, "updatedAt");
  if (updatedAt < createdAt) {
    throw new Error(
      "validateResumableUploadSession: updatedAt must be greater than or equal to createdAt",
    );
  }
  const status = value.status;
  if (status !== "open" && status !== "complete") {
    throw new Error(
      "validateResumableUploadSession: status must be open or complete",
    );
  }
  if (!isRecord(value.chunks)) {
    throw new Error("validateResumableUploadSession: chunks must be an object");
  }

  const chunks: Record<number, ResumableUploadChunk> = {};
  for (const [key, rawChunk] of Object.entries(value.chunks)) {
    const keyIndex = Number(key);
    if (!Number.isSafeInteger(keyIndex) || keyIndex < 0) {
      throw new Error(
        `validateResumableUploadSession: chunk key ${key} is not a safe index`,
      );
    }
    if (String(keyIndex) !== key) {
      throw new Error(
        `validateResumableUploadSession: chunk key ${key} must be canonical`,
      );
    }
    const chunk = validateResumableUploadChunk(
      rawChunk,
      {
        sessionId,
        uploadBytes,
        chunkSize,
        chunkCount,
        createdAt,
        updatedAt,
        status,
        chunks: {},
      },
      keyIndex,
    );
    chunks[chunk.index] = chunk;
  }
  const maxReceivedAt = Object.values(chunks).reduce(
    (max, chunk) => Math.max(max, chunk.receivedAt),
    createdAt,
  );
  if (updatedAt < maxReceivedAt) {
    throw new Error(
      "validateResumableUploadSession: updatedAt must cover received chunk timestamps",
    );
  }

  const complete = Object.keys(chunks).length === chunkCount;
  if (complete !== (status === "complete")) {
    throw new Error(
      "validateResumableUploadSession: status does not match received chunk completeness",
    );
  }

  return {
    sessionId,
    uploadBytes,
    chunkSize,
    chunkCount,
    createdAt,
    updatedAt,
    status,
    chunks,
  };
}

export function mergeResumableUploadSessions(
  baseSession: ResumableUploadSession,
  ...updates: ResumableUploadSession[]
): ResumableUploadSession {
  const base = validateResumableUploadSession(baseSession);
  const chunks: Record<number, ResumableUploadChunk> = { ...base.chunks };
  let updatedAt = base.updatedAt;

  for (const rawUpdate of updates) {
    const update = validateResumableUploadSession(rawUpdate);
    assertSameSessionIdentity(base, update);
    updatedAt = Math.max(updatedAt, update.updatedAt);
    for (const chunk of Object.values(update.chunks)) {
      const existing = chunks[chunk.index];
      if (existing && !sameChunk(existing, chunk)) {
        throw new Error(
          `mergeResumableUploadSessions: chunk ${chunk.index} conflicts with an already merged chunk`,
        );
      }
      chunks[chunk.index] = chunk;
    }
  }

  const complete = Object.keys(chunks).length === base.chunkCount;
  return {
    ...base,
    chunks,
    updatedAt,
    status: complete ? "complete" : "open",
  };
}

export function resumableSha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function resumableByteLength(bytes: Uint8Array | string): number {
  return typeof bytes === "string"
    ? Buffer.byteLength(bytes, "utf8")
    : bytes.byteLength;
}

function expectedChunkRange(
  session: ResumableUploadSession,
  index: number,
): { start: number; endExclusive: number } {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= session.chunkCount
  ) {
    throw new Error(
      `recordResumableChunk: chunk index ${index} is outside 0..${session.chunkCount - 1}`,
    );
  }
  const start = index * session.chunkSize;
  return {
    start,
    endExclusive: Math.min(start + session.chunkSize, session.uploadBytes),
  };
}

function validateResumableUploadChunk(
  value: unknown,
  session: ResumableUploadSession,
  keyIndex: number,
): ResumableUploadChunk {
  if (!isRecord(value)) {
    throw new Error(
      `validateResumableUploadSession: chunk ${keyIndex} must be an object`,
    );
  }
  const index = readNonNegativeInteger(value, "index");
  if (index !== keyIndex) {
    throw new Error(
      `validateResumableUploadSession: chunk key ${keyIndex} does not match index ${index}`,
    );
  }
  const expected = expectedChunkRange(session, index);
  const offset = readNonNegativeInteger(value, "offset");
  const byteLength = readPositiveInteger(value, "byteLength");
  const sha256 = readString(value, "sha256");
  const receivedAt = readNonNegativeInteger(value, "receivedAt");
  if (offset !== expected.start) {
    throw new Error(
      `validateResumableUploadSession: chunk ${index} offset ${offset} does not match expected ${expected.start}`,
    );
  }
  if (byteLength !== expected.endExclusive - expected.start) {
    throw new Error(
      `validateResumableUploadSession: chunk ${index} byteLength ${byteLength} does not match expected ${expected.endExclusive - expected.start}`,
    );
  }
  if (!SHA256_HEX.test(sha256)) {
    throw new Error(
      `validateResumableUploadSession: chunk ${index} sha256 must be lowercase hex`,
    );
  }
  return { index, offset, byteLength, sha256, receivedAt };
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `createResumableUploadSession: ${field} must be a positive safe integer`,
    );
  }
}

function safeSessionId(value: string): string {
  const trimmed = value.trim();
  if (!SAFE_SESSION_ID.test(trimmed)) {
    throw new Error(
      "createResumableUploadSession: sessionId must be a safe path component",
    );
  }
  return trimmed;
}

function assertSameSessionIdentity(
  base: ResumableUploadSession,
  update: ResumableUploadSession,
): void {
  for (const field of [
    "sessionId",
    "uploadBytes",
    "chunkSize",
    "chunkCount",
    "createdAt",
  ] as const) {
    if (base[field] !== update[field]) {
      throw new Error(
        `mergeResumableUploadSessions: update ${field} does not match base session`,
      );
    }
  }
}

function sameChunk(
  left: ResumableUploadChunk,
  right: ResumableUploadChunk,
): boolean {
  return (
    left.index === right.index &&
    left.offset === right.offset &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: Record<string, unknown>, field: string): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string") {
    throw new Error(
      `validateResumableUploadSession: ${field} must be a string`,
    );
  }
  return fieldValue;
}

function readPositiveInteger(
  value: Record<string, unknown>,
  field: string,
): number {
  const fieldValue = value[field];
  if (
    typeof fieldValue !== "number" ||
    !Number.isSafeInteger(fieldValue) ||
    fieldValue <= 0
  ) {
    throw new Error(
      `validateResumableUploadSession: ${field} must be a positive safe integer`,
    );
  }
  return fieldValue;
}

function readNonNegativeInteger(
  value: Record<string, unknown>,
  field: string,
): number {
  const fieldValue = value[field];
  if (
    typeof fieldValue !== "number" ||
    !Number.isSafeInteger(fieldValue) ||
    fieldValue < 0
  ) {
    throw new Error(
      `validateResumableUploadSession: ${field} must be a non-negative safe integer`,
    );
  }
  return fieldValue;
}
