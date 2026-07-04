/**
 * Language detection from region (IP geo) and browser hints.
 *
 * Pure helpers shared by every surface (desktop app, cloud-frontend, marketing
 * sites) so language guessing is consistent. Server code resolves from request
 * headers via {@link resolveServerLanguage}; clients resolve from the browser
 * via {@link detectClientLanguage}.
 *
 * Consumers import directly from `@elizaos/ui/i18n/region` to avoid a module
 * cycle with `./index`.
 */

import { normalizeLanguage } from "./index";
import type { UiLanguage } from "./messages";

/**
 * ISO 3166-1 alpha-2 country code → best-supported UI language. Only countries
 * whose dominant language maps to one of our 8 supported locales are listed;
 * everything else falls back to English by omission.
 */
const REGION_LANGUAGE: Record<string, UiLanguage> = {
  // Chinese (Simplified) — also used as the closest match for TW/HK/MO.
  CN: "zh-CN",
  TW: "zh-CN",
  HK: "zh-CN",
  MO: "zh-CN",
  SG: "zh-CN",
  // Korean
  KR: "ko",
  KP: "ko",
  // Japanese
  JP: "ja",
  // Vietnamese
  VN: "vi",
  // Filipino / Tagalog
  PH: "tl",
  // Portuguese
  PT: "pt",
  BR: "pt",
  AO: "pt",
  MZ: "pt",
  // Spanish
  ES: "es",
  MX: "es",
  AR: "es",
  CO: "es",
  CL: "es",
  PE: "es",
  VE: "es",
  EC: "es",
  GT: "es",
  CU: "es",
  BO: "es",
  DO: "es",
  HN: "es",
  PY: "es",
  SV: "es",
  NI: "es",
  CR: "es",
  PA: "es",
  UY: "es",
  PR: "es",
};

/** Map an ISO country code to a supported language, or `null` if unmapped. */
export function languageFromRegion(country?: string | null): UiLanguage | null {
  if (typeof country !== "string") return null;
  const code = country.trim().toUpperCase();
  return code ? (REGION_LANGUAGE[code] ?? null) : null;
}

/**
 * Pick the highest-priority supported language from an `Accept-Language`
 * header (q-value ordered), or `null` if none of the listed languages map to a
 * supported locale.
 */
export function languageFromAcceptLanguage(
  header?: string | null,
): UiLanguage | null {
  if (typeof header !== "string" || !header.trim()) return null;
  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      return { tag: tag.trim(), q: q ? Number.parseFloat(q) : 1 };
    })
    // `q=0` means "not acceptable" (RFC 9110 §12.4.2) — such tags must be
    // excluded, not merely ranked last, or a lone `ja;q=0` would still select
    // Japanese. Unparseable q-values are dropped with them (`NaN > 0` is false).
    .filter((entry) => entry.tag && entry.tag !== "*" && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const matched = matchSupported(tag);
    if (matched) return matched;
  }
  return null;
}

/**
 * Normalize a single BCP-47 tag to a supported language ONLY when it genuinely
 * matches one. `normalizeLanguage` falls back to English for unknown input, so
 * we guard against treating an unrelated tag (e.g. `de`) as English.
 */
function matchSupported(tag: string): UiLanguage | null {
  if (!tag) return null;
  if (/^en(-|$)/i.test(tag)) return "en";
  const normalized = normalizeLanguage(tag);
  return normalized === "en" ? null : normalized;
}

/**
 * Server-side language resolution. An explicit browser language preference
 * (`Accept-Language`) wins; otherwise fall back to IP/region geo. Returns
 * `null` when neither signal yields a supported language so the caller can
 * apply its own default.
 *
 * `country` is sourced from CDN/proxy geo headers (e.g. `cf-ipcountry`,
 * `x-vercel-ip-country`, `x-appengine-country`, `fastly-geo-country`).
 */
export function resolveServerLanguage(opts: {
  acceptLanguage?: string | null;
  country?: string | null;
}): UiLanguage | null {
  return (
    languageFromAcceptLanguage(opts.acceptLanguage) ??
    languageFromRegion(opts.country)
  );
}

/** Country geo headers set by common CDNs/proxies, in priority order. */
const COUNTRY_HEADERS = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "x-appengine-country",
  "fastly-geo-country",
  "x-country-code",
] as const;

/** Extract the client country from a request header bag, if any CDN set it. */
export function countryFromHeaders(
  headers:
    | Headers
    | Record<string, string | string[] | undefined>
    | null
    | undefined,
): string | null {
  if (!headers) return null;
  const get = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    const raw = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
  };
  for (const name of COUNTRY_HEADERS) {
    const value = get(name);
    if (value && value.toUpperCase() !== "XX") return value;
  }
  return null;
}

/**
 * Client-side language detection from browser hints alone. Scans the full
 * `navigator.languages` list (not just the first) for a supported language,
 * then falls back to the region subtag of the primary language (e.g. a browser
 * set to `en-MX` resolves to Spanish). Returns `null` when nothing matches.
 */
export function detectClientLanguage(): UiLanguage | null {
  if (typeof navigator === "undefined") return null;
  const tags =
    navigator.languages && navigator.languages.length > 0
      ? navigator.languages
      : navigator.language
        ? [navigator.language]
        : [];
  for (const tag of tags) {
    const matched = matchSupported(tag);
    if (matched) return matched;
  }
  // No direct language match — infer from the region subtag of the primary tag.
  const primary = tags[0];
  const region = primary?.split("-")[1];
  return languageFromRegion(region);
}
