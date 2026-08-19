/**
 * Fail-closed same-machine trust for computer-use compatibility approval
 * routes. Origin treated a missing peer address as local and authorized
 * GET/POST approval routes without a token. A proxy client-IP header, a
 * non-loopback Host, a present Origin that does not match Host (host+port),
 * or browser fetch metadata other than same-origin/none must not restore
 * that bypass. Originless direct loopback clients remain admitted.
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
  return parseHostAuthority(host).hostname;
}

function parseHostAuthority(host: string): {
  hostname: string;
  port: string | null;
} {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return { hostname: trimmed, port: null };
    const hostname = trimmed.slice(1, end);
    const after = trimmed.slice(end + 1);
    const port =
      after.startsWith(":") && after.length > 1 ? after.slice(1) : null;
    return { hostname, port };
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return { hostname: trimmed, port: null };
  return { hostname: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) };
}

function parseOriginAuthority(origin: string): {
  hostname: string;
  port: string;
} | null {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const hostname = parsed.hostname.trim().toLowerCase();
    if (!hostname) return null;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return { hostname, port };
  } catch {
    // error-policy:J3 untrusted Origin header; unparseable origin is invalid.
    return null;
  }
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
  if (
    secFetchSite &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "none"
  ) {
    return false;
  }

  const origin = firstHeaderValue(req.headers.origin);
  if (origin) {
    const originAuth = parseOriginAuthority(origin);
    if (!originAuth || !isLoopbackHostname(originAuth.hostname)) {
      return false;
    }
    if (!host) return false;
    const hostAuth = parseHostAuthority(host);
    if (!isLoopbackHostname(hostAuth.hostname)) return false;
    if (originAuth.hostname !== hostAuth.hostname) return false;
    const hostPort = hostAuth.port ?? "80";
    if (originAuth.port !== hostPort) return false;
  }

  return true;
}
