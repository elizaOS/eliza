/**
 * Mounts the public `GET /api/i18n/locale` endpoint, which suggests a UI
 * language for a fresh client. Prefers a configured non-English `ui.language`
 * from `ElizaConfig`, otherwise selects the best-supported `Accept-Language`
 * match in q-value order, and falls back to English. The selection logic lives
 * in `resolveSuggestedUiLanguage` and is exercised directly by the unit tests.
 */
import type http from "node:http";
import { loadElizaConfig } from "@elizaos/agent";
import { normalizeLanguage } from "@elizaos/shared";
import { sendJson as sendJsonResponse } from "./response";

type LanguageCandidate = {
  index: number;
  q: number;
  tag: string;
};

function parseAcceptLanguage(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
  return raw
    .split(",")
    .map((part, index): LanguageCandidate | null => {
      const [tagPart, ...params] = part.trim().split(";");
      const tag = tagPart.trim();
      if (!tag) return null;
      const qParam = params
        .map((param) => param.trim())
        .find((param) => param.toLowerCase().startsWith("q="));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      if (!Number.isFinite(q) || q <= 0) return null;
      return { index, q, tag };
    })
    .filter((candidate): candidate is LanguageCandidate => candidate != null)
    .sort((left, right) => right.q - left.q || left.index - right.index)
    .map((candidate) => candidate.tag);
}

export function resolveSuggestedUiLanguage(options: {
  acceptLanguage?: string | string[];
  configuredLanguage?: unknown;
}): string {
  const configured = normalizeLanguage(options.configuredLanguage);
  if (configured !== "en") return configured;

  for (const tag of parseAcceptLanguage(options.acceptLanguage)) {
    const normalized = normalizeLanguage(tag);
    if (normalized !== "en" || tag.toLowerCase().startsWith("en")) {
      return normalized;
    }
  }

  return "en";
}

export function handleI18nLocaleRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");

  if (method !== "GET" || url.pathname !== "/api/i18n/locale") {
    return false;
  }

  let configuredLanguage: unknown;
  try {
    configuredLanguage = (loadElizaConfig() as { ui?: { language?: unknown } })
      .ui?.language;
  } catch {
    configuredLanguage = undefined;
  }

  sendJsonResponse(res, 200, {
    language: resolveSuggestedUiLanguage({
      acceptLanguage: req.headers["accept-language"],
      configuredLanguage,
    }),
  });
  return true;
}
