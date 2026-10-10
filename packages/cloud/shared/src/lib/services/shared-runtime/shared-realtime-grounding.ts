/**
 * Enforces fresh, source-bound public evidence for mutable factual claims in
 * Shared without sending private-state requests to a public search provider.
 */

import {
  type ActionResult,
  ElizaError,
  isBlockedHostname,
  isPrivateIpAddress,
} from "@elizaos/core";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import type { SharedTurnMessage } from "./run-shared-agent-turn";
import {
  currentNwsObservationSource,
  isCurrentWeatherUnavailableReason,
  isVerifiedCurrentNwsObservation,
  parseCurrentWeatherSourceDiagnostics,
  parseExplicitUsWeatherQuery,
} from "./shared-current-weather";
import { sharedSelectedGroundingMetadata } from "./shared-runtime-history-policy";

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
const CORRECTION =
  /\b(?:wrong|incorrect|not right|made that up|hallucinat(?:e|ed|ion)|check again|try again|prove it|where did (?:that|you) (?:come|get) from)\b|^\s*\?+\s*$/i;
const PRIVATE_STATE =
  /\b(?:my|mine|our|ours|todo|todos|reminder|reminders|calendar|schedule|meeting|meetings|order|account|email|inbox|messages|files|notes|contacts|password|passcode|secret|api[- ]?key|credential|codename|internal project|ssn|social security|credit card|bank balance|phone number|home address|location)\b/i;
const INVISIBLE_OR_CONTROL = /[\p{Cc}\p{Cf}]/u;
const SENSITIVE_LITERAL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b\d{3}[- ]\d{2}[- ]\d{4}\b/i;
const PHONE_LITERAL =
  /(?:^|[^\p{L}\p{N}])(?:(?:\+[1-9]\d{9,14})|(?:1?[2-9]\d{2}[2-9]\d{6})|(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]\d{3,4}[ .-]\d{3,4})(?:$|[^\p{L}\p{N}])/u;
const STREET_ADDRESS_LITERAL =
  /\b\d{1,6}\s+(?:[\p{L}\p{N}.'’-]+\s+){0,5}(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|parkway|pkwy|highway|hwy)\b/iu;
const COORDINATE_LITERAL =
  /(?:[+-]?\d{1,2}\.\d{3,}\s*,\s*[+-]?\d{1,3}\.\d{3,})|(?:\d{1,2}\.\d{3,}\s*[NS]\s*,?\s*\d{1,3}\.\d{3,}\s*[EW])/iu;
const NETWORK_TARGET_LITERAL =
  /(?:https?:\/\/[^\s<>'"]+)|(?:\blocalhost\b)|(?:\b(?:\d{1,3}\.){3}\d{1,3}\b)|(?:\[[0-9a-f:]+\])|(?:\b[0-9a-f]{0,4}:[0-9a-f:]+\b)|(?:\b(?:[a-z0-9-]+\.)+[a-z]{2,63}\b)/iu;
const MARKETS =
  /\b(?:price|quote|exchange rate|market cap|market price|stock|share price|crypto|cryptocurrency|bitcoin|btc|ethereum|eth|forex|bond yield|commodity|gold price|oil price)\b/i;
const NEWS =
  /\b(?:news|headlines?|breaking|announcement|announced|release today|current events)\b/i;
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
const PUBLIC_MARKET_SUBJECT =
  /\b(?:bitcoin|btc|ethereum|eth|gold|oil|usd|eur|gbp|jpy|cad|aud)\b/giu;
const WEATHER_TOPIC = /\b(?:weather|forecast|air quality|uv index)\b/i;
const WEATHER_CONDITION = /\b(?:temperature|rain|snow|wind)\b/i;
const WEATHER_LOCATION = /\b(?:in|at|for|near|around)\s+[\p{L}\p{N}]/iu;
const SPORTS_CONTEXT =
  /\b(?:sports?|game|match|team|league|tournament|playoffs?|season|nba|wnba|nfl|nhl|mlb|epl|ipl)\b/i;
const NAMED_TEAM_SCORE = /\b\p{Lu}[\p{L}\p{N}.'’-]*(?:\s+\p{Lu}[\p{L}\p{N}.'’-]*){0,3}\s+score\b/u;
const SOURCE_MARKER = /\[\[SOURCE_URL:(https?:\/\/[^\]\s]+)\]\]/giu;
const HTTP_URL = /https?:\/\/[^\s<>"']+/giu;
const CLAIM_UNIT =
  /(?:[$€£¥%])|°\s*[CF]\b|\b(?:USD|EUR|GBP|JPY|CAD|AUD|BTC|ETH|dollars?|euros?|pounds?|yen|percent(?:age)?|celsius|fahrenheit|kelvin|mph|kph|km\/h|m\/s|mm|cm|km|meters?|metres?|miles?|feet|ft|inches?|degrees?)\b/giu;
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

function classifyPublicIntent(text: string): SharedRealtimeDomain | undefined {
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

function classifyPublicStandalone(text: string): SharedRealtimeDomain | undefined {
  return isSharedPublicSearchSafe(text) ? classifyPublicIntent(text) : undefined;
}

/** All literal/control/network guards remain independent of product or private-tool intent. */
function isSharedPublicSearchLiteralSafe(message: string): boolean {
  if (INVISIBLE_OR_CONTROL.test(message)) return false;
  const normalized = message.normalize("NFKC");
  const networkLiteral = normalized.match(NETWORK_TARGET_LITERAL)?.[0];
  if (networkLiteral) {
    const hostname = networkLiteral
      .replace(/^https?:\/\//iu, "")
      .replace(/^\[/u, "")
      .split(/[\]/?#]/u)[0]
      .split(":")[0];
    if (isBlockedHostname(hostname) || isPrivateIpAddress(hostname)) return false;
    return false;
  }
  return (
    !SENSITIVE_LITERAL.test(normalized) &&
    !PHONE_LITERAL.test(normalized) &&
    !STREET_ADDRESS_LITERAL.test(normalized) &&
    !COORDINATE_LITERAL.test(normalized)
  );
}

/** Complete public product topic from this utterance only; private/mixed intent wins. */
export function sharedPublicGoogleProductQuery(message: string): string | undefined {
  const text = message.normalize("NFKC").trim();
  if (!isSharedPublicSearchLiteralSafe(text) || !/\b(?:gmail|google calendar)\b/iu.test(text))
    return undefined;
  const rest = text.replace(/\b(?:gmail|google calendar)\b/giu, "");
  if (
    PRIVATE_STATE.test(rest) ||
    /\b(?:your|their|his|her)\b/iu.test(rest) ||
    /(?:\band\b|\bthen\b|[;.!?])\s*(?:connect|link|send|manage|update|delete|cancel|create|book|schedule|move|reschedule)\b/iu.test(
      rest,
    )
  )
    return undefined;
  // A provider-directed inbox/account operation is not a public documentation query.
  if (
    /\b(?:connect|link)\s+(?:gmail|google calendar)\b/iu.test(text) ||
    /\b(?:read|search|find|check|show|list|summari[sz]e)\s+(?:gmail|google calendar)\s+(?:for|in|inbox|mail|emails?|messages?|events?)\b/iu.test(
      text,
    )
  )
    return undefined;
  const explicitWeb =
    /\b(?:search|find|look up|check|read)\b[^.!?]{0,60}\b(?:web|internet|online)\b/iu.test(text);
  const publicProductTopic =
    /\b(?:api|docs?|documentation|sdk|pricing|prices?|help|support|tutorials?|features?|limits?|quotas?|reviews?|news)\b/iu.test(
      text,
    );
  if (!explicitWeb && !publicProductTopic) return undefined;
  const topic = (text.match(EXPLICIT_PUBLIC_SEARCH)?.[1] ?? text)
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();
  // Intent classification must not call the public guard that calls this classifier.
  return checkPublicSearchTopicSize(topic);
}

/** One private-Google recognizer shared by registration and public-network admission. */
export function isSharedPrivateGoogleContextRequest(message: string): boolean {
  const text = message.normalize("NFKC").trim();
  if (sharedPublicGoogleProductQuery(text)) return false;
  return (
    /\b(?:connect|link|read|search|find|check|show|list|summari[sz]e)\b[^.!?]{0,80}\b(?:gmail|google calendar)\b/iu.test(
      text,
    ) ||
    /\b(?:what|when|which|read|search|find|check|show|list|summari[sz]e)\b[^.!?]{0,60}\bmy (?:[\p{L}\p{N}]+ ){0,3}(?:inbox|mail|emails?|calendar)\b/iu.test(
      text,
    )
  );
}

/** Denies private/sensitive material; the product exception changes no literal/network guard. */
export function isSharedPublicSearchSafe(message: string): boolean {
  const normalized = message.normalize("NFKC");
  return (
    isSharedPublicSearchLiteralSafe(normalized) &&
    !isSharedPrivateGoogleContextRequest(normalized) &&
    (!PRIVATE_STATE.test(normalized) || Boolean(sharedPublicGoogleProductQuery(normalized)))
  );
}

function publicSubjectWords(value: string | undefined): string | undefined {
  const words =
    value
      ?.trim()
      .split(/\s+/u)
      .filter(
        (word) => !/^(?:now|today|tonight|currently|current|latest|please|public)$/iu.test(word),
      ) ?? [];
  if (words.length === 0 || words.length > 4) return undefined;
  const subject = words.join(" ");
  return /^[\p{L}\p{N}.'’&-]+(?:\s+[\p{L}\p{N}.'’&-]+){0,3}$/u.test(subject) ? subject : undefined;
}

/** Keep an explicit public city/region together while excluding follow-on instructions. */
function publicWeatherLocation(value: string | undefined): string | undefined {
  if (!value || value.length > 240) return undefined;
  // A period ends the location sentence, except common place-name abbreviations.
  const sentence = value.split(/(?<!\bSt)(?<!\bMt)\.(?:\s|$)/iu, 1)[0];
  const location = sentence
    .split(/(?:\s+and)?\s+(?=(?:include|provide|return|answer|respond)\b|text\s+only\b)/iu, 1)[0]
    .trim();
  if (!location || location.length > 80) return undefined;
  const parts = location.split(",");
  if (parts.length > 3) return undefined;
  const normalized = parts.map(publicSubjectWords);
  if (normalized.some((part) => !part)) return undefined;
  return normalized.join(", ");
}

function publicProviderQuery(domain: SharedRealtimeDomain, text: string): string | undefined {
  if (domain === "markets") {
    const recognized = [
      ...new Set(text.match(PUBLIC_MARKET_SUBJECT)?.map((value) => value.toUpperCase()) ?? []),
    ];
    const adjacent = publicSubjectWords(
      text.match(
        /\b([\p{Lu}][\p{L}\p{N}.'’&-]*(?:\s+[\p{Lu}][\p{L}\p{N}.'’&-]*){0,3})\s+(?:stock|shares?|share price|stock price)\b/u,
      )?.[1] ?? text.match(/\b(?:price|quote)\s+(?:of|for)\s+([^,;?!\n]{1,60})/iu)?.[1],
    );
    if (adjacent) return `${adjacent} stock price current`;
    if (recognized.length === 0) return undefined;
    const metric = text.match(MARKET_METRIC)?.[0]?.toLocaleLowerCase("en-US") ?? "price";
    return `${recognized.join(" ")} ${metric} current`;
  }
  if (domain === "weather") {
    const location = publicWeatherLocation(
      text.match(
        /\b(?:weather|forecast|temperature|rain|snow|wind)\b[^,;\n]*?\b(?:in|at|for|near|around)\s+([^;?!\n]{1,240})(?=[;?!\n]|$)/iu,
      )?.[1],
    );
    return location ? `current public weather in ${location}` : undefined;
  }
  if (domain === "news") {
    const before = text.match(
      /\b(?:latest|current|breaking)\s+([^;?!\n]+?)\s+(?:news|headlines?)\b/iu,
    )?.[1];
    const after = text.match(
      /\b(?:news|headlines?)\s+(?:about|on|for)\s+([^;?!\n]+)(?=[;?!\n]|$)/iu,
    )?.[1];
    const rawSubject = before ?? after;
    const subject = boundedPublicSearchTopic(rawSubject);
    if (rawSubject !== undefined && !subject) return undefined;
    const query = subject ? `latest public ${subject} news` : "latest public news";
    return boundedPublicSearchTopic(query);
  }
  if (domain === "sports") {
    const league = text.match(/\b(?:NBA|WNBA|NFL|NHL|MLB|EPL|IPL)\b/iu)?.[0]?.toUpperCase();
    const team = publicSubjectWords(
      text.match(/\bcurrent public sports\s+([^,;?!\n]{1,60})/iu)?.[1] ??
        text.match(
          /\b([\p{Lu}][\p{L}\p{N}.'’&-]*(?:\s+[\p{Lu}][\p{L}\p{N}.'’&-]*){0,3})\s+(?:score|standings|fixture|record)\b/u,
        )?.[1],
    );
    const subject = league ?? team;
    return subject ? `current public sports ${subject}` : undefined;
  }
  const role = text.match(PUBLIC_MUTABLE_FACT)?.[0]?.toLocaleLowerCase("en-US");
  const entity = publicSubjectWords(
    text.match(
      /\b(?:president|prime minister|governor|mayor|senator|representative|ceo|chief executive|officeholder|software version|release version)\b\s+(?:of|for)\s+([^,;?!\n]{1,80})/iu,
    )?.[1],
  );
  return role && entity ? `current public ${role} of ${entity}` : undefined;
}

/** Freshness preflight is an optimization; it is not the entire public-search capability. */
export type SharedPublicSearchIntent =
  | { kind: "prefetched"; requirement: SharedRealtimeRequirement }
  | { kind: "general"; topic: string };
const EXPLICIT_PUBLIC_SEARCH =
  /^\s*(?:(?:please|can you|could you|would you)\s+)?(?:search(?:\s+(?:the\s+)?(?:web|internet|online))?(?:\s+for)?|look\s+up|find(?:\s+me)?)\s+(.+)$/iu;
const GENERAL_PUBLIC_RESEARCH =
  /\b(?:research|papers?|studies|documentation|reviews?|recommendations?|best|compare|comparison|products?|prices?|versions?|models?|context limits?|benchmarks?)\b/iu;
function checkPublicSearchTopicSize(topic: string | undefined): string | undefined {
  if (!topic) return undefined;
  if ([...topic].length > 2048) {
    throw new ElizaError("Public search topics must not exceed 2048 characters", {
      code: "PUBLIC_SEARCH_QUERY_TOO_LARGE",
    });
  }
  return topic;
}
function boundedPublicSearchTopic(value: string | undefined): string | undefined {
  const topic = value
    ?.trim()
    .replace(/[.!?]+$/u, "")
    .trim()
    .replace(/\s+/gu, " ");
  return topic && isSharedPublicSearchSafe(topic) ? checkPublicSearchTopicSize(topic) : undefined;
}
/** Authority comes only from a standalone authenticated public utterance, never history text. */
export function resolveSharedPublicSearchIntent(
  message: string,
  history: readonly SharedTurnMessage[],
): SharedPublicSearchIntent | undefined {
  const normalized = message.normalize("NFKC").trim();
  if (!isSharedPublicSearchSafe(normalized)) return undefined;
  const googlePublicTopic = sharedPublicGoogleProductQuery(normalized);
  if (googlePublicTopic) return { kind: "general", topic: googlePublicTopic };
  const requirement = resolveSharedRealtimeRequirement(normalized, history);
  if (requirement) return { kind: "prefetched", requirement };
  // Preserve unsupported/missing-location current-data gates instead of broadening them.
  if (classifyPublicIntent(normalized)) return undefined;
  const explicitTopic = normalized.match(EXPLICIT_PUBLIC_SEARCH)?.[1];
  if (
    !explicitTopic &&
    (!FACTUAL_REQUEST.test(normalized) ||
      NON_FACTUAL_REQUEST.test(normalized) ||
      (!FRESHNESS.test(normalized) && !GENERAL_PUBLIC_RESEARCH.test(normalized)))
  )
    return undefined;
  const topic = boundedPublicSearchTopic(explicitTopic ?? normalized.replace(/[?!]+$/u, ""));
  // A bare reference cannot authorize a history-derived public query.
  if (
    !topic ||
    /^(?:(?:it|that|this|those|these|above|earlier|previous|same|thing|things|stuff|for|the|a|an|please|again|more)\s*)+$/iu.test(
      topic,
    )
  )
    return undefined;
  return { kind: "general", topic };
}

/** Detects mutable-public intent without granting provider-dispatch authority. */
export function hasSharedRealtimeIntent(
  message: string,
  history: readonly SharedTurnMessage[],
): boolean {
  const normalized = message.normalize("NFKC").trim();
  return Boolean(
    (isSharedPublicSearchSafe(normalized) && sharedPublicGoogleProductQuery(normalized)) ||
      classifyPublicIntent(normalized) ||
      sharedSelectedGroundingMetadata(history, normalized),
  );
}

/** Identifies current public data solely from this authenticated raw utterance. */
export function resolveSharedRealtimeRequirement(
  message: string,
  history: readonly SharedTurnMessage[],
): SharedRealtimeRequirement | undefined {
  const normalized = message.normalize("NFKC").trim();
  if (!isSharedPublicSearchSafe(normalized)) return undefined;
  // Public Google product queries use the canonical complete-topic general path.
  if (sharedPublicGoogleProductQuery(normalized)) return undefined;
  const direct = classifyPublicStandalone(normalized);
  const correction = CORRECTION.test(normalized);
  if (direct) {
    const query = publicProviderQuery(direct, normalized);
    return query ? { domain: direct, query, correction } : undefined;
  }
  const selected = sharedSelectedGroundingMetadata(history, normalized);
  const priorQuery = selected?.query.normalize("NFKC").trim();
  const priorDomain = priorQuery ? classifyPublicStandalone(priorQuery) : undefined;
  if (!selected || !priorDomain) return undefined;
  const query = publicProviderQuery(priorDomain, priorQuery ?? "");
  if (!query) return undefined;
  return {
    domain: priorDomain,
    query,
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
  domain?: SharedRealtimeDomain,
): ActionResult {
  const data = result.data && typeof result.data === "object" ? result.data : {};
  const sources = sourceEvidence(data.sources);
  const receiptObservedAt = data.observedAt;
  const sourceDiagnostics = parseCurrentWeatherSourceDiagnostics(data.sourceDiagnostics);
  const weather =
    (domain === "weather" || query.startsWith("current public weather in ")) &&
    parseExplicitUsWeatherQuery(query) !== undefined;
  const nws =
    data.provider === "nws" &&
    isVerifiedCurrentNwsObservation(data.weatherObservation, query, observedAt) &&
    sources?.length === 1 &&
    sources[0].url === data.weatherObservation.sourceUrl &&
    sources[0].text === currentNwsObservationSource(data.weatherObservation).text;
  if (
    result.success === true &&
    data.actionName === "WEB_SEARCH" &&
    normalizedRealtimeQuery(data.query) === normalizedRealtimeQuery(query) &&
    (weather ? nws : data.provider === "parallel") &&
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
    data: {
      actionName: "WEB_SEARCH",
      query,
      observedAt,
      ...(sourceDiagnostics ? { sourceDiagnostics } : {}),
      ...(isCurrentWeatherUnavailableReason(data.unavailableReason)
        ? { unavailableReason: data.unavailableReason }
        : weather
          ? { unavailableReason: "CURRENT_WEATHER_RECEIPT_UNTRACEABLE" }
          : {}),
    },
  };
}

/** A successful current-data receipt must retain at least one complete source result. */
export function hasTraceableRealtimeGrounding(
  grounding: SharedRuntimePublicGrounding | undefined,
): grounding is AvailableGrounding & {
  sources: [SourceEvidence, ...SourceEvidence[]];
} {
  return Boolean(
    grounding?.kind === "web_search" &&
      grounding.truncated === false &&
      (grounding.provider !== "nws" ||
        isVerifiedCurrentNwsObservation(grounding.weatherObservation, grounding.query)) &&
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

function canonicalClaimUnit(unit: string): string {
  const normalized = unit.toLocaleLowerCase("en-US");
  if (normalized === "$" || /^usd|dollars?$/u.test(normalized)) return "currency:usd";
  if (normalized === "€" || /^eur|euros?$/u.test(normalized)) return "currency:eur";
  if (normalized === "£" || /^gbp|pounds?$/u.test(normalized)) return "currency:gbp";
  if (normalized === "¥" || /^jpy|yen$/u.test(normalized)) return "currency:jpy";
  if (normalized === "cad" || normalized === "aud") return `currency:${normalized}`;
  if (normalized === "btc" || normalized === "eth") return `asset:${normalized}`;
  if (normalized === "%" || /^percent(?:age)?$/u.test(normalized)) return "ratio:percent";
  if (/^(?:celsius|°\s*c)$/u.test(normalized)) return "temperature:celsius";
  if (/^(?:fahrenheit|°\s*f)$/u.test(normalized)) return "temperature:fahrenheit";
  if (/^kelvin$/u.test(normalized)) return "temperature:kelvin";
  if (/^degrees?$/u.test(normalized)) return "temperature:degree-unspecified";
  if (normalized === "mph") return "speed:mph";
  if (normalized === "kph" || normalized === "km/h") return "speed:kph";
  if (normalized === "m/s") return "speed:mps";
  if (normalized === "mm") return "length:mm";
  if (normalized === "cm") return "length:cm";
  if (normalized === "km") return "length:km";
  if (/^met(?:er|re)s?$/u.test(normalized)) return "length:m";
  if (/^miles?$/u.test(normalized)) return "length:mile";
  if (normalized === "ft" || normalized === "feet") return "length:ft";
  if (/^inches?$/u.test(normalized)) return "length:inch";
  return `unit:${normalized}`;
}

function claimUnits(value: string): string[] {
  return value.match(CLAIM_UNIT)?.map(canonicalClaimUnit) ?? [];
}

type NumericUnitTuple = { value: number; unit: string };

function numericUnitTuples(value: string): NumericUnitTuple[] {
  const unit =
    "[$€£¥%]|°\\s*[CF]\\b|USD|EUR|GBP|JPY|CAD|AUD|BTC|ETH|dollars?|euros?|pounds?|yen|percent(?:age)?|celsius|fahrenheit|kelvin|mph|kph|km\\/h|m\\/s|mm|cm|km|meters?|metres?|miles?|feet|ft|inches?|degrees?";
  const pattern = new RegExp(
    `(?:(${unit})\\s*)?(-?\\d[\\d,]*(?:\\.\\d+)?)(?:\\s*(${unit}))?`,
    "giu",
  );
  const tuples: NumericUnitTuple[] = [];
  for (const match of value.matchAll(pattern)) {
    const rawUnit = match[1] ?? match[3];
    const parsed = Number(match[2]?.replaceAll(",", ""));
    if (rawUnit && Number.isFinite(parsed)) {
      tuples.push({ value: parsed, unit: canonicalClaimUnit(rawUnit) });
    }
  }
  return tuples;
}

function orderedNumericUnitsSupported(
  claims: readonly NumericUnitTuple[],
  evidence: readonly NumericUnitTuple[],
): boolean {
  let cursor = 0;
  for (const claim of claims) {
    let matched = false;
    while (cursor < evidence.length) {
      const candidate = evidence[cursor];
      cursor += 1;
      if (candidate.unit === claim.unit && numericSupported(claim.value, [candidate.value])) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

function claimWords(value: string): string[] {
  return (
    value
      .replace(CLAIM_UNIT, " ")
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

export interface SharedRealtimeBindingDiagnostic {
  reason: "marker_missing" | "source_not_in_receipt" | "claim_not_supported";
  markerCount: number;
  knownSourceMarkerCount: number;
  /** Bits: negation1, numbers2, numericUnits4, units8, attribution16, words32, url64, empty128. */
  failedPredicateMask: number;
}

function claimSupported(
  claim: string,
  source: SourceEvidence,
  diagnostic?: { failedPredicateMask: number },
): boolean {
  const normalized = claim.trim();
  if (!normalized || /^[\s?!.,-]{1,12}$/u.test(normalized)) {
    if (diagnostic) diagnostic.failedPredicateMask |= 128;
    return false;
  }
  const urls = replyUrls(normalized);
  if (!urls) {
    if (diagnostic) diagnostic.failedPredicateMask |= 64;
    return false;
  }
  for (const url of urls) {
    if (url !== canonicalPublicUrl(source.url)) {
      if (diagnostic) diagnostic.failedPredicateMask |= 64;
      return false;
    }
  }
  const claimNumbers = numericValues(normalized);
  const units = claimUnits(normalized);
  const numericUnits = numericUnitTuples(normalized);
  const attributions = [...normalized.matchAll(ATTRIBUTION)].map((match) =>
    match[1].trim().toLowerCase(),
  );
  const words = claimWords(normalized);
  return evidenceClauses(source.text).some((clause) => {
    if (NEGATION.test(normalized) !== NEGATION.test(clause)) {
      if (diagnostic) diagnostic.failedPredicateMask |= 1;
      return false;
    }
    if (!orderedNumbersSupported(claimNumbers, numericValues(clause))) {
      if (diagnostic) diagnostic.failedPredicateMask |= 2;
      return false;
    }
    if (!orderedNumericUnitsSupported(numericUnits, numericUnitTuples(clause))) {
      if (diagnostic) diagnostic.failedPredicateMask |= 4;
      return false;
    }
    const evidenceUnits = new Set(claimUnits(clause));
    if (units.some((unit) => !evidenceUnits.has(unit))) {
      if (diagnostic) diagnostic.failedPredicateMask |= 8;
      return false;
    }
    const lowerClause = clause.toLowerCase();
    if (attributions.some((attribution) => !lowerClause.includes(attribution))) {
      if (diagnostic) diagnostic.failedPredicateMask |= 16;
      return false;
    }
    const supported = orderedWordsSupported(words, claimWords(clause));
    if (!supported && diagnostic) diagnostic.failedPredicateMask |= 32;
    return supported;
  });
}

export function normalizedRealtimeQuery(value: unknown): string | undefined {
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

function supportedRealtimeReply(
  reply: string,
  grounding: AvailableGrounding,
  onRefusal?: (diagnostic: SharedRealtimeBindingDiagnostic) => void,
): { reply: string; selectedUrls: string[]; omittedUnsupported: boolean } | undefined {
  if (!hasTraceableRealtimeGrounding(grounding)) return undefined;
  SOURCE_MARKER.lastIndex = 0;
  let cursor = 0;
  let omittedUnsupported = false;
  const diagnostic = {
    markerCount: 0,
    knownSourceMarkerCount: 0,
    failedPredicateMask: 0,
  };
  const segments: string[] = [];
  const selectedUrls: string[] = [];
  for (const marker of reply.matchAll(SOURCE_MARKER)) {
    diagnostic.markerCount = Math.min(1000, diagnostic.markerCount + 1);
    const source = sourceForUrl(grounding, marker[1]);
    if (source) {
      diagnostic.knownSourceMarkerCount = Math.min(1000, diagnostic.knownSourceMarkerCount + 1);
    }
    const claim = reply.slice(cursor, marker.index).trim();
    if (source && claimSupported(claim, source, diagnostic)) {
      segments.push(claim);
      selectedUrls.push(marker[1]);
    } else {
      omittedUnsupported = true;
    }
    cursor = (marker.index ?? 0) + marker[0].length;
  }
  if (reply.slice(cursor).trim()) omittedUnsupported = true;
  if (segments.length === 0 && onRefusal) {
    try {
      onRefusal({
        ...diagnostic,
        reason:
          diagnostic.markerCount === 0
            ? "marker_missing"
            : diagnostic.knownSourceMarkerCount === 0
              ? "source_not_in_receipt"
              : "claim_not_supported",
      });
    } catch {
      // Diagnostic delivery must not change the existing refusal outcome.
    }
  }
  return segments.length > 0
    ? { reply: segments.join("\n"), selectedUrls, omittedUnsupported }
    : undefined;
}

/** Produces Telegram-safe attribution or an honest deterministic recovery. */
export function finalizeSharedRealtimeReply(
  reply: string,
  grounding: SharedRuntimePublicGrounding | undefined,
  onRefusal?: (diagnostic: SharedRealtimeBindingDiagnostic) => void,
): string {
  if (!hasTraceableRealtimeGrounding(grounding)) {
    return "I can’t verify the current value from a complete, traceable live source right now, so I won’t guess. Please try again shortly.";
  }
  const supported = supportedRealtimeReply(reply, grounding, onRefusal);
  if (!supported) {
    return `I found live public results, but I couldn’t safely bind the requested claim to one complete source, so I won’t guess.\n\nSource provider: ${grounding.provider} (checked ${new Date(grounding.observedAt).toISOString()})`;
  }
  const sources = [...new Set(supported.selectedUrls)].map((url) => {
    const canonical = canonicalPublicUrl(url);
    if (!canonical) throw new TypeError("Validated Shared realtime source became invalid");
    const observed =
      grounding.provider === "nws" && grounding.weatherObservation
        ? `, observation ${grounding.weatherObservation.timestamp}`
        : "";
    return `Source: ${new URL(canonical).hostname.replace(/^www\./u, "")} — ${canonical} (${grounding.provider}${observed}, checked ${new Date(grounding.observedAt).toISOString()})`;
  });
  const omission = supported.omittedUnsupported
    ? "\n\nI left out part of the draft because it was not supported by the live source."
    : "";
  return `${supported.reply}${omission}\n\n${sources.join("\n")}`;
}

/** System-only policy; actual provider results remain untrusted data messages. */
export function sharedRealtimePromptPolicy(
  grounding: SharedRuntimePublicGrounding | undefined,
): string {
  if (!grounding) {
    return "Public-search grounding policy:\n- WEB_SEARCH is available for this turn; do not claim a search has run until its action result confirms success.\n- After a successful search, use only its structured current-turn source objects for public factual claims. Append [[SOURCE_URL:https://exact-supporting-url]] immediately after every supported claim segment, using the exact URL from that result. Never combine a claim from one result with another result's URL.\n- If the action fails or the sources do not support the requested answer, say what you could not verify. Never invent a search, article, attribution, numeric value, or source. Do not repeat the same completed query.";
  }
  return grounding.kind === "web_search"
    ? "Current-data grounding policy:\n- A complete live public read already ran for this turn. Use only its structured current-turn source objects for mutable factual claims.\n- Keep each claim with its own source: append [[SOURCE_URL:https://exact-supporting-url]] immediately after every claim segment. Never combine a value from one result with another result’s URL.\n- Preserve the source value, timestamp, units or currency. If evidence conflicts or omits the requested value, say you cannot verify it.\n- Never invent a search, article, source, attribution, or numeric value. Do not run a duplicate search for the same query."
    : "Current-data grounding policy:\n- The required live public read failed or lacked complete source-bound evidence. Say you cannot verify the current value and do not provide a number, source, article, or claimed search result.\n- Recover conversationally from corrections; never answer with punctuation alone.";
}
