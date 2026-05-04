import type http from "node:http";
import { isIP } from "node:net";
import { isLoopbackBindHost } from "@elizaos/shared";

export function isLoopbackRemoteAddress(
  remoteAddress: string | null | undefined,
): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized === "::ffff:0:127.0.0.1"
  );
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

const CLIENT_IP_PROXY_HEADERS = new Set([
  "forwarded",
  "forwarded-for",
  "x-forwarded",
  "x-forwarded-for",
  "x-original-forwarded-for",
  "x-real-ip",
  "x-client-ip",
  "x-forwarded-client-ip",
  "x-cluster-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
  "fastly-client-ip",
  "x-appengine-user-ip",
  "x-azure-clientip",
]);

function headerValues(value: string | string[] | undefined): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function isClientIpProxyHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    CLIENT_IP_PROXY_HEADERS.has(normalized) ||
    normalized.endsWith("-client-ip") ||
    normalized.endsWith("-connecting-ip") ||
    normalized.endsWith("-real-ip")
  );
}

function extractForwardedForCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const pattern = /(?:^|[;,])\s*for=(?:"([^"]*)"|([^;,]*))/gi;
  for (const match of raw.matchAll(pattern)) {
    candidates.push(match[1] ?? match[2] ?? "");
  }
  return candidates;
}

function extractProxyClientAddressCandidates(
  headerName: string,
  raw: string,
): string[] {
  if (headerName === "forwarded") {
    return extractForwardedForCandidates(raw);
  }

  const forwardedCandidates = raw.toLowerCase().includes("for=")
    ? extractForwardedForCandidates(raw)
    : [];
  if (forwardedCandidates.length > 0) return forwardedCandidates;

  return raw.split(",");
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function isNeutralProxyClientAddress(raw: string): boolean {
  const normalized = stripMatchingQuotes(raw).trim().toLowerCase();
  return (
    !normalized ||
    normalized === "unknown" ||
    normalized === "null" ||
    normalized.startsWith("_")
  );
}

function normalizeProxyClientIp(raw: string): string | null {
  let normalized = stripMatchingQuotes(raw).trim();
  if (!normalized) return null;

  if (normalized.startsWith("[")) {
    const close = normalized.indexOf("]");
    if (close > 0) {
      normalized = normalized.slice(1, close);
    }
  } else {
    const ipv4HostPort = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)$/.exec(normalized);
    if (ipv4HostPort?.[1]) {
      normalized = ipv4HostPort[1];
    }
  }

  const zoneIndex = normalized.indexOf("%");
  if (zoneIndex >= 0) {
    normalized = normalized.slice(0, zoneIndex);
  }

  normalized = normalized.trim().toLowerCase();
  return isIP(normalized) ? normalized : null;
}

function isLoopbackProxyClientIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:0:127.")
  );
}

function proxyClientHeaderBlocksLocalTrust(
  headers: http.IncomingHttpHeaders,
): boolean {
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const headerName = rawName.toLowerCase();
    if (!isClientIpProxyHeaderName(headerName)) continue;

    for (const value of headerValues(rawValue)) {
      for (const candidate of extractProxyClientAddressCandidates(
        headerName,
        value,
      )) {
        if (isNeutralProxyClientAddress(candidate)) continue;
        const ip = normalizeProxyClientIp(candidate);
        if (!ip || !isLoopbackProxyClientIp(ip)) return true;
      }
    }
  }

  return false;
}

function isCloudProvisionedByEnv(): boolean {
  return process.env.ELIZA_CLOUD_PROVISIONED === "1";
}

function isTrustedLocalOrigin(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return true;
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === "file:" ||
      parsed.protocol === "app:" ||
      parsed.protocol === "tauri:" ||
      parsed.protocol === "capacitor:" ||
      parsed.protocol === "capacitor-electron:" ||
      parsed.protocol === "electrobun:"
    ) {
      return true;
    }
    return isLoopbackBindHost(parsed.hostname);
  } catch {
    return false;
  }
}

export function isTrustedLocalRequest(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
): boolean {
  if (isCloudProvisionedByEnv()) return false;
  if (!isLoopbackRemoteAddress(req.socket?.remoteAddress)) return false;
  if (proxyClientHeaderBlocksLocalTrust(req.headers)) return false;

  const host = firstHeaderValue(req.headers.host);
  if (host && !isLoopbackBindHost(host)) return false;

  const secFetchSite = firstHeaderValue(
    req.headers["sec-fetch-site"],
  )?.toLowerCase();
  if (secFetchSite === "cross-site") return false;

  const origin = firstHeaderValue(req.headers.origin);
  if (origin && !isTrustedLocalOrigin(origin)) return false;

  const referer = firstHeaderValue(req.headers.referer);
  if (!origin && referer && !isTrustedLocalOrigin(referer)) return false;

  return true;
}
