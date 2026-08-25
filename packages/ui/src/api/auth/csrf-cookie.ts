/** Reads the browser session's readable CSRF companion cookie. */

import { CSRF_COOKIE_NAME } from "./sessions";

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
