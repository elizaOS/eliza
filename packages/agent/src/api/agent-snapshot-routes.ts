/**
 * HTTP boundary for full-agent snapshot capture and restore. Legacy JSON
 * snapshots stay capped at 128 MiB, while schema-v2 pre-upgrade transfers use
 * canonical NDJSON with response backpressure and direct request streaming.
 */
import type http from "node:http";
import {
  type AgentRuntime,
  ElizaError,
  getSnapshotCaptureBarrier,
  type IAgentRuntime,
  logger,
  readRequestBody,
  sendJson,
  sendJsonError,
} from "@elizaos/core";
import type { ElizaConfig } from "../config/config.ts";
import {
  type AgentSnapshotUpgradeBinding,
  createAgentSnapshot,
  parseAgentSnapshotRequest,
  restoreAgentSnapshot,
  validateAgentSnapshotForRestore,
} from "../services/agent-backup.ts";
import { resolveCandidateSnapshotRestoreBinding } from "../services/agent-snapshot-restore-binding.ts";
import {
  createAgentSnapshotStream,
  runExclusiveSnapshotRestore,
} from "../services/agent-snapshot-stream.ts";
import {
  AGENT_SNAPSHOT_STREAM_CONTENT_TYPE,
  AGENT_SNAPSHOT_STREAM_TRANSFER,
} from "../services/agent-snapshot-stream-protocol.ts";
import {
  handleCandidateSnapshotRestore,
  snapshotProtocolStatus,
} from "./candidate-snapshot-restore.ts";

const MAX_SNAPSHOT_REQUEST_BODY_BYTES = 4 * 1024;
export const AGENT_BACKUP_V1_MAX_BODY_BYTES = 128 * 1024 * 1024;

function invalidRequest(message: string, cause?: unknown): ElizaError {
  return new ElizaError(message, {
    cause,
    code: "AGENT_SNAPSHOT_REQUEST_INVALID",
    severity: "fatal",
  });
}

async function readSnapshotRequest(
  req: http.IncomingMessage,
): Promise<unknown> {
  try {
    const raw = await readRequestBody(req, {
      maxBytes: MAX_SNAPSHOT_REQUEST_BODY_BYTES,
    });
    return raw?.trim() ? (JSON.parse(raw) as unknown) : undefined;
  } catch (cause) {
    // error-policy:J3 Untrusted request bytes become an explicit invalid request.
    throw invalidRequest("Invalid snapshot request body", cause);
  }
}

async function readLegacyRestoreRequest(
  req: http.IncomingMessage,
): Promise<unknown> {
  try {
    const raw = await readRequestBody(req, {
      maxBytes: AGENT_BACKUP_V1_MAX_BODY_BYTES,
    });
    if (!raw) throw invalidRequest("Request body is required");
    return JSON.parse(raw) as unknown;
  } catch (cause) {
    // error-policy:J3 Untrusted legacy JSON becomes an explicit invalid request.
    if (cause instanceof ElizaError) throw cause;
    throw invalidRequest("Invalid backup snapshot payload", cause);
  }
}

async function waitForDrain(res: http.ServerResponse): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off("close", onClose);
      res.off("drain", onDrain);
      res.off("error", onError);
    };
    const onClose = (): void => {
      cleanup();
      reject(
        new ElizaError("Snapshot client disconnected", {
          code: "AGENT_SNAPSHOT_STREAM_ABORTED",
          severity: "ephemeral",
        }),
      );
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onError = (cause: Error): void => {
      cleanup();
      reject(cause);
    };
    res.once("close", onClose);
    res.once("drain", onDrain);
    res.once("error", onError);
  });
}

async function writeWithBackpressure(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bytes: Uint8Array,
): Promise<void> {
  if (req.aborted || res.destroyed) {
    throw new ElizaError("Snapshot client disconnected", {
      code: "AGENT_SNAPSHOT_STREAM_ABORTED",
      severity: "ephemeral",
    });
  }
  if (!res.write(bytes)) {
    await waitForDrain(res);
  }
}

async function sendSnapshotStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtime: IAgentRuntime | AgentRuntime,
  binding: AgentSnapshotUpgradeBinding,
): Promise<void> {
  const iterator = createAgentSnapshotStream(runtime, binding);
  try {
    // Planning can fail before a byte is committed, preserving an ordinary
    // structured HTTP error instead of a misleading partial 200 response.
    const first = await iterator.next();
    if (first.done) {
      throw new ElizaError("Snapshot stream did not emit a descriptor", {
        code: "AGENT_SNAPSHOT_STREAM_INVALID",
        severity: "fatal",
      });
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", AGENT_SNAPSHOT_STREAM_CONTENT_TYPE);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    await writeWithBackpressure(req, res, first.value);
    for await (const frame of iterator) {
      await writeWithBackpressure(req, res, frame);
    }
    res.end();
  } finally {
    await iterator.return(undefined);
  }
}

export async function handleAgentSnapshotRoutes(args: {
  config: ElizaConfig;
  method: string;
  pathname: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  runtime: IAgentRuntime | AgentRuntime | null;
  url: URL;
}): Promise<boolean> {
  const { config, method, pathname, req, res, runtime, url } = args;
  if (
    method !== "POST" ||
    (pathname !== "/api/snapshot" && pathname !== "/api/restore")
  ) {
    return false;
  }
  if (!runtime) {
    sendJsonError(res, "Runtime not ready", 503);
    return true;
  }

  if (pathname === "/api/snapshot") {
    try {
      const request = parseAgentSnapshotRequest(await readSnapshotRequest(req));
      if (request.transfer === AGENT_SNAPSHOT_STREAM_TRANSFER) {
        if (!request.binding) {
          throw new ElizaError("Snapshot upgrade binding is missing", {
            code: "AGENT_SNAPSHOT_REQUEST_INVALID",
            severity: "fatal",
          });
        }
        await sendSnapshotStream(req, res, runtime, request.binding);
      } else {
        const admission = getSnapshotCaptureBarrier(runtime).admitMutation();
        try {
          sendJson(res, await createAgentSnapshot(runtime, config, request));
        } finally {
          admission.release();
        }
      }
    } catch (error) {
      // error-policy:J1 The HTTP boundary translates capture/protocol failures
      // before headers and terminates a partial stream after headers.
      logger.error({ error }, "[agent-backup] Snapshot failed");
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
      } else {
        sendJsonError(
          res,
          error instanceof Error ? error.message : "Snapshot failed",
          snapshotProtocolStatus(error),
        );
      }
    }
    return true;
  }

  try {
    if (url.searchParams.has("transfer")) {
      const binding = resolveCandidateSnapshotRestoreBinding();
      if (!binding) {
        throw new ElizaError(
          "This runtime is not a snapshot restore candidate",
          {
            code: "AGENT_SNAPSHOT_RESTORE_NOT_ENABLED",
            severity: "fatal",
          },
        );
      }
      await handleCandidateSnapshotRestore({
        binding,
        req,
        res,
        runtime,
        url,
      });
      return true;
    }
    if ([...url.searchParams.keys()].length !== 0) {
      throw new ElizaError("Unsupported snapshot restore query", {
        code: "AGENT_SNAPSHOT_STREAM_INVALID",
        severity: "fatal",
      });
    }
    const body = await validateAgentSnapshotForRestore(
      runtime,
      await readLegacyRestoreRequest(req),
    );
    sendJson(
      res,
      await runExclusiveSnapshotRestore(runtime, () =>
        restoreAgentSnapshot(runtime, body),
      ),
    );
  } catch (error) {
    // error-policy:J1 The HTTP boundary maps malformed transfers to 400 while
    // preserving operational restore failures as observable server errors.
    logger.error({ error }, "[agent-backup] Restore failed");
    sendJsonError(
      res,
      error instanceof Error ? error.message : "Restore failed",
      snapshotProtocolStatus(error),
    );
  }
  return true;
}
