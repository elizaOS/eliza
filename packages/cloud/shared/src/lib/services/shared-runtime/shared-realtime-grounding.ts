/**
 * Enforces fresh, source-bound public evidence for mutable factual claims in
 * Shared without sending private-state requests to a public search provider.
 */

import { type ActionResult, isBlockedHostname, isPrivateIpAddress } from "@elizaos/core/edge";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import type { SharedTurnMessage } from "./run-shared-agent-turn";

export type SharedRealtimeDomain = "markets" | "weather" | "news" | "sports" | "mutable_fact";

export interface SharedRealtimeRequirement {
  domain: SharedRealtimeDomain;
  query: string;
  correction: boolean;
}

type AvailableGrounding = Extract<SharedRuntimePublicGrounding, { kind: "web_search" }>;
type SourceEvidence = { url: string; text: string };

const FRESHNESS =
  /\b(?:now|rn|right now|current|currently|today|tonight|latest|live|recent|recently|up[- ]?to[- ]?date|this (?:morning|afternoon|evening|week|month|year))\b/i;
const WEB_VERIFICATION =
  /\b(?:check|search|browse|look(?:ed)? up|verify|fact[- ]?check)(?:\s+(?:it|that|this|again|online|the))?(?:\s+(?:web|internet|source|sources|news))?\b|\b(?:source|sources|citation|citations)\??$/i;
const CORRECTION =
  /\b(?:wrong|incorrect|not right|made that up|hallucinat(?:e|ed|ion)|check again|try again|prove it|where did (?:that|you) (?:come|get) from)\b|^\s*\?+\s*$/i;
const PRIVATE_STATE =
  /\b(?:my|mine|our|ours|todo|todos|reminder|reminders|calendar|schedule|meeting|meetings|order|account|email|inbox|messages|files|notes|contacts|password|passcode|secret|api[- ]?key|credential|ssn|social security|credit card|bank balance|phone number|home address|location)\b/i;
const SENSITIVE_LITERAL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d{3}[- ]\d{2}[- ]\d{4}\b/i;
const MARKETS =
  /\b(?:price|quote|exchange rate|market cap|market price|stock|share price|crypto|cryptocurrency|bitcoin|btc|ethereum|eth|forex|bond yield|commodity|gold price|oil price)\b/i;
const NEWS = /\b(?:news|headline|breaking|announcement|announced|release today|current events)\b/i;
const SPORTS = /\b(?:score|standings|fixture|match result|game result|playoffs|season record)\b/i;
const PUBLIC_MUTABLE_FACT =
  /\b(?:president|prime minister|governor|mayor|senator|representative|ceo|chief executive|officeholder|software version|release version|public outage|public traffic)\b/i;
const FACTUAL_REQUEST =
  /^\s*(?:what|what['’]?s|how|who|where|when|which|is|are|was|were|do|does|did|can|could|would|will|give me|show me|tell me|find|check|search|look up|verify|please\s+(?:find|check|search|look up|verify))\b/i;
const NON_FACTUAL_REQUEST =
  /\b(?:joke|pun|riddle|poem|fiction|fictional|role[- ]?play|imagine|make[- ]?believe|write|draft|compose|create|design|build|code|implement|edit|rewrite)\b/i;
const HISTORICAL_CONTEXT =
  /\b(?:yesterday|ago|last (?:night|week|month|year|season)|in (?:the )?past|historically|history|was|were|used to|\d{4})\b/i;
const MARKET_METRIC =
  /\b(?:price|quote|exchange rate|market cap|market price|share price|bond yield|gold price|oil price|trading at|worth)\b/i;
const MARKET_SUBJECT =
  /\b(?:stock|shares?|crypto|cryptocurrency|bitcoin|btc|ethereum|eth|forex|bond|commodity|gold|oil|currency|usd|eur|gbp|jpy|cad|aud)\b/i;
const WEATHER_TOPIC = /\b(?:weather|forecast|air quality|uv index)\b/i;
const WEATHER_CONDITION = /\b(?:temperature|rain|snow|wind)\b/i;
const WEATHER_LOCATION = /\b(?:in|at|for|near|around)\s+[\p{L}\p{N}]/iu;
const SPORTS_CONTEXT =
  /\b(?:sports?|game|match|team|league|tournament|playoffs?|season|nba|wnba|nfl|nhl|mlb|epl|ipl)\b/i;
const NAMED_TEAM_SCORE = /\b\p{Lu}[\p{L}\p{N}.'’-]*(?:\s+\p{Lu}[\p{L}\p{N}.'’-]*){0,3}\s+score\b/u;
const SOURCE_MARKER = /\[\[SOURCE_URL:(https?:\/\/[^\]\s]+)\]\]/giu;
const HTTP_URL = /https?:\/\/[^\s<>"']+/giu;
const CURRENCY = /\b(?:USD|EUR|GBP|JPY|CAD|AUD|BTC|ETH)\b/giu;
const ATTRIBUTION = /\b(?:according to|reported by)\s+([^,.;\n]{1,80})/giu;
const NEGATION =
  /\b(?:no|not|never|neither|nor|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|hasn['’]t|haven['’]t|hadn['’]t|won['’]t|wouldn['’]t|didn['’]t|doesn['’]t|don['’]t)\b/iu;
const CLAIM_STOP_WORDS = new Set([
  "a",
  "about",
  "according",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "checked",
  "currently",
  "for",
  "from",
  "had",
  "has",
  "have",
  "in",
  "into",
  "is",
  "it",
  "its",
  "latest",
  "of",
  "on",
  "or",
  "reported",
  "source",
  "that",
  "the",
  "this",
  "to",
  "today",
  "was",
  "were",
  "will",
  "with",
]);

function classifyPublicStandalone(text: string): SharedRealtimeDomain | undefined {
  if (!isSharedPublicSearchSafe(text)) return undefined;
  if (NON_FACTUAL_REQUEST.test(text) || (HISTORICAL_CONTEXT.test(text) && !FRESHNESS.test(text))) {
    return undefined;
  }
  const factualRequest = FACTUAL_REQUEST.test(text);
  if (
    (WEATHER_TOPIC.test(text) &&
      (FRESHNESS.test(text) || factualRequest || WEATHER_LOCATION.test(text))) ||
    (WEATHER_CONDITION.test(text) &&
      (FRESHNESS.test(text) || (factualRequest && WEATHER_LOCATION.test(text))))
  ) {
    return "weather";
  }
  if (
    MARKETS.test(text) &&
    MARKET_METRIC.test(text) &&
    MARKET_SUBJECT.test(text) &&
    (FRESHNESS.test(text) || factualRequest)
  ) {
    return "markets";
  }
  if (NEWS.test(text) && (FRESHNESS.test(text) || factualRequest)) {
    return "news";
  }
  if (
    SPORTS.test(text) &&
    (FRESHNESS.test(text) ||
      (factualRequest && (SPORTS_CONTEXT.test(text) || NAMED_TEAM_SCORE.test(text))))
  ) {
    return "sports";
  }
  if (PUBLIC_MUTABLE_FACT.test(text) && FRESHNESS.test(text)) return "mutable_fact";
  return undefined;
}

/** Denies Shared public-network tools when the authenticated utterance is private or sensitive. */
export function isSharedPublicSearchSafe(message: string): boolean {
  return !PRIVATE_STATE.test(message) && !SENSITIVE_LITERAL.test(message);
}

/** Identifies public current-data turns and corrections that inherit that exact public topic. */
export function resolveSharedRealtimeRequirement(
  message: string,
  history: readonly SharedTurnMessage[],
): SharedRealtimeRequirement | undefined {
  const normalized = message.trim();
  const direct = classifyPublicStandalone(normalized);
  const correction = CORRECTION.test(normalized);
  if (direct) return { domain: direct, query: normalized, correction };
  if (PRIVATE_STATE.test(normalized) || (!correction && !WEB_VERIFICATION.test(normalized))) {
    return undefined;
  }
  const prior = [...history].reverse().find((turn) => turn.role === "user");
  const priorDomain = prior ? classifyPublicStandalone(prior.content) : undefined;
  if (!prior || !priorDomain) return undefined;
  return {
    domain: priorDomain,
    query: `${prior.content}\n${normalized}\nVerify against current public sources.`,
    correction: true,
  };
}

function canonicalPublicUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      isBlockedHostname(parsed.hostname) ||
      isPrivateIpAddress(parsed.hostname)
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    // error-policy:J3 malformed source markers are rejected, never repaired.
    return undefined;
  }
}

function containsUnsafeHttpUrl(value: string): boolean {
  HTTP_URL.lastIndex = 0;
  for (const match of value.matchAll(HTTP_URL)) {
    if (!canonicalPublicUrl(match[0].replace(/[),.;]+$/u, ""))) return true;
  }
  return false;
}

function sourceEvidence(value: unknown): SourceEvidence[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const sources: SourceEvidence[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const record = item as Record<string, unknown>;
    const url = canonicalPublicUrl(record.url);
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!url || !text || containsUnsafeHttpUrl(text)) return undefined;
    sources.push({ url, text });
  }
  return sources;
}

/** Rejects incomplete, unbounded, source-free, or aggregate-only current-data receipts. */
export function requireTraceableRealtimeSearch(
  result: ActionResult,
  query: string,
  observedAt = Date.now(),
): ActionResult {
  const data = result.data && typeof result.data === "object" ? result.data : {};
  const sources = sourceEvidence(data.sources);
  const receiptObservedAt = data.observedAt;
  if (
    result.success === true &&
    data.actionName === "WEB_SEARCH" &&
    normalizedRealtimeQuery(data.query) === normalizedRealtimeQuery(query) &&
    (data.provider === "parallel" || data.provider === "exa") &&
    typeof receiptObservedAt === "number" &&
    Number.isSafeInteger(receiptObservedAt) &&
    Math.abs(receiptObservedAt - observedAt) <= 5 * 60 * 1000 &&
    data.truncated === false &&
    data.evidenceOverflowed !== true &&
    sources
  ) {
    return {
      ...result,
      data: {
        ...data,
        sourceUrls: sources.map((source) => source.url),
        sources,
      },
    };
  }
  return {
    success: false,
    text: "Live public data is temporarily unavailable from complete, source-bound evidence.",
    error: "Live public data is temporarily unavailable from complete, source-bound evidence.",
    data: { actionName: "WEB_SEARCH", query, observedAt },
  };
}

/** A successful current-data receipt must retain at least one complete source result. */
export function hasTraceableRealtimeGrounding(
  grounding: SharedRuntimePublicGrounding | undefined,
): grounding is AvailableGrounding & { sources: [SourceEvidence, ...SourceEvidence[]] } {
  return Boolean(
    grounding?.kind === "web_search" &&
      grounding.truncated === false &&
      grounding.sources &&
      grounding.sources.length > 0,
  );
}

function numericValues(value: string): number[] {
  return [...value.matchAll(/(?:[$€£¥]\s*)?(-?\d[\d,]*(?:\.\d+)?)%?/gu)]
    .map((match) => Number(match[1]?.replaceAll(",", "")))
    .filter(Number.isFinite);
}

function numericSupported(claim: number, evidence: readonly number[]): boolean {
  return evidence.some((candidate) => {
    if (claim === candidate) return true;
    if (Number.isInteger(claim) && claim >= 1900 && claim <= 2200) return false;
    if (Math.abs(candidate) < 100) return false;
    return Math.abs(claim - candidate) / Math.abs(candidate) <= 0.005;
  });
}

function replyUrls(value: string): string[] | undefined {
  const urls: string[] = [];
  for (const match of value.matchAll(/https?:\/\/[^\s<>"'\]]+/gu)) {
    const url = canonicalPublicUrl(match[0].replace(/[),.;]+$/u, ""));
    if (!url) return undefined;
    urls.push(url);
  }
  return urls;
}

function claimWords(value: string): string[] {
  return (
    value
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((word) => !/^\p{N}+$/u.test(word) && !CLAIM_STOP_WORDS.has(word)) ?? []
  );
}

function evidenceClauses(value: string): string[] {
  const strings: string[] = [];
  try {
    const pending: unknown[] = [JSON.parse(value)];
    let visited = 0;
    while (pending.length > 0 && visited < 128) {
      const item = pending.pop();
      visited += 1;
      if (Array.isArray(item)) {
        pending.push(...item);
      } else if (item && typeof item === "object") {
        const scalarValues: string[] = [];
        for (const child of Object.values(item as Record<string, unknown>)) {
          if (child && typeof child === "object") {
            pending.push(child);
          } else if (typeof child === "string") {
            if (!/^https?:\/\//iu.test(child.trim())) scalarValues.push(child);
          } else if (typeof child === "number" || typeof child === "boolean") {
            scalarValues.push(String(child));
          }
        }
        if (scalarValues.length > 0) strings.push(scalarValues.join(" "));
      } else if (typeof item === "string" && !/^https?:\/\//iu.test(item.trim())) {
        strings.push(item);
      }
    }
  } catch {
    // error-policy:J3 non-JSON evidence remains an untrusted text fragment.
    strings.push(value.replace(HTTP_URL, " "));
  }
  return strings.flatMap((item) =>
    item
      .split(/(?:[.!?]\s+|[;\n]+|\s+(?:but|whereas|while)\s+)/giu)
      .map((clause) => clause.trim())
      .filter(Boolean),
  );
}

function orderedWordsSupported(claim: readonly string[], evidence: readonly string[]): boolean {
  let cursor = 0;
  for (const word of claim) {
    const index = evidence.indexOf(word, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

function orderedNumbersSupported(claim: readonly number[], evidence: readonly number[]): boolean {
  let cursor = 0;
  for (const value of claim) {
    let matched = false;
    while (cursor < evidence.length) {
      const candidate = evidence[cursor];
      cursor += 1;
      if (numericSupported(value, [candidate])) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

function sourceForUrl(
  grounding: AvailableGrounding,
  selectedUrl: string,
): SourceEvidence | undefined {
  const canonical = canonicalPublicUrl(selectedUrl);
  if (!canonical) return undefined;
  return grounding.sources?.find((source) => canonicalPublicUrl(source.url) === canonical);
}

function claimSupported(claim: string, source: SourceEvidence): boolean {
  const normalized = claim.trim();
  if (!normalized || /^[\s?!.,-]{1,12}$/u.test(normalized)) return false;
  const urls = replyUrls(normalized);
  if (!urls) return false;
  for (const url of urls) {
    if (url !== canonicalPublicUrl(source.url)) return false;
  }
  const claimNumbers = numericValues(normalized);
  const claimCurrencies = normalized.toUpperCase().match(CURRENCY) ?? [];
  const attributions = [...normalized.matchAll(ATTRIBUTION)].map((match) =>
    match[1].trim().toLowerCase(),
  );
  const words = claimWords(normalized);
  return evidenceClauses(source.text).some((clause) => {
    if (NEGATION.test(normalized) !== NEGATION.test(clause)) return false;
    if (!orderedNumbersSupported(claimNumbers, numericValues(clause))) return false;
    const evidenceCurrencies = new Set(clause.toUpperCase().match(CURRENCY) ?? []);
    if (claimCurrencies.some((unit) => !evidenceCurrencies.has(unit))) return false;
    const lowerClause = clause.toLowerCase();
    if (attributions.some((attribution) => !lowerClause.includes(attribution))) return false;
    return orderedWordsSupported(words, claimWords(clause));
  });
}

function normalizedRealtimeQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  return normalized || undefined;
}

/** Reuses a server receipt only for its exact normalized query. */
export function createMatchingRealtimeSearchRunner(
  result: ActionResult,
): (query: string) => Promise<ActionResult> {
  const expectedQuery = normalizedRealtimeQuery(result.data?.query);
  return async (query) => {
    if (expectedQuery && normalizedRealtimeQuery(query) === expectedQuery) return result;
    return {
      success: false,
      text: "A different public search is not authorized during this grounded turn.",
      error: "A different public search is not authorized during this grounded turn.",
      data: { actionName: "WEB_SEARCH", query, observedAt: Date.now() },
    };
  };
}

/** Matches action receipts without trusting caller-controlled query formatting. */
export function isMatchingRealtimeSearchResult(result: ActionResult, query: string): boolean {
  const resultQuery = normalizedRealtimeQuery(result.data?.query);
  const expectedQuery = normalizedRealtimeQuery(query);
  return (
    result.data?.actionName === "WEB_SEARCH" &&
    resultQuery !== undefined &&
    expectedQuery !== undefined &&
    resultQuery === expectedQuery
  );
}

/** Every delivered claim segment must bind to and match one structured result. */
export function validateSharedRealtimeReply(reply: string, grounding: AvailableGrounding): boolean {
  if (!hasTraceableRealtimeGrounding(grounding)) return false;
  SOURCE_MARKER.lastIndex = 0;
  let cursor = 0;
  let count = 0;
  for (const marker of reply.matchAll(SOURCE_MARKER)) {
    const source = sourceForUrl(grounding, marker[1]);
    const claim = reply.slice(cursor, marker.index).trim();
    if (!source || !claimSupported(claim, source)) return false;
    cursor = (marker.index ?? 0) + marker[0].length;
    count += 1;
  }
  return count > 0 && reply.slice(cursor).trim().length === 0;
}

/** Produces Telegram-safe attribution or an honest deterministic recovery. */
export function finalizeSharedRealtimeReply(
  reply: string,
  grounding: SharedRuntimePublicGrounding | undefined,
): string {
  if (!hasTraceableRealtimeGrounding(grounding)) {
    return "I can’t verify the current value from a complete, traceable live source right now, so I won’t guess. Please try again shortly.";
  }
  if (!validateSharedRealtimeReply(reply, grounding)) {
    return `I found live public results, but I couldn’t safely bind the requested claim to one complete source, so I won’t guess.\n\nSource provider: ${grounding.provider} (checked ${new Date(grounding.observedAt).toISOString()})`;
  }
  SOURCE_MARKER.lastIndex = 0;
  const selectedUrls = [...reply.matchAll(SOURCE_MARKER)].map((marker) => marker[1]);
  const answer = reply.replace(SOURCE_MARKER, "").trim();
  const sources = [...new Set(selectedUrls)].map((url) => {
    const canonical = canonicalPublicUrl(url);
    if (!canonical) throw new TypeError("Validated Shared realtime source became invalid");
    return `Source: ${new URL(canonical).hostname.replace(/^www\./u, "")} — ${canonical} (${grounding.provider}, checked ${new Date(grounding.observedAt).toISOString()})`;
  });
  return `${answer}\n\n${sources.join("\n")}`;
}

/** System-only policy; actual provider results remain untrusted data messages. */
export function sharedRealtimePromptPolicy(grounding: SharedRuntimePublicGrounding): string {
  return grounding.kind === "web_search"
    ? "Current-data grounding policy:\n- A complete live public read already ran for this turn. Use only its structured current-turn source objects for mutable factual claims.\n- Keep each claim with its own source: append [[SOURCE_URL:https://exact-supporting-url]] immediately after every claim segment. Never combine a value from one result with another result’s URL.\n- Preserve the source value, timestamp, units or currency. If evidence conflicts or omits the requested value, say you cannot verify it.\n- Never invent a search, article, source, attribution, or numeric value. Do not run a duplicate search for the same query."
    : "Current-data grounding policy:\n- The required live public read failed or lacked complete source-bound evidence. Say you cannot verify the current value and do not provide a number, source, article, or claimed search result.\n- Recover conversationally from corrections; never answer with punctuation alone.";
}
