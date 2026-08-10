/**
 * Resolves Browser omnibox input for both the app UI and agent actions.
 * Explicit hosts remain navigation targets; ordinary text becomes a Google
 * search, using Google's supported embedded surface so web-hosted Browser tabs
 * do not fail on the regular homepage's frame policy.
 */

/** Google homepage variant that explicitly supports embedded app browsers. */
export const DEFAULT_BROWSER_SEARCH_HOME_URL =
  "https://www.google.com/webhp?igu=1";

/** Stable error codes exposed to UI and action boundaries. */
export type BrowserAddressInputErrorCode =
  | "invalid_url"
  | "unsupported_protocol";

/** Typed invalid-destination error for boundary-specific user messages. */
export class BrowserAddressInputError extends Error {
  readonly code: BrowserAddressInputErrorCode;

  constructor(code: BrowserAddressInputErrorCode, message: string) {
    super(message);
    this.name = "BrowserAddressInputError";
    this.code = code;
  }
}

function isIpv4Host(value: string): boolean {
  const host = value.split(/[/:?#]/, 1)[0] ?? "";
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

function isExplicitHostInput(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (/^localhost(?::\d+)?(?:[/?#]|$)/i.test(value)) return true;
  if (/^\[[0-9a-f:]+\](?::\d+)?(?:[/?#]|$)/i.test(value)) return true;
  if (isIpv4Host(value)) return true;
  if (/^[a-z\d-]+:\d+(?:[/?#]|$)/i.test(value)) return true;
  return /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z\d](?:[a-z\d-]*[a-z\d])?(?::\d+)?(?:[/?#]|$)/i.test(
    value,
  );
}

function defaultProtocolForHost(value: string): "http" | "https" {
  if (/^localhost(?::|[/?#]|$)/i.test(value)) return "http";
  if (/^\[[0-9a-f:]+\](?::|[/?#]|$)/i.test(value)) return "http";
  if (isIpv4Host(value)) return "http";
  if (/^[a-z\d-]+:\d+(?:[/?#]|$)/i.test(value)) {
    return /:443(?:[/?#]|$)/.test(value) ? "https" : "http";
  }
  return "https";
}

function makeGooglePageEmbeddable(url: URL): URL {
  if (!/(^|\.)google\.com$/i.test(url.hostname)) return url;
  if (url.hostname.toLowerCase() === "google.com") {
    url.hostname = "www.google.com";
  }
  if (url.pathname === "/") url.pathname = "/webhp";
  if (url.pathname === "/webhp" || url.pathname === "/search") {
    url.searchParams.set("igu", "1");
  }
  return url;
}

/** Build the canonical interactive Google results URL for a free-text query. */
export function buildBrowserSearchUrl(query: string): string {
  const trimmed = query.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    throw new BrowserAddressInputError(
      "invalid_url",
      "A browser search query cannot be empty.",
    );
  }
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("igu", "1");
  url.searchParams.set("q", trimmed);
  return url.toString();
}

/**
 * Resolve a user- or agent-supplied omnibox value to an absolute destination.
 * A scheme, dotted hostname, localhost/IP literal, or numeric host port is a
 * URL; everything else is a search query.
 */
export function resolveBrowserAddressInput(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;
  if (trimmed === "about:blank") return trimmed;
  if (trimmed.startsWith("//")) {
    try {
      return makeGooglePageEmbeddable(new URL(`https:${trimmed}`)).toString();
    } catch {
      throw new BrowserAddressInputError(
        "invalid_url",
        "Enter a valid web address or search query.",
      );
    }
  }

  const hostInput = isExplicitHostInput(trimmed);
  const schemeMatch = trimmed.match(/^([a-z][a-z\d+.-]*):/i);
  const explicitScheme = schemeMatch !== null && !hostInput;
  if (explicitScheme) {
    const protocol = schemeMatch[1]?.toLowerCase();
    if (protocol !== "http" && protocol !== "https") {
      throw new BrowserAddressInputError(
        "unsupported_protocol",
        "Only http and https URLs are supported.",
      );
    }
  }

  if (!explicitScheme && !hostInput) {
    return buildBrowserSearchUrl(trimmed);
  }

  const candidate = explicitScheme
    ? trimmed
    : `${defaultProtocolForHost(trimmed)}://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new BrowserAddressInputError(
        "unsupported_protocol",
        "Only http and https URLs are supported.",
      );
    }
    return makeGooglePageEmbeddable(parsed).toString();
  } catch (error) {
    if (error instanceof BrowserAddressInputError) throw error;
    throw new BrowserAddressInputError(
      "invalid_url",
      "Enter a valid web address or search query.",
    );
  }
}
