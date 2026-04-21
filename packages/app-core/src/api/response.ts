/**
 * Shared HTTP JSON response helpers for the app API layer.
 *
 * Consolidates the `sendJson` / `sendJsonError` / `sendJsonResponse` pattern
 * that was independently defined in server.ts, cloud-routes.ts, and others.
 */

import type http from "node:http";

/** Send a JSON response. No-op if headers already sent. */
export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Send a JSON `{ error: message }` response. */
export function sendJsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  sendJson(res, status, { error: message });
}
