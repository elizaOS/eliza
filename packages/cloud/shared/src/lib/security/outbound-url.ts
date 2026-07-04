// Defines cloud shared outbound url behavior for backend service consumers.
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function ipv4FromMappedIpv6(address: string): string | null {
  const normalized = normalizeHostname(address);

  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (mapped.includes(".")) {
      return mapped;
    }

    const parts = mapped.split(":");
    if (parts.length === 2) {
      const high = Number.parseInt(parts[0], 16);
      const low = Number.parseInt(parts[1], 16);
      if (
        Number.isInteger(high) &&
        Number.isInteger(low) &&
        high >= 0 &&
        high <= 0xffff &&
        low >= 0 &&
        low <= 0xffff
      ) {
        return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      }
    }
  }

  const parts = normalized.split(":");
  if (
    parts.length === 8 &&
    parts.slice(0, 5).every((part) => part === "0") &&
    parts[5] === "ffff"
  ) {
    const high = Number.parseInt(parts[6], 16);
    const low = Number.parseInt(parts[7], 16);
    if (
      Number.isInteger(high) &&
      Number.isInteger(low) &&
      high >= 0 &&
      high <= 0xffff &&
      low >= 0 &&
      low <= 0xffff
    ) {
      return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
    }
  }

  // Deprecated IPv4-compatible IPv6 (`::/96`, RFC 4291 §2.5.5.1): `::a.b.c.d` or
  // its compressed-hex form `::HHHH:LLLL` with the high 96 bits all zero. These
  // embed an IPv4 address that resolvers may route — `::169.254.169.254` reaches
  // the cloud metadata endpoint — so decode the IPv4 and screen it. `::` and
  // `::1` are NOT IPv4-compatible host addresses and are handled elsewhere.
  if (normalized.startsWith("::") && normalized !== "::" && normalized !== "::1") {
    const tail = normalized.slice("::".length);
    if (tail.includes(".")) {
      // `::a.b.c.d` — the only colon-less, dotted tail after `::`.
      if (!tail.includes(":")) {
        return tail;
      }
    } else {
      const tailParts = tail.split(":");
      if (tailParts.length === 2) {
        const high = Number.parseInt(tailParts[0], 16);
        const low = Number.parseInt(tailParts[1], 16);
        if (
          Number.isInteger(high) &&
          Number.isInteger(low) &&
          high >= 0 &&
          high <= 0xffff &&
          low >= 0 &&
          low <= 0xffff &&
          // Exclude the tiny low range (`::0`–`::ffff`) that is not a routable
          // IPv4-compatible host: a single trailing group is `::N`, not `::H:L`.
          (high !== 0 || low !== 0)
        ) {
          return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
        }
      }
    }
  }

  return null;
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
  const mappedIpv4 = ipv4FromMappedIpv6(normalized);

  if (mappedIpv4) {
    return isForbiddenIpAddress(mappedIpv4);
  }

  if (normalized === "::" || normalized === "::1") return true;

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
 * Synchronous SSRF guard: validates URL syntax, requires http(s), and rejects
 * credentials, localhost, and private/reserved IP *literals* — WITHOUT resolving
 * DNS. Use at registration time (storing a URL), where a momentarily
 * unresolvable host must not block the write and the Worker runtime is not a
 * reliable place for outbound DNS. Full DNS-based SSRF enforcement (which also
 * defeats DNS rebinding) must still run at fetch/proxy time via
 * {@link assertSafeOutboundUrl}.
 */
export function assertSafeOutboundUrlSync(rawUrl: string): URL {
  return validateUrlSyntax(rawUrl);
}

/**
 * Resolves `hostname` (or accepts an IP literal) and rejects the whole answer
 * set if any record points at a private/reserved range. Returns every resolved
 * address so callers can both validate and pin a single connection target.
 */
async function resolveValidatedAddresses(hostname: string): Promise<LookupAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    // IP literals are already screened by validateUrlSyntax (isForbiddenIpAddress),
    // so we can pin to the literal without a DNS round-trip.
    return [{ address: hostname, family: literalFamily }];
  }

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

  return records;
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
    await resolveValidatedAddresses(hostname);
  }

  return parsed;
}

/**
 * Like {@link assertSafeOutboundUrl}, but also returns a single validated
 * address to PIN the connection to. The caller must connect to exactly this
 * address (e.g. via an http(s) `lookup` hook) so the socket cannot re-resolve
 * the hostname to a private range between validation and connect
 * (TOCTOU / DNS rebinding). All resolved addresses are still screened; the
 * first is returned as the pin.
 */
export async function resolveSafeOutboundTarget(
  rawUrl: string,
): Promise<{ url: URL; address: string; family: number }> {
  const parsed = validateUrlSyntax(rawUrl);
  const hostname = normalizeHostname(parsed.hostname);
  const [pinned] = await resolveValidatedAddresses(hostname);

  return { url: parsed, address: pinned.address, family: pinned.family };
}
