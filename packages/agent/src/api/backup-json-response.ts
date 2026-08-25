/**
 * Streams full-agent backup manifests across the HTTP boundary without asking
 * Node's response writer to materialize one giant outgoing buffer.
 */

import type http from "node:http";
import { ElizaError } from "@elizaos/core";
import type { AgentBackupStateData } from "../services/agent-backup.ts";

const STRING_CHUNK_CODE_UNITS = 256 * 1024;

/**
 * Thrown when the backup download transport dies mid-stream (client disconnect
 * or socket error) instead of parking forever on a `drain` that can never
 * arrive. Mirrors the v2 capture writer's AGENT_BACKUP_V2_CLIENT_DISCONNECTED
 * policy: ephemeral, not a server fault.
 */
export class AgentBackupClientDisconnectedError extends ElizaError {
  override readonly name = "AgentBackupClientDisconnectedError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, {
      code: "AGENT_BACKUP_CLIENT_DISCONNECTED",
      cause: options?.cause,
      severity: "ephemeral",
    });
  }
}

function isUnsupportedJsonValue(value: unknown): boolean {
  return (
    value === undefined ||
    typeof value === "function" ||
    typeof value === "symbol"
  );
}

async function* encodeJsonString(value: string): AsyncGenerator<string> {
  yield '"';
  for (
    let offset = 0;
    offset < value.length;
    offset += STRING_CHUNK_CODE_UNITS
  ) {
    const encoded = JSON.stringify(
      value.slice(offset, offset + STRING_CHUNK_CODE_UNITS),
    );
    yield encoded.slice(1, -1);
  }
  yield '"';
}

async function* encodeJsonValue(
  input: unknown,
  ancestors: Set<object>,
): AsyncGenerator<string> {
  let value = input;
  if (
    value !== null &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof value.toJSON === "function"
  ) {
    value = value.toJSON();
  }

  if (value === null) {
    yield "null";
    return;
  }
  if (typeof value === "string") {
    yield* encodeJsonString(value);
    return;
  }
  if (typeof value === "number") {
    yield Number.isFinite(value) ? String(value) : "null";
    return;
  }
  if (typeof value === "boolean") {
    yield value ? "true" : "false";
    return;
  }
  if (typeof value === "bigint") {
    throw new TypeError("Do not know how to serialize a BigInt");
  }
  if (isUnsupportedJsonValue(value)) {
    yield "null";
    return;
  }
  if (typeof value !== "object") {
    yield "null";
    return;
  }
  if (ancestors.has(value)) {
    throw new TypeError("Converting circular structure to JSON");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      yield "[";
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) yield ",";
        yield* encodeJsonValue(value[index], ancestors);
      }
      yield "]";
      return;
    }

    yield "{";
    let wroteProperty = false;
    for (const key of Object.keys(value)) {
      const propertyValue = (value as Record<string, unknown>)[key];
      if (isUnsupportedJsonValue(propertyValue)) continue;
      if (wroteProperty) yield ",";
      yield JSON.stringify(key);
      yield ":";
      yield* encodeJsonValue(propertyValue, ancestors);
      wroteProperty = true;
    }
    yield "}";
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Resolves on `drain`; rejects with a typed error if the transport closes or
 * errors first, so an aborted download can never park this writer forever on
 * a backpressure wait that will never complete (the v2 capture writer in
 * backup-v2-stream-response.ts applies the same close/error racing).
 */
function waitForDrain(res: http.ServerResponse): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(
        new AgentBackupClientDisconnectedError(
          "Agent backup client disconnected while the JSON snapshot was backpressured",
        ),
      );
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(
        error instanceof Error
          ? error
          : new Error("Agent backup response stream failed", { cause: error }),
      );
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}

/** Writes a restorable snapshot as chunked JSON while honoring backpressure. */
export async function writeAgentBackupJsonResponse(
  res: http.ServerResponse,
  snapshot: AgentBackupStateData,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  // Capture transport errors raised outside the drain wait (a write can emit
  // "error" asynchronously between chunks) instead of letting them surface as
  // an unhandled stream event; the loop checks the capture after every write.
  let streamError: unknown;
  const captureStreamError = (error: unknown): void => {
    streamError ??=
      error instanceof Error
        ? error
        : new Error("Agent backup response stream failed", { cause: error });
  };
  res.on("error", captureStreamError);
  try {
    for await (const chunk of encodeJsonValue(snapshot, new Set())) {
      if (!res.write(chunk)) await waitForDrain(res);
      if (streamError) throw streamError;
      if (res.destroyed) {
        throw new AgentBackupClientDisconnectedError(
          "Agent backup response transport closed mid-stream",
        );
      }
    }
  } finally {
    res.off("error", captureStreamError);
  }
  res.end();
}
