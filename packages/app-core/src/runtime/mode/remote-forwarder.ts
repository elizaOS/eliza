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
    sendJsonError(res, 503, "Remote target not configured");
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

  // Per RFC 7230 §6.1, hop-by-hop headers MUST NOT be forwarded by an
  // intermediary. Strip them — re-using values like an upstream
  // `Connection: keep-alive` or a stale `Transfer-Encoding` against the
  // target's connection produces corrupt framing.
  const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value !== "string") continue;
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    headers[name] = value;
  }
  // Replace the Host header — we are addressing the target now, not the
  // controller.
  headers.host = targetUrl.host;
  if (snapshot.remoteAccessToken) {
    headers.authorization = `Bearer ${snapshot.remoteAccessToken}`;
  }

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
