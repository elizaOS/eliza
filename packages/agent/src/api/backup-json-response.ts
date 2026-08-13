/**
 * Streams full-agent backup manifests across the HTTP boundary without asking
 * Node's response writer to materialize one giant outgoing buffer.
 */

import { once } from "node:events";
import type http from "node:http";
import type { AgentBackupStateData } from "../services/agent-backup.ts";

const STRING_CHUNK_CODE_UNITS = 256 * 1024;

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

/** Writes a restorable snapshot as chunked JSON while honoring backpressure. */
export async function writeAgentBackupJsonResponse(
  res: http.ServerResponse,
  snapshot: AgentBackupStateData,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  for await (const chunk of encodeJsonValue(snapshot, new Set())) {
    if (!res.write(chunk)) await once(res, "drain");
  }
  res.end();
}
