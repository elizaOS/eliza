/**
 * Owns the authenticated snapshot-v2 HTTP boundary and its backpressure-aware
 * binary response writer. Request identity is validated before headers commit;
 * after commit, any source/transport failure terminates the response so a
 * truncated capture can never be mistaken for a successful terminal frame.
 */

import type http from "node:http";
import { logger, readRequestBody } from "@elizaos/core";
import {
  AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE,
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  type AgentBackupCaptureV2Request,
  parseAgentBackupCaptureV2Request,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import {
  type AgentBackupV2CaptureComponentSource,
  AgentBackupV2CaptureError,
  type AgentBackupV2CaptureRuntime,
  createAgentBackupV2Capture,
} from "../services/agent-backup-v2-capture.ts";

export interface AgentBackupV2WritableResponse {
  statusCode: number;
  readonly headersSent?: boolean;
  readonly writableEnded?: boolean;
  setHeader(name: string, value: string): unknown;
  write(chunk: Uint8Array, callback?: (error?: Error | null) => void): boolean;
  end(): unknown;
  destroy(error?: Error): unknown;
  once(
    event: "drain" | "close" | "error",
    listener: (...args: unknown[]) => void,
  ): unknown;
  off(
    event: "drain" | "close" | "error",
    listener: (...args: unknown[]) => void,
  ): unknown;
}

function writeWithCompletion(
  res: AgentBackupV2WritableResponse,
  frame: Uint8Array,
  signal: AbortSignal | undefined,
): { accepted: boolean; completion: Promise<void> } {
  let accepted = false;
  const completion = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off("close", onClose);
      res.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error | null): void => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onClose = (): void =>
      finish(
        new AgentBackupV2CaptureError(
          "Agent backup capture client disconnected before a frame was flushed",
          "AGENT_BACKUP_V2_CLIENT_DISCONNECTED",
          undefined,
          { severity: "ephemeral" },
        ),
      );
    const onError = (error: unknown): void =>
      finish(
        error instanceof Error ? error : new Error("Capture response failed"),
      );
    const onAbort = (): void =>
      finish(signal ? interruptionError(signal) : new Error("Aborted"));
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      accepted = res.write(frame, finish);
    } catch (error) {
      finish(
        error instanceof Error
          ? error
          : new Error("Capture response write failed"),
      );
    }
    if (signal?.aborted) onAbort();
  });
  return { accepted, completion };
}

export interface AgentBackupV2SnapshotRouteDependencies {
  runtime: AgentBackupV2CaptureRuntime;
  config: ElizaConfig;
  /** Deterministic source injection for real transport tests only. */
  components?: readonly AgentBackupV2CaptureComponentSource[];
  now?: () => number;
}

const activeCaptureByAgent = new Map<string, string>();

function interruptionError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new AgentBackupV2CaptureError(
    "Agent backup capture response was interrupted",
    "AGENT_BACKUP_V2_CAPTURE_ABORTED",
    undefined,
    { severity: "ephemeral" },
  );
}

function assertWritableActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw interruptionError(signal);
}

function waitForDrain(
  res: AgentBackupV2WritableResponse,
  signal: AbortSignal | undefined,
): Promise<void> {
  assertWritableActive(signal);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(
        new AgentBackupV2CaptureError(
          "Agent backup capture client disconnected during backpressure",
          "AGENT_BACKUP_V2_CLIENT_DISCONNECTED",
          undefined,
          { severity: "ephemeral" },
        ),
      );
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new Error("Agent backup capture response failed"),
      );
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal ? interruptionError(signal) : new Error("Capture aborted"));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** Write one frame at a time and never pull the next frame before `drain`. */
export async function writeAgentBackupV2StreamResponse(
  res: AgentBackupV2WritableResponse,
  frames: AsyncIterable<Uint8Array>,
  options: Readonly<{ signal?: AbortSignal; operationId?: string }> = {},
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", AGENT_BACKUP_CAPTURE_V2_CONTENT_TYPE);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Eliza-Backup-Capture-Version", "2");
  if (options.operationId) {
    res.setHeader("X-Eliza-Backup-Operation-Id", options.operationId);
  }
  for await (const frame of frames) {
    try {
      assertWritableActive(options.signal);
      const write = writeWithCompletion(res, frame, options.signal);
      if (write.accepted) await write.completion;
      else
        await Promise.all([
          write.completion,
          waitForDrain(res, options.signal),
        ]);
    } finally {
      frame.fill(0);
    }
  }
  assertWritableActive(options.signal);
  res.end();
}

function writeJsonFailure(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({ error: message, code }));
}

function captureFailureStatus(error: AgentBackupV2CaptureError): number {
  switch (error.code) {
    case "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED":
    case "AGENT_BACKUP_V2_INVALID_DEADLINE":
      return 408;
    case "AGENT_BACKUP_V2_AGENT_MISMATCH":
    case "AGENT_BACKUP_V2_FILE_CHANGED":
    case "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_CHANGED":
      return 409;
    case "AGENT_BACKUP_V2_PGLITE_PHYSICAL_BYTES_LIMIT":
    case "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_ENTRY_LIMIT":
    case "AGENT_BACKUP_V2_PGLITE_DUMP_EXCEEDS_PREFLIGHT":
      return 413;
    case "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY":
      return 429;
    case "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED":
      return 503;
    case "AGENT_BACKUP_V2_POSTGRES_UNSUPPORTED":
    case "AGENT_BACKUP_V2_PGLITE_NOT_FILESYSTEM":
    case "AGENT_BACKUP_V2_PGLITE_MANAGED_DUMP_UNAVAILABLE":
      return 501;
    case "AGENT_BACKUP_V2_CAPTURE_ABORTED":
    case "AGENT_BACKUP_V2_CLIENT_DISCONNECTED":
      return 499;
    default:
      return 500;
  }
}

function captureFailureRetryAfter(
  error: AgentBackupV2CaptureError,
): string | null {
  switch (error.code) {
    case "AGENT_BACKUP_V2_PGLITE_DUMP_BUSY":
    case "AGENT_BACKUP_V2_PGLITE_RSS_BUDGET_EXCEEDED":
      return "5";
    case "AGENT_BACKUP_V2_PGLITE_PREFLIGHT_CHANGED":
      return "1";
    default:
      return null;
  }
}

async function readCaptureRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Readonly<AgentBackupCaptureV2Request> | null> {
  let raw: string | null;
  try {
    raw = await readRequestBody(req, {
      maxBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxRequestBytes,
      tooLargeMessage: "Capture-v2 request exceeds its 4 KiB limit",
    });
  } catch (error) {
    // error-policy:J1 request read failures are translated at the HTTP boundary.
    writeJsonFailure(
      res,
      400,
      "AGENT_BACKUP_V2_INVALID_REQUEST",
      error instanceof Error ? error.message : "Invalid capture-v2 request",
    );
    return null;
  }
  if (!raw) {
    writeJsonFailure(
      res,
      400,
      "AGENT_BACKUP_V2_INVALID_REQUEST",
      "Capture-v2 request body is required",
    );
    return null;
  }
  try {
    return parseAgentBackupCaptureV2Request(JSON.parse(raw));
  } catch (error) {
    // error-policy:J3 JSON and schema validation reject untrusted input before
    // any capture source or streaming response is opened.
    writeJsonFailure(
      res,
      400,
      "AGENT_BACKUP_V2_INVALID_REQUEST",
      error instanceof Error ? error.message : "Invalid capture-v2 request",
    );
    return null;
  }
}

/** Handle `POST /api/snapshot/v2` after the server's normal auth gate. */
export async function handleAgentBackupV2SnapshotRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  dependencies: Readonly<AgentBackupV2SnapshotRouteDependencies>,
): Promise<void> {
  const request = await readCaptureRequest(req, res);
  if (!request) return;
  const now = dependencies.now ?? Date.now;
  if (request.agentId !== dependencies.runtime.agentId) {
    writeJsonFailure(
      res,
      409,
      "AGENT_BACKUP_V2_AGENT_MISMATCH",
      "Capture request agent does not match the active runtime",
    );
    return;
  }
  const remainingMs = request.deadlineEpochMs - now();
  if (
    remainingMs <= 0 ||
    remainingMs > AGENT_BACKUP_CAPTURE_V2_LIMITS.maxDeadlineAheadMs
  ) {
    writeJsonFailure(
      res,
      408,
      "AGENT_BACKUP_V2_INVALID_DEADLINE",
      "Capture request deadline is expired or too far in the future",
    );
    return;
  }
  const activeOperationId = activeCaptureByAgent.get(request.agentId);
  if (activeOperationId) {
    res.setHeader("Retry-After", "5");
    writeJsonFailure(
      res,
      429,
      "AGENT_BACKUP_V2_CAPTURE_BUSY",
      activeOperationId === request.operationId
        ? "This capture operation is already active"
        : "Another capture operation is already active for this agent",
    );
    return;
  }

  activeCaptureByAgent.set(request.agentId, request.operationId);
  const controller = new AbortController();
  const deadlineTimer = setTimeout(
    () =>
      controller.abort(
        new AgentBackupV2CaptureError(
          "Agent backup capture deadline exceeded",
          "AGENT_BACKUP_V2_CAPTURE_DEADLINE_EXCEEDED",
          { operationId: request.operationId },
          { severity: "ephemeral" },
        ),
      ),
    Math.min(remainingMs, 2_147_483_647),
  );
  const clientDisconnected = (): void => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(
        new AgentBackupV2CaptureError(
          "Agent backup capture client disconnected",
          "AGENT_BACKUP_V2_CLIENT_DISCONNECTED",
          { operationId: request.operationId },
          { severity: "ephemeral" },
        ),
      );
    }
  };
  req.once("aborted", clientDisconnected);
  res.once("close", clientDisconnected);

  try {
    const frames = createAgentBackupV2Capture(
      dependencies.runtime,
      dependencies.config,
      request,
      {
        signal: controller.signal,
        components: dependencies.components,
        now,
      },
    );
    await writeAgentBackupV2StreamResponse(res, frames, {
      signal: controller.signal,
      operationId: request.operationId,
    });
  } catch (error) {
    // error-policy:J1 a pre-commit failure receives structured JSON; once any
    // frame is committed the only truthful response is a truncated transport.
    const normalized =
      error instanceof AgentBackupV2CaptureError
        ? error
        : new AgentBackupV2CaptureError(
            "Agent backup capture failed",
            "AGENT_BACKUP_V2_CAPTURE_FAILED",
            { operationId: request.operationId },
            { cause: error, severity: "ephemeral" },
          );
    logger.warn(
      {
        err: normalized.message,
        code: normalized.code,
        operationId: request.operationId,
      },
      "[agent-backup-v2] Capture request failed",
    );
    if (res.headersSent) {
      res.destroy(normalized);
    } else {
      const retryAfter = captureFailureRetryAfter(normalized);
      if (retryAfter) res.setHeader("Retry-After", retryAfter);
      writeJsonFailure(
        res,
        captureFailureStatus(normalized),
        normalized.code,
        normalized.message,
      );
    }
  } finally {
    clearTimeout(deadlineTimer);
    req.off("aborted", clientDisconnected);
    res.off("close", clientDisconnected);
    if (activeCaptureByAgent.get(request.agentId) === request.operationId) {
      activeCaptureByAgent.delete(request.agentId);
    }
  }
}
