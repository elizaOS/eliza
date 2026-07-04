/**
 * GET /api/i18n/locale — server-side language suggestion derived from the
 * request's IP-geo country header and `Accept-Language`. Used only as a
 * first-visit fallback when the browser gives no usable language hint.
 *
 * The route handler is mounted at the cloud edge in
 * `packages/cloud/api/src/bootstrap-app.ts`.
 */

import { getBootConfig } from "../config/boot-config";
import { normalizeLanguage, type UiLanguage } from "../i18n";
import { supportsFullAppShellRoutes } from "./app-shell-capabilities";
import { fetchWithCsrf } from "./csrf-client";

function localeBase(): string {
  if (typeof window === "undefined") return "";
  const apiBase = getBootConfig().apiBase;
  return apiBase ? apiBase.replace(/\/$/, "") : window.location.origin;
}

function shouldFetchSuggestedLanguage(): boolean {
  if (typeof window === "undefined") return false;
  const apiBase = getBootConfig().apiBase;
  if (apiBase) return supportsFullAppShellRoutes(apiBase);
  const host = window.location.hostname.toLowerCase();
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
}

/**
 * Fetch the server's suggested UI language. Returns `null` when the endpoint
 * is unreachable or the server has no confident suggestion (advisory only).
 */
export async function fetchSuggestedLanguage(): Promise<UiLanguage | null> {
  if (!shouldFetchSuggestedLanguage()) return null;
  let res: Response;
  try {
    res = await fetchWithCsrf(`${localeBase()}/api/i18n/locale`);
  } catch {
    // error-policy:J4 advisory-only first-visit language hint; an unreachable
    // endpoint degrades to "no suggestion" (null) and the caller falls back to
    // the browser's own language. Not a required data load.
    return null;
  }
  if (!res.ok) return null;
  // error-policy:J4 malformed suggestion body → no suggestion (advisory only).
  const body = (await res.json().catch(() => null)) as {
    language?: unknown;
  } | null;
  if (!body || typeof body.language !== "string") return null;
  return normalizeLanguage(body.language);
}
