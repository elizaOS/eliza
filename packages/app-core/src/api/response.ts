/**
 * JSON response helpers for the app-core HTTP API. `sendJson` writes a status
 * plus an `application/json` body, while `sendJsonError` wraps a message as
 * `{ error }`. Every payload is sanitized before serialization so error
 * internals never leak to clients.
 */
import type http from "node:http";

function sanitizeJsonPayload(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value instanceof Error) {
    return { error: value.message || "Internal error" };
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonPayload(item, seen));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "stack" || key === "stackTrace") continue;
    out[key] = sanitizeJsonPayload(item, seen);
  }
  seen.delete(value);
  return out;
}

function writeJson(res: http.ServerResponse, body: unknown): void {
  res.end(JSON.stringify(sanitizeJsonPayload(body)));
}

export const __test__ = {
  sanitizeJsonPayload,
};

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  writeJson(res, body);
}

export function sendJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message });
}
