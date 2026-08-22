/**
 * Enforces fresh public-read evidence for mutable factual claims in Shared.
 * Classification is deterministic, while provider text remains untrusted data.
 */

import type { ActionResult } from "@elizaos/core/edge";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import type { SharedTurnMessage } from "./run-shared-agent-turn";

export type SharedRealtimeDomain =
  | "markets"
  | "weather"
  | "news"
  | "sports"
  | "mutable_fact"
  | "explicit_verification";

export interface SharedRealtimeRequirement {
  domain: SharedRealtimeDomain;
  query: string;
  correction: boolean;
}

const FRESHNESS =
  /\b(?:now|rn|right now|current|currently|today|tonight|latest|live|recent|recently|up[- ]?to[- ]?date|this (?:morning|afternoon|evening|week|month|year))\b/i;
const EXPLICIT_VERIFICATION =
  /\b(?:check|search|browse|look(?:ed)? up|verify|confirm|fact[- ]?check)(?:\s+(?:it|that|this|again|online|the))?(?:\s+(?:web|internet|source|sources|news))?\b|\b(?:source|sources|citation|citations|link|links)\??$/i;
const CORRECTION =
  /\b(?:wrong|incorrect|not right|made that up|hallucinat(?:e|ed|ion)|check again|try again|prove it|where did (?:that|you) (?:come|get) from)\b|^\s*\?+\s*$/i;
const MARKETS =
  /\b(?:price|quote|exchange rate|market cap|market price|stock|share price|crypto|cryptocurrency|bitcoin|btc|ethereum|eth|forex|bond yield|commodity|gold price|oil price)\b/i;
const WEATHER = /\b(?:weather|forecast|temperature|rain|snow|wind|air quality|uv index)\b/i;
const NEWS = /\b(?:news|headline|breaking|announcement|announced|release today|current events)\b/i;
const SPORTS = /\b(?:score|standings|fixture|match result|game result|playoffs|season record)\b/i;
const MUTABLE_FACT =
  /\b(?:president|prime minister|governor|mayor|senator|representative|ceo|chief executive|officeholder|version|release version|availability|status|outage|traffic|flight status|schedule)\b/i;

function classifyStandalone(text: string): SharedRealtimeDomain | undefined {
  if (WEATHER.test(text)) return "weather";
  if (
    MARKETS.test(text) &&
    (FRESHNESS.test(text) || /\b(?:price|quote|exchange rate)\b/i.test(text))
  ) {
    return "markets";
  }
  if (NEWS.test(text) && (FRESHNESS.test(text) || /\b(?:news|headline|breaking)\b/i.test(text))) {
    return "news";
  }
  if (
    SPORTS.test(text) &&
    (FRESHNESS.test(text) || /\b(?:score|standings|fixture)\b/i.test(text))
  ) {
    return "sports";
  }
  if (
    MUTABLE_FACT.test(text) &&
    (FRESHNESS.test(text) || /^\s*(?:who|what|when|is|are)\b/i.test(text))
  ) {
    return "mutable_fact";
  }
  if (EXPLICIT_VERIFICATION.test(text)) return "explicit_verification";
  return undefined;
}

/** Identifies current-data turns and terse corrections that inherit that need. */
export function resolveSharedRealtimeRequirement(
  message: string,
  history: readonly SharedTurnMessage[],
): SharedRealtimeRequirement | undefined {
  const normalized = message.trim();
  const direct = classifyStandalone(normalized);
  const correction = CORRECTION.test(normalized);
  if (direct && direct !== "explicit_verification") {
    return { domain: direct, query: normalized, correction };
  }
  if (!correction && !EXPLICIT_VERIFICATION.test(normalized)) return undefined;
  const prior = [...history]
    .reverse()
    .find((turn) => turn.role === "user" && classifyStandalone(turn.content));
  if (!prior) return direct ? { domain: direct, query: normalized, correction } : undefined;
  return {
    domain: classifyStandalone(prior.content) ?? "explicit_verification",
    query: `${prior.content}\n${normalized}\nVerify against current public sources.`,
    correction: true,
  };
}

function normalizedNumericTokens(value: string): Set<string> {
  return new Set(
    [...value.matchAll(/(?:[$€£¥]\s*)?\d[\d,]*(?:\.\d+)?%?/gu)].map((match) =>
      match[0].toLowerCase().replace(/[\s,]/gu, ""),
    ),
  );
}

function replyUrls(value: string): string[] {
  return [...value.matchAll(/https?:\/\/[^\s<>"'\]]+/gu)].map((match) =>
    match[0].replace(/[),.;]+$/u, ""),
  );
}

function selectedSourceUrl(
  reply: string,
  grounding: Extract<SharedRuntimePublicGrounding, { kind: "web_search" }>,
): string | undefined {
  const selected = reply.match(/\[\[SOURCE_URL:(https?:\/\/[^\]\s]+)\]\]/iu)?.[1];
  if (!selected) return undefined;
  return (grounding.sourceUrls ?? []).find(
    (allowed) => allowed === selected || allowed === `${selected}/` || `${allowed}/` === selected,
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return "public source";
  }
}

/** A successful current-data receipt must be attributable outside provider prose. */
export function hasTraceableRealtimeGrounding(
  grounding: SharedRuntimePublicGrounding | undefined,
): grounding is Extract<SharedRuntimePublicGrounding, { kind: "web_search" }> & {
  sourceUrls: [string, ...string[]];
} {
  return Boolean(
    grounding?.kind === "web_search" && grounding.sourceUrls && grounding.sourceUrls.length > 0,
  );
}

/** Converts a healthy-looking but source-free search into an explicit miss. */
export function requireTraceableRealtimeSearch(
  result: ActionResult,
  query: string,
  observedAt = Date.now(),
): ActionResult {
  const data = result.data && typeof result.data === "object" ? result.data : {};
  if (
    result.success === true &&
    Array.isArray(data.sourceUrls) &&
    data.sourceUrls.some((url) => typeof url === "string" && /^https?:\/\//u.test(url))
  ) {
    return result;
  }
  return {
    success: false,
    text: "Live public data is temporarily unavailable from a traceable source.",
    error: "Live public data is temporarily unavailable from a traceable source.",
    data: { actionName: "WEB_SEARCH", query, observedAt },
  };
}

/** Rejects new numbers, currencies, URLs, and named attributions absent from evidence. */
export function validateSharedRealtimeReply(
  reply: string,
  grounding: Extract<SharedRuntimePublicGrounding, { kind: "web_search" }>,
): boolean {
  const trimmed = reply.trim();
  if (!trimmed || /^[\s?!.,-]{1,12}$/u.test(trimmed)) return false;
  if (!selectedSourceUrl(trimmed, grounding)) return false;
  const evidenceNumbers = normalizedNumericTokens(grounding.text);
  for (const token of normalizedNumericTokens(trimmed)) {
    if (!evidenceNumbers.has(token)) return false;
  }
  const evidenceCurrencies = new Set(
    grounding.text.toUpperCase().match(/\b(?:USD|EUR|GBP|JPY|CAD|AUD|BTC|ETH)\b/gu) ?? [],
  );
  for (const currency of trimmed.toUpperCase().match(/\b(?:USD|EUR|GBP|JPY|CAD|AUD|BTC|ETH)\b/gu) ??
    []) {
    if (!evidenceCurrencies.has(currency)) return false;
  }
  const allowedUrls = new Set(grounding.sourceUrls ?? []);
  for (const url of replyUrls(trimmed)) {
    if (!allowedUrls.has(url) && !allowedUrls.has(`${url}/`)) return false;
  }
  for (const match of trimmed.matchAll(
    /\b(?:according to|reported by)\s+([^,.;\n[][^,.;\n]{0,79})/giu,
  )) {
    if (!grounding.text.toLowerCase().includes(match[1].trim().toLowerCase())) return false;
  }
  return true;
}

/** Produces Telegram-safe attribution or an honest deterministic recovery. */
export function finalizeSharedRealtimeReply(
  reply: string,
  grounding: SharedRuntimePublicGrounding | undefined,
): string {
  if (!hasTraceableRealtimeGrounding(grounding)) {
    return "I can’t verify the current value from a traceable live source right now, so I won’t guess. Please try again shortly.";
  }
  const sourceUrl = selectedSourceUrl(reply, grounding);
  if (!sourceUrl) {
    return `I found live public results, but I couldn’t safely verify a single current value from them, so I won’t guess.\n\nSource provider: ${grounding.provider} (checked ${new Date(grounding.observedAt).toISOString()})`;
  }
  const checkedAt = new Date(grounding.observedAt).toISOString();
  const source = `Source: ${hostname(sourceUrl)} — ${sourceUrl} (${grounding.provider}, checked ${checkedAt})`;
  if (!validateSharedRealtimeReply(reply, grounding)) {
    return `I found live public results, but I couldn’t safely verify a single current value from them, so I won’t guess.\n\n${source}`;
  }
  const answer = reply.replace(/\s*\[\[SOURCE_URL:https?:\/\/[^\]\s]+\]\]\s*/giu, " ").trim();
  return `${answer}\n\n${source}`;
}

/** System-only policy; the actual provider result is injected as untrusted data. */
export function sharedRealtimePromptPolicy(grounding: SharedRuntimePublicGrounding): string {
  return grounding.kind === "web_search"
    ? "Current-data grounding policy:\n- A live public read already ran for this turn. Use only its current-turn evidence for mutable factual claims.\n- Preserve its value, timestamp, units or currency, provider, and source URL. If sources conflict or omit the requested value, say so and do not guess.\n- End the draft with [[SOURCE_URL:https://exact-supporting-url]] using one URL from the supplied evidence that directly supports the claim; this marker is removed before delivery.\n- Never invent a search, article, source, attribution, or numeric value. Do not run a duplicate search unless the supplied receipt is explicitly unavailable."
    : "Current-data grounding policy:\n- The required live public read failed or had no traceable source. Say you cannot verify the current value and do not provide a number, source, article, or claimed search result.\n- Recover conversationally from corrections; never answer with punctuation alone.";
}
