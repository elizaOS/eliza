/**
 * Canonical predicate testing whether a host belongs to a private, loopback, or LAN network.
 *
 * Serves as the single source of truth for protocol-selection and cloud-login-backend
 * routing decisions that determine whether an agent backend is local or LAN-hosted
 * (`useCloudState`, `useOnboardingCallbacks`). Enforces strict IPv4/IPv6 parsing and
 * bracket validation covering loopback (127.0.0.0/8, ::1), RFC1918 private ranges,
 * IPv6 ULA (fc00::/7) and link-local (fe80::/10), CGNAT/Tailscale (100.64.0.0/10),
 * and .local / .internal / .localhost domain suffixes.
 */

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9]\d{0,2})$/.test(part))
  ) {
    return null;
  }
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (
    numbers.some((value) => Number.isNaN(value) || value < 0 || value > 255)
  ) {
    return null;
  }
  return numbers;
}

function isPrivateIpv4(parts: number[]): boolean {
  const [octet1, octet2] = parts;
  // 0.0.0.0/8 - This network (RFC 1122)
  if (octet1 === 0) return true;
  // 10.0.0.0/8 - RFC 1918
  if (octet1 === 10) return true;
  // 127.0.0.0/8 - Loopback (RFC 1122)
  if (octet1 === 127) return true;
  // 169.254.0.0/16 - Link-local (RFC 3927)
  if (octet1 === 169 && octet2 === 254) return true;
  // 172.16.0.0/12 - RFC 1918
  if (octet1 === 172 && octet2 >= 16 && octet2 <= 31) return true;
  // 192.168.0.0/16 - RFC 1918
  if (octet1 === 192 && octet2 === 168) return true;
  // 100.64.0.0/10 - Carrier-Grade NAT / Tailscale (RFC 6598)
  if (octet1 === 100 && octet2 >= 64 && octet2 <= 127) return true;
  return false;
}

function parseIpv6Hextets(address: string): number[] | null {
  let input = address.split("%")[0];
  if (input.includes(".")) {
    const colon = input.lastIndexOf(":");
    if (colon === -1) return null;
    const ipv4 = parseIpv4(input.slice(colon + 1));
    if (!ipv4) return null;
    input = `${input.slice(0, colon + 1)}${(((ipv4[0] << 8) | ipv4[1]) & 0xffff).toString(16)}:${(((ipv4[2] << 8) | ipv4[3]) & 0xffff).toString(16)}`;
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
  const zeros = 8 - (head.length + tail.length);
  if (zeros < 1) return null;
  return [...head, ...new Array<number>(zeros).fill(0), ...tail];
}

function isPrivateIpv6(hextets: number[]): boolean {
  const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets;
  // ::1 (Loopback) or :: (Unspecified)
  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    h5 === 0 &&
    h6 === 0 &&
    (h7 === 1 || h7 === 0)
  ) {
    return true;
  }
  // fc00::/7 - Unique Local Address (ULA)
  if ((h0 & 0xfe00) === 0xfc00) {
    return true;
  }
  // fe80::/10 - Link-local
  if ((h0 & 0xffc0) === 0xfe80) {
    return true;
  }
  // fec0::/10 - Deprecated site-local
  if ((h0 & 0xffc0) === 0xfec0) {
    return true;
  }
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96)
  if (
    h0 === 0 &&
    h1 === 0 &&
    h2 === 0 &&
    h3 === 0 &&
    h4 === 0 &&
    (h5 === 0 || h5 === 0xffff)
  ) {
    const embeddedIpv4 = [
      (h6 >> 8) & 0xff,
      h6 & 0xff,
      (h7 >> 8) & 0xff,
      h7 & 0xff,
    ];
    return isPrivateIpv4(embeddedIpv4);
  }
  return false;
}

export function isPrivateNetworkHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return false;

  // Bracket handling: IPv6 literals in URIs/hosts may be enclosed in [].
  // If brackets are present, they must be matched strictly around a valid IPv6 address.
  if (trimmed.includes("[") || trimmed.includes("]")) {
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
      return false;
    }
    const inner = trimmed.slice(1, -1);
    if (inner.includes("[") || inner.includes("]")) {
      return false;
    }
    const hextets = parseIpv6Hextets(inner);
    return hextets !== null && isPrivateIpv6(hextets);
  }

  // Named loopback and private domain suffixes
  if (
    trimmed === "localhost" ||
    trimmed.endsWith(".localhost") ||
    trimmed.endsWith(".local") ||
    trimmed.endsWith(".internal")
  ) {
    return true;
  }

  // IPv4 validation
  const ipv4 = parseIpv4(trimmed);
  if (ipv4) {
    return isPrivateIpv4(ipv4);
  }

  // Unbracketed IPv6 validation
  const ipv6 = parseIpv6Hextets(trimmed);
  if (ipv6) {
    return isPrivateIpv6(ipv6);
  }

  return false;
}
