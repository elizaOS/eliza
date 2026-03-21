import net from "node:net";

const ALWAYS_BLOCKED_IP_PATTERNS: RegExp[] = [
  /^0\./, // "this" network
  /^169\.254\./, // link-local / metadata
  /^fe[89ab][0-9a-f]:/i, // IPv6 link-local fe80::/10
  /^::$/i, // unspecified
  /^::1$/i, // IPv6 loopback
];

const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^10\./, // RFC1918
  /^127\./, // loopback
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^f[cd][0-9a-f]{2}:/i, // IPv6 ULA fc00::/7
];

export function normalizeHostLike(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

export function decodeIpv6MappedHex(mapped: string): string | null {
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

export function normalizeIpForPolicy(ip: string): string {
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

export function isBlockedPrivateOrLinkLocalIp(ip: string): boolean {
  const normalized = normalizeIpForPolicy(ip);
  if (ALWAYS_BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeIpForPolicy(host);
  if (!normalized) return false;
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  // Accept only IPv4 literals in 127.0.0.0/8, not hostnames that prefix-match.
  if (net.isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }

  return false;
}
