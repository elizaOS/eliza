import type http from "node:http";
import {
  countryFromHeaders,
  resolveServerLanguage,
} from "@elizaos/ui/i18n/region";
import { sendJson as sendJsonResponse } from "./response";

/**
 * Public language-suggestion route.
 *
 * `GET /api/i18n/locale` resolves the best UI language for the requester from
 * request signals the browser cannot see on its own: the CDN/proxy IP-geo
 * country header and the `Accept-Language` header. The SPA calls this only when
 * the user has no stored language preference, so a first-time visitor behind a
 * geo-aware proxy lands in their region's language without a manual switch.
 *
 * Unauthenticated by design — language is needed before login, and the response
 * carries no user data.
 */
export async function handleI18nLocaleRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method !== "GET" || url.pathname !== "/api/i18n/locale") {
    return false;
  }

  const acceptLanguage = req.headers["accept-language"] ?? null;
  const country = countryFromHeaders(req.headers);
  const language = resolveServerLanguage({
    acceptLanguage: Array.isArray(acceptLanguage)
      ? acceptLanguage[0]
      : acceptLanguage,
    country,
  });

  sendJsonResponse(res, 200, { language });
  return true;
}
