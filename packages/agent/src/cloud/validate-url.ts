import dns from "node:dns";
import net from "node:net";
import { promisify } from "node:util";

const dnsLookupAll = promisify(dns.lookup);

const BLOCKED_IPV4_CIDRS: Array<{ base: number; mask: number }> = [
  cidrV4("0.0.0.0", 8),
  cidrV4("10.0.0.0", 8),
  cidrV4("172.16.0.0", 12),
  cidrV4("192.168.0.0", 16),
  cidrV4("100.64.0.0", 10),
  cidrV4("127.0.0.0", 8),
  cidrV4("169.254.0.0", 16),
  cidrV4("192.0.0.0", 24),
  cidrV4("198.18.0.0", 15),
  cidrV4("192.0.2.0", 24),
  cidrV4("198.51.100.0", 24),
  cidrV4("203.0.113.0", 24),
  cidrV4("224.0.0.0", 4),
  cidrV4("240.0.0.0", 4),
];

function normalizeHostLike(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

function decodeIpv6MappedHex(mapped: string): string | null {
  const parts = mapped.split(":");
  if (parts.length < 1 || parts.length > 2) return null;

  const parsed = parts.map((part) => {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return Number.NaN;
    return Number.parseInt(part, 16);
  });
  if (parsed.some((value) => !Number.isFinite(value))) return null;

  const [hi, lo] = parsed.length === 1 ? [0, parsed[0]] : parsed;
  const octets = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
  return octets.join(".");
}

function canonicalizeIpv6(ip: string): string | null {
  try {
    return new URL(`http://[${ip}]/`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

function normalizeIpForPolicy(ip: string): string {
  const base = normalizeHostLike(ip).split("%")[0];
  if (!base) return base;

  let normalized = base;
  if (net.isIP(normalized) === 6) {
    normalized = canonicalizeIpv6(normalized) ?? normalized;
  }

  let mapped: string | null = null;
  if (normalized.startsWith("::ffff:")) {
    mapped = normalized.slice("::ffff:".length);
  } else if (normalized.startsWith("0:0:0:0:0:ffff:")) {
    mapped = normalized.slice("0:0:0:0:0:ffff:".length);
  }
  if (!mapped) return normalized;

  if (net.isIP(mapped) === 4) return mapped;
  return decodeIpv6MappedHex(mapped) ?? normalized;
}

function cidrV4(base: string, prefix: number): { base: number; mask: number } {
  const parsed = parseIpv4ToInt(base);
  if (parsed === null) {
    throw new Error(`Invalid CIDR base IPv4 address: ${base}`);
  }
  const shift = 32 - prefix;
  const mask = shift === 32 ? 0 : (0xffffffff << shift) >>> 0;
  return { base: parsed & mask, mask };
}

function parseIpv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }

  return value >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
  const asInt = parseIpv4ToInt(ip);
  if (asInt === null) return true;
  return BLOCKED_IPV4_CIDRS.some((cidr) => (asInt & cidr.mask) === cidr.base);
}

function isBlockedIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    /^fe[89ab][0-9a-f]:/.test(normalized) ||
    /^f[cd][0-9a-f]{2}:/i.test(normalized) ||
    normalized.startsWith("ff")
  );
}

function isBlockedIp(ip: string): boolean {
  const normalized = normalizeIpForPolicy(ip);
  const family = net.isIP(normalized);
  if (family === 4) return isBlockedIpv4(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  return false;
}

export async function validateCloudBaseUrl(
  rawUrl: string,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return `Invalid cloud base URL: "${rawUrl}"`;
  }

  if (parsed.protocol !== "https:") {
    return `Cloud base URL must use HTTPS, got "${parsed.protocol}" in "${rawUrl}"`;
  }

  const hostname = normalizeHostLike(parsed.hostname);
  if (!hostname) {
    return `Invalid cloud base URL: "${rawUrl}"`;
  }

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return `Cloud base URL "${rawUrl}" points to a blocked local hostname.`;
  }

  // Dev-mode bypass: skip IP-range blocking but keep URL format checks above.
  if (process.env.NODE_ENV === "development" || process.env.ELIZA_DEV) {
    return null;
  }

  if (isBlockedIp(hostname)) {
    return `Cloud base URL "${rawUrl}" points to a blocked address.`;
  }

  try {
    const results = await dnsLookupAll(hostname, { all: true });
    const addresses = Array.isArray(results) ? results : [results];
    for (const entry of addresses) {
      const ip =
        typeof entry === "string"
          ? entry
          : (entry as { address: string }).address;
      if (isBlockedIp(ip)) {
        return (
          `Cloud base URL "${rawUrl}" resolves to ${ip}, ` +
          "which is a blocked internal/metadata address."
        );
      }
    }
  } catch {
    return `Cloud base URL "${rawUrl}" could not be resolved via DNS.`;
  }

  return null;
}
