import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isForbiddenIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }

  const [first, second, third, fourth] = parts;

  if (first === 0) return true;
  if (first === 10) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  if (first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 0 && third === 0) return true;
  if (first === 192 && second === 0 && third === 2) return true;
  if (first === 192 && second === 88 && third === 99) return true;
  if (first === 192 && second === 168) return true;
  if (first === 198 && (second === 18 || second === 19)) return true;
  if (first === 198 && second === 51 && third === 100) return true;
  if (first === 203 && second === 0 && third === 113) return true;
  if (first >= 224 && first <= 239) return true;
  if (first >= 240) return true;
  if (first === 255 && second === 255 && third === 255 && fourth === 255) {
    return true;
  }

  return false;
}

function isForbiddenIpv6(address: string): boolean {
  const normalized = normalizeHostname(address);

  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isForbiddenIpAddress(mapped);
  }

  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  if (normalized.startsWith("2001:db8")) {
    return true;
  }

  return false;
}

export function isForbiddenIpAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);

  if (family === 4) {
    return isForbiddenIpv4(normalized);
  }

  if (family === 6) {
    return isForbiddenIpv6(normalized);
  }

  return false;
}

function validateUrlSyntax(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http and https URLs are allowed");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Credentials in URLs are not allowed");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new Error("URL is missing a hostname");
  }

  if (hostname === "localhost" || hostname === "0.0.0.0" || hostname.endsWith(".localhost")) {
    throw new Error("Localhost destinations are not allowed");
  }

  if (isForbiddenIpAddress(hostname)) {
    throw new Error("Private or reserved IP addresses are not allowed");
  }

  return parsed;
}

/**
 * Validates an outbound URL against SSRF-sensitive destinations.
 * For hostnames, DNS is resolved at call time so rebinding to private ranges
 * cannot bypass creation-time validation.
 */
export async function assertSafeOutboundUrl(rawUrl: string): Promise<URL> {
  const parsed = validateUrlSyntax(rawUrl);
  const hostname = normalizeHostname(parsed.hostname);

  if (!isIP(hostname)) {
    let records: LookupAddress[];
    try {
      records = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("Unable to resolve endpoint hostname");
    }

    if (!records.length) {
      throw new Error("Unable to resolve endpoint hostname");
    }

    for (const record of records) {
      if (isForbiddenIpAddress(record.address)) {
        throw new Error("Endpoint resolves to a private or reserved IP address");
      }
    }
  }

  return parsed;
}
