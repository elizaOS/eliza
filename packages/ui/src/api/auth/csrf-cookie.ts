/** Reads the browser session's readable CSRF companion cookie. */

import { shellLocalStorage } from "../../surface-realm-channel";
import { CSRF_COOKIE_NAME } from "./sessions";

const CSRF_TOKEN_BY_ORIGIN_STORAGE_KEY = "eliza_csrf_token_by_origin_v1";

function csrfOrigin(url: string): string | null {
  try {
    return new URL(url, globalThis.location?.href).origin;
  } catch {
    return null;
  }
}

function readStoredCsrfTokens(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(
      localStorage.getItem(CSRF_TOKEN_BY_ORIGIN_STORAGE_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          entry[1].length > 0 &&
          entry[1].length <= 512,
      ),
    );
  } catch {
    // error-policy:J3 malformed or unavailable local storage is equivalent to
    // an absent CSRF mirror; the request will fail closed at the server.
    return {};
  }
}

/**
 * Retain a successful login/setup response's CSRF token for its API origin.
 * Capacitor remote-Mac builds run JavaScript on the app origin, so WebKit sends
 * the remote HttpOnly session cookie but does not expose the remote origin's
 * readable CSRF companion through `document.cookie`. The token is scoped by
 * origin to prevent it from riding a request to another configured server.
 */
export function rememberCsrfTokenForUrl(url: string, token: string): void {
  const origin = csrfOrigin(url);
  const normalizedToken = token.trim();
  if (!origin || !normalizedToken || normalizedToken.length > 512) return;
  if (typeof localStorage === "undefined") return;
  try {
    shellLocalStorage.setItem(
      CSRF_TOKEN_BY_ORIGIN_STORAGE_KEY,
      JSON.stringify({ ...readStoredCsrfTokens(), [origin]: normalizedToken }),
    );
  } catch {
    // error-policy:J6 best-effort native CSRF mirror. Same-origin browsers keep
    // using the cookie path; native requests fail closed if storage is denied.
  }
}

/** Return the decoded token, or null for absent and malformed cookie values. */
export function readCsrfTokenFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${CSRF_COOKIE_NAME}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length));
      } catch {
        // error-policy:J3 untrusted cookie values — a malformed percent-escape
        // is an absent CSRF token, not a client crash.
        return null;
      }
    }
  }
  return null;
}

/** Read a same-origin cookie or the native mirror for the request origin. */
export function readCsrfTokenForUrl(url: string): string | null {
  const origin = csrfOrigin(url);
  if (!origin) return null;

  const pageOrigin = csrfOrigin(globalThis.location?.href ?? "");
  if (origin === pageOrigin) {
    const cookieToken = readCsrfTokenFromCookie();
    if (cookieToken) return cookieToken;
  }

  return readStoredCsrfTokens()[origin] ?? null;
}
