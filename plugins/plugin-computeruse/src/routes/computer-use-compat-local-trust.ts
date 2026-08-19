/**
 * Fail-closed same-machine trust for computer-use compatibility approval
 * routes. Origin treated a missing peer address as local and authorized
 * GET/POST approval routes without a token. A proxy client-IP header or a
 * non-loopback Host must not restore that bypass.
 */
import type http from "node:http";

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

const LOOPBACK_REMOTES = new Set([
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1",
  "::ffff:127.0.0.1",
  "::ffff:0:127.0.0.1",
]);

const PROXY_CLIENT_IP_HEADERS = [
  "forwarded",
  "forwarded-for",
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
  );
}

function hostnameFromHostHeader(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}

export function isTrustedComputerUseLocalRequest(
  req: Pick<http.IncomingMessage, "headers"> & {
    socket?: Pick<http.IncomingMessage["socket"], "remoteAddress"> | null;
  },
): boolean {
  if (process.env.ELIZA_REQUIRE_LOCAL_AUTH === "1") return false;
  if (process.env.ELIZA_CLOUD_PROVISIONED === "1") return false;

  const remoteAddress = req.socket?.remoteAddress?.trim().toLowerCase();
  if (!remoteAddress || !LOOPBACK_REMOTES.has(remoteAddress)) {
    return false;
  }

  for (const header of PROXY_CLIENT_IP_HEADERS) {
    if (firstHeaderValue(req.headers[header])) return false;
  }

  const host = firstHeaderValue(req.headers.host);
  if (host && !isLoopbackHostname(hostnameFromHostHeader(host))) {
    return false;
  }

  const secFetchSite = firstHeaderValue(
    req.headers["sec-fetch-site"],
  )?.toLowerCase();
  if (secFetchSite === "cross-site") return false;

  const origin = firstHeaderValue(req.headers.origin);
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (!isLoopbackHostname(parsed.hostname)) {
        return false;
      }
    } catch {
      // error-policy:J3 untrusted Origin header; an unparseable origin is
      // rejected (fail-closed), never treated as local.
      return false;
    }
  }

  return true;
}
