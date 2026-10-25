/**
 * Canonical client-IP validation for redemption anti-sybil gates. The cloud API
 * only passes trusted proxy headers into this helper; the service reuses it so
 * direct callers cannot create distinct cap identities with malformed strings.
 */

export function normalizeRedemptionClientIp(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.length > 128) {
    return undefined;
  }

  const ipv4Parts = trimmed.split(".");
  if (ipv4Parts.length === 4) {
    const normalized = ipv4Parts.map((part) => {
      if (!/^\d{1,3}$/.test(part)) return undefined;
      if (part.length > 1 && part.startsWith("0")) return undefined;
      const octet = Number(part);
      if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
        return undefined;
      }
      return String(octet);
    });
    if (normalized.every((part): part is string => typeof part === "string")) {
      return normalized.join(".");
    }
    return undefined;
  }

  if (!trimmed.includes(":")) return undefined;
  try {
    const hostname = new URL(`http://[${trimmed}]/`).hostname;
    return hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1).toLowerCase()
      : hostname.toLowerCase();
  } catch {
    return undefined;
  }
}
