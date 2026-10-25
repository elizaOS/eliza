/**
 * Reconstructs direct and proxy-aware HTTP origins at API request boundaries.
 * Forwarded metadata is opt-in because it is only authoritative behind a
 * configured proxy; comma-separated chains use the client-facing first value.
 */

import type http from "node:http";

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string") return undefined;
  const normalized = first.split(",", 1)[0]?.trim();
  return normalized || undefined;
}

/** Empty when the request carries no usable host metadata. */
export function resolveDirectRequestOrigin(req: http.IncomingMessage): string {
  const proto =
    req.socket && "encrypted" in req.socket && req.socket.encrypted
      ? "https"
      : "http";
  const host = firstHeaderValue(req.headers.host);
  return host ? `${proto}://${host}` : "";
}

/**
 * Proxy-aware origin for boundaries that already permit forwarded metadata.
 * Security-sensitive callers should use `resolveDirectRequestOrigin` unless a
 * configured external origin establishes proxy authority.
 */
export function resolveRequestOrigin(req: http.IncomingMessage): string {
  const proto =
    firstHeaderValue(req.headers["x-forwarded-proto"]) ??
    (req.socket && "encrypted" in req.socket && req.socket.encrypted
      ? "https"
      : "http");
  const host =
    firstHeaderValue(req.headers["x-forwarded-host"]) ??
    firstHeaderValue(req.headers.host);
  return host ? `${proto}://${host}` : "";
}
