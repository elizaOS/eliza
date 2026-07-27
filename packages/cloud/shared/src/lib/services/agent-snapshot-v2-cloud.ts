/**
 * Connects the agent snapshot v2 wire protocol to durable encrypted Cloud
 * storage and the authenticated agent restore endpoint.
 *
 * Both directions validate while streaming. Capture validates the source and
 * the read-after-write copy before committing the database row; restore
 * validates decrypted storage bytes again while the agent consumes them.
 */
import type {
  AgentBackupSnapshotType,
  StoredAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import { logger } from "../utils/logger";
import {
  type AgentBackupV2StorageService,
  agentBackupV2StorageService,
  readStoredChunkedBackup,
} from "./agent-backup-v2-storage";
import {
  AGENT_SNAPSHOT_V2_CONTENT_TYPE,
  AGENT_SNAPSHOT_V2_MAX_WIRE_BYTES,
  AgentSnapshotV2StreamValidator,
  type AgentSnapshotV2ValidationSummary,
  observeAgentSnapshotV2Stream,
  validateAgentSnapshotV2Stream,
} from "./agent-snapshot-v2-stream";

const MAX_ERROR_RESPONSE_BYTES = 8 * 1024;
const MAX_SUCCESS_RESPONSE_BYTES = 16 * 1024;
const RESTORE_BASE_TIMEOUT_MS = 10 * 60_000;
const RESTORE_IDLE_TIMEOUT_MS = 2 * 60_000;
const RESTORE_MIN_BYTES_PER_SECOND = 1024 * 1024;

interface SnapshotV2StorageBoundary {
  create: AgentBackupV2StorageService["create"];
}

export interface AgentSnapshotV2RestoreTimeouts {
  baseMs: number;
  idleMs: number;
  minBytesPerSecond: number;
}

export interface AgentSnapshotV2CloudDependencies {
  storage: SnapshotV2StorageBoundary;
  readStored: typeof readStoredChunkedBackup;
  fetch: typeof fetch;
  restoreTimeouts?: AgentSnapshotV2RestoreTimeouts;
}

const defaultDependencies: AgentSnapshotV2CloudDependencies = {
  storage: agentBackupV2StorageService,
  readStored: readStoredChunkedBackup,
  fetch,
};

export function agentSnapshotV2RestoreTimeoutMs(
  wireBytes: number,
  policy: AgentSnapshotV2RestoreTimeouts = {
    baseMs: RESTORE_BASE_TIMEOUT_MS,
    idleMs: RESTORE_IDLE_TIMEOUT_MS,
    minBytesPerSecond: RESTORE_MIN_BYTES_PER_SECOND,
  },
): number {
  if (
    !Number.isSafeInteger(wireBytes) ||
    wireBytes < 0 ||
    wireBytes > AGENT_SNAPSHOT_V2_MAX_WIRE_BYTES ||
    !Number.isSafeInteger(policy.baseMs) ||
    policy.baseMs <= 0 ||
    !Number.isSafeInteger(policy.idleMs) ||
    policy.idleMs <= 0 ||
    !Number.isSafeInteger(policy.minBytesPerSecond) ||
    policy.minBytesPerSecond <= 0
  ) {
    throw new Error("Snapshot restore timeout inputs are invalid");
  }
  return policy.baseMs + Math.ceil((wireBytes * 1_000) / policy.minBytesPerSecond);
}

function restoreTimeouts(
  dependencies: AgentSnapshotV2CloudDependencies,
): AgentSnapshotV2RestoreTimeouts {
  return (
    dependencies.restoreTimeouts ?? {
      baseMs: RESTORE_BASE_TIMEOUT_MS,
      idleMs: RESTORE_IDLE_TIMEOUT_MS,
      minBytesPerSecond: RESTORE_MIN_BYTES_PER_SECOND,
    }
  );
}

function createRestoreWatchdog(params: { absoluteMs: number; idleMs: number }): {
  close(): void;
  markActivity(): void;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = (message: string): void => {
    if (!controller.signal.aborted) controller.abort(new Error(message));
  };
  const absoluteTimer = setTimeout(
    () => abort(`Snapshot restore exceeded its ${params.absoluteMs}-ms transfer budget`),
    params.absoluteMs,
  );
  const markActivity = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => abort(`Snapshot restore made no upload progress for ${params.idleMs} ms`),
      params.idleMs,
    );
  };
  markActivity();
  return {
    close() {
      clearTimeout(absoluteTimer);
      if (idleTimer) clearTimeout(idleTimer);
    },
    markActivity,
    signal: controller.signal,
  };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Snapshot restore was aborted");
}

function raceWithAbort<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function* observeRestoreActivity(
  source: AsyncIterable<Uint8Array>,
  markActivity: () => void,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let reachedEnd = false;
  try {
    while (true) {
      const next = await raceWithAbort(iterator.next(), signal);
      if (next.done) {
        reachedEnd = true;
        return;
      }
      markActivity();
      yield next.value;
    }
  } finally {
    if (!reachedEnd && iterator.return) {
      const cleanup = Promise.resolve(iterator.return());
      if (signal.aborted) {
        void cleanup.catch((error: unknown) => {
          logger.warn("[AgentSnapshotV2Cloud] Stored stream cancellation failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } else {
        await cleanup;
      }
    }
  }
}

interface CancellableResponseByteStream {
  cancel(reason: unknown): Promise<void>;
  source: AsyncIterable<Uint8Array>;
}

function responseByteStream(response: Response): CancellableResponseByteStream {
  const body = response.body;
  if (!body) {
    throw new Error("Agent snapshot response has no body");
  }
  const reader = body.getReader();
  let ended = false;
  let iteratorStarted = false;
  let lockReleased = false;
  const releaseLock = (): void => {
    if (lockReleased) return;
    lockReleased = true;
    reader.releaseLock();
  };
  const cancel = async (reason: unknown): Promise<void> => {
    if (ended) {
      releaseLock();
      return;
    }
    ended = true;
    try {
      await reader.cancel(reason);
    } finally {
      releaseLock();
    }
  };
  const source: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      if (iteratorStarted) {
        throw new Error("Agent snapshot response body may only be consumed once");
      }
      iteratorStarted = true;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            ended = true;
            releaseLock();
            return;
          }
          if (!(next.value instanceof Uint8Array)) {
            throw new Error("Agent snapshot response emitted a non-binary body view");
          }
          yield next.value;
        }
      } finally {
        if (!ended) {
          try {
            await cancel("Snapshot stream consumer stopped before EOF");
          } catch (error) {
            // error-policy:J6 best-effort teardown — validation/storage already
            // surfaced the primary failure; cancellation releases transport.
            logger.warn("[AgentSnapshotV2Cloud] Snapshot body cancellation failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    },
  };
  return { cancel, source };
}

function iterableBody(
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await raceWithAbort(iterator.next(), signal);
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason) {
      const cleanup = iterator.return?.(reason);
      if (!cleanup) return;
      if (signal.aborted) {
        // error-policy:J6 the watchdog already surfaced the transfer failure;
        // iterator cleanup must not keep the request body alive indefinitely.
        void Promise.resolve(cleanup).catch((error: unknown) => {
          logger.warn("[AgentSnapshotV2Cloud] Request body cancellation failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }
      await cleanup;
    },
  });
}

async function readBodySnippet(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const next = signal ? await raceWithAbort(reader.read(), signal) : await reader.read();
      if (next.done) break;
      const remaining = maxBytes + 1 - total;
      const chunk = next.value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new Error(`Agent response exceeds its ${maxBytes}-byte budget`);
      }
    }
  } finally {
    try {
      if (signal) {
        await raceWithAbort(reader.cancel(), signal);
      } else {
        await reader.cancel();
      }
    } catch (error) {
      // error-policy:J6 best-effort teardown — the bounded response body has
      // already been consumed or rejected, so cancellation only frees transport.
      logger.warn("[AgentSnapshotV2Cloud] Response body cancellation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function sameCommittedStream(
  source: AgentSnapshotV2ValidationSummary,
  stored: AgentSnapshotV2ValidationSummary,
): boolean {
  return (
    source.wireBytes === stored.wireBytes &&
    source.trailer.aggregateSha256 === stored.trailer.aggregateSha256 &&
    source.trailer.chunkCount === stored.trailer.chunkCount &&
    source.trailer.descriptorSha256 === stored.trailer.descriptorSha256 &&
    source.trailer.fileCount === stored.trailer.fileCount &&
    source.trailer.totalBytes === stored.trailer.totalBytes
  );
}

export async function captureAgentSnapshotV2(params: {
  response: Response;
  organizationId: string;
  sandboxRecordId: string;
  agentId: string;
  snapshotType?: AgentBackupSnapshotType;
  backupId?: string;
  dependencies?: AgentSnapshotV2CloudDependencies;
}): Promise<{ backup: StoredAgentSandboxBackup; summary: AgentSnapshotV2ValidationSummary }> {
  if (!params.response.ok) {
    const detail = await readBodySnippet(params.response, MAX_ERROR_RESPONSE_BYTES);
    throw new Error(`Snapshot v2 fetch failed: HTTP ${params.response.status} ${detail}`.trimEnd());
  }
  const dependencies = params.dependencies ?? defaultDependencies;
  const contentType = params.response.headers.get("content-type") ?? "";
  const sourceValidator = new AgentSnapshotV2StreamValidator({
    contentType,
    expectedAgentId: params.agentId,
  });
  const responseStream = responseByteStream(params.response);
  const observedSource = observeAgentSnapshotV2Stream({
    source: responseStream.source,
    validator: sourceValidator,
  });
  try {
    const backup = await dependencies.storage.create({
      identity: {
        organizationId: params.organizationId,
        sandboxRecordId: params.sandboxRecordId,
        backupId: params.backupId,
        backupSchemaVersion: 2,
      },
      snapshotType: params.snapshotType ?? "pre-upgrade",
      source: observedSource,
      maxTotalBytes: AGENT_SNAPSHOT_V2_MAX_WIRE_BYTES,
      verify: async (storedSource) => {
        const stored = await validateAgentSnapshotV2Stream({
          source: storedSource,
          options: {
            contentType: AGENT_SNAPSHOT_V2_CONTENT_TYPE,
            expectedAgentId: params.agentId,
          },
        });
        const source = sourceValidator.finish();
        if (!sameCommittedStream(source, stored)) {
          throw new Error("Stored snapshot v2 stream differs from its source");
        }
        return { contentHash: stored.trailer.aggregateSha256 };
      },
    });
    return { backup, summary: sourceValidator.finish() };
  } catch (error) {
    try {
      await responseStream.cancel(error);
    } catch (cancelError) {
      // error-policy:J6 the storage/validation failure remains primary.
      logger.warn("[AgentSnapshotV2Cloud] Snapshot body cancellation failed", {
        error: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
    }
    throw error;
  }
}

interface AgentSnapshotV2RestoreResult {
  aggregateSha256: string;
  fileCount: number;
  requiresRestart: true;
  schemaVersion: 2;
  success: true;
  totalBytes: number;
  transfer: "chunked-v1";
}

function parseRestoreResult(value: string): AgentSnapshotV2RestoreResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("Agent restore response is not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent restore response is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [
    "aggregateSha256",
    "fileCount",
    "requiresRestart",
    "schemaVersion",
    "success",
    "totalBytes",
    "transfer",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Agent restore response has unsupported or missing fields");
  }
  if (
    record.success !== true ||
    record.requiresRestart !== true ||
    record.schemaVersion !== 2 ||
    record.transfer !== "chunked-v1" ||
    typeof record.aggregateSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.aggregateSha256) ||
    typeof record.fileCount !== "number" ||
    !Number.isSafeInteger(record.fileCount) ||
    record.fileCount < 0 ||
    typeof record.totalBytes !== "number" ||
    !Number.isSafeInteger(record.totalBytes) ||
    record.totalBytes < 0
  ) {
    throw new Error("Agent restore response is invalid");
  }
  return record as unknown as AgentSnapshotV2RestoreResult;
}

export async function restoreAgentSnapshotV2(params: {
  backup: StoredAgentSandboxBackup;
  organizationId: string;
  agentId: string;
  endpoint: string;
  headers: HeadersInit;
  dependencies?: AgentSnapshotV2CloudDependencies;
}): Promise<AgentSnapshotV2ValidationSummary> {
  if (
    params.backup.verification_status !== "verified" ||
    params.backup.storage_commit_state !== "complete"
  ) {
    throw new Error(`Backup ${params.backup.id} is not a verified restore point`);
  }
  const dependencies = params.dependencies ?? defaultDependencies;
  const storedWireBytes = params.backup.size_bytes;
  if (
    typeof storedWireBytes !== "number" ||
    !Number.isSafeInteger(storedWireBytes) ||
    storedWireBytes < 0 ||
    storedWireBytes > AGENT_SNAPSHOT_V2_MAX_WIRE_BYTES
  ) {
    throw new Error(`Backup ${params.backup.id} has an invalid stored byte count`);
  }
  const timeoutPolicy = restoreTimeouts(dependencies);
  const watchdog = createRestoreWatchdog({
    absoluteMs: agentSnapshotV2RestoreTimeoutMs(storedWireBytes, timeoutPolicy),
    idleMs: timeoutPolicy.idleMs,
  });
  try {
    const validator = new AgentSnapshotV2StreamValidator({
      contentType: AGENT_SNAPSHOT_V2_CONTENT_TYPE,
      expectedAgentId: params.agentId,
    });
    const storedSource = await raceWithAbort(
      dependencies.readStored({
        organizationId: params.organizationId,
        row: params.backup,
        signal: watchdog.signal,
      }),
      watchdog.signal,
    );
    const source = observeAgentSnapshotV2Stream({
      source: observeRestoreActivity(storedSource, watchdog.markActivity, watchdog.signal),
      validator,
    });
    const headers = new Headers(params.headers);
    headers.set("Content-Type", AGENT_SNAPSHOT_V2_CONTENT_TYPE);
    const requestInit: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers,
      body: iterableBody(source, watchdog.signal),
      duplex: "half",
      signal: watchdog.signal,
    };
    const response = await raceWithAbort(
      dependencies.fetch(params.endpoint, requestInit),
      watchdog.signal,
    );
    if (!response.ok) {
      const detail = await readBodySnippet(response, MAX_ERROR_RESPONSE_BYTES, watchdog.signal);
      throw new Error(`Snapshot v2 restore failed: HTTP ${response.status} ${detail}`.trimEnd());
    }
    const summary = validator.finish();
    if (params.backup.content_hash !== summary.trailer.aggregateSha256) {
      throw new Error(`Backup ${params.backup.id} content hash does not match its stored stream`);
    }
    const result = parseRestoreResult(
      await readBodySnippet(response, MAX_SUCCESS_RESPONSE_BYTES, watchdog.signal),
    );
    if (
      result.aggregateSha256 !== summary.trailer.aggregateSha256 ||
      result.fileCount !== summary.trailer.fileCount ||
      result.totalBytes !== summary.trailer.totalBytes
    ) {
      throw new Error("Agent restore acknowledgement does not match the committed snapshot");
    }
    return summary;
  } catch (error) {
    if (watchdog.signal.aborted) {
      throw new Error("Snapshot v2 restore timed out", {
        cause: watchdog.signal.reason ?? error,
      });
    }
    throw error;
  } finally {
    watchdog.close();
  }
}
