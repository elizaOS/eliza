/**
 * SSRF guard for cloud-shared outbound fetches and registration-time URL
 * screening: rejects credentials, localhost, and private/reserved IP literals,
 * and resolves+pins DNS at fetch time so rebinding cannot bypass the check.
 */
import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

/**
 * Expand an IPv6 address string into its eight 16-bit groups, handling `::`
 * compression and a dotted-quad tail (`64:ff9b::169.254.169.254`, the
 * inet_pton mixed form). Returns null when the string is not a syntactically
 * valid IPv6 address — the caller then falls back to the first-hextet string
 * classification only. Ported from packages/core/src/network/ssrf.ts so the
 * two outbound guards classify transition ranges identically.
 */
function parseIpv6Hextets(address: string): number[] | null {
  let input = address;
  // A dotted tail carries the final 32 bits as IPv4 text; rewrite it in place
  // as two hex groups so the expansion below stays uniform. Keeping the colon
  // that precedes the tail preserves a `::` compression spanning it.
  if (input.includes(".")) {
    const colon = input.lastIndexOf(":");
    if (colon === -1) return null;
    const octetParts = input.slice(colon + 1).split(".");
    if (octetParts.length !== 4) return null;
    const octets: number[] = [];
    for (const part of octetParts) {
      if (!/^\d{1,3}$/.test(part)) return null;
      const octet = Number.parseInt(part, 10);
      if (octet > 255) return null;
      octets.push(octet);
    }
    input = `${input.slice(0, colon + 1)}${(((octets[0] << 8) | octets[1]) & 0xffff).toString(16)}:${(((octets[2] << 8) | octets[3]) & 0xffff).toString(16)}`;
  }
  const parseGroups = (text: string): number[] | null => {
    if (!text) return [];
    const groups: number[] = [];
    for (const part of text.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const head = parseGroups(halves[0] ?? "");
  if (head === null) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const tail = parseGroups(halves[1] ?? "");
  if (tail === null) return null;
  // "::" must compress at least one all-zero group.
  const zeros = 8 - (head.length + tail.length);
  if (zeros < 1) return null;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

/**
 * Extract the policy-relevant embedded IPv4 from the transition/coexistence
 * ranges an attacker can route to internal space: IPv4-compatible `::/96`
 * (deprecated, still honored by some stacks), IPv4-mapped `::ffff:0:0/96`,
 * NAT64 `64:ff9b::/96` (RFC 6052 well-known prefix — live on AWS
 * IPv6-only/DNS64 subnets), 6to4 `2002::/16` (RFC 3056, IPv4 in bits 16..48),
 * and Teredo `2001:0000::/32` (RFC 4380, client IPv4 XOR-obfuscated in the low
 * 32 bits). On those network paths a literal URL never touches DNS, so
 * screening the embedded IPv4 is the only chance to classify the address the
 * packet actually reaches. Returns null when the address is outside those
 * ranges. Ported from packages/core/src/network/ssrf.ts.
 */
function embeddedIpv4ForPolicy(hextets: number[]): number[] | null {
  const [h0, h1, h2, , , h5, h6, h7] = hextets;
  const low32ToIpv4 = (): number[] => [(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff];
  // IPv4-compatible ::/96 and IPv4-mapped ::ffff:0:0/96 — the embedded address
  // is the low 32 bits. (`::` and `::1` are classified by the caller, but their
  // embedded 0.0.0.0/0.0.0.1 are caught by the IPv4 zero-net rule regardless.)
  if (h0 === 0 && h1 === 0 && h2 === 0 && hextets[3] === 0) {
    if (hextets[4] === 0 && (h5 === 0 || h5 === 0xffff)) {
      return low32ToIpv4();
    }
  }
  // NAT64 well-known prefix 64:ff9b::/96 — embedded IPv4 is the low 32 bits.
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && hextets[3] === 0) {
    if (hextets[4] === 0 && h5 === 0) {
      return low32ToIpv4();
    }
  }
  // 6to4 2002::/16 — embedded IPv4 sits in bits 16..48.
  if (h0 === 0x2002) {
    return [(h1 >> 8) & 0xff, h1 & 0xff, (h2 >> 8) & 0xff, h2 & 0xff];
  }
  // Teredo 2001:0000::/32 — client IPv4 is the low 32 bits XOR 0xffffffff.
  if (h0 === 0x2001 && h1 === 0x0000) {
    return [
      ((h6 ^ 0xffff) >> 8) & 0xff,
      (h6 ^ 0xffff) & 0xff,
      ((h7 ^ 0xffff) >> 8) & 0xff,
      (h7 ^ 0xffff) & 0xff,
    ];
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

  if (normalized === "::" || normalized === "::1") return true;

  const hextets = parseIpv6Hextets(normalized);
  if (hextets) {
    const [first, second] = hextets;
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if (first === 0x2001 && second === 0x0db8) return true; // 2001:db8::/32 documentation

    // Transition ranges (IPv4-mapped/compatible, NAT64, 6to4, Teredo) embed an
    // IPv4 the network may translate the literal to — e.g. a daemon on a
    // NAT64/DNS64 subnet connecting to [64:ff9b::a9fe:a9fe] actually reaches
    // 169.254.169.254 — so screen that embedded address with the IPv4 policy
    // too. This also covers the leading-zero-expanded spellings of `::`/`::1`
    // (0:0:0:0:0:0:0:0 / 0:0:0:0:0:0:0:1) via the zero-net IPv4 rule.
    const embedded = embeddedIpv4ForPolicy(hextets);
    if (embedded) {
      return isForbiddenIpv4(embedded.join("."));
    }
    return false;
  }

  // The address passed isIP but did not expand — keep the historical
  // first-hextet string classification as the fallback.
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
 * zod-refine-friendly predicate form of {@link assertSafeOutboundUrlSync} for
 * registration-time URL fields (e.g. an app's `app_url` / `allowed_origins`).
 * Null/empty values pass — presence and shape are the schema's job; this only
 * screens dangerous targets (non-http(s), embedded credentials, localhost,
 * private/reserved IP literals). DNS-based screening still runs at fetch time
 * via safeFetch, so a momentarily unresolvable public host is not rejected
 * here.
 */
export function isSafeRegistrationUrl(value: string | null | undefined): boolean {
  if (value == null || value === "") return true;
  try {
    assertSafeOutboundUrlSync(value);
    return true;
  } catch {
    // error-policy:J3 untrusted registration input — a guard rejection is an
    // explicit invalid result (false), never a swallowed error.
    return false;
  }
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
