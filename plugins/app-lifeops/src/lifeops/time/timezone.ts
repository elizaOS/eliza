import { isValidTimeZone } from "../defaults.js";

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

function supportedTimeZoneValues(): string[] {
  const valuesFn = (
    Intl as typeof Intl & {
      supportedValuesOf?: (key: string) => string[];
    }
  ).supportedValuesOf;
  if (typeof valuesFn !== "function") {
    return [];
  }
  try {
    return valuesFn("timeZone");
  } catch {
    return [];
  }
}

const TIME_ZONE_CITY_ALIASES = (() => {
  const map = new Map<string, string>();
  for (const timeZone of supportedTimeZoneValues()) {
    const parts = timeZone.split("/");
    const city = parts[parts.length - 1]?.replace(/_/g, " ").trim();
    if (!city) {
      continue;
    }
    const key = canonicalizeTimeZoneAliasKey(city);
    if (!key || map.has(key)) {
      continue;
    }
    map.set(key, timeZone);
  }
  return map;
})();

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

export function inferTimeZoneFromLocationText(
  value: string | null | undefined,
): string | null {
  const explicit = extractExplicitTimeZoneFromText(value);
  if (explicit) {
    return explicit;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  const tokens = canonicalizeTimeZoneAliasKey(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }

  for (let size = Math.min(3, tokens.length); size >= 1; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phrase = tokens.slice(index, index + size).join(" ");
      const alias = TIME_ZONE_CITY_ALIASES.get(phrase);
      if (alias && isValidTimeZone(alias)) {
        return alias;
      }
    }
  }

  return null;
}
