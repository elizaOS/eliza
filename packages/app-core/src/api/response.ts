/**
 * JSON response helpers for the app-core HTTP API. `sendJson` writes a status
 * plus an `application/json` body (and is a no-op once headers are sent);
 * `sendJsonError` wraps a message as `{ error }`. Every payload is serialized
 * through a replacer that strips stack traces so error internals never leak to
 * clients.
 */
import type http from "node:http";

/**
 * JSON.stringify replacer that strips stack traces in a single serialization
 * pass: omits `stack`/`stackTrace` keys and renders Error values as a safe
 * `{ error: message }`. This replaces a recursive deep-clone scrub that
 * allocated a parallel object tree on every response (~86 us/response) — the
 * replacer is byte-identical for all normal data and allocates nothing extra.
 * (Values with a custom `toJSON`, e.g. Date, now serialize via `toJSON` as one
 * would expect, instead of the old scrub's `{}`.)
 */
function scrubStackReplacer(_key: string, value: unknown): unknown {
  if (_key === "stack" || _key === "stackTrace") {
    return undefined;
  }
  if (value instanceof Error) {
    return { error: value.message || "Internal error" };
  }
  return value;
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body, scrubStackReplacer));
}

export function sendJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message });
}
