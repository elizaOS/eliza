import type http from "node:http";
import {
  countryFromHeaders,
  resolveServerLanguage,
} from "@elizaos/ui/i18n/region";
import { sendJson } from "./response";

export async function handleI18nLocaleRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method !== "GET" || url.pathname !== "/api/i18n/locale") {
    return false;
  }

  const acceptLanguage = req.headers["accept-language"];
  const language = resolveServerLanguage({
    acceptLanguage: Array.isArray(acceptLanguage)
      ? (acceptLanguage[0] ?? null)
      : (acceptLanguage ?? null),
    country: countryFromHeaders(req.headers),
  });

  sendJson(res, 200, { language });
  return true;
}
