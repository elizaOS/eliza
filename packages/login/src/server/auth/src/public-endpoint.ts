import { containsAsciiControl } from "../../shared/src/text-boundaries";

export const BLOCKED_PUBLIC_ENDPOINT_DNS_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "localdomain",
  "lan",
  "home",
  "home.arpa",
  "corp",
  "test",
  "example",
  "invalid",
  "onion",
  "alt",
] as const;
function ipv4ToUint32(address: string): number | null {
  const parts = address.split(".");
  // DNS APIs return canonical dotted-decimal addresses. Keep this portable
  // parser equally strict: Number() would otherwise accept empty octets,
  // signs, exponents, whitespace, and ambiguous leading-zero forms.
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))
  ) {
    return null;
  }
  const octets = parts.map((part) => Number(part));
  if (
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return (
    (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0
  );
}

function inIpv4Cidr(value: number, base: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length > 253) return false;
  return hostname
    .split(".")
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );
}

/**
 * Return true only for ordinary globally-routable IPv4 unicast space.
 *
 * The deny list intentionally includes every IANA special-purpose block that
 * can be interpreted as a local, documentation, benchmarking, relay, multicast,
 * or reserved destination. An identity-provider endpoint has no valid reason to
 * use one of these ranges.
 */
function isPublicIpv4(address: string): boolean {
  const value = ipv4ToUint32(address);
  if (value === null) return false;

  const blocked: ReadonlyArray<readonly [string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.31.196.0", 24],
    ["192.52.193.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["192.175.48.0", 24],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];

  return !blocked.some(([base, prefix]) => {
    const baseValue = ipv4ToUint32(base);
    return baseValue !== null && inIpv4Cidr(value, baseValue, prefix);
  });
}

function expandIpv6Words(address: string): number[] | null {
  let normalized = address.toLowerCase().split("%", 1)[0];
  if (normalized.includes(".")) {
    const colon = normalized.lastIndexOf(":");
    if (colon === -1) return null;
    const embedded = ipv4ToUint32(normalized.slice(colon + 1));
    if (embedded === null) return null;
    normalized = `${normalized.slice(0, colon)}:${(embedded >>> 16).toString(16)}:${(embedded & 0xffff).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const words = part
      .split(":")
      .map((word) =>
        /^[0-9a-f]{1,4}$/.test(word) ? Number.parseInt(word, 16) : Number.NaN,
      );
    return words.some((word) => !Number.isInteger(word)) ? null : words;
  };
  const left = parse(halves[0]);
  const right = parse(halves[1] ?? "");
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv4FromWords(high: number, low: number): string {
  return [high >>> 8, high & 0xff, low >>> 8, low & 0xff].join(".");
}

function embeddedIpv4(words: number[]): string | null {
  const zeroPrefix = words.slice(0, 5).every((word) => word === 0);
  // IPv4-mapped ::ffff:0:0/96. OS resolvers may return this form for a
  // perfectly public A record, so classify the embedded address itself.
  if (zeroPrefix && words[5] === 0xffff)
    return ipv4FromWords(words[6], words[7]);

  const nat64 =
    words[0] === 0x64 &&
    words[1] === 0xff9b &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0;
  if (nat64) return ipv4FromWords(words[6], words[7]);

  if (words[0] === 0x2002) return ipv4FromWords(words[1], words[2]);
  return null;
}

function isPublicIpv6(address: string): boolean {
  const words = expandIpv6Words(address);
  if (!words || words.length !== 8) return false;

  const embedded = embeddedIpv4(words);
  if (embedded) return isPublicIpv4(embedded);

  // IPv4-compatible ::/96 is deprecated special-use space. In particular,
  // forms such as ::127.0.0.1 must not bypass the IPv4 loopback classifier.
  if (words.slice(0, 6).every((word) => word === 0)) return false;

  // Global unicast allocations are currently within 2000::/3. Rejecting
  // everything else also closes unique-local, link/site-local, multicast,
  // discard-only, and local-use translation ranges without prefix guessing.
  if ((words[0] & 0xe000) !== 0x2000) return false;

  // IANA special-purpose ranges within 2000::/3.
  if (words[0] === 0x2001 && words[1] <= 0x01ff) return false; // 2001::/23
  if (words[0] === 0x2001 && words[1] === 0x0db8) return false; // documentation
  if (words[0] === 0x2002) return false; // deprecated 6to4 when not handled above
  if (words[0] === 0x2620 && words[1] === 0x004f && words[2] === 0x8000) {
    return false; // Direct Delegation AS112 service
  }
  if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return false; // 3fff::/20 docs

  return true;
}

/** True only when `address` is a syntactically valid, globally-routable IP. */
export function isPublicInternetAddress(
  address: string,
  family?: number,
): boolean {
  // Zone identifiers are interface-local routing hints, not public Internet
  // destinations. Resolvers should not return them; fail closed if one does.
  if (address.includes("%") || address !== address.trim()) return false;
  const normalized = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .trim();
  const detected =
    ipv4ToUint32(normalized) !== null
      ? 4
      : expandIpv6Words(normalized) !== null
        ? 6
        : 0;
  if (family !== undefined && family !== 4 && family !== 6) return false;
  if (family !== undefined && detected !== family) return false;
  if (detected === 4) return isPublicIpv4(normalized);
  if (detected === 6) return isPublicIpv6(normalized);
  return false;
}

export function assertPublicInternetAddress(
  address: string,
  family: number,
  resource: string,
): void {
  if (!isPublicInternetAddress(address, family)) {
    throw new Error(`${resource} must resolve to a public address`);
  }
}

/** Validate the non-DNS portion of an outbound public HTTPS endpoint. */
export function assertPublicHttpsEndpoint(
  value: string,
  resource: string,
): URL {
  let url: URL;
  try {
    if (value.length > 2_048 || containsAsciiControl(value)) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error(`${resource} must be a public https URL`);
  }
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/g, "")
    .toLowerCase();
  const literalFamily =
    ipv4ToUint32(hostname) !== null
      ? 4
      : expandIpv6Words(hostname) !== null
        ? 6
        : 0;
  if (
    url.protocol !== "https:" ||
    url.port === "0" ||
    url.username !== "" ||
    url.password !== "" ||
    !hostname ||
    (literalFamily === 0 &&
      (!hostname.includes(".") || !isValidDnsHostname(hostname))) ||
    BLOCKED_PUBLIC_ENDPOINT_DNS_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    ) ||
    (literalFamily !== 0 && !isPublicInternetAddress(hostname, literalFamily))
  ) {
    throw new Error(`${resource} must be a public https URL`);
  }
  return url;
}
