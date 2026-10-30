/** Resolves colloquial time-zone names and abbreviations (e.g. "pacific", "pst") to IANA zone ids. */
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

// Aliases that are also ordinary words in prose ("CT scan", "PT session",
// "Central Park", "mountain biking", "the New York office"). The free-text
// scan reads them as a zone only where the text uses them as one; the
// abbreviations (PST, EST, UTC, ...) and the "... time" / "... standard" /
// "... daylight" phrases name a zone wherever they appear.
const PROSE_REGION_ALIASES = new Set([
  "pt",
  "mt",
  "ct",
  "et",
  "pacific",
  "mountain",
  "central",
  "eastern",
]);
const PROSE_CITY_ALIASES = new Set([
  "los angeles",
  "denver",
  "chicago",
  "new york",
]);

const CLOCK_TIME_TOKEN_PATTERN = /^(?:\d{1,2}(?::\d{2})?(?:am|pm)?|am|pm)$/;

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
    // error-policy:J3 runtime-capability probe; an engine that lacks
    // Intl.supportedValuesOf("timeZone") yields an empty enumeration, and
    // callers fall back to their own timezone list.
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

function freeTextTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/(?<=\d|\s|^)([ap])\.m\.?/g, "$1m")
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Whether the phrase at `tokens[index, index + size)` is used as a zone or a
 * place: the whole text, followed by "time" ("Tokyo time"), right after a
 * clock time ("10am PT", "3:30 central"), or, for a place, after "in"
 * ("while I'm in Tokyo").
 */
function phraseNamesZone(
  tokens: readonly string[],
  index: number,
  size: number,
  place: boolean,
): boolean {
  if (size === tokens.length) {
    return true;
  }
  const next = tokens[index + size];
  if (next === "time" || next === "timezone") {
    return true;
  }
  const previous = tokens[index - 1];
  if (previous === undefined) {
    return false;
  }
  return (
    CLOCK_TIME_TOKEN_PATTERN.test(previous) || (place && previous === "in")
  );
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
  const canonical = canonicalizeTimeZoneAliasKey(trimmed);
  // A planner that reads "2026-08-19T14:00:00Z" stamps timeZone "Z". Intl
  // rejects it, but it names UTC. This alias applies to the exact token
  // only: it stays out of TIME_ZONE_ALIASES because that table is also
  // scanned as free-text words by extractExplicitTimeZoneFromText, where a
  // bare "z" in prose ("Jay Z", "Gen Z", "A-Z") is not a time zone.
  if (canonical === "z") {
    return isValidTimeZone("UTC") ? "UTC" : null;
  }
  const alias = TIME_ZONE_ALIASES[canonical];
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

  const ianaPattern = new RegExp(IANA_TIME_ZONE_PATTERN);
  ianaPattern.lastIndex = 0;
  for (
    let match = ianaPattern.exec(value);
    match !== null;
    match = ianaPattern.exec(value)
  ) {
    const normalized = normalizeExplicitTimeZoneToken(match[1] ?? match[0]);
    if (normalized) {
      return normalized;
    }
  }

  const tokens = freeTextTokens(value);
  for (const alias of Object.keys(TIME_ZONE_ALIASES).sort(
    (left, right) => right.length - left.length,
  )) {
    const aliasTokens = alias.split(" ");
    const size = aliasTokens.length;
    const region = PROSE_REGION_ALIASES.has(alias);
    const place = PROSE_CITY_ALIASES.has(alias);
    for (let index = 0; index <= tokens.length - size; index += 1) {
      if (
        aliasTokens.some((token, offset) => tokens[index + offset] !== token)
      ) {
        continue;
      }
      if ((region || place) && !phraseNamesZone(tokens, index, size, place)) {
        continue;
      }
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

  // A zone's city segment is often a plain word or a name ("Casey",
  // "Christmas", "wake", "center"), so a city counts only where the text
  // uses it as a place or a zone.
  const tokens = freeTextTokens(value);
  if (tokens.length === 0) {
    return null;
  }

  for (let size = Math.min(3, tokens.length); size >= 1; size -= 1) {
    for (let index = 0; index <= tokens.length - size; index += 1) {
      const phrase = tokens.slice(index, index + size).join(" ");
      const alias = TIME_ZONE_CITY_ALIASES.get(phrase);
      if (
        alias &&
        isValidTimeZone(alias) &&
        phraseNamesZone(tokens, index, size, true)
      ) {
        return alias;
      }
    }
  }

  return null;
}
