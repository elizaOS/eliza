/**
 * Shared HTTP JSON response helpers for the app API layer.
 *
 * Consolidates the `sendJson` / `sendJsonError` / `sendJsonResponse` pattern
 * that was independently defined in server.ts, cloud-routes.ts, and others.
 */

import type http from "node:http";

function scrubStackFields(value: unknown): unknown {
  if (value instanceof Error) {
    return { error: value.message || "Internal error" };
  }
  if (Array.isArray(value)) {
    return value.map(scrubStackFields);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "stack" || k === "stackTrace") continue;
      out[k] = scrubStackFields(v);
    }
    return out;
  }
  return value;
}

/** Send a JSON response. No-op if headers already sent. */
export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(scrubStackFields(body)));
}

/** Send a JSON `{ error: message }` response. */
export function sendJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message });
}
