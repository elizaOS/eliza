/**
 * GET /api/i18n/locale — server-side language suggestion derived from the
 * request's IP-geo country header and `Accept-Language`. Used only as a
 * first-visit fallback when the browser gives no usable language hint.
 *
 * The route handler is mounted at the cloud edge in
 * `packages/cloud-api/src/bootstrap-app.ts`.
 */

import { getBootConfig } from "../config/boot-config";
import { normalizeLanguage, type UiLanguage } from "../i18n";
import { fetchWithCsrf } from "./csrf-client";

function localeBase(): string {
  if (typeof window === "undefined") return "";
  const apiBase = getBootConfig().apiBase;
  return apiBase ? apiBase.replace(/\/$/, "") : window.location.origin;
}

/**
 * Fetch the server's suggested UI language. Returns `null` when the endpoint
 * is unreachable or the server has no confident suggestion (advisory only).
 */
export async function fetchSuggestedLanguage(): Promise<UiLanguage | null> {
  let res: Response;
  try {
    res = await fetchWithCsrf(`${localeBase()}/api/i18n/locale`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as {
    language?: unknown;
  } | null;
  if (!body || typeof body.language !== "string") return null;
  return normalizeLanguage(body.language);
}
