/**
 * Remote-mode forwarder.
 *
 * AGENTS.md §1: in `remote` mode, mutating cloud settings must affect the
 * *target's* cloud settings (the local instance the controller is wired
 * to), not the controller's own config. The controller has no cloud
 * surface of its own — every cloud-routed write proxies to the target.
 *
 * Reads stay local: the dashboard reads its own status (which is the
 * thin-client target shape), and queries that need target state already
 * route through `/api/cloud/v1/*` (the cloud thin-client proxy).
 *
 * This module does not catch transport errors — a broken target is a
 * 502 surface to the caller, not a silent log-and-continue.
 */

import type http from "node:http";
import { fetchWithTimeoutGuard } from "@elizaos/agent";
import { sendJsonError } from "../../api/response";
import { getRuntimeModeSnapshot } from "./runtime-mode";

/** Pathnames whose mutations belong to the target in remote mode. */
const REMOTE_FORWARDED_MUTATION_PREFIXES = [
  "/api/cloud/login",
  "/api/cloud/disconnect",
  "/api/cloud/billing/",
  "/api/cloud/v1/",
] as const;

const FORWARDED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function shouldForwardToRemoteTarget(
  pathname: string,
  method: string,
): boolean {
  if (!FORWARDED_METHODS.has(method.toUpperCase())) return false;
  return REMOTE_FORWARDED_MUTATION_PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p,
  );
}

// Per RFC 7230 §6.1, hop-by-hop headers MUST NOT be forwarded by an
// intermediary. Re-using an upstream `Connection: keep-alive` or stale
// `Transfer-Encoding` against the target's connection corrupts framing.
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Build the outbound `Headers` for the target. Visible for testing.
 *
 * Per RFC 7230 §3.2.2, multi-valued request headers (`Cookie`, `Accept`,
 * `Forwarded`, etc.) are equivalent to a single comma-joined value.
 * Node parses `set-cookie` and any duplicated header as `string[]`;
 * we forward every value via `headers.append(name, v)` instead of
 * silently dropping the array (the previous behavior).
 */
export function buildForwardHeaders(
  incoming: http.IncomingHttpHeaders,
  targetHost: string,
  remoteAccessToken: string | null,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else {
      headers.set(name, value);
    }
  }
  // Replace the Host header — we are addressing the target now, not the
  // controller.
  headers.set("host", targetHost);
  if (remoteAccessToken) {
    headers.set("authorization", `Bearer ${remoteAccessToken}`);
  }
  return headers;
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Returns true when the controller forwarded the request to the target
 * (and wrote the response). Returns false when not in remote mode or the
 * route is not in the forwarded list, in which case the caller continues
 * dispatch.
 */
export async function forwardRemoteCloudMutation(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = (req.method ?? "GET").toUpperCase();
  const snapshot = getRuntimeModeSnapshot();

  if (snapshot.mode !== "remote") return false;
  if (!shouldForwardToRemoteTarget(url.pathname, method)) return false;
  if (!snapshot.remoteApiBase) {
    sendJsonError(
      res,
      snapshot.remoteApiBaseError ? 400 : 503,
      snapshot.remoteApiBaseError ?? "Remote target not configured",
    );
    return true;
  }

  const targetUrl = new URL(
    `${url.pathname}${url.search}`,
    snapshot.remoteApiBase,
  );

  const rawBody = FORWARDED_METHODS.has(method)
    ? await readRequestBody(req)
    : undefined;
  const body: BodyInit | undefined =
    rawBody && rawBody.length > 0 ? rawBody.toString("utf8") : undefined;

  const headers = buildForwardHeaders(
    req.headers,
    targetUrl.host,
    snapshot.remoteAccessToken,
  );

  const upstream = await fetchWithTimeoutGuard(
    targetUrl.toString(),
    {
      method,
      headers,
      body,
    },
    30_000,
  );

  const responseBody = await upstream.arrayBuffer();
  res.writeHead(upstream.status, {
    "content-type":
      upstream.headers.get("content-type") ?? "application/json",
  });
  res.end(Buffer.from(responseBody));
  return true;
}
