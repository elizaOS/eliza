import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const ALLOW_INSECURE_WEBHOOK_URLS =
  process.env.STEWARD_ALLOW_INSECURE_WEBHOOK_URLS === "true";

function isNonPublicIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) ||
    (a === 192 && b === 31 && octets[2] === 196) ||
    (a === 192 && b === 52 && octets[2] === 193) ||
    (a === 192 && b === 88 && octets[2] === 99) ||
    (a === 192 && b === 175 && octets[2] === 48) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224 ||
    hostname === "255.255.255.255"
  );
}

function mappedIpv4FromIpv6(hostname: string): string | null {
  const normalized = hostname.toLowerCase();
  const dotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];

  const hex = normalized.match(
    /^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function expandIpv6Words(hostname: string): number[] | null {
  const normalized = hostname.toLowerCase();
  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const parseWords = (part: string): number[] | null => {
    if (!part) return [];
    const words = part.split(":");
    const parsed = words.map((word) => {
      if (!/^[0-9a-f]{1,4}$/.test(word)) return Number.NaN;
      return Number.parseInt(word, 16);
    });
    return parsed.some(
      (word) => !Number.isInteger(word) || word < 0 || word > 0xffff,
    )
      ? null
      : parsed;
  };

  const left = parseWords(halves[0]);
  const right = parseWords(halves[1] ?? "");
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function embeddedIpv4FromIpv6(hostname: string): string | null {
  const words = expandIpv6Words(hostname);
  if (!words || words.length !== 8) return null;

  const fromWords = (high: number, low: number) =>
    [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");

  const isNat64WellKnown =
    words[0] === 0x64 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0;
  if (isNat64WellKnown) return fromWords(words[6], words[7]);

  // RFC 8215 IPv4-translated ::ffff:0:0/96 — distinct from the IPv4-mapped
  // form (words[5] === 0xffff, handled by mappedIpv4FromIpv6). The IPv4 is
  // embedded in the low 32 bits and reachable through NAT64/SIIT paths, so
  // it must face the same non-public checks. Parity with the delivery-time
  // dispatcher screen (SEC-178); registration should reject these up front.
  const isIpv4Translated =
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0xffff &&
    words[5] === 0;
  if (isIpv4Translated) return fromWords(words[6], words[7]);

  if (words[0] === 0x2002) return fromWords(words[1], words[2]);

  return null;
}

function isNonPublicIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const ipv4Mapped = mappedIpv4FromIpv6(normalized);
  if (ipv4Mapped) return isNonPublicIpv4(ipv4Mapped);
  const ipv4Embedded = embeddedIpv4FromIpv6(normalized);
  if (ipv4Embedded) return isNonPublicIpv4(ipv4Embedded);
  const words = expandIpv6Words(normalized);
  // RFC 8215 reserves 64:ff9b:1::/48 for local use and explicitly says no
  // assumption can be made about an embedded IPv4 address or its location.
  // Treat the entire non-globally-reachable prefix as non-public (matching the
  // OIDC screeners) instead of extracting a would-be /96 suffix.
  if (words?.[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return true;
  // Deprecated IPv4-compatible ::/96 space is special-use, not a public
  // webhook destination. Closes parser-dependent forms such as
  // `[::127.0.0.1]` / `[::7f00:1]` (parity with the dispatcher screen).
  if (
    words &&
    words.slice(0, 6).every((word) => word === 0) &&
    (words[6] !== 0 || words[7] !== 0)
  )
    return true;
  // Only ordinary global-unicast space is a valid literal destination. Public
  // IPv4 embeddings above return before this check; everything else outside
  // 2000::/3 is reserved, local, discard-only, or currently unallocated.
  if (words?.[0] !== undefined && (words[0] & 0xe000) !== 0x2000) return true;
  // IANA protocol assignments occupy 2001::/23. Individual sub-prefixes such
  // as benchmarking 2001:2::/48 do not make the adjacent space public.
  if (words?.[0] === 0x2001 && words[1] <= 0x01ff) return true;
  if (words?.[0] === 0x2001 && words[1] === 0xdb8) return true;
  // Keep registration-time screening aligned with the delivery dispatcher for
  // the complete benchmarking and discard-only special-use prefixes.
  if (words?.[0] === 0x2001 && words[1] === 0x0002 && words[2] === 0)
    return true;
  if (
    words?.[0] === 0x0100 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0
  )
    return true;
  if (words?.[0] !== undefined && (words[0] & 0xffc0) === 0xfe80) return true;
  if (words?.[0] !== undefined && (words[0] & 0xffc0) === 0xfec0) return true;
  if (words?.[0] === 0x2620 && words[1] === 0x004f && words[2] === 0x8000)
    return true;
  if (words?.[0] === 0x3fff && (words[1] & 0xf000) === 0) return true;
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("ff")
  );
}

export function validateWebhookUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password)
      return "url must not include credentials";

    if (parsed.protocol !== "https:") {
      if (!ALLOW_INSECURE_WEBHOOK_URLS || parsed.protocol !== "http:") {
        return "url must use https";
      }
    }

    const hostname = parsed.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/g, "")
      .toLowerCase();
    if (!hostname) return "url must include a host";
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      return "url host must be public";
    }
    if (hostname.endsWith(".local") || hostname.endsWith(".internal")) {
      return "url host must be public";
    }

    const ipVersion = isIP(hostname);
    if (ipVersion === 4 && isNonPublicIpv4(hostname))
      return "url host must be public";
    if (ipVersion === 6 && isNonPublicIpv6(hostname))
      return "url host must be public";

    return null;
  } catch {
    return "url must be a valid HTTPS URL";
  }
}

// ─── DNS-resolving validation (SEC-017) ──────────────────────────────────────

export type DnsAnswer = { address: string; family: number };
export type DnsResolver = (hostname: string) => Promise<DnsAnswer[]>;

const defaultResolver: DnsResolver = (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function isNonPublicAddress(address: string, family?: number): boolean {
  const normalized = address.toLowerCase();
  const version = isIP(normalized);
  if (version === 0 || (family !== undefined && family !== version))
    return true;
  if (version === 4) return isNonPublicIpv4(normalized);
  if (version === 6) return isNonPublicIpv6(normalized);
  // Kept as an explicit fail-closed fallback if Node adds another family.
  return true;
}

/**
 * SEC-017: `validateWebhookUrl` only inspects the hostname STRING, so a name
 * like `169.254.169.254.nip.io` (public DNS → link-local) or a DNS rebinding
 * (public A record at config time, private at fetch time) passes it. This
 * async variant additionally resolves the hostname and rejects when ANY
 * answer is a non-public address, failing closed on resolution errors. Use it
 * at registration time AND at delivery time (fresh answers close the
 * config→fetch rebinding window). The resolver is injectable for tests.
 */
export async function validateWebhookUrlResolved(
  url: string,
  resolver: DnsResolver = defaultResolver,
): Promise<string | null> {
  const stringError = validateWebhookUrl(url);
  if (stringError) return stringError;

  let hostname: string;
  try {
    hostname = new URL(url).hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.+$/g, "")
      .toLowerCase();
  } catch {
    return "url must be a valid HTTPS URL";
  }
  // IP literals are fully covered by the string-level checks above.
  if (isIP(hostname)) return null;

  let answers: DnsAnswer[];
  try {
    answers = await resolver(hostname);
  } catch {
    return "url host could not be resolved";
  }
  if (answers.length === 0) return "url host could not be resolved";
  for (const answer of answers) {
    if (isNonPublicAddress(answer.address, answer.family)) {
      return "url host must resolve to a public address";
    }
  }
  return null;
}
