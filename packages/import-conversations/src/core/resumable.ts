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
  const expected = expectedChunkRange(session, options.index);
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

  const sha256 = sha256Hex(options.bytes);
  if (options.sha256 !== undefined && options.sha256 !== sha256) {
    throw new Error(
      `recordResumableChunk: chunk ${options.index} sha256 mismatch`,
    );
  }

  const existing = session.chunks[options.index];
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
      session,
      chunk: existing,
      progress: getResumableUploadProgress(session),
    };
  }

  if (session.status !== "open") {
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
  const chunks = { ...session.chunks, [options.index]: chunk };
  const complete = Object.keys(chunks).length === session.chunkCount;
  const next: ResumableUploadSession = {
    ...session,
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
  const chunks = Object.values(session.chunks);
  return {
    receivedBytes: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    uploadBytes: session.uploadBytes,
    receivedChunks: chunks.length,
    chunkCount: session.chunkCount,
    complete: chunks.length === session.chunkCount,
  };
}

export function findMissingResumableUploadRanges(
  session: ResumableUploadSession,
): MissingUploadRange[] {
  const ranges: MissingUploadRange[] = [];
  for (let index = 0; index < session.chunkCount; index += 1) {
    if (session.chunks[index]) continue;
    const range = expectedChunkRange(session, index);
    ranges.push({
      start: range.start,
      endExclusive: range.endExclusive,
      chunkIndex: index,
    });
  }
  return ranges;
}

export function sha256Hex(bytes: Uint8Array | string): string {
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
