import { isValidTimeZone } from "../lifeops/defaults.js";

const TIME_ZONE_ALIASES: Record<string, string> = {
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  pt: "America/Los_Angeles",
  pacific: "America/Los_Angeles",
  "pacific time": "America/Los_Angeles",
  "pacific timezone": "America/Los_Angeles",
  "pacific daylight": "America/Los_Angeles",
  "pacific daylight time": "America/Los_Angeles",
  "pacific standard": "America/Los_Angeles",
  "pacific standard time": "America/Los_Angeles",
  "los angeles": "America/Los_Angeles",
  mst: "America/Denver",
  mdt: "America/Denver",
  mt: "America/Denver",
  mountain: "America/Denver",
  "mountain time": "America/Denver",
  "mountain timezone": "America/Denver",
  "mountain daylight": "America/Denver",
  "mountain daylight time": "America/Denver",
  "mountain standard": "America/Denver",
  "mountain standard time": "America/Denver",
  denver: "America/Denver",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  ct: "America/Chicago",
  central: "America/Chicago",
  "central time": "America/Chicago",
  "central timezone": "America/Chicago",
  "central daylight": "America/Chicago",
  "central daylight time": "America/Chicago",
  "central standard": "America/Chicago",
  "central standard time": "America/Chicago",
  chicago: "America/Chicago",
  est: "America/New_York",
  edt: "America/New_York",
  et: "America/New_York",
  eastern: "America/New_York",
  "eastern time": "America/New_York",
  "eastern timezone": "America/New_York",
  "eastern daylight": "America/New_York",
  "eastern daylight time": "America/New_York",
  "eastern standard": "America/New_York",
  "eastern standard time": "America/New_York",
  "new york": "America/New_York",
  utc: "UTC",
  gmt: "UTC",
};

const IANA_TIME_ZONE_PATTERN = /\b([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\b/g;

function canonicalizeTimeZoneAliasKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b(?:timezone|time)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeExplicitTimeZoneToken(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const alias = TIME_ZONE_ALIASES[canonicalizeTimeZoneAliasKey(trimmed)];
  if (alias && isValidTimeZone(alias)) {
    return alias;
  }
  if (isValidTimeZone(trimmed)) {
    return trimmed;
  }
  return null;
}

export function extractExplicitTimeZoneFromText(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  let match: RegExpExecArray | null;
  const ianaPattern = new RegExp(IANA_TIME_ZONE_PATTERN);
  ianaPattern.lastIndex = 0;
  while ((match = ianaPattern.exec(value)) !== null) {
    const normalized = normalizeExplicitTimeZoneToken(match[1] ?? match[0]);
    if (normalized) {
      return normalized;
    }
  }

  const lower = ` ${canonicalizeTimeZoneAliasKey(value)} `;
  for (const alias of Object.keys(TIME_ZONE_ALIASES).sort(
    (left, right) => right.length - left.length,
  )) {
    const escapedAlias = alias
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\ /g, "\\s+");
    const aliasPattern = new RegExp(`(^|\\s)${escapedAlias}(?=\\s|$)`, "i");
    if (aliasPattern.test(lower)) {
      const normalized = normalizeExplicitTimeZoneToken(alias);
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}
