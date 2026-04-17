import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  ModelType,
  parseJSONObjectFromText,
  parseKeyValueXml,
} from "@elizaos/core";
import type {
  CreateLifeOpsCalendarEventAttendee,
  CreateLifeOpsCalendarEventRequest,
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
} from "@elizaos/shared/contracts/lifeops";
import {
  getValidationKeywordTerms,
  textIncludesKeywordTerm,
} from "@elizaos/shared/validation-keywords";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getWeekdayForLocalDate,
  getZonedDateParts,
} from "../lifeops/time.js";
import {
  collectKeywordTermMatchesForKey,
  hasContextSignalSyncForKey,
} from "@elizaos/agent/actions/context-signal";
import { renderGroundedActionReply } from "@elizaos/agent/actions/grounded-action-reply";
import { recentConversationTexts as collectRecentConversationTexts } from "./life-recent-context.js";
import {
  calendarReadUnavailableMessage,
  calendarWriteUnavailableMessage,
  detailArray,
  detailBoolean,
  detailNumber,
  detailString,
  formatCalendarEventDateTime,
  formatCalendarFeed,
  formatNextEventContext,
  getGoogleCapabilityStatus,
  hasLifeOpsAccess,
  INTERNAL_URL,
  messageText,
  toActionData,
} from "./lifeops-google-helpers.js";

type CalendarSubaction =
  | "feed"
  | "next_event"
  | "search_events"
  | "create_event"
  | "update_event"
  | "delete_event"
  | "trip_window";

type TripWindowIntent = {
  location: string;
};

type RankedCalendarSearchCandidate = {
  event: LifeOpsCalendarEvent;
  score: number;
  matchedQueries: string[];
};

type CreateEventCalendarContext = {
  calendarTimeZone: string;
  feed: LifeOpsCalendarFeed;
};

export type CalendarLlmPlan = {
  subaction: CalendarSubaction | null;
  queries: string[];
  response?: string;
  shouldAct?: boolean | null;
  title?: string;
  tripLocation?: string;
  timeMin?: string;
  timeMax?: string;
  windowLabel?: string;
};

const MIN_CREATE_EVENT_DURATION_MINUTES = 15;

type CalendarActionParams = {
  subaction?: CalendarSubaction;
  intent?: string;
  title?: string;
  query?: string;
  queries?: string[];
  details?: Record<string, unknown>;
};

const CALENDAR_VALIDATION_CONTEXT_LIMIT = 12;
const PARAMETER_DOC_NOISE_PATTERN =
  /\b(?:actions?|params?|parameters?|query\?:string|subaction\?:string|details\?:object|required parameter|supported keys include|may include:|match against titles|structured calendar arguments|structured data when needed|boolean when)\b|\b\w+\?:\w+\b/i;

const CAL_I18N_OPTS = { includeAllLocales: true } as const;
const CAL_AFFIRMATIVE_TERMS = getValidationKeywordTerms(
  "contextSignal.affirmative.strong",
  CAL_I18N_OPTS,
);
const CAL_TEMPORAL_FOLLOWUP_TERMS = getValidationKeywordTerms(
  "contextSignal.temporal_followup.strong",
  CAL_I18N_OPTS,
);
const CAL_LIFEOPS_STRONG_TERMS = getValidationKeywordTerms(
  "contextSignal.lifeops.strong",
  CAL_I18N_OPTS,
);
const CAL_CALENDAR_STRONG_TERMS = getValidationKeywordTerms(
  "contextSignal.calendar.strong",
  CAL_I18N_OPTS,
);
const CAL_CALENDAR_WEAK_TERMS = getValidationKeywordTerms(
  "contextSignal.calendar.weak",
  CAL_I18N_OPTS,
);

function textMatchesAnyCal(text: string, terms: readonly string[]): boolean {
  return terms.some((term) => textIncludesKeywordTerm(text, term));
}

const I18N_LOCALES = ["en", "zh-CN", "ko", "es", "pt", "vi", "tl"];

function buildIntlMonthMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const locale of I18N_LOCALES) {
    for (let month = 0; month < 12; month++) {
      const date = new Date(2024, month, 15);
      for (const style of ["long", "short"] as const) {
        const name = new Intl.DateTimeFormat(locale, { month: style })
          .format(date)
          .toLowerCase()
          .replace(/\.$/, "");
        if (name.length > 0) map[name] = month + 1;
      }
    }
  }
  return map;
}

function buildIntlWeekdayMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const locale of I18N_LOCALES) {
    for (let dow = 0; dow < 7; dow++) {
      const date = new Date(2024, 0, 7 + dow);
      for (const style of ["long", "short"] as const) {
        const name = new Intl.DateTimeFormat(locale, { weekday: style })
          .format(date)
          .toLowerCase()
          .replace(/\.$/, "");
        if (name.length > 0) map[name] = dow;
      }
    }
  }
  return map;
}

const MONTH_MAP: Record<string, number> = buildIntlMonthMap();
const WEEKDAY_MAP: Record<string, number> = buildIntlWeekdayMap();

const MONTH_NAMES_SORTED = Object.keys(MONTH_MAP).sort(
  (a, b) => b.length - a.length,
);
const MONTH_NAME_PATTERN = new RegExp(
  `\\b(${MONTH_NAMES_SORTED.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  "i",
);

const WEEKDAY_NAMES_SORTED = Object.keys(WEEKDAY_MAP).sort(
  (a, b) => b.length - a.length,
);
const WEEKDAY_NAME_PATTERN = new RegExp(
  `\\b(?:(this|next)\\s+)?(${WEEKDAY_NAMES_SORTED.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "i",
);
const CALENDAR_DETAIL_ALIASES = {
  calendarId: ["calendarid", "calendar_id"],
  timeMin: ["timemin", "time_min"],
  timeMax: ["timemax", "time_max"],
  timeZone: ["timezone", "time_zone"],
  forceSync: ["forcesync", "force_sync"],
  windowDays: ["windowdays", "window_days"],
  startAt: ["startat", "start_at"],
  endAt: ["endat", "end_at"],
  durationMinutes: ["durationminutes", "duration_minutes"],
  windowPreset: ["windowpreset", "window_preset"],
  eventId: [
    "eventid",
    "event_id",
    "externaleventid",
    "external_event_id",
    "googleeventid",
    "google_event_id",
  ],
  newTitle: ["newtitle", "new_title", "renameto", "rename_to"],
  description: ["desc", "summary", "body"],
  location: ["place", "venue"],
} as const;

function normalizeCalendarSubaction(value: unknown): CalendarSubaction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "feed":
    case "next_event":
    case "search_events":
    case "create_event":
    case "update_event":
    case "delete_event":
    case "trip_window":
      return normalized;
    default:
      return null;
  }
}

function normalizeShouldAct(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function normalizePlannerResponse(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildCalendarReplyOnlyFallback(
  subaction: CalendarSubaction | null,
): string {
  switch (subaction) {
    case "create_event":
      return "What event do you want to add, and when should it happen?";
    case "search_events":
    case "trip_window":
      return "What calendar event or trip do you want me to look up?";
    case "next_event":
    case "feed":
      return "Do you want today's schedule, your next event, or a specific event?";
    case "update_event":
      return "Which calendar event do you want to change, and what should change?";
    case "delete_event":
      return "Which calendar event do you want to delete?";
    default:
      return "What do you want to do on your calendar — check your schedule, find an event, or create one?";
  }
}

function looksLikeLifeReminderRequestForCalendarAction(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }
  if (
    collectKeywordTermMatchesForKey([normalized], "calendar", {
      includeAllLocales: true,
    }).size > 0
  ) {
    return false;
  }
  return textMatchesAnyCal(normalized, CAL_LIFEOPS_STRONG_TERMS);
}

function buildCalendarServiceErrorFallback(
  error: LifeOpsServiceError,
  intent: string,
): string {
  const normalized = normalizeText(error.message);
  if (
    normalized.includes("utc 'z' suffix") ||
    normalized.includes("local datetime without 'z'")
  ) {
    return `I couldn't pin down the event time from "${intent}". Tell me the date and time again in plain language, like "Friday at 8 pm Pacific."`;
  }
  if (
    normalized.includes("startat is required") ||
    normalized.includes("windowpreset is not provided")
  ) {
    return "I still need the time for that event. Tell me when it should happen.";
  }
  if (normalized.includes("endat must be later than startat")) {
    return "That end time lands before the start. Give me the date and time again and I'll fix it.";
  }
  if (error.status === 429 || normalized.includes("rate limit")) {
    return "Calendar is rate-limited right now. Try again in a bit.";
  }
  return "I couldn't finish that calendar change yet. Tell me the event and timing again, and I'll try it a different way.";
}

function buildCalendarEventDisambiguationFallback(args: {
  action: "update" | "delete";
  candidates: LifeOpsCalendarEvent[];
  titleHint?: string;
}): string {
  const previewLines = args.candidates.slice(0, 3).map((candidate) => {
    const when = formatCalendarEventDateTime(candidate, {
      includeTimeZoneName: true,
    });
    return `- ${candidate.title} (${when})`;
  });
  const intro = args.titleHint
    ? `I found multiple events matching "${args.titleHint}".`
    : "I found multiple matching calendar events.";
  const suffix =
    args.candidates.length > 3
      ? ` There are ${args.candidates.length} matches total.`
      : "";
  return [
    intro,
    ...previewLines,
    `Tell me which one to ${args.action} by giving the title and date/time.${suffix}`,
  ].join("\n");
}

function shouldDeleteAllMatchingCalendarEvents(args: {
  intent: string;
  titleHint?: string;
  candidateCount: number;
}): boolean {
  const normalizedIntent = normalizeText(args.intent);
  const normalizedTitleHint = normalizeText(args.titleHint ?? "");
  const titleStartsWithQuantifier = /^(all|both|every|each)\b/.test(
    normalizedTitleHint,
  );

  if (
    /\b(?:remove|delete|cancel|kill|drop)\b\s+(?:the\s+)?(?:duplicates?|copies)\b/.test(
      normalizedIntent,
    )
  ) {
    return true;
  }

  const quantifierMatch = normalizedIntent.match(
    /\b(?:remove|delete|cancel|kill|drop)\b\s+(both|all|every|each)\b/,
  );
  if (!quantifierMatch) {
    return false;
  }
  if (titleStartsWithQuantifier) {
    return false;
  }

  const quantifier = quantifierMatch[1];
  if (quantifier === "both" && args.candidateCount !== 2) {
    return false;
  }

  const trailingIntent = normalizedIntent.slice(
    (quantifierMatch.index ?? 0) + quantifierMatch[0].length,
  );
  return /\b(?:matching|events?|meetings?|appointments?|invites?|entries|duplicates?|copies)\b/.test(
    trailingIntent,
  );
}

async function renderCalendarActionReply(args: {
  runtime: IAgentRuntime;
  message: Memory;
  state: State | undefined;
  intent: string;
  scenario: string;
  fallback: string;
  context?: Record<string, unknown>;
}): Promise<string> {
  const { runtime, message, state, intent, scenario, fallback, context } = args;
  return renderGroundedActionReply({
    runtime,
    message,
    state,
    intent,
    domain: "calendar",
    scenario,
    fallback,
    context,
    preferCharacterVoice: true,
    additionalRules: [
      "Mirror the user's phrasing for dates, times, ranges, and scheduling language when possible.",
      "Prefer phrases like tomorrow morning, next week, later, earlier, free, busy, or the user's own wording over robotic calendar language.",
      "Never surface raw ISO timestamps unless the user used raw ISO timestamps.",
      "Preserve all concrete event facts from the context and canonical fallback.",
      "If this is reply-only or a clarification, do not pretend you already changed the calendar.",
    ],
  });
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasCalendarTextSignal(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  if (
    collectKeywordTermMatchesForKey([text], "calendar", {
      includeAllLocales: true,
      strength: "strong",
    }).size > 0
  ) {
    return true;
  }
  return (
    collectKeywordTermMatchesForKey([text], "calendar", {
      includeAllLocales: true,
      strength: "weak",
    }).size >= 2
  );
}

function wordCount(value: string): number {
  const normalized = normalizeText(value);
  if (!normalized) {
    return 0;
  }
  return normalized.split(" ").filter(Boolean).length;
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function tokenVariants(token: string): string[] {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const variants = new Set([normalized]);
  if (normalized.endsWith("ies") && normalized.length > 3) {
    variants.add(`${normalized.slice(0, -3)}y`);
  }
  if (normalized.endsWith("es") && normalized.length > 4) {
    variants.add(normalized.slice(0, -2));
  }
  if (
    normalized.endsWith("s") &&
    !normalized.endsWith("ss") &&
    normalized.length > 3
  ) {
    variants.add(normalized.slice(0, -1));
  }
  return [...variants];
}

function tokenizeForSearch(value: string): string[] {
  return [...new Set(tokenize(value).flatMap((token) => tokenVariants(token)))];
}

function normalizeCalendarSearchQueryValue(
  value: string | undefined,
): string | undefined {
  if (!value) {
    return undefined;
  }

  if (PARAMETER_DOC_NOISE_PATTERN.test(value)) {
    return undefined;
  }

  const cleaned = normalizeText(value)
    .replace(/\b(?:actions?|params?|parameters?)\b[:;]*/g, "")
    .replace(/\b\w+\?:\w+(?:\s+\[[^\]]+\])?\s*-\s*/g, " ")
    .replace(
      /\b(?:search|find|look(?:ing)? for|show me|check)\s+(?:my\s+)?(?:calendar|schedule)\s+for\b/g,
      "",
    )
    .replace(/\b(?:search|find|look(?:ing)? for|show me|check)\b/g, "")
    .replace(/\b(?:on|in) my calendar\b/g, "")
    .replace(
      /\b(?:today|tomorrow|tonight|this week(?:end)?|next week(?:end)?|week after(?: next)?|this month|next month|this year|next year)\b/g,
      "",
    )
    .replace(/\b(?:scheduled|coming up|happening|for me)\b/g, "")
    .replace(/\b(?:events?|appointments?|meetings?)\b$/g, "")
    .replace(/\bsupported keys include\b.*$/g, "")
    .replace(/\bmatch against titles\b.*$/g, "")
    .replace(/\bstructured calendar arguments\b.*$/g, "")
    .replace(/[;:,]+/g, " ")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .trim();

  if (
    !cleaned ||
    ["calendar", "schedule", "event", "events"].includes(cleaned) ||
    textMatchesAnyCal(cleaned, CAL_TEMPORAL_FOLLOWUP_TERMS) ||
    PARAMETER_DOC_NOISE_PATTERN.test(cleaned)
  ) {
    return undefined;
  }
  return cleaned;
}

function dedupeCalendarQueries(queries: Array<string | undefined>): string[] {
  const normalized = queries
    .map((query) => normalizeCalendarSearchQueryValue(query))
    .filter((query): query is string => Boolean(query));
  return [...new Set(normalized)];
}

function normalizeCalendarDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) {
    return undefined;
  }

  const normalized: Record<string, unknown> = { ...details };
  const aliasMap = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(CALENDAR_DETAIL_ALIASES)) {
    aliasMap.set(normalizeLookupKey(canonical), canonical);
    for (const alias of aliases) {
      aliasMap.set(normalizeLookupKey(alias), canonical);
    }
  }

  for (const [key, value] of Object.entries(details)) {
    const canonical = aliasMap.get(normalizeLookupKey(key));
    if (!canonical) {
      continue;
    }
    if (normalized[canonical] === undefined) {
      normalized[canonical] = value;
    }
  }

  return normalized;
}

function parseStateLine(line: string): { role: string; text: string } {
  const trimmed = line.trim();
  const timestampedMatch = trimmed.match(
    /^\d{1,2}:\d{2}\s+\([^)]+\)\s+\[[^\]]+\]\s+(\S+)\s*:\s*(.*)/,
  );
  if (timestampedMatch) {
    return {
      role: timestampedMatch[1].toLowerCase(),
      text: timestampedMatch[2].trim(),
    };
  }

  const simpleMatch = trimmed.match(
    /^(user|assistant|system|owner|admin|\S+)\s*:\s*(.*)/i,
  );
  if (simpleMatch) {
    return {
      role: simpleMatch[1].toLowerCase(),
      text: simpleMatch[2].trim(),
    };
  }

  return { role: "", text: trimmed };
}

const SYSTEM_ROLE_NAMES = new Set(["assistant", "system"]);

function splitStateTextCandidates(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) => parseStateLine(line).text)
    .filter((text) => text.length > 0);
}

function userIntentsFromState(state: State | undefined): string[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const values =
    stateRecord.values && typeof stateRecord.values === "object"
      ? (stateRecord.values as Record<string, unknown>)
      : undefined;
  const raw =
    typeof values?.recentMessages === "string"
      ? values.recentMessages
      : typeof stateRecord.text === "string"
        ? stateRecord.text
        : "";
  if (!raw) {
    return [];
  }

  const agentName =
    typeof values?.agentName === "string" ? values.agentName.toLowerCase() : "";
  const excludedRoles = new Set(SYSTEM_ROLE_NAMES);
  if (agentName) {
    excludedRoles.add(agentName);
  }

  return raw
    .split(/\n+/)
    .filter((line) => {
      const { role } = parseStateLine(line);
      return role.length > 0 && !excludedRoles.has(role);
    })
    .map((line) => parseStateLine(line).text)
    .filter((text) => text.length > 0);
}

function planningConversationLines(state: State | undefined): string[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const values =
    stateRecord.values && typeof stateRecord.values === "object"
      ? (stateRecord.values as Record<string, unknown>)
      : undefined;
  const raw =
    typeof values?.recentMessages === "string"
      ? values.recentMessages
      : typeof stateRecord.text === "string"
        ? stateRecord.text
        : "";
  if (!raw) {
    return [];
  }

  return raw
    .split(/\n+/)
    .map((line) => parseStateLine(line))
    .filter((line) => line.role.length > 0 && line.text.length > 0)
    .map((line) => `${line.role}: ${line.text}`);
}

function hasCalendarContextSignal(
  message: Memory,
  state: State | undefined,
): boolean {
  return hasContextSignalSyncForKey(message, state, "calendar", {
    contextLimit: CALENDAR_VALIDATION_CONTEXT_LIMIT,
  });
}

function stateTextCandidates(state: State | undefined): string[] {
  if (!state || typeof state !== "object") {
    return [];
  }

  const stateRecord = state as Record<string, unknown>;
  const values =
    stateRecord.values && typeof stateRecord.values === "object"
      ? (stateRecord.values as Record<string, unknown>)
      : undefined;

  const candidates: string[] = [];
  const pushText = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      candidates.push(...splitStateTextCandidates(value));
    }
  };

  pushText(values?.recentMessages);
  pushText(stateRecord.text);

  const recentMessagesData =
    stateRecord.recentMessagesData ?? stateRecord.recentMessages;
  if (Array.isArray(recentMessagesData)) {
    for (const item of recentMessagesData) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const content = (item as Record<string, unknown>).content;
      if (!content || typeof content !== "object") {
        continue;
      }
      pushText((content as Record<string, unknown>).text);
    }
  }

  return [...new Set(candidates)];
}

function scoreIntentCandidate(value: string): number {
  const normalized = normalizeText(value);
  if (!normalized) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = Math.min(normalized.length, 160) / 16;
  if (textMatchesAnyCal(normalized, CAL_AFFIRMATIVE_TERMS)) {
    score -= 200;
  }
  if (PARAMETER_DOC_NOISE_PATTERN.test(normalized)) {
    score -= 500;
  }
  if (hasCalendarTextSignal(value)) {
    score += 10;
  }
  if (textMatchesAnyCal(normalized, CAL_CALENDAR_STRONG_TERMS)) {
    score += 14;
  }
  if (textMatchesAnyCal(normalized, CAL_CALENDAR_WEAK_TERMS)) {
    score += 10;
  }
  if (textMatchesAnyCal(normalized, CAL_CALENDAR_STRONG_TERMS)) {
    score += 8;
  }
  return score;
}

function looksLikeNarrativeCalendarQuery(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }

  return (
    /\b(?:tell me if|let me know if|whether|can you|could you|would you|do i have|are there|what(?:'s| is) on|what(?: event| events)? do i have|when do i|try to find)\b/.test(
      normalized,
    ) &&
    /\b(?:calendar|schedule|event|events|flight|flights|travel|trip|appointment|meeting|hotel|stay|return)\b/.test(
      normalized,
    )
  );
}

function looksLikeLiteralRequestEcho(query: string, intent: string): boolean {
  const normalizedQuery = normalizeText(query);
  const normalizedIntent = normalizeText(intent);
  const questionLike = /[?¿]/.test(query);
  if (!normalizedQuery || !normalizedIntent) {
    return false;
  }
  if (normalizedQuery === normalizedIntent) {
    return (
      questionLike ||
      wordCount(normalizedQuery) >= 10 ||
      normalizedQuery.length >= 80
    );
  }
  return (
    (normalizedQuery.includes(normalizedIntent) ||
      normalizedIntent.includes(normalizedQuery)) &&
    (questionLike || normalizedQuery.length >= 96)
  );
}

function resolveCalendarIntent(
  paramsIntent: string | undefined,
  message: Parameters<typeof messageText>[0],
  state: State | undefined,
): string {
  const normalizeFollowUpConstraint = (value: string) => {
    const cleaned = value
      .trim()
      .replace(
        /^(?:yes|yeah|yep|yup|ok|okay|sure|please|please do|do it|go ahead|sounds good)\b[\s,.-]*/i,
        "",
      )
      .replace(/^(?:and\s+|also\s+)/i, "")
      .replace(
        /^(?:what about|how about|and the|also the|or the|only the|just the)\s+/i,
        "",
      )
      .trim();
    if (
      /^(?:try\s+(?:it|again|that)|retry|do\s+(?:it\s+)?again|one\s+more\s+time|proceed|go for it)$/i.test(
        cleaned,
      )
    ) {
      return "";
    }
    return cleaned;
  };
  const currentMessageText = messageText(message).trim();
  const normalizedCurrentMessage = normalizeText(currentMessageText);
  const currentMessageHasCalendarSignal =
    hasCalendarTextSignal(currentMessageText);
  const isRefinement =
    /^(?:what about|how about|and the|also the|or the|only the|just the)\b/i.test(
      normalizedCurrentMessage,
    );
  if (currentMessageText && currentMessageHasCalendarSignal && !isRefinement) {
    return currentMessageText;
  }

  if (
    currentMessageText &&
    (textMatchesAnyCal(normalizedCurrentMessage, CAL_AFFIRMATIVE_TERMS) ||
      textMatchesAnyCal(
        normalizedCurrentMessage,
        CAL_TEMPORAL_FOLLOWUP_TERMS,
      ) ||
      isRefinement ||
      hasCalendarContextSignal(message, state))
  ) {
    const followUpCandidates = userIntentsFromState(state).filter(
      (candidate) =>
        hasCalendarTextSignal(candidate) &&
        normalizeText(candidate) !== normalizedCurrentMessage,
    );
    const recentRelevantIntent =
      followUpCandidates.length > 0
        ? followUpCandidates.reduce((best, current) =>
            scoreIntentCandidate(current) >= scoreIntentCandidate(best)
              ? current
              : best,
          )
        : undefined;
    if (recentRelevantIntent) {
      const followUpConstraint =
        normalizeFollowUpConstraint(currentMessageText);
      return followUpConstraint
        ? `${recentRelevantIntent} ${followUpConstraint}`.trim()
        : recentRelevantIntent;
    }
  }

  const candidates = [
    {
      text: paramsIntent?.trim(),
      source: "params" as const,
    },
    {
      text: messageText(message).trim(),
      source: "message" as const,
    },
    ...stateTextCandidates(state).map((text) => ({
      text,
      source: "state" as const,
    })),
  ].filter(
    (
      candidate,
    ): candidate is { text: string; source: "params" | "message" | "state" } =>
      Boolean(candidate.text && candidate.text.trim().length > 0),
  );

  if (candidates.length === 0) {
    return "";
  }

  return [...candidates]
    .sort((left, right) => {
      const leftBonus =
        left.source === "message" && hasCalendarTextSignal(left.text) ? 20 : 0;
      const rightBonus =
        right.source === "message" && hasCalendarTextSignal(right.text)
          ? 20
          : 0;
      return (
        scoreIntentCandidate(right.text) +
        rightBonus -
        (scoreIntentCandidate(left.text) + leftBonus)
      );
    })
    .map((candidate) => candidate.text)[0];
}

function inferCalendarSubaction(
  intent: string,
  details: Record<string, unknown> | undefined,
  query: string | undefined,
): CalendarSubaction {
  // Delete intent is checked first because phrases like "delete the duplicate
  // event" otherwise get swept up by the search_events branch via "duplicate"
  // → "look for". Only the verb decides the subaction here.
  if (
    /\b(delete|remove|cancel|drop|get rid of|trash|kill)\b.*\b(event|meeting|appointment|calendar|reminder|invite)\b/.test(
      intent,
    ) ||
    /\b(uncancel|unbook|unschedule)\b/.test(intent)
  ) {
    return "delete_event";
  }
  // Update intent — same eager-match treatment so "rename", "move", "reschedule"
  // don't get pulled into search_events.
  if (
    /\b(rename|reschedule|move|push|change|update|edit|modify)\b.*\b(event|meeting|appointment|calendar|invite)\b/.test(
      intent,
    )
  ) {
    return "update_event";
  }
  if (
    query ||
    detailString(details, "query") ||
    /\b(find|search|look for|matching|related to|flight|flights|fly|travel|trip|return)\b/.test(
      intent,
    )
  ) {
    return "search_events";
  }
  if (
    detailString(details, "startAt") ||
    detailNumber(details, "durationMinutes") ||
    /\b(create|add|book)\b/.test(intent) ||
    /\bschedule\s+(?:a|an|this|that|the)?\s*(?:calendar\s+)?(?:meeting|event|appointment|call)\b/.test(
      intent,
    ) ||
    /\bput\b.*\b(calendar|meeting|event)\b/.test(intent) ||
    /\bmake an event\b/.test(intent)
  ) {
    return "create_event";
  }
  if (
    /\b(next|upcoming|soon|about to|coming up)\b/.test(intent) &&
    /\b(event|meeting|appointment|call|calendar item|thing)\b/.test(intent)
  ) {
    return "next_event";
  }
  return "feed";
}

function shouldTrustExplicitCalendarSubaction(
  subaction: CalendarSubaction | undefined,
  params: CalendarActionParams,
  details: Record<string, unknown> | undefined,
): boolean {
  if (!subaction) {
    return false;
  }

  switch (subaction) {
    case "create_event":
      return Boolean(
        params.title ||
          detailString(details, "title") ||
          detailString(details, "startAt") ||
          detailString(details, "windowPreset") ||
          detailNumber(details, "durationMinutes"),
      );
    case "update_event":
      return Boolean(
        detailString(details, "eventId") ||
          detailString(details, "title") ||
          detailString(details, "newTitle") ||
          detailString(details, "startAt") ||
          detailString(details, "endAt"),
      );
    case "delete_event":
      return Boolean(
        detailString(details, "eventId") ||
          params.title ||
          detailString(details, "title"),
      );
    case "search_events":
      return Boolean(
        params.query ||
          detailString(details, "query") ||
          (params.queries?.length ?? 0) > 0 ||
          (detailArray(details, "queries")?.length ?? 0) > 0,
      );
    default:
      return false;
  }
}

function cleanTripLocation(value: string): string | undefined {
  const cleaned = value
    .trim()
    .replace(
      /\b(?:today|tomorrow|tonight|this week(?:end)?|next week(?:end)?|this month|next month|for me|coming up|upcoming|on my calendar|on the calendar|on my schedule|on the schedule)\b.*$/i,
      "",
    )
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function inferTripWindowIntent(intent: string): TripWindowIntent | null {
  const patterns = [
    /\bwhile\s+(?:i(?:'m| am)|im)\s+in\s+(.+?)(?=$|[?.!,])/i,
    /\bwhen\s+(?:i(?:'m| am)|im)\s+in\s+(.+?)(?=$|[?.!,])/i,
    /\bduring\s+(?:my\s+)?(?:trip|stay|visit)\s+(?:to|in)\s+(.+?)(?=$|[?.!,])/i,
    /\bonce\s+(?:i(?:'m| am)|im)\s+in\s+(.+?)(?=$|[?.!,])/i,
  ];

  for (const pattern of patterns) {
    const match = intent.match(pattern);
    const location = cleanTripLocation(match?.[1] ?? "");
    if (location) {
      return { location };
    }
  }

  return null;
}

function parseExplicitLocalDate(
  value: string,
  timeZone: string,
): { year: number; month: number; day: number } | null {
  const normalized = normalizeText(value);
  const localToday = getZonedDateParts(new Date(), timeZone);

  const isoMatch = normalized.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    return {
      year: Number(isoMatch[1]),
      month: Number(isoMatch[2]),
      day: Number(isoMatch[3]),
    };
  }

  const monthNameMatch = normalized.match(MONTH_NAME_PATTERN);
  if (monthNameMatch) {
    return {
      year: monthNameMatch[3] ? Number(monthNameMatch[3]) : localToday.year,
      month: MONTH_MAP[normalizeLookupKey(monthNameMatch[1])],
      day: Number(monthNameMatch[2]),
    };
  }

  const numericMatch = normalized.match(
    /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/,
  );
  if (numericMatch) {
    const yearRaw = numericMatch[3];
    const parsedYear =
      yearRaw === undefined
        ? localToday.year
        : yearRaw.length === 2
          ? 2000 + Number(yearRaw)
          : Number(yearRaw);
    return {
      year: parsedYear,
      month: Number(numericMatch[1]),
      day: Number(numericMatch[2]),
    };
  }

  const weekdayMatch = normalized.match(WEEKDAY_NAME_PATTERN);
  if (weekdayMatch) {
    const qualifier = normalizeLookupKey(weekdayMatch[1] ?? "");
    const weekdayKey = normalizeLookupKey(weekdayMatch[2] ?? "");
    const targetWeekday = WEEKDAY_MAP[weekdayKey];
    if (targetWeekday !== undefined) {
      const currentWeekday = new Date(
        Date.UTC(
          localToday.year,
          Math.max(0, localToday.month - 1),
          localToday.day,
          12,
          0,
          0,
        ),
      ).getUTCDay();
      let delta = (targetWeekday - currentWeekday + 7) % 7;
      if (qualifier === "next") {
        delta = delta === 0 ? 7 : delta + 7;
      }
      return addDaysToLocalDate(
        {
          year: localToday.year,
          month: localToday.month,
          day: localToday.day,
        },
        delta,
      );
    }
  }

  return null;
}

function resolveCalendarTimeZone(
  details: Record<string, unknown> | undefined,
): string {
  return detailString(details, "timeZone") ?? resolveDefaultTimeZone();
}

type LocalDateOnly = Pick<
  ReturnType<typeof getZonedDateParts>,
  "year" | "month" | "day"
>;

function getLocalTodayDate(timeZone: string): LocalDateOnly {
  const localNow = getZonedDateParts(new Date(), timeZone);
  return {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
  };
}

function addMonthsToLocalDate(
  dateOnly: LocalDateOnly,
  monthDelta: number,
): LocalDateOnly {
  const utcDate = new Date(
    Date.UTC(
      dateOnly.year,
      dateOnly.month - 1 + monthDelta,
      dateOnly.day,
      12,
      0,
      0,
    ),
  );
  return {
    year: utcDate.getUTCFullYear(),
    month: utcDate.getUTCMonth() + 1,
    day: utcDate.getUTCDate(),
  };
}

function buildLocalDateRange(
  timeZone: string,
  startDate: LocalDateOnly,
  endDateExclusive: LocalDateOnly,
  options?: {
    startHour?: number;
    startMinute?: number;
    endHour?: number;
    endMinute?: number;
  },
): { timeMin: string; timeMax: string } {
  return {
    timeMin: buildUtcDateFromLocalParts(timeZone, {
      year: startDate.year,
      month: startDate.month,
      day: startDate.day,
      hour: options?.startHour ?? 0,
      minute: options?.startMinute ?? 0,
      second: 0,
    }).toISOString(),
    timeMax: buildUtcDateFromLocalParts(timeZone, {
      year: endDateExclusive.year,
      month: endDateExclusive.month,
      day: endDateExclusive.day,
      hour: options?.endHour ?? 0,
      minute: options?.endMinute ?? 0,
      second: 0,
    }).toISOString(),
  };
}

function buildLocalDayRange(
  timeZone: string,
  startOffsetDays: number,
  endOffsetDaysExclusive: number,
): { timeMin: string; timeMax: string } {
  const localToday = getLocalTodayDate(timeZone);
  return buildLocalDateRange(
    timeZone,
    addDaysToLocalDate(localToday, startOffsetDays),
    addDaysToLocalDate(localToday, endOffsetDaysExclusive),
  );
}

function compareLocalDates(left: LocalDateOnly, right: LocalDateOnly): number {
  if (left.year !== right.year) {
    return left.year - right.year;
  }
  if (left.month !== right.month) {
    return left.month - right.month;
  }
  return left.day - right.day;
}

function resolveCreateEventCalendarTimeZone(
  details: Record<string, unknown> | undefined,
  feed: LifeOpsCalendarFeed | null | undefined,
  fallbackTimeZone: string,
): string {
  const explicitTimeZone = detailString(details, "timeZone");
  if (explicitTimeZone) {
    return explicitTimeZone;
  }

  const counts = new Map<string, number>();
  for (const event of feed?.events ?? []) {
    const eventTimeZone =
      typeof event.timezone === "string" ? event.timezone.trim() : "";
    if (!eventTimeZone) {
      continue;
    }
    counts.set(eventTimeZone, (counts.get(eventTimeZone) ?? 0) + 1);
  }

  let winner = fallbackTimeZone;
  let winnerCount = 0;
  for (const [timeZone, count] of counts.entries()) {
    if (count > winnerCount) {
      winner = timeZone;
      winnerCount = count;
    }
  }
  return winner;
}

function formatCreateEventCalendarContext(
  context: CreateEventCalendarContext | null,
): string {
  if (!context) {
    return "(calendar context unavailable)";
  }

  const lines = [
    `Calendar timezone: ${context.calendarTimeZone}`,
    `Context window: ${context.feed.timeMin} to ${context.feed.timeMax}`,
  ];

  if (context.feed.events.length === 0) {
    lines.push("(no upcoming events in the next 2 weeks)");
    return lines.join("\n");
  }

  const visibleEvents = context.feed.events.slice(0, 40);
  for (const event of visibleEvents) {
    const when = event.isAllDay
      ? formatCalendarMoment(event)
      : formatCalendarEventDateTime(event, {
          includeTimeZoneName: true,
          includeYear: true,
        });
    lines.push(
      `- ${when} — ${event.title}${event.location ? ` @ ${event.location}` : ""}`,
    );
  }
  if (context.feed.events.length > visibleEvents.length) {
    lines.push(
      `... ${context.feed.events.length - visibleEvents.length} more upcoming events omitted`,
    );
  }
  return lines.join("\n");
}

function isPersonalCreateEvent(intent: string, title: string): boolean {
  return /\b(hug|wife|husband|partner|girlfriend|boyfriend|family|mom|dad|date|dinner|lunch|coffee|check in|check-in|call|text|birthday|anniversary|pick up|pickup|drop off|drop-off)\b/i.test(
    `${intent} ${title}`,
  );
}

function resolveSuggestedCreateEventDurationMinutes(
  intent: string,
  title: string,
): number {
  if (isShortPreparationEvent(intent, title)) {
    return MIN_CREATE_EVENT_DURATION_MINUTES;
  }
  return isPersonalCreateEvent(intent, title) ? 15 : 60;
}

function roundUpToStep(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function overlapsBusyWindow(
  startMinute: number,
  durationMinutes: number,
  busyWindows: Array<{ startMinute: number; endMinute: number }>,
): boolean {
  const endMinute = startMinute + durationMinutes;
  return busyWindows.some(
    (window) =>
      startMinute < window.endMinute && endMinute > window.startMinute,
  );
}

function busyWindowsForLocalDate(
  events: LifeOpsCalendarEvent[],
  targetDate: LocalDateOnly,
  timeZone: string,
): Array<{ startMinute: number; endMinute: number }> {
  const windows: Array<{ startMinute: number; endMinute: number }> = [];

  for (const event of events) {
    if (event.isAllDay) {
      continue;
    }
    const start = getZonedDateParts(new Date(event.startAt), timeZone);
    const end = getZonedDateParts(new Date(event.endAt), timeZone);
    const startDate = { year: start.year, month: start.month, day: start.day };
    const endDate = { year: end.year, month: end.month, day: end.day };

    if (
      compareLocalDates(endDate, targetDate) < 0 ||
      compareLocalDates(startDate, targetDate) > 0
    ) {
      continue;
    }

    const startMinute =
      compareLocalDates(startDate, targetDate) < 0
        ? 0
        : start.hour * 60 + start.minute;
    const endMinute =
      compareLocalDates(endDate, targetDate) > 0
        ? 24 * 60
        : Math.max(startMinute + 1, end.hour * 60 + end.minute);

    windows.push({ startMinute, endMinute });
  }

  return windows.sort((left, right) => left.startMinute - right.startMinute);
}

function resolvePreferredCreateEventMinutes(
  intent: string,
  title: string,
  targetDate: LocalDateOnly,
): number[] {
  const weekday = getWeekdayForLocalDate(targetDate);
  if (isPersonalCreateEvent(intent, title)) {
    return [19 * 60, 20 * 60, 18 * 60 + 30, 17 * 60 + 30];
  }
  if (
    /\b(dentist|doctor|therapy|appointment|meeting|interview|review|sync)\b/i.test(
      `${intent} ${title}`,
    )
  ) {
    return [9 * 60, 10 * 60, 11 * 60, 14 * 60, 15 * 60];
  }
  return weekday === 0 || weekday === 6
    ? [10 * 60, 13 * 60, 18 * 60]
    : [9 * 60, 11 * 60, 14 * 60, 16 * 60, 19 * 60];
}

function chooseSuggestedCreateEventMinute(args: {
  busyWindows: Array<{ startMinute: number; endMinute: number }>;
  preferredMinutes: number[];
  durationMinutes: number;
}): number | null {
  for (const minute of args.preferredMinutes) {
    if (!overlapsBusyWindow(minute, args.durationMinutes, args.busyWindows)) {
      return minute;
    }
  }

  const latestEnd = Math.max(
    0,
    ...args.busyWindows.map((window) => window.endMinute),
  );
  const afterLastEvent = roundUpToStep(latestEnd + 15, 15);
  if (
    afterLastEvent + args.durationMinutes <= 22 * 60 &&
    !overlapsBusyWindow(afterLastEvent, args.durationMinutes, args.busyWindows)
  ) {
    return afterLastEvent;
  }

  for (let minute = 8 * 60; minute <= 21 * 60; minute += 30) {
    if (!overlapsBusyWindow(minute, args.durationMinutes, args.busyWindows)) {
      return minute;
    }
  }

  return null;
}

function suggestCreateEventStartAt(args: {
  currentMessage: string;
  intent: string;
  title: string;
  calendarContext: CreateEventCalendarContext | null;
}): { startAt: string; timeZone: string } | null {
  if (!args.calendarContext) {
    return null;
  }

  const targetDate =
    parseExplicitLocalDate(
      args.currentMessage,
      args.calendarContext.calendarTimeZone,
    ) ??
    parseExplicitLocalDate(args.intent, args.calendarContext.calendarTimeZone);
  if (!targetDate) {
    return null;
  }

  const durationMinutes = resolveSuggestedCreateEventDurationMinutes(
    args.intent,
    args.title,
  );
  const busyWindows = busyWindowsForLocalDate(
    args.calendarContext.feed.events,
    targetDate,
    args.calendarContext.calendarTimeZone,
  );
  const startMinute = chooseSuggestedCreateEventMinute({
    busyWindows,
    preferredMinutes: resolvePreferredCreateEventMinutes(
      args.intent,
      args.title,
      targetDate,
    ),
    durationMinutes,
  });
  if (startMinute === null) {
    return null;
  }

  return {
    startAt: buildUtcDateFromLocalParts(args.calendarContext.calendarTimeZone, {
      year: targetDate.year,
      month: targetDate.month,
      day: targetDate.day,
      hour: Math.floor(startMinute / 60),
      minute: startMinute % 60,
      second: 0,
    }).toISOString(),
    timeZone: args.calendarContext.calendarTimeZone,
  };
}

async function loadCreateEventCalendarContext(
  service: LifeOpsService,
  details: Record<string, unknown> | undefined,
  hasCalendarRead: boolean,
): Promise<CreateEventCalendarContext | null> {
  if (!hasCalendarRead) {
    return null;
  }

  const requestTimeZone = resolveCalendarTimeZone(details);
  const feed = await service.getCalendarFeed(INTERNAL_URL, {
    mode: detailString(details, "mode") as
      | "local"
      | "remote"
      | "cloud_managed"
      | undefined,
    side: detailString(details, "side") as "owner" | "agent" | undefined,
    grantId: detailString(details, "grantId"),
    calendarId: detailString(details, "calendarId"),
    timeZone: requestTimeZone,
    forceSync: detailBoolean(details, "forceSync"),
    ...buildLocalDayRange(requestTimeZone, 0, 14),
  });

  if (!feed || !Array.isArray(feed.events)) {
    return null;
  }

  return {
    calendarTimeZone: resolveCreateEventCalendarTimeZone(
      details,
      feed,
      requestTimeZone,
    ),
    feed,
  };
}

function normalizeIsoDateTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeWindowLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value.trim();
  return cleaned.length > 0 && cleaned.length <= 80 ? cleaned : undefined;
}

function resolveCalendarLlmWindow(
  llmPlan: CalendarLlmPlan | undefined,
): { timeMin: string; timeMax: string; label: string } | null {
  const timeMin = normalizeIsoDateTime(llmPlan?.timeMin);
  const timeMax = normalizeIsoDateTime(llmPlan?.timeMax);
  if (!timeMin || !timeMax) {
    return null;
  }

  const minMs = Date.parse(timeMin);
  const maxMs = Date.parse(timeMax);
  const spanMs = maxMs - minMs;
  if (
    !Number.isFinite(spanMs) ||
    spanMs <= 0 ||
    spanMs > 370 * 24 * 60 * 60 * 1000
  ) {
    return null;
  }

  return {
    timeMin,
    timeMax,
    label:
      normalizeWindowLabel(llmPlan?.windowLabel) ?? "for the requested window",
  };
}

function resolveWeekendWindow(
  timeZone: string,
  modifier: "this" | "next",
): { timeMin: string; timeMax: string } {
  const localToday = getLocalTodayDate(timeZone);
  const currentWeekday = getWeekdayForLocalDate(localToday);
  let startOffsetDays = (6 - currentWeekday + 7) % 7;
  let endOffsetFromToday = startOffsetDays + 2;
  if (modifier === "this" && (currentWeekday === 6 || currentWeekday === 0)) {
    startOffsetDays = 0;
    endOffsetFromToday = currentWeekday === 6 ? 2 : 1;
  }
  if (modifier === "next") {
    startOffsetDays += 7;
    endOffsetFromToday += 7;
  }
  const startDay = addDaysToLocalDate(localToday, startOffsetDays);
  const endDay = addDaysToLocalDate(localToday, endOffsetFromToday);
  return buildLocalDateRange(timeZone, startDay, endDay);
}

function resolveMonthWindow(
  timeZone: string,
  modifier: "this" | "next",
): { timeMin: string; timeMax: string } {
  const localToday = getLocalTodayDate(timeZone);
  if (modifier === "this") {
    const endOfWindow = addMonthsToLocalDate(
      {
        year: localToday.year,
        month: localToday.month,
        day: 1,
      },
      1,
    );
    return buildLocalDateRange(timeZone, localToday, endOfWindow);
  }

  const startOfNextMonth = addMonthsToLocalDate(
    {
      year: localToday.year,
      month: localToday.month,
      day: 1,
    },
    1,
  );
  const startOfFollowingMonth = addMonthsToLocalDate(startOfNextMonth, 1);
  return buildLocalDateRange(timeZone, startOfNextMonth, startOfFollowingMonth);
}

function resolveTonightWindow(timeZone: string): {
  timeMin: string;
  timeMax: string;
} {
  const localNow = getZonedDateParts(new Date(), timeZone);
  const startHour = Math.max(localNow.hour, 17);
  const startMinute = localNow.hour >= 17 ? localNow.minute : 0;
  const startDay = {
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
  };
  const endDay = addDaysToLocalDate(startDay, 1);
  return buildLocalDateRange(timeZone, startDay, endDay, {
    startHour,
    startMinute,
  });
}

// Wide window used by update_event / delete_event lookups when the user
// gave no time hint. Reaches 1 year back and 5 years forward — far enough
// to find a future birthday or a recent past meeting without scanning the
// entire account.
function buildWideLookupRange(timeZone: string): {
  timeMin: string;
  timeMax: string;
} {
  return buildLocalDayRange(timeZone, -365, 365 * 5);
}

function resolveCalendarWindow(
  intent: string,
  details: Record<string, unknown> | undefined,
  forSearch: boolean,
  llmPlan?: CalendarLlmPlan,
): {
  request: GetLifeOpsCalendarFeedRequest;
  label: string;
} {
  const timeMin = detailString(details, "timeMin");
  const timeMax = detailString(details, "timeMax");
  const calendarId = detailString(details, "calendarId");
  const timeZone = resolveCalendarTimeZone(details);
  const forceSync = detailBoolean(details, "forceSync");
  if (timeMin || timeMax) {
    return {
      request: {
        calendarId,
        timeMin: timeMin ?? undefined,
        timeMax: timeMax ?? undefined,
        timeZone,
        forceSync,
      },
      label: detailString(details, "label") ?? "for the requested window",
    };
  }

  const llmWindow = resolveCalendarLlmWindow(llmPlan);
  if (llmWindow) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        timeMin: llmWindow.timeMin,
        timeMax: llmWindow.timeMax,
      },
      label: llmWindow.label,
    };
  }

  const normalizedIntent = normalizeText(intent);
  const explicitDate = parseExplicitLocalDate(normalizedIntent, timeZone);
  if (explicitDate) {
    const nextDate = addDaysToLocalDate(explicitDate, 1);
    const explicitDateLabel = (
      normalizedIntent.match(/(?:on|for)\s+(.+)$/i)?.[1] ?? normalizedIntent
    )
      .replace(/^(?:on|for)\s+/i, "")
      .trim();
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        timeMin: buildUtcDateFromLocalParts(timeZone, {
          year: explicitDate.year,
          month: explicitDate.month,
          day: explicitDate.day,
          hour: 0,
          minute: 0,
          second: 0,
        }).toISOString(),
        timeMax: buildUtcDateFromLocalParts(timeZone, {
          year: nextDate.year,
          month: nextDate.month,
          day: nextDate.day,
          hour: 0,
          minute: 0,
          second: 0,
        }).toISOString(),
      },
      label: `on ${explicitDateLabel}`,
    };
  }
  if (/\btonight\b/.test(normalizedIntent)) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...resolveTonightWindow(timeZone),
      },
      label: "tonight",
    };
  }
  if (
    /\bnext week\b/.test(normalizedIntent) &&
    /\b(?:week after next|the week after)\b/.test(normalizedIntent)
  ) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...buildLocalDayRange(timeZone, 7, 21),
      },
      label: "next week or the week after",
    };
  }
  if (/\btomorrow\b/.test(normalizedIntent)) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...buildLocalDayRange(timeZone, 1, 2),
      },
      label: "tomorrow",
    };
  }
  if (/\bnext weekend\b/.test(normalizedIntent)) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...resolveWeekendWindow(timeZone, "next"),
      },
      label: "next weekend",
    };
  }
  if (/\b(?:this weekend|weekend)\b/.test(normalizedIntent)) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...resolveWeekendWindow(timeZone, "this"),
      },
      label: "this weekend",
    };
  }
  if (/\b(?:week after next|the week after)\b/.test(normalizedIntent)) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...buildLocalDayRange(timeZone, 14, 21),
      },
      label: "the week after next",
    };
  }
  if (/\bnext week\b/.test(normalizedIntent)) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...buildLocalDayRange(timeZone, 7, 14),
      },
      label: "next week",
    };
  }
  if (/\b(this week|week)\b/.test(normalizedIntent)) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...buildLocalDayRange(timeZone, 0, 7),
      },
      label: "this week",
    };
  }
  if (/\bnext month\b/.test(normalizedIntent)) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...resolveMonthWindow(timeZone, "next"),
      },
      label: "next month",
    };
  }
  if (/\bthis month\b/.test(normalizedIntent)) {
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...resolveMonthWindow(timeZone, "this"),
      },
      label: "this month",
    };
  }

  const windowDays = detailNumber(details, "windowDays");
  if (forSearch) {
    const days = windowDays && windowDays > 0 ? Math.min(windowDays, 90) : 30;
    return {
      request: {
        calendarId,
        timeZone,
        forceSync,
        ...buildLocalDayRange(timeZone, 0, days),
      },
      label: `across the next ${days} days`,
    };
  }

  return {
    request: {
      calendarId,
      timeZone,
      forceSync,
      ...buildLocalDayRange(timeZone, 0, 1),
    },
    label: "today",
  };
}

function resolveTripWindowRequest(
  details: Record<string, unknown> | undefined,
  llmPlan?: CalendarLlmPlan,
): GetLifeOpsCalendarFeedRequest {
  const timeMin = detailString(details, "timeMin");
  const timeMax = detailString(details, "timeMax");
  const calendarId = detailString(details, "calendarId");
  const timeZone = resolveCalendarTimeZone(details);
  const forceSync = detailBoolean(details, "forceSync");

  if (timeMin || timeMax) {
    return {
      calendarId,
      timeMin: timeMin ?? undefined,
      timeMax: timeMax ?? undefined,
      timeZone,
      forceSync,
    };
  }

  const llmWindow = resolveCalendarLlmWindow(llmPlan);
  if (llmWindow) {
    return {
      calendarId,
      timeZone,
      forceSync,
      timeMin: llmWindow.timeMin,
      timeMax: llmWindow.timeMax,
    };
  }

  const windowDays = detailNumber(details, "windowDays");
  const days = windowDays && windowDays > 0 ? Math.min(windowDays, 120) : 60;
  return {
    calendarId,
    timeZone,
    forceSync,
    ...buildLocalDayRange(timeZone, 0, days),
  };
}

function inferCalendarSearchQuery(intent: string): string | undefined {
  const normalizedIntent = normalizeText(intent);
  if (/\b(flight|flights|fly|flying|travel|trip)\b/.test(normalizedIntent)) {
    const locationMatch = normalizedIntent.match(
      /\b(?:from|to)\s+(.+?)(?=\b(?:today|tomorrow|tonight|this week(?:end)?|next week(?:end)?|week after(?: next)?|this month|next month|this year|next year|or|and|please|idk|i dk|i don't know)\b|[?.!,]|$)/i,
    );
    const parts = ["flight"];
    if (/\b(return|back|home)\b/.test(normalizedIntent)) {
      parts.push("return");
    }
    const location = normalizeCalendarSearchQueryValue(
      locationMatch?.[1] ?? "",
    );
    if (location) {
      parts.push(location);
    }
    return normalizeCalendarSearchQueryValue(parts.join(" ")) ?? "flight";
  }

  const dateMatch = normalizedIntent.match(
    /\b(?:on|for)\s+((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{1,2}-\d{1,2})\b/i,
  );
  const normalizedDate = normalizeCalendarSearchQueryValue(dateMatch?.[1]);
  if (normalizedDate) {
    return normalizedDate;
  }

  const patterns = [
    /^(?:please\s+)?(?:find|search(?: for)?|look(?:ing)? for|show me)\s+(.+)$/i,
    /^(?:please\s+)?(?:do i have|are there)\s+(?:any\s+)?(.+?)(?:\?|$)/i,
    /^(?:please\s+)?(?:check|look|see)\s+(?:my\s+)?calendar\s+for\s+(.+?)(?:\?|$)/i,
    /^what\s+(?:event|events)\s+do\s+i\s+have\s+(?:on|for)\s+(.+?)(?:\?|$)/i,
    /^(?:please\s+)?any\s+(.+?)(?:\?|$)/i,
  ];

  for (const pattern of patterns) {
    const match = normalizedIntent.match(pattern);
    const value = normalizeCalendarSearchQueryValue(match?.[1] ?? "");
    if (value) {
      return value;
    }
  }

  return undefined;
}

function inferCalendarSearchQueries(intent: string): string[] {
  const normalizedIntent = normalizeText(intent);
  const queries = new Set<string>();
  const push = (value: string | undefined) => {
    const normalized = normalizeCalendarSearchQueryValue(value);
    if (normalized) {
      queries.add(normalized);
    }
  };

  push(inferCalendarSearchQuery(intent));

  if (/\b(return|back|home)\b/.test(normalizedIntent)) {
    const locationMatch = normalizedIntent.match(
      /\b(?:from|to)\s+(.+?)(?=\b(?:today|tomorrow|tonight|this week(?:end)?|next week(?:end)?|week after(?: next)?|this month|next month|this year|next year|or|and|please|idk|i dk|i don't know)\b|[?.!,]|$)/i,
    );
    const location = normalizeCalendarSearchQueryValue(
      locationMatch?.[1] ?? "",
    );
    push(`return flight${location ? ` ${location}` : ""}`);
    if (location) {
      push(`flight back ${location}`);
      push(`${location} return flight`);
    }
  }

  return [...queries];
}

function sanitizeCalendarQuery(
  query: string | undefined,
  intent: string,
): string | undefined {
  if (!query) {
    return undefined;
  }
  const raw = normalizeText(query);
  if (
    PARAMETER_DOC_NOISE_PATTERN.test(raw) ||
    raw.includes("supported keys include") ||
    raw.includes("match against titles") ||
    raw.includes("structured calendar arguments")
  ) {
    return undefined;
  }
  const cleaned = normalizeCalendarSearchQueryValue(query);
  if (
    !cleaned ||
    PARAMETER_DOC_NOISE_PATTERN.test(cleaned) ||
    textMatchesAnyCal(cleaned, CAL_TEMPORAL_FOLLOWUP_TERMS) ||
    looksLikeLiteralRequestEcho(cleaned, intent) ||
    cleaned.length > 160
  ) {
    return undefined;
  }
  const inferred = inferCalendarSearchQuery(intent);
  if (
    inferred &&
    looksLikeNarrativeCalendarQuery(cleaned) &&
    normalizeText(inferred) !== normalizeText(cleaned)
  ) {
    return undefined;
  }
  return cleaned;
}

function scoreCalendarQueryCandidate(query: string, intent: string): number {
  const normalized = normalizeText(query);
  if (!normalized) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (PARAMETER_DOC_NOISE_PATTERN.test(normalized)) {
    score -= 500;
  }
  if (looksLikeNarrativeCalendarQuery(normalized)) {
    score -= 120;
  }
  if (looksLikeLiteralRequestEcho(query, intent)) {
    score -= 120;
  }
  if (textMatchesAnyCal(normalized, CAL_TEMPORAL_FOLLOWUP_TERMS)) {
    score -= 120;
  }

  const tokens = tokenizeForSearch(normalized);
  if (tokens.length <= 4) {
    score += 12;
  } else if (tokens.length >= 8) {
    score -= 15;
  }

  const inferredQueries = inferCalendarSearchQueries(intent).map((value) =>
    normalizeText(value),
  );
  if (inferredQueries.includes(normalized)) {
    score += 60;
  }
  for (const inferredQuery of inferredQueries) {
    if (!inferredQuery) {
      continue;
    }
    if (
      normalized.includes(inferredQuery) ||
      inferredQuery.includes(normalized)
    ) {
      score += 18;
    }
    const inferredTokens = new Set(tokenizeForSearch(inferredQuery));
    score += tokens.filter((token) => inferredTokens.has(token)).length * 8;
  }

  if (
    /\b(flight|flights|travel|trip|return|back|home)\b/.test(
      normalizeText(intent),
    ) &&
    /\b(flight|flights|travel|trip|return|back|home)\b/.test(normalized)
  ) {
    score += 12;
  }

  return score;
}

function eventDateSearchTerms(event: LifeOpsCalendarEvent): Set<string> {
  const formatter = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: event.timezone || undefined,
      ...options,
    }).format(new Date(event.startAt));

  const monthLong = normalizeText(
    formatter({ month: "long" }).replace(/\./g, ""),
  );
  const monthShort = normalizeText(
    formatter({ month: "short" }).replace(/\./g, ""),
  );
  const weekdayLong = normalizeText(formatter({ weekday: "long" }));
  const weekdayShort = normalizeText(formatter({ weekday: "short" }));
  const day = formatter({ day: "numeric" });
  const dayPadded = day.padStart(2, "0");
  const monthNumeric = formatter({ month: "numeric" });
  const monthPadded = monthNumeric.padStart(2, "0");
  const year = formatter({ year: "numeric" });

  return new Set(
    [
      `${monthLong} ${day}`,
      `${monthLong} ${day} ${year}`,
      `${monthShort} ${day}`,
      `${monthShort} ${day} ${year}`,
      `${weekdayLong} ${monthLong} ${day}`,
      `${weekdayShort} ${monthShort} ${day}`,
      `${monthNumeric}/${day}`,
      `${monthNumeric}/${dayPadded}`,
      `${monthPadded}/${day}`,
      `${monthPadded}/${dayPadded}`,
      `${year}-${monthPadded}-${dayPadded}`,
      weekdayLong,
      weekdayShort,
    ].map((term) => normalizeText(term)),
  );
}

async function extractCalendarSearchQueriesWithLlm(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  timeZone?: string,
): Promise<string[]> {
  return (
    await extractCalendarPlanWithLlm(runtime, message, state, intent, timeZone)
  ).queries;
}

export async function extractCalendarPlanWithLlm(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  timeZone = resolveDefaultTimeZone(),
): Promise<CalendarLlmPlan> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  const now = new Date();
  const nowIso = now.toISOString();
  const localNow = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const prompt = [
    "Plan the calendar action for this request.",
    "The user may speak in any language.",
    "Use the current request plus recent conversation context.",
    "If the current request is vague or a follow-up, recover the subject from recent conversation and apply the new constraint from the current request.",
    "You are allowed to decide that the assistant should reply naturally without acting yet.",
    "Set shouldAct=false when the user is vague, only acknowledging, brainstorming, or asking for calendar help without enough specifics to safely act.",
    "When shouldAct=false, provide a short natural response that asks only for what is missing.",
    "",
    "Return a JSON object with exactly these fields:",
    "  subaction: one of the allowed subactions below, or null when this should be reply-only/no-op",
    "  shouldAct: boolean",
    "  response: short natural-language reply when shouldAct is false, otherwise empty or null",
    "  queries: array or ||-delimited string of up to 3 search queries",
    "  title: optional event title",
    "  tripLocation: optional trip location",
    "  timeMin: optional ISO 8601 datetime",
    "  timeMax: optional ISO 8601 datetime",
    "  windowLabel: optional natural-language window label",
    "",
    "Subactions and when to use each:",
    "  feed — view today's, tomorrow's, or this week's schedule (e.g. 'what's on my calendar', 'what do I have today', 'this week's agenda')",
    "  next_event — check the next upcoming event only (e.g. 'what's my next meeting', 'when is my next appointment')",
    "  search_events — find events by title, attendee, location, or date range (e.g. 'find my flight', 'when is the dentist', 'meetings with John')",
    "  create_event — schedule a new event (e.g. 'schedule a meeting tomorrow at 3pm', 'add lunch with Sarah on Friday')",
    "  update_event — rename, reschedule, move, or edit an existing event (e.g. 'rename my meeting to standup', 'reschedule the dentist to Friday', 'move the call to 3pm')",
    "  delete_event — remove or cancel an existing event (e.g. 'delete the team meeting', 'cancel my appointment', 'remove the duplicate event')",
    "  trip_window — query what's happening during a trip or stay in a specific place (e.g. 'what's happening while I'm in Denver', 'my Tokyo itinerary')",
    "",
    "For feed, search_events, or trip_window, infer an exact timeMin/timeMax window when the request names or implies a date or date range.",
    "timeMin and timeMax must be ISO 8601 datetimes that the API can use directly.",
    "windowLabel should be a short natural-language label like on monday, this weekend, next month, or tonight.",
    "For search_events or trip_window, extract up to 3 short search queries.",
    "Preserve names, places, and keywords in their original language or script when useful.",
    "Convert time constraints into concise searchable dates or windows even if the user phrases them in another language.",
    "Focus on people, places, flights, itinerary, appointments, and explicit dates.",
    "If the request is about a date, include a date query like april 12 or 2026-04-12.",
    "If the request asks what is happening while the user is in a place, use trip_window and include tripLocation.",
    "",
    "Examples:",
    '  "what\'s on my calendar tomorrow" → {"subaction":"feed","shouldAct":true,"response":null}',
    '  "schedule a meeting with Alex at 3pm" → {"subaction":"create_event","shouldAct":true,"response":null,"title":"Meeting with Alex"}',
    '  "find my return flight" → {"subaction":"search_events","shouldAct":true,"response":null,"queries":["return flight"]}',
    '  "what do I have while I\'m in Tokyo" → {"subaction":"trip_window","shouldAct":true,"response":null,"queries":["tokyo"],"tripLocation":"Tokyo"}',
    '  "rename my meeting to standup" → {"subaction":"update_event","shouldAct":true,"response":null,"queries":["meeting"],"title":"standup"}',
    '  "delete the team meeting tomorrow" → {"subaction":"delete_event","shouldAct":true,"response":null,"queries":["team meeting"]}',
    '  "can you help me with my calendar?" → {"subaction":null,"shouldAct":false,"response":"What do you want to do on your calendar — check your schedule, find an event, or create one?","queries":[]}',
    "",
    "The user may speak any language. Detect the calendar intent regardless of language.",
    "When the user asks about what is happening in a specific location or during a trip, detect this as trip_window and extract the location, regardless of language.",
    "",
    "Return ONLY valid JSON. No prose. No markdown. No XML. No <think>.",
    "",
    `Current timezone: ${timeZone}`,
    `Current local datetime: ${localNow}`,
    `Current ISO datetime: ${nowIso}`,
    "",
    "<current_request>",
    currentMessage,
    "</current_request>",
    "<resolved_intent>",
    intent,
    "</resolved_intent>",
    "<recent_conversation>",
    recentConversation,
    "</recent_conversation>",
  ].join("\n");

  let rawResponse = "";
  try {
    const result = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
    });
    rawResponse = typeof result === "string" ? result : "";
  } catch (error) {
    runtime.logger?.warn?.(
      {
        src: "action:calendar",
        error: error instanceof Error ? error.message : String(error),
      },
      "Calendar action planning model call failed",
    );
    return {
      subaction: null,
      queries: [],
      shouldAct: null,
    };
  }

  const parsed =
    parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
    parseJSONObjectFromText(rawResponse);
  if (!parsed) {
    return {
      subaction: null,
      queries: [],
      shouldAct: null,
    };
  }

  const tripLocation =
    typeof parsed.tripLocation === "string" &&
    parsed.tripLocation.trim().length > 0
      ? parsed.tripLocation.trim()
      : undefined;

  // Extract queries from multiple possible shapes:
  // - TOON string: "flight || dentist" (split on ||)
  // - TOON single: "return flight" (no delimiter)
  // - JSON array: ["flight", "dentist"]
  // - Numbered fallbacks: query1, query2, query3
  const rawQueries: Array<string | undefined> = [];
  if (typeof parsed.queries === "string" && parsed.queries.trim().length > 0) {
    for (const q of parsed.queries.split(/\s*\|\|\s*/)) {
      if (q.trim().length > 0) rawQueries.push(q.trim());
    }
  } else if (Array.isArray(parsed.queries)) {
    for (const value of parsed.queries) {
      if (typeof value === "string") rawQueries.push(value);
    }
  }
  if (typeof parsed.query === "string") rawQueries.push(parsed.query);
  if (typeof parsed.query1 === "string") rawQueries.push(parsed.query1);
  if (typeof parsed.query2 === "string") rawQueries.push(parsed.query2);
  if (typeof parsed.query3 === "string") rawQueries.push(parsed.query3);
  if (tripLocation) rawQueries.push(tripLocation);

  return {
    subaction: normalizeCalendarSubaction(parsed.subaction),
    queries: dedupeCalendarQueries(rawQueries),
    response: normalizePlannerResponse(parsed.response),
    shouldAct: normalizeShouldAct(parsed.shouldAct),
    title:
      typeof parsed.title === "string" && parsed.title.trim().length > 0
        ? parsed.title.trim()
        : undefined,
    tripLocation,
    timeMin: normalizeIsoDateTime(parsed.timeMin),
    timeMax: normalizeIsoDateTime(parsed.timeMax),
    windowLabel: normalizeWindowLabel(parsed.windowLabel ?? parsed.label),
  };
}

async function resolveCalendarSearchQueries(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  explicitQueries: Array<string | undefined>,
  intent: string,
  llmPlan?: CalendarLlmPlan,
  timeZone?: string,
): Promise<string[]> {
  const providedQueries = dedupeCalendarQueries(
    explicitQueries.map((query) => sanitizeCalendarQuery(query, intent)),
  );
  const heuristicQueries = inferCalendarSearchQueries(intent);
  const llmQueries =
    llmPlan && llmPlan.queries.length > 0
      ? llmPlan.queries
      : await extractCalendarSearchQueriesWithLlm(
          runtime,
          message,
          state,
          intent,
          timeZone,
        );
  const stateQueries = userIntentsFromState(state)
    .reverse()
    .flatMap((candidate) => inferCalendarSearchQueries(candidate));
  const candidates = dedupeCalendarQueries(
    [
      ...providedQueries,
      ...llmQueries,
      ...heuristicQueries,
      ...stateQueries,
    ].map((query) => sanitizeCalendarQuery(query, intent)),
  );
  return [...candidates].sort(
    (left, right) =>
      scoreCalendarQueryCandidate(right, intent) -
      scoreCalendarQueryCandidate(left, intent),
  );
}

function inferCreateEventTitle(intent: string): string | undefined {
  const patterns = [
    /\b(?:create|add|schedule|book|put)\s+(?:a|an|the)?\s*(.+?)(?=\b(?:for|on|at|tomorrow|today|tonight|next|this|from)\b|[?.!,]|$)/i,
    /\b(?:meeting|appointment|call|event)\s+(?:with|for)\s+(.+?)(?=\b(?:for|on|at|tomorrow|today|tonight|next|this|from)\b|[?.!,]|$)/i,
  ];
  for (const pattern of patterns) {
    const match = intent.match(pattern);
    const value = match?.[1]?.trim();
    if (value && !/^(calendar|event|meeting|appointment|call)$/i.test(value)) {
      return value.replace(/\s+/g, " ").trim();
    }
  }
  return undefined;
}

function isShortPreparationEvent(intent: string, title: string): boolean {
  return /\b(get ready|ready for|prep|prepare|packing|pack|leave for|head to|airport|flight|reminder|remind me)\b/i.test(
    `${intent} ${title}`,
  );
}

function resolveCreateEventDurationMinutes(args: {
  explicitDuration: number | undefined;
  extractedDuration: number | undefined;
  intent: string;
  title: string;
  hasExplicitEndAt: boolean;
  hasExplicitWindowPreset: boolean;
  hasExplicitStartAt: boolean;
}): number | undefined {
  const {
    explicitDuration,
    extractedDuration,
    intent,
    title,
    hasExplicitEndAt,
    hasExplicitWindowPreset,
    hasExplicitStartAt,
  } = args;

  if (
    typeof explicitDuration === "number" &&
    Number.isFinite(explicitDuration)
  ) {
    return explicitDuration > 0 ? explicitDuration : undefined;
  }
  if (
    typeof extractedDuration === "number" &&
    Number.isFinite(extractedDuration)
  ) {
    if (extractedDuration > 0) {
      return extractedDuration;
    }
    if (
      isShortPreparationEvent(intent, title) &&
      (hasExplicitStartAt || hasExplicitWindowPreset)
    ) {
      return MIN_CREATE_EVENT_DURATION_MINUTES;
    }
    return undefined;
  }
  if (
    !hasExplicitEndAt &&
    isShortPreparationEvent(intent, title) &&
    (hasExplicitStartAt || hasExplicitWindowPreset)
  ) {
    return MIN_CREATE_EVENT_DURATION_MINUTES;
  }
  return undefined;
}

type CreateEventRequestBuildArgs = {
  details: Record<string, unknown> | undefined;
  extractedDetails: Record<string, unknown>;
  explicitTitle: string | undefined;
  inferredTitle: string | undefined;
  intent: string;
  fallbackRequest?: CreateLifeOpsCalendarEventRequest;
  preferExtractedDetails?: boolean;
};

type CreateEventRequestBuildResult = {
  title: string | undefined;
  resolvedStartAt: string | undefined;
  resolvedWindowPreset:
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;
  request: CreateLifeOpsCalendarEventRequest;
};

function parseCreateEventDurationValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function pickCreateEventStringField(
  args: CreateEventRequestBuildArgs,
  key: string,
): string | undefined {
  const explicit = detailString(args.details, key);
  const extracted = detailString(args.extractedDetails, key);
  const fallback =
    args.fallbackRequest &&
    typeof args.fallbackRequest[
      key as keyof CreateLifeOpsCalendarEventRequest
    ] === "string"
      ? (args.fallbackRequest[
          key as keyof CreateLifeOpsCalendarEventRequest
        ] as string)
      : undefined;
  return args.preferExtractedDetails
    ? (extracted ?? explicit ?? fallback)
    : (explicit ?? extracted ?? fallback);
}

function buildCreateEventRequest(
  args: CreateEventRequestBuildArgs,
): CreateEventRequestBuildResult {
  const extractedTitle = detailString(args.extractedDetails, "title");
  const title = args.preferExtractedDetails
    ? (extractedTitle ??
      args.explicitTitle ??
      args.fallbackRequest?.title ??
      args.inferredTitle)
    : (args.explicitTitle ??
      extractedTitle ??
      args.fallbackRequest?.title ??
      args.inferredTitle);

  const explicitStartAt = detailString(args.details, "startAt");
  const explicitEndAt = detailString(args.details, "endAt");
  const explicitWindowPreset = detailString(args.details, "windowPreset") as
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;
  const extractedStartAt = detailString(args.extractedDetails, "startAt");
  const extractedEndAt = detailString(args.extractedDetails, "endAt");
  const extractedWindowPreset = detailString(
    args.extractedDetails,
    "windowPreset",
  ) as
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;

  let resolvedStartAt: string | undefined;
  let resolvedWindowPreset:
    | "tomorrow_morning"
    | "tomorrow_afternoon"
    | "tomorrow_evening"
    | undefined;
  if (args.preferExtractedDetails && extractedStartAt) {
    resolvedStartAt = extractedStartAt;
    resolvedWindowPreset = undefined;
  } else if (args.preferExtractedDetails && extractedWindowPreset) {
    resolvedStartAt = undefined;
    resolvedWindowPreset = extractedWindowPreset;
  } else {
    resolvedStartAt =
      explicitStartAt ?? extractedStartAt ?? args.fallbackRequest?.startAt;
    resolvedWindowPreset = resolvedStartAt
      ? undefined
      : (explicitWindowPreset ??
        extractedWindowPreset ??
        args.fallbackRequest?.windowPreset);
  }

  const rawEndAt =
    args.preferExtractedDetails &&
    (extractedStartAt || extractedWindowPreset) &&
    !extractedEndAt
      ? undefined
      : args.preferExtractedDetails
        ? (extractedEndAt ?? explicitEndAt ?? args.fallbackRequest?.endAt)
        : (explicitEndAt ?? extractedEndAt ?? args.fallbackRequest?.endAt);

  const explicitDuration = detailNumber(args.details, "durationMinutes");
  const extractedDuration = parseCreateEventDurationValue(
    args.extractedDetails.durationMinutes,
  );
  const fallbackDuration = args.fallbackRequest?.durationMinutes;

  const durationMinutes = resolveCreateEventDurationMinutes({
    explicitDuration: explicitDuration,
    extractedDuration,
    intent: args.intent,
    title: title ?? args.fallbackRequest?.title ?? "",
    hasExplicitEndAt: Boolean(rawEndAt),
    hasExplicitWindowPreset: Boolean(resolvedWindowPreset),
    hasExplicitStartAt: Boolean(resolvedStartAt),
  });
  const resolvedDurationMinutes =
    explicitDuration !== undefined || extractedDuration !== undefined
      ? durationMinutes
      : fallbackDuration;

  return {
    title,
    resolvedStartAt,
    resolvedWindowPreset,
    request: {
      mode:
        (detailString(args.details, "mode") as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined) ?? args.fallbackRequest?.mode,
      side: ((detailString(args.details, "side") as
        | "owner"
        | "agent"
        | undefined) ?? args.fallbackRequest?.side) as
        | "owner"
        | "agent"
        | undefined,
      grantId: detailString(args.details, "grantId"),
      calendarId:
        detailString(args.details, "calendarId") ??
        args.fallbackRequest?.calendarId,
      title: title ?? "",
      description:
        pickCreateEventStringField(args, "description") ??
        args.fallbackRequest?.description,
      location:
        pickCreateEventStringField(args, "location") ??
        args.fallbackRequest?.location,
      startAt: resolvedStartAt,
      endAt: rawEndAt ?? args.fallbackRequest?.endAt,
      timeZone:
        pickCreateEventStringField(args, "timeZone") ??
        args.fallbackRequest?.timeZone,
      durationMinutes: resolvedDurationMinutes,
      windowPreset: resolvedWindowPreset,
      attendees:
        normalizeCalendarAttendees(args.details) ??
        args.fallbackRequest?.attendees,
    },
  };
}

function createEventRequestFingerprint(
  request: CreateLifeOpsCalendarEventRequest,
): string {
  return JSON.stringify({
    title: request.title,
    description: request.description ?? null,
    location: request.location ?? null,
    startAt: request.startAt ?? null,
    endAt: request.endAt ?? null,
    timeZone: request.timeZone ?? null,
    durationMinutes: request.durationMinutes ?? null,
    windowPreset: request.windowPreset ?? null,
    calendarId: request.calendarId ?? null,
    side: request.side ?? null,
    mode: request.mode ?? null,
    grantId: (request as unknown as Record<string, unknown>).grantId ?? null,
  });
}

function formatCreateEventRecentConversation(state: State | undefined): string {
  const conversation = planningConversationLines(state).join("\n").trim();
  return conversation.length > 0 ? conversation : "(none)";
}

function parseCreateEventExtractionResponse(
  rawResponse: string,
): Record<string, unknown> {
  const parsed = parseKeyValueXml<Record<string, unknown>>(rawResponse);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function formatUpdateEventTargetContext(
  event: LifeOpsCalendarEvent | null,
): string {
  if (!event) {
    return "(unknown)";
  }
  const attendees = event.attendees
    .map((attendee) => attendee.displayName ?? attendee.email ?? "")
    .filter((value) => value.length > 0)
    .join(", ");
  return [
    `title: ${event.title}`,
    `startAt: ${event.startAt}`,
    `endAt: ${event.endAt}`,
    `timeZone: ${event.timezone ?? ""}`,
    `formattedStart: ${formatCalendarEventDateTime(event, {
      includeTimeZoneName: true,
    })}`,
    `location: ${event.location ?? ""}`,
    `description: ${event.description ?? ""}`,
    `attendees: ${attendees}`,
  ].join("\n");
}

function shouldRetryCreateEventExtraction(error: LifeOpsServiceError): boolean {
  const normalized = normalizeText(error.message);
  if (error.status === 401 || error.status === 403) {
    return false;
  }
  if (
    /\b(?:not connected|needs re-authentication|unauthorized|forbidden|permission|scope|grant)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return (
    error.status === 400 ||
    error.status === 409 ||
    /\b(?:startat|endat|duration|windowpreset|date|time|timezone|datetime|later than|invalid|bad request|parse|format)\b/.test(
      normalized,
    )
  );
}

async function inferCreateEventDetails(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  calendarContext: CreateEventCalendarContext | null,
  fallbackTimeZone = resolveDefaultTimeZone(),
): Promise<Record<string, unknown>> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  // Anchor the LLM in the present so relative phrases ("tomorrow", "next
  // friday", "april 15") and explicit-but-yearless dates resolve to the
  // correct ISO datetime instead of guessing or returning empty.
  const now = new Date();
  const nowIso = now.toISOString();
  const timeZone = fallbackTimeZone;
  const calendarTimeZone =
    calendarContext?.calendarTimeZone ?? fallbackTimeZone;
  const nowReadable = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const prompt = [
    "Extract calendar event creation fields from the request.",
    "The user may speak in any language.",
    "Use the full recent conversation below, not just the latest message.",
    "Treat the latest user request as authoritative, but recover missing event subject, date, or location from earlier turns when needed.",
    "If the current request is a follow-up, recover the event subject from recent conversation and apply new timing or location constraints from the current request.",
    "Use the calendar context below to ground any timing guess.",
    "Preserve names and places in their original language or script when useful.",
    "Return XML only. No prose. Leave fields empty when unknown.",
    "If a start time or window is implied but duration is not explicit, infer a reasonable positive duration.",
    "For short prep or reminder blocks, use at least 15 minutes instead of 0.",
    "When the user gives a concrete day or date without an exact time-of-day, use the calendar context to infer a plausible open startAt in the calendar timezone. Avoid obvious overlaps with nearby events. If the calendar context is unavailable or the timing is ambiguous, leave startAt empty.",
    "Only use windowPreset for explicit 'tomorrow morning|afternoon|evening' phrasing — never as a fallback for arbitrary dates.",
    "",
    "<response>",
    "  <title>event title</title>",
    "  <description>optional description</description>",
    "  <location>optional location</location>",
    "  <startAt>ISO datetime if explicit or resolvable from a date phrase</startAt>",
    "  <endAt>ISO datetime if explicit</endAt>",
    "  <durationMinutes>number if implied</durationMinutes>",
    "  <windowPreset>tomorrow_morning|tomorrow_afternoon|tomorrow_evening</windowPreset>",
    "  <timeZone>IANA timezone if stated</timeZone>",
    "</response>",
    "",
    `Current timezone: ${timeZone}`,
    `Calendar timezone for scheduling: ${calendarTimeZone}`,
    `Current local datetime: ${nowReadable}`,
    `Current ISO datetime: ${nowIso}`,
    "",
    "<current_request>",
    currentMessage,
    "</current_request>",
    "<resolved_intent>",
    intent,
    "</resolved_intent>",
    "<recent_conversation>",
    recentConversation,
    "</recent_conversation>",
    "<calendar_context>",
    formatCreateEventCalendarContext(calendarContext),
    "</calendar_context>",
  ].join("\n");

  try {
    const result = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const rawResponse = typeof result === "string" ? result : "";
    return parseCreateEventExtractionResponse(rawResponse);
  } catch (error) {
    runtime.logger?.warn?.(
      {
        src: "action:calendar",
        error: error instanceof Error ? error.message : String(error),
      },
      "Calendar create-event extraction model call failed",
    );
    return {};
  }
}

async function inferUpdateEventDetails(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  targetEvent: LifeOpsCalendarEvent | null,
  fallbackTimeZone = targetEvent?.timezone ?? resolveDefaultTimeZone(),
): Promise<Record<string, unknown>> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  const now = new Date();
  const nowIso = now.toISOString();
  const timeZone = fallbackTimeZone;
  const nowReadable = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const prompt = [
    "Extract calendar event update fields from the request.",
    "The user may speak in any language.",
    "Use the full recent conversation below, not just the latest message.",
    "The current event below is the source of truth for unchanged fields.",
    "Only return fields the user is actually changing. Leave fields empty when unchanged or unknown.",
    "If the user asks to move or reschedule the event, compute absolute ISO datetimes for the updated startAt and endAt using the current event as context.",
    "If the user gives a relative shift like later, earlier, push back, or move forward, apply it to the current event timing.",
    "Unless the user explicitly changes the timezone, preserve the current event timezone.",
    "If the user only renames the event, leave startAt, endAt, location, description, and timeZone empty.",
    "Return XML only. No prose.",
    "",
    "<response>",
    "  <title>new event title if changed</title>",
    "  <description>updated description if changed</description>",
    "  <location>updated location if changed</location>",
    "  <startAt>updated ISO datetime if changed</startAt>",
    "  <endAt>updated ISO datetime if changed</endAt>",
    "  <timeZone>IANA timezone if changed or needed to interpret the update</timeZone>",
    "</response>",
    "",
    `Current timezone: ${timeZone}`,
    `Current local datetime: ${nowReadable}`,
    `Current ISO datetime: ${nowIso}`,
    "",
    "<current_request>",
    currentMessage,
    "</current_request>",
    "<resolved_intent>",
    intent,
    "</resolved_intent>",
    "<recent_conversation>",
    recentConversation,
    "</recent_conversation>",
    "<current_event>",
    formatUpdateEventTargetContext(targetEvent),
    "</current_event>",
  ].join("\n");

  try {
    const result = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const rawResponse = typeof result === "string" ? result : "";
    return parseCreateEventExtractionResponse(rawResponse);
  } catch (error) {
    runtime.logger?.warn?.(
      {
        src: "action:calendar",
        error: error instanceof Error ? error.message : String(error),
      },
      "Calendar update-event extraction model call failed",
    );
    return {};
  }
}

async function repairCreateEventDetails(
  runtime: IAgentRuntime,
  message: Memory,
  state: State | undefined,
  intent: string,
  calendarContext: CreateEventCalendarContext | null,
  failedRequest: CreateLifeOpsCalendarEventRequest,
  previousExtraction: Record<string, unknown>,
  error: LifeOpsServiceError,
  fallbackTimeZone = resolveDefaultTimeZone(),
): Promise<Record<string, unknown>> {
  const recentConversation = formatCreateEventRecentConversation(state);
  const currentMessage = messageText(message).trim();
  const now = new Date();
  const timeZone = fallbackTimeZone;
  const calendarTimeZone =
    calendarContext?.calendarTimeZone ?? fallbackTimeZone;
  const nowIso = now.toISOString();
  const nowReadable = new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const prompt = [
    "Extract calendar event creation fields from the request.",
    "The previous create attempt failed. Repair the extraction so the next create attempt succeeds.",
    "Use the full recent conversation below, not just the latest message.",
    "The latest user request is authoritative, but preserve the existing event subject, people, and places unless the user changed them.",
    "Use the calendar context below to ground any timing repair.",
    "Use the exact failure reason to correct only the broken fields.",
    "Return XML only. No prose. Leave fields empty when unchanged or unknown.",
    "",
    "<response>",
    "  <title>event title</title>",
    "  <description>optional description</description>",
    "  <location>optional location</location>",
    "  <startAt>ISO datetime if explicit or resolvable from a date phrase</startAt>",
    "  <endAt>ISO datetime if explicit</endAt>",
    "  <durationMinutes>number if implied</durationMinutes>",
    "  <windowPreset>tomorrow_morning|tomorrow_afternoon|tomorrow_evening</windowPreset>",
    "  <timeZone>IANA timezone if stated</timeZone>",
    "</response>",
    "",
    `Current timezone: ${timeZone}`,
    `Calendar timezone for scheduling: ${calendarTimeZone}`,
    `Current local datetime: ${nowReadable}`,
    `Current ISO datetime: ${nowIso}`,
    `Create failure: ${error.message}`,
    `Previous extraction: ${JSON.stringify(previousExtraction)}`,
    `Previous create request: ${JSON.stringify(failedRequest)}`,
    "",
    "<current_request>",
    currentMessage,
    "</current_request>",
    "<resolved_intent>",
    intent,
    "</resolved_intent>",
    "<recent_conversation>",
    recentConversation,
    "</recent_conversation>",
    "<calendar_context>",
    formatCreateEventCalendarContext(calendarContext),
    "</calendar_context>",
  ].join("\n");

  try {
    const result = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const rawResponse = typeof result === "string" ? result : "";
    return parseCreateEventExtractionResponse(rawResponse);
  } catch (repairError) {
    runtime.logger?.warn?.(
      {
        src: "action:calendar",
        error:
          repairError instanceof Error
            ? repairError.message
            : String(repairError),
      },
      "Calendar create-event repair model call failed",
    );
    return {};
  }
}

function scoreCalendarEvent(
  event: LifeOpsCalendarEvent,
  query: string,
): number {
  const normalizedQuery = normalizeText(query);
  const title = normalizeText(event.title);
  const description = normalizeText(event.description);
  const location = normalizeText(event.location);
  const attendees = event.attendees
    .flatMap((attendee) => [attendee.displayName ?? "", attendee.email ?? ""])
    .map((value) => normalizeText(value))
    .filter((value) => value.length > 0);
  let score = 0;

  const queryVariants = [
    ...new Set([normalizedQuery, ...tokenVariants(normalizedQuery)]),
  ];
  if (queryVariants.some((variant) => title === variant)) {
    score += 100;
  } else if (
    queryVariants.some(
      (variant) => variant.length > 0 && title.includes(variant),
    )
  ) {
    score += 75;
  }

  if (
    queryVariants.some(
      (variant) => variant.length > 0 && description.includes(variant),
    )
  ) {
    score += 35;
  }
  if (
    queryVariants.some(
      (variant) => variant.length > 0 && location.includes(variant),
    )
  ) {
    score += 30;
  }
  if (
    attendees.some((value) =>
      queryVariants.some(
        (variant) => variant.length > 0 && value.includes(variant),
      ),
    )
  ) {
    score += 25;
  }

  const queryTokens = tokenizeForSearch(normalizedQuery);
  if (queryTokens.length > 0) {
    const titleTokens = new Set(tokenizeForSearch(title));
    const descriptionTokens = new Set(tokenizeForSearch(description));
    const locationTokens = new Set(tokenizeForSearch(location));
    const attendeeTokens = attendees.flatMap((value) =>
      tokenizeForSearch(value),
    );
    const attendeeTokenSet = new Set(attendeeTokens);

    score += queryTokens.filter((token) => titleTokens.has(token)).length * 12;
    score +=
      queryTokens.filter((token) => descriptionTokens.has(token)).length * 8;
    score +=
      queryTokens.filter((token) => locationTokens.has(token)).length * 14;
    score +=
      queryTokens.filter((token) => attendeeTokenSet.has(token)).length * 8;
  }

  if (/\b(return|back|home)\b/.test(normalizedQuery)) {
    if (/\b(return|back|home)\b/.test(`${title} ${description}`)) {
      score += 24;
    } else if (
      /\b(flight|travel|trip)\b/.test(`${title} ${description} ${location}`)
    ) {
      score -= 36;
    }
  }

  const dateTerms = eventDateSearchTerms(event);
  if (
    [...dateTerms].some(
      (term) =>
        term === normalizedQuery ||
        normalizedQuery.includes(term) ||
        term.includes(normalizedQuery),
    )
  ) {
    score += 90;
  }
  const dateTokens = new Set(
    [...dateTerms].flatMap((term) => tokenizeForSearch(term)),
  );
  score += queryTokens.filter((token) => dateTokens.has(token)).length * 10;

  return score;
}

function shouldGroundCalendarSearchWithLlm(
  query: string,
  rankedEvents: RankedCalendarSearchCandidate[],
): boolean {
  const strongestScore = rankedEvents[0]?.score ?? 0;
  if (strongestScore <= 0) {
    return false;
  }
  if (strongestScore >= 72) {
    return false;
  }
  return wordCount(query) >= 2 || rankedEvents.length > 1;
}

function normalizeCalendarMatchIdsFromValue(
  value: unknown,
  allowedIds: Set<string>,
): string[] {
  const rawIds: string[] = [];
  if (typeof value === "string") {
    for (const token of value.split(/\s*\|\|\s*|\s*,\s*|\s+/)) {
      if (token.trim().length > 0) {
        rawIds.push(token.trim());
      }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim().length > 0) {
        rawIds.push(item.trim());
      }
    }
  }
  return [...new Set(rawIds.filter((id) => allowedIds.has(id)))];
}

function extractCalendarGroundedMatchIds(
  rawResponse: string,
  allowedIds: Set<string>,
): string[] | null {
  const parsed =
    parseKeyValueXml<Record<string, unknown>>(rawResponse) ??
    parseJSONObjectFromText(rawResponse);
  if (!parsed) {
    return null;
  }

  const possibleKeys = [
    "matchIds",
    "matches",
    "ids",
    "matchId",
    "matchId1",
    "matchId2",
    "matchId3",
  ] as const;
  const sawExplicitMatchField = possibleKeys.some((key) => key in parsed);
  if (!sawExplicitMatchField) {
    return null;
  }

  const ids = possibleKeys.flatMap((key) =>
    normalizeCalendarMatchIdsFromValue(parsed[key], allowedIds),
  );
  return [...new Set(ids)];
}

function formatCalendarCandidateForGrounding(
  candidate: RankedCalendarSearchCandidate,
): string {
  const attendees = candidate.event.attendees
    .map((attendee) => attendee.displayName ?? attendee.email ?? "")
    .filter((value) => value.length > 0)
    .join(", ");
  return [
    `id: ${candidate.event.id}`,
    `score: ${candidate.score}`,
    `title: ${candidate.event.title}`,
    `startAt: ${candidate.event.startAt}`,
    `location: ${candidate.event.location ?? ""}`,
    `description: ${(candidate.event.description ?? "").slice(0, 240)}`,
    `attendees: ${attendees}`,
  ].join("\n");
}

async function groundCalendarSearchMatchesWithLlm(
  runtime: IAgentRuntime,
  state: State | undefined,
  intent: string,
  queries: string[],
  candidates: RankedCalendarSearchCandidate[],
): Promise<string[] | null> {
  if (candidates.length === 0) {
    return [];
  }

  const recentConversation = formatCreateEventRecentConversation(state);
  const allowedIds = new Set(candidates.map((candidate) => candidate.event.id));
  const prompt = [
    "Decide which candidate calendar events directly match the user's request.",
    "Be strict.",
    "Return NO matches when the candidate only shares a generic time window or vague travel context.",
    "If the request names a person, company, topic, or event name, only match candidates that explicitly mention that subject in the title, description, location, or attendees.",
    "Flights only count when the request is actually about flights/travel, or the flight text explicitly mentions the named subject.",
    "Return TOON only. No prose. No <think>.",
    "Use || to separate multiple ids.",
    "",
    "Example:",
    "matchIds: evt_1 || evt_2",
    "reason:",
    "",
    "<resolved_intent>",
    intent,
    "</resolved_intent>",
    "<search_queries>",
    queries.join(" || "),
    "</search_queries>",
    "<recent_conversation>",
    recentConversation,
    "</recent_conversation>",
    "",
    "Candidates:",
    ...candidates.map(
      (candidate, index) =>
        `candidate ${index + 1}\n${formatCalendarCandidateForGrounding(candidate)}`,
    ),
  ].join("\n");

  try {
    const result = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const rawResponse = typeof result === "string" ? result : "";
    return extractCalendarGroundedMatchIds(rawResponse, allowedIds);
  } catch (error) {
    runtime.logger?.warn?.(
      {
        src: "action:calendar",
        error: error instanceof Error ? error.message : String(error),
      },
      "Calendar search grounding model call failed",
    );
    return null;
  }
}

function isTravelEvent(event: LifeOpsCalendarEvent): boolean {
  return /\b(flight|fly|travel|trip|hotel|stay|lodging|airbnb|check[- ]?in|check[- ]?out|return|home)\b/i.test(
    `${event.title} ${event.description} ${event.location}`,
  );
}

function eventStartMs(event: LifeOpsCalendarEvent): number {
  return Date.parse(event.startAt);
}

function eventEndMs(event: LifeOpsCalendarEvent): number {
  const parsed = Date.parse(event.endAt);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return eventStartMs(event);
}

function resolveTripWindowEvents(
  events: LifeOpsCalendarEvent[],
  location: string,
): LifeOpsCalendarEvent[] | null {
  const anchors = events
    .map((event) => ({
      event,
      score:
        scoreCalendarEvent(event, location) + (isTravelEvent(event) ? 12 : 0),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) => eventStartMs(left.event) - eventStartMs(right.event),
    );

  if (anchors.length === 0) {
    return null;
  }

  const windowStart = Math.min(
    ...anchors.map((candidate) => eventStartMs(candidate.event)),
  );
  const windowEnd = Math.max(
    ...anchors.map((candidate) => eventEndMs(candidate.event)),
  );

  return events
    .filter(
      (event) =>
        eventEndMs(event) >= windowStart && eventStartMs(event) <= windowEnd,
    )
    .sort((left, right) => eventStartMs(left) - eventStartMs(right));
}

function formatCalendarMoment(event: LifeOpsCalendarEvent): string {
  if (event.isAllDay) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: event.timezone || undefined,
      month: "short",
      day: "numeric",
    }).format(new Date(event.startAt));
  }
  return formatCalendarEventDateTime(event);
}

function formatTripWindowResults(
  events: LifeOpsCalendarEvent[],
  location: string,
): string {
  if (events.length === 0) {
    return `I couldn't find any upcoming calendar events while you're in ${location}.`;
  }

  const lines = [`Here's what's on your calendar while you're in ${location}:`];
  for (const event of events.slice(0, 12)) {
    lines.push(`- ${formatCalendarMoment(event)}: **${event.title}**`);
  }
  return lines.join("\n");
}

function formatCalendarSearchResults(
  events: LifeOpsCalendarEvent[],
  query: string,
  label: string,
  intent: string,
): string {
  if (events.length === 0) {
    return `No calendar events matched "${query}" ${label}.`;
  }
  if (events.length === 1) {
    const event = events[0];
    const normalizedIntent = normalizeText(intent);
    const matchingSubject =
      /\b(flight|flights|fly|travel|trip|return|back|home)\b/.test(
        `${normalizedIntent} ${query}`,
      )
        ? "flight"
        : "calendar event";
    return `Your matching ${matchingSubject} is **${event.title}** (${formatCalendarMoment(event)}).`;
  }
  const lines = [
    `Found ${events.length} calendar event${events.length === 1 ? "" : "s"} for "${query}" ${label}:`,
  ];
  for (const event of events.slice(0, 8)) {
    const when = event.isAllDay
      ? "all day"
      : formatCalendarEventDateTime(event);
    lines.push(`- **${event.title}** (${when})`);
    if (event.location) {
      lines.push(`  Location: ${event.location}`);
    }
    if (event.description) {
      lines.push(`  ${event.description.slice(0, 120)}`);
    }
  }
  return lines.join("\n");
}

function normalizeCalendarAttendees(
  details: Record<string, unknown> | undefined,
): CreateLifeOpsCalendarEventAttendee[] | undefined {
  const attendees = detailArray(details, "attendees");
  if (!attendees) {
    return undefined;
  }
  const mapped: Array<CreateLifeOpsCalendarEventAttendee | null> =
    attendees.map((attendee) => {
      if (typeof attendee === "string" && attendee.trim().length > 0) {
        return {
          email: attendee.trim(),
        };
      }
      if (
        !attendee ||
        typeof attendee !== "object" ||
        Array.isArray(attendee)
      ) {
        return null;
      }
      const record = attendee as Record<string, unknown>;
      const email =
        typeof record.email === "string" && record.email.trim().length > 0
          ? record.email.trim()
          : null;
      if (!email) {
        return null;
      }
      return {
        email,
        displayName:
          typeof record.displayName === "string" &&
          record.displayName.trim().length > 0
            ? record.displayName.trim()
            : undefined,
        optional:
          typeof record.optional === "boolean" ? record.optional : undefined,
      };
    });
  const normalized = mapped.filter(
    (attendee): attendee is CreateLifeOpsCalendarEventAttendee =>
      attendee !== null,
  );
  return normalized.length > 0 ? normalized : undefined;
}

export const calendarAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: "CALENDAR_ACTION",
  similes: [
    "CALENDAR",
    "CHECK_CALENDAR",
    "SCHEDULE_EVENT",
    "CREATE_CALENDAR_EVENT",
    "SEARCH_CALENDAR",
    "NEXT_MEETING",
    "ITINERARY",
    "TRAVEL_SCHEDULE",
    "CHECK_SCHEDULE",
  ],
  description:
    "Interact with Google Calendar through LifeOps. " +
    "USE this action for: viewing today's or this week's schedule; checking the next upcoming event; " +
    "searching events by title, attendee, location, or date range; creating new calendar events; " +
    "querying travel itineraries, flights, hotel stays, and trip windows. " +
    "DO NOT use this action for email inbox work, drafting or sending emails — use GMAIL_ACTION instead. " +
    "DO NOT use this action for personal habits, goals, routines, or reminders — use LIFE instead. " +
    "This action provides the final grounded reply; do not pair it with a speculative REPLY action.",
  descriptionCompressed: "Google Calendar via LifeOps: view schedule, search events, create events, query travel. Not for email or habits.",
  suppressPostActionContinuation: true,
  validate: async (runtime, message, state) => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      return false;
    }
    return hasCalendarContextSignal(message, state);
  },
  handler: async (
    runtime,
    message,
    state,
    options,
    callback?: HandlerCallback,
  ) => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text =
        "Calendar actions are restricted to the owner, explicitly granted users, and the agent.";
      await callback?.({ text });
      return {
        success: false,
        text,
      };
    }

    const rawParams = (options as HandlerOptions | undefined)?.parameters as
      | CalendarActionParams
      | undefined;
    const params = rawParams ?? ({} as CalendarActionParams);
    const intent = resolveCalendarIntent(params.intent, message, state);
    const details = normalizeCalendarDetails(params.details);
    const planningTimeZone = resolveCalendarTimeZone(details);
    const llmPlan = await extractCalendarPlanWithLlm(
      runtime,
      message,
      state,
      intent,
      planningTimeZone,
    );
    const heuristicQuery = inferCalendarSearchQuery(intent);
    const inferredQuery = sanitizeCalendarQuery(
      params.query ?? detailString(details, "query"),
      intent,
    );
    const inferredQueries = dedupeCalendarQueries([
      inferredQuery,
      ...llmPlan.queries,
      ...(params.queries ?? []),
      ...(detailArray(details, "queries")?.map((value) =>
        typeof value === "string" ? value : undefined,
      ) ?? []),
    ]);
    const explicitTitle =
      (typeof params.title === "string" && params.title.trim().length > 0
        ? params.title.trim()
        : undefined) ??
      detailString(details, "title") ??
      llmPlan.title;
    const inferredTitle =
      explicitTitle ?? llmPlan.title ?? inferCreateEventTitle(intent);
    const tripWindowIntent =
      llmPlan.tripLocation && llmPlan.tripLocation.trim().length > 0
        ? { location: llmPlan.tripLocation.trim() }
        : inferTripWindowIntent(intent);
    const explicitSubaction = params.subaction as CalendarSubaction | undefined;
    const preferExplicitSubaction = shouldTrustExplicitCalendarSubaction(
      explicitSubaction,
      params,
      details,
    );
    const hasExplicitCalendarExecutionInput = Boolean(
      params.subaction ||
        params.title ||
        params.query ||
        (params.queries?.length ?? 0) > 0 ||
        detailString(details, "query") ||
        (detailArray(details, "queries")?.length ?? 0) > 0 ||
        detailString(details, "eventId") ||
        detailString(details, "startAt") ||
        detailString(details, "endAt") ||
        detailString(details, "location") ||
        detailString(details, "windowPreset") ||
        detailNumber(details, "windowDays"),
    );
    const forcedSubaction = ((): CalendarSubaction | null => {
      const text = normalizeText(messageText(message));
      if (
        /\b(?:rename|change|move|reschedule|push back)\b[^.?!]+\bto\b/.test(
          text,
        ) ||
        /\b(rename|reschedule|update|edit|modify|change|move)\b.*\b(event|meeting|appointment|calendar|invite)\b/.test(
          text,
        )
      ) {
        return "update_event";
      }
      if (
        /\b(delete|remove|cancel|drop|get rid of|trash|kill)\b.*\b(event|meeting|appointment|calendar|invite)\b/.test(
          text,
        ) ||
        /\b(delete|remove|cancel)\b.+\b(today|tomorrow|tonight|this week|next week)\b/.test(
          text,
        )
      ) {
        return "delete_event";
      }
      if (
        /\b(create|add|book|schedule|make|put)\b[^.?!]*\b(event|meeting|appointment|invite|calendar)\b/.test(
          text,
        )
      ) {
        return "create_event";
      }
      if (
        /\b(show|list|tell|give|read)\b[^.?!]*\b(all|every|everything|entire|full|whole)\b[^.?!]*\b(event|events|calendar|schedule|meeting|meetings|appointment|appointments|entry|entries|agenda)\b/.test(
          text,
        ) ||
        /\b(all|every|everything)\b\s+(?:my\s+)?(?:calendar|events?|meetings?|appointments?)\b/.test(
          text,
        )
      ) {
        return "feed";
      }
      return null;
    })();

    let subaction: CalendarSubaction;
    if (tripWindowIntent) {
      subaction = "trip_window";
    } else if (forcedSubaction) {
      subaction = forcedSubaction;
    } else if (llmPlan.subaction && !preferExplicitSubaction) {
      subaction = llmPlan.subaction;
    } else if (params.subaction) {
      subaction = params.subaction as CalendarSubaction;
    } else {
      runtime.logger?.warn?.(
        { src: "action:calendar", intent },
        "Calendar LLM plan returned no subaction; falling back to regex inference",
      );
      subaction = inferCalendarSubaction(
        normalizeText(intent),
        details,
        inferredQuery ?? heuristicQuery,
      );
    }
    runtime.logger?.debug?.(
      {
        src: "action:calendar",
        subaction,
        forcedSubaction,
        rawMessage: messageText(message).slice(0, 200),
        resolvedIntent: intent.slice(0, 200),
        params: {
          subaction: params.subaction,
          title: params.title,
          intent: params.intent?.slice(0, 200),
        },
        detailKeys: details ? Object.keys(details) : [],
      },
      "calendar action dispatch",
    );
    const service = new LifeOpsService(runtime);
    const respond = async <
      T extends NonNullable<ActionResult["data"]> | undefined,
    >(payload: {
      success: boolean;
      text: string;
      data?: T;
    }) => {
      await callback?.({
        text: payload.text,
        source: "action",
        action: "CALENDAR_ACTION",
      });
      return payload;
    };
    const renderReply = (
      scenario: string,
      fallback: string,
      context?: Record<string, unknown>,
    ) =>
      renderCalendarActionReply({
        runtime,
        message,
        state,
        intent,
        scenario,
        fallback,
        context,
      });

    if (
      !hasExplicitCalendarExecutionInput &&
      !forcedSubaction &&
      !tripWindowIntent &&
      looksLikeLifeReminderRequestForCalendarAction(messageText(message))
    ) {
      const fallback =
        "That sounds like a reminder or todo rather than a calendar event. Tell me the reminder and when it should happen.";
      return respond({
        success: true,
        text: await renderReply("out_of_domain", fallback, {
          requestedDomain: "lifeops",
        }),
        data: {
          noop: true,
          suggestedSubaction: null,
        },
      });
    }

    if (
      llmPlan.shouldAct === false &&
      !hasExplicitCalendarExecutionInput &&
      !forcedSubaction &&
      !tripWindowIntent
    ) {
      const fallback =
        llmPlan.response ?? buildCalendarReplyOnlyFallback(llmPlan.subaction);
      return respond({
        success: true,
        text: await renderReply("reply_only", fallback, {
          llmPlan,
          suggestedSubaction: llmPlan.subaction,
        }),
        data: {
          noop: true,
          ...(llmPlan.subaction
            ? { suggestedSubaction: llmPlan.subaction }
            : {}),
        },
      });
    }

    try {
      const google = await getGoogleCapabilityStatus(service);

      if (subaction === "next_event") {
        if (!google.hasCalendarRead) {
          return respond({
            success: false,
            text: calendarReadUnavailableMessage(google),
          });
        }
        const context = await service.getNextCalendarEventContext(
          INTERNAL_URL,
          {
            calendarId: detailString(details, "calendarId"),
            timeZone: resolveCalendarTimeZone(details),
          },
        );
        const fallback = formatNextEventContext(context);
        return respond({
          success: true,
          text: await renderReply("next_event", fallback, {
            event: context,
          }),
          data: toActionData(context),
        });
      }

      if (subaction === "create_event") {
        if (!google.hasCalendarWrite) {
          return respond({
            success: false,
            text: calendarWriteUnavailableMessage(google),
          });
        }
        let calendarContext: CreateEventCalendarContext | null = null;
        try {
          calendarContext = await loadCreateEventCalendarContext(
            service,
            details,
            google.hasCalendarRead,
          );
        } catch (error) {
          runtime.logger?.warn?.(
            {
              src: "action:calendar",
              error: error instanceof Error ? error.message : String(error),
            },
            "Calendar create-event context fetch failed",
          );
        }
        const extractedDetails = await inferCreateEventDetails(
          runtime,
          message,
          state,
          intent,
          calendarContext,
          planningTimeZone,
        );
        const { title, resolvedStartAt, resolvedWindowPreset, request } =
          buildCreateEventRequest({
            details,
            extractedDetails,
            explicitTitle,
            inferredTitle,
            intent,
          });
        if (!title) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_create_event_title",
              "What event do you want to add?",
              {
                missing: ["title"],
              },
            ),
          });
        }
        // The LifeOps service throws a raw 400 when neither startAt nor a
        // window preset is supplied. Catch that case here so the user gets a
        // useful prompt instead of "startAt is required when windowPreset is
        // not provided" — and so the failure path doesn't re-trigger the
        // action via post-action continuation.
        if (!resolvedStartAt && !resolvedWindowPreset) {
          const suggestedStartAt = title
            ? suggestCreateEventStartAt({
                currentMessage: messageText(message).trim(),
                intent,
                title,
                calendarContext,
              })
            : null;
          const fallback = suggestedStartAt
            ? `i can tentatively put "${title}" on ${formatCalendarEventDateTime(
                {
                  startAt: suggestedStartAt.startAt,
                  timezone: suggestedStartAt.timeZone,
                },
                { includeTimeZoneName: true },
              )}. if you want a different time, tell me what works better.`
            : `i need a time for "${title}" in ${
                calendarContext?.calendarTimeZone ??
                resolveCalendarTimeZone(details)
              }. try "tomorrow morning", "tomorrow afternoon", "tomorrow evening", or give me a specific date and time.`;
          return respond({
            success: false,
            text: await renderReply("clarify_create_event_time", fallback, {
              title,
              suggestedStartAt,
              calendarTimeZone:
                calendarContext?.calendarTimeZone ??
                resolveCalendarTimeZone(details),
            }),
          });
        }
        let requestToCreate = request;
        let event: LifeOpsCalendarEvent;
        try {
          event = await service.createCalendarEvent(
            INTERNAL_URL,
            requestToCreate,
          );
        } catch (error) {
          if (
            error instanceof LifeOpsServiceError &&
            shouldRetryCreateEventExtraction(error)
          ) {
            const repairedDetails = await repairCreateEventDetails(
              runtime,
              message,
              state,
              intent,
              calendarContext,
              requestToCreate,
              extractedDetails,
              error,
              planningTimeZone,
            );
            const repaired = buildCreateEventRequest({
              details,
              extractedDetails: repairedDetails,
              explicitTitle,
              inferredTitle,
              intent,
              fallbackRequest: requestToCreate,
              preferExtractedDetails: true,
            });
            if (
              repaired.title &&
              (repaired.resolvedStartAt || repaired.resolvedWindowPreset) &&
              createEventRequestFingerprint(repaired.request) !==
                createEventRequestFingerprint(requestToCreate)
            ) {
              runtime.logger?.info?.(
                {
                  src: "action:calendar",
                  error: error.message,
                  priorRequest: requestToCreate,
                  repairedRequest: repaired.request,
                },
                "Retrying calendar create-event after repair extraction",
              );
              requestToCreate = repaired.request;
              event = await service.createCalendarEvent(
                INTERNAL_URL,
                requestToCreate,
              );
            } else {
              throw error;
            }
          } else {
            throw error;
          }
        }
        const fallback = `Created calendar event "${event.title}" for ${formatCalendarEventDateTime(
          event,
          {
            includeTimeZoneName: true,
          },
        )}.`;
        return respond({
          success: true,
          text: await renderReply("created_event", fallback, {
            event,
            request: requestToCreate,
          }),
          data: toActionData(event),
        });
      }

      if (subaction === "update_event") {
        if (!google.hasCalendarWrite) {
          return respond({
            success: false,
            text: calendarWriteUnavailableMessage(google),
          });
        }
        // Parse "rename X to Y" / "change X to Y" patterns directly from
        // the user message. The chat LLM tends to put only the NEW title in
        // params.title, but we need the OLD title to find the event we're
        // patching. Pull both halves from the literal phrase if it's there.
        // We try the raw message first because resolveCalendarIntent may
        // have replaced the user's text with the LLM's rewritten version,
        // which often drops "rename" entirely.
        const rawMessageText = messageText(message);
        const renamePattern =
          /\b(?:rename|change|update|edit)\b\s+["“]?([^"”]+?)["”]?\s+(?:to|into|as)\s+["“]?([^"”]+?)["”]?(?:[.!?]|$)/i;
        const renameMatch =
          rawMessageText.match(renamePattern) ?? intent.match(renamePattern);
        const oldTitleFromIntent = renameMatch?.[1]?.trim();
        const newTitleFromIntent = renameMatch?.[2]?.trim();

        const explicitEventId = detailString(details, "eventId");
        let resolvedEventId = explicitEventId;
        let resolvedCalendarId = detailString(details, "calendarId");
        let targetEvent: LifeOpsCalendarEvent | null = null;
        // Same lookup-by-title fallback as delete_event so the user can say
        // "rename my dentist appointment to dentist follow-up" without first
        // copying an opaque google id.
        if (!resolvedEventId) {
          // Use a wide lookup window — events can be far in the future
          // (e.g. a birthday in 2027). The default narrow window would
          // miss anything beyond the current day.
          // forceSync: true is critical here — without it the feed query
          // returns the local cache (life_calendar_events), which may not
          // contain far-future events that have never been synced before
          // (or any events at all if the cache was wiped). Forcing the
          // sync makes the bot pull a fresh window from Google so the
          // title-based lookup actually has events to filter against.
          const wideLookup = buildWideLookupRange(
            resolveCalendarTimeZone(details),
          );
          const feed = await service.getCalendarFeed(INTERNAL_URL, {
            mode: detailString(details, "mode") as
              | "local"
              | "remote"
              | "cloud_managed"
              | undefined,
            side: detailString(details, "side") as
              | "owner"
              | "agent"
              | undefined,
            grantId: detailString(details, "grantId"),
            calendarId: detailString(details, "calendarId"),
            timeZone: resolveCalendarTimeZone(details),
            forceSync: true,
            ...wideLookup,
          });
          // Prefer the OLD title parsed from "rename X to Y" — explicit
          // title from the chat LLM almost always carries the NEW name.
          const titleHint =
            oldTitleFromIntent ?? explicitTitle ?? inferredTitle;
          const candidates = titleHint
            ? feed.events.filter((e) =>
                normalizeText(e.title).includes(normalizeText(titleHint)),
              )
            : feed.events;
          if (candidates.length === 0) {
            const fallback = titleHint
              ? `i couldn't find an event matching "${titleHint}" in that window.`
              : "i couldn't find any events to update in that window. give me a title or a date.";
            return respond({
              success: false,
              text: await renderReply("update_event_not_found", fallback, {
                titleHint,
              }),
            });
          }
          if (candidates.length > 1) {
            const fallback = buildCalendarEventDisambiguationFallback({
              action: "update",
              candidates,
              titleHint,
            });
            return respond({
              success: false,
              text: await renderReply("clarify_update_event_target", fallback, {
                candidateCount: candidates.length,
                titleHint,
                candidates,
              }),
            });
          }
          targetEvent = candidates[0];
          resolvedEventId = targetEvent.externalId;
          resolvedCalendarId = targetEvent.calendarId;
        }
        const newTitle =
          newTitleFromIntent ??
          detailString(details, "newTitle") ??
          explicitTitle;

        // Reuse the same LLM extractor that create_event uses to pull
        // startAt / endAt / location / description out of the user's intent
        // text. The chat LLM rarely populates `details.startAt` directly for
        // an update — it just rewrites the intent and lets the action figure
        // out the time. Without this we'd PATCH with no fields and the
        // event wouldn't actually move.
        //
        // CRITICAL: only run the extractor when the user actually mentioned
        // a time. For pure rename intents like "rename X to Y" the LLM will
        // happily hallucinate a startAt from the year in the new title
        // ("rename my party 2027 to ..." → startAt 2027-01-01), and a
        // PATCH with start.dateTime but no matching end.dateTime triggers
        // Google's "Bad Request" rejection. Detect time keywords in the
        // raw message before invoking the extractor.
        const explicitStartAtForUpdate = detailString(details, "startAt");
        const explicitEndAtForUpdate = detailString(details, "endAt");
        const rawForUpdate = normalizeText(messageText(message));
        const hasTimeAnchor =
          /\b(at|on|by|from|until)\s+\d/.test(rawForUpdate) ||
          /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/.test(
            rawForUpdate,
          ) ||
          /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/.test(rawForUpdate) ||
          /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(rawForUpdate);
        const hasRelativeShiftCue =
          /\b(?:later|earlier|push back|push it back|bring forward|move forward|move back|delay|postpone|advance)\b/.test(
            rawForUpdate,
          );
        const needsTimeExtraction =
          (hasTimeAnchor || hasRelativeShiftCue) &&
          !(
            explicitStartAtForUpdate ||
            explicitEndAtForUpdate ||
            detailNumber(details, "durationMinutes")
          );
        const shouldInferUpdateDetails =
          Boolean(targetEvent) &&
          (needsTimeExtraction ||
            /\b(?:rename|change|move|reschedule|update|edit|location|description|notes)\b/.test(
              rawForUpdate,
            ));
        const extractedForUpdate = shouldInferUpdateDetails
          ? await inferUpdateEventDetails(
              runtime,
              message,
              state,
              intent,
              targetEvent,
              targetEvent?.timezone ?? planningTimeZone,
            )
          : needsTimeExtraction
            ? await inferCreateEventDetails(
                runtime,
                message,
                state,
                intent,
                null,
                targetEvent?.timezone ?? planningTimeZone,
              )
            : ({} as Record<string, unknown>);
        const extractedStartAt =
          typeof extractedForUpdate.startAt === "string"
            ? extractedForUpdate.startAt.trim()
            : undefined;
        const extractedEndAt =
          typeof extractedForUpdate.endAt === "string"
            ? extractedForUpdate.endAt.trim()
            : undefined;
        const extractedLocation =
          typeof extractedForUpdate.location === "string"
            ? extractedForUpdate.location.trim()
            : undefined;
        const extractedDescription =
          typeof extractedForUpdate.description === "string"
            ? extractedForUpdate.description.trim()
            : undefined;
        const extractedTimeZoneForUpdate =
          typeof extractedForUpdate.timeZone === "string"
            ? extractedForUpdate.timeZone.trim()
            : undefined;

        const event = await service.updateCalendarEvent(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          calendarId: resolvedCalendarId,
          eventId: resolvedEventId ?? "",
          title: newTitle,
          description:
            detailString(details, "description") ?? extractedDescription,
          location: detailString(details, "location") ?? extractedLocation,
          startAt: explicitStartAtForUpdate ?? extractedStartAt,
          endAt: explicitEndAtForUpdate ?? extractedEndAt,
          timeZone:
            detailString(details, "timeZone") ??
            extractedTimeZoneForUpdate ??
            targetEvent?.timezone ??
            undefined,
        });
        const fallback = `updated "${event.title}" — ${formatCalendarEventDateTime(
          event,
          {
            includeTimeZoneName: true,
          },
        )}.`;
        return respond({
          success: true,
          text: await renderReply("updated_event", fallback, {
            event,
            targetEvent,
          }),
          data: toActionData(event),
        });
      }

      if (subaction === "delete_event") {
        if (!google.hasCalendarWrite) {
          return respond({
            success: false,
            text: calendarWriteUnavailableMessage(google),
          });
        }
        const explicitEventId = detailString(details, "eventId");
        const calendarIdForDelete = detailString(details, "calendarId");
        // The LLM may not know the event id directly. Fall back to a feed
        // lookup so phrases like "delete the duplicate test event tomorrow"
        // can resolve to a concrete event without forcing the user to copy
        // an opaque google id from the bot's previous reply.
        const resolvedEventId = explicitEventId;
        let resolvedEventTitle: string | undefined;
        const resolvedCalendarId = calendarIdForDelete;
        if (!resolvedEventId) {
          // For delete-by-title we honor an explicit time window if the
          // user gave one ("delete the test event tomorrow"); otherwise we
          // search wide so far-future events are still findable.
          // forceSync: true ensures the lookup actually queries Google
          // instead of returning a stale (or empty) local cache.
          const hasExplicitWindow =
            /\b(today|tomorrow|tonight|this week|next week|the week after|this weekend|next weekend|weekend|this month|next month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
              intent,
            );
          const feedRequest = hasExplicitWindow
            ? resolveCalendarWindow(intent, details, false, llmPlan).request
            : {
                calendarId: detailString(details, "calendarId"),
                timeZone: resolveCalendarTimeZone(details),
                ...buildWideLookupRange(resolveCalendarTimeZone(details)),
              };
          const feed = await service.getCalendarFeed(INTERNAL_URL, {
            mode: detailString(details, "mode") as
              | "local"
              | "remote"
              | "cloud_managed"
              | undefined,
            side: detailString(details, "side") as
              | "owner"
              | "agent"
              | undefined,
            grantId: detailString(details, "grantId"),
            forceSync: true,
            ...feedRequest,
          });
          const titleHint = explicitTitle ?? inferredTitle;
          const candidates = titleHint
            ? feed.events.filter((e) =>
                normalizeText(e.title).includes(normalizeText(titleHint)),
              )
            : feed.events;
          if (candidates.length === 0) {
            const fallback = titleHint
              ? `i couldn't find an event matching "${titleHint}" in that window.`
              : "i couldn't find any events to delete in that window. give me a title or a date.";
            return respond({
              success: false,
              text: await renderReply("delete_event_not_found", fallback, {
                titleHint,
              }),
            });
          }

          // Detect "delete all / delete both / delete N" phrasing — when the
          // user explicitly opts in to multi-delete, sweep every match.
          const deleteAllMatch = shouldDeleteAllMatchingCalendarEvents({
            intent,
            titleHint,
            candidateCount: candidates.length,
          });

          if (candidates.length > 1 && !deleteAllMatch) {
            const fallback = buildCalendarEventDisambiguationFallback({
              action: "delete",
              candidates,
              titleHint,
            });
            return respond({
              success: false,
              text: await renderReply("clarify_delete_event_target", fallback, {
                candidateCount: candidates.length,
                titleHint,
                candidates,
              }),
            });
          }

          const targets = deleteAllMatch ? candidates : [candidates[0]];
          const deleteResults: Array<{
            title: string;
            ok: boolean;
            error?: string;
          }> = [];
          for (const target of targets) {
            try {
              await service.deleteCalendarEvent(INTERNAL_URL, {
                mode: detailString(details, "mode") as
                  | "local"
                  | "remote"
                  | "cloud_managed"
                  | undefined,
                side: detailString(details, "side") as
                  | "owner"
                  | "agent"
                  | undefined,
                grantId: detailString(details, "grantId"),
                calendarId: target.calendarId,
                eventId: target.externalId,
              });
              deleteResults.push({ title: target.title, ok: true });
            } catch (err) {
              deleteResults.push({
                title: target.title,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          const okCount = deleteResults.filter((r) => r.ok).length;
          const failCount = deleteResults.length - okCount;
          const publicDeleteResults = deleteResults.map((result) => ({
            title: result.title,
            ok: result.ok,
          }));
          const summary =
            failCount === 0
              ? targets.length === 1
                ? `deleted "${deleteResults[0].title}".`
                : `deleted ${okCount} matching events.`
              : okCount === 0
                ? `I couldn't delete those ${deleteResults.length} matching events. Try again in a bit or tell me which one to remove.`
                : `Deleted ${okCount} matching event${okCount === 1 ? "" : "s"}, but ${failCount} failed. Tell me which one to remove if you want me to retry individually.`;
          return respond({
            success: failCount === 0,
            text: await renderReply("deleted_event", summary, {
              deleteResults: publicDeleteResults,
              okCount,
              failCount,
            }),
          });
        }
        // Path: explicit eventId was given, no feed lookup needed
        if (!resolvedEventId) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_delete_event_target",
              "i need an event id or a title + date to delete an event.",
              {
                missing: ["event target"],
              },
            ),
          });
        }
        await service.deleteCalendarEvent(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          calendarId: resolvedCalendarId,
          eventId: resolvedEventId,
        });
        const fallback = resolvedEventTitle
          ? `deleted "${resolvedEventTitle}".`
          : "deleted that calendar event.";
        return respond({
          success: true,
          text: await renderReply("deleted_event", fallback, {
            eventTitle: resolvedEventTitle,
          }),
        });
      }

      if (!google.hasCalendarRead) {
        return respond({
          success: false,
          text: calendarReadUnavailableMessage(google),
        });
      }

      if (subaction === "trip_window" && tripWindowIntent) {
        const feed = await service.getCalendarFeed(INTERNAL_URL, {
          mode: detailString(details, "mode") as
            | "local"
            | "remote"
            | "cloud_managed"
            | undefined,
          side: detailString(details, "side") as "owner" | "agent" | undefined,
          grantId: detailString(details, "grantId"),
          ...resolveTripWindowRequest(details, llmPlan),
        });
        const itineraryEvents = resolveTripWindowEvents(
          feed.events,
          tripWindowIntent.location,
        );
        if (!itineraryEvents || itineraryEvents.length === 0) {
          const fallback = `I couldn't find a clear trip window for ${tripWindowIntent.location} in your upcoming calendar.`;
          return respond({
            success: true,
            text: await renderReply("trip_window_not_found", fallback, {
              location: tripWindowIntent.location,
            }),
            data: toActionData({
              ...feed,
              location: tripWindowIntent.location,
              events: [],
            }),
          });
        }
        const fallback = formatTripWindowResults(
          itineraryEvents,
          tripWindowIntent.location,
        );
        return respond({
          success: true,
          text: await renderReply("trip_window_results", fallback, {
            location: tripWindowIntent.location,
            events: itineraryEvents,
          }),
          data: toActionData({
            ...feed,
            location: tripWindowIntent.location,
            events: itineraryEvents,
          }),
        });
      }

      // When the user explicitly asks for "all events" / "everything" / a
      // multi-year span, broaden the lookup window past the default
      // "today only" feed window. resolveCalendarWindow's default is too
      // narrow for these queries — without this branch, "show all my
      // events" returns "no events today" even when the calendar has
      // dozens of upcoming items. We apply this regardless of whether the
      // chat LLM picked feed or search_events because both subactions go
      // through this code path.
      const rawMessageNorm = normalizeText(messageText(message));
      const wantsWideWindow =
        /\b(all|every|everything|entire|full|whole)\b[^.?!]*\b(event|events|calendar|schedule|meeting|meetings|appointment|appointments|entry|entries|agenda)\b/.test(
          rawMessageNorm,
        ) ||
        /\b(next|past|last)\s+\d+\s*(year|years|month|months|weeks?)\b/.test(
          rawMessageNorm,
        ) ||
        /\b(today\s+(?:until|through|to)\s+next\s+(?:year|month))\b/.test(
          rawMessageNorm,
        ) ||
        /\bevery\s+calendar\s+entry\b/.test(rawMessageNorm);
      const baseResolved = resolveCalendarWindow(
        intent,
        details,
        subaction === "search_events" || wantsWideWindow,
        llmPlan,
      );
      const request = wantsWideWindow
        ? {
            ...baseResolved.request,
            ...buildWideLookupRange(resolveCalendarTimeZone(details)),
          }
        : baseResolved.request;
      const label = wantsWideWindow
        ? "across the full window"
        : baseResolved.label;
      const feed = await service.getCalendarFeed(INTERNAL_URL, {
        mode: detailString(details, "mode") as
          | "local"
          | "remote"
          | "cloud_managed"
          | undefined,
        side: detailString(details, "side") as "owner" | "agent" | undefined,
        grantId: detailString(details, "grantId"),
        forceSync: wantsWideWindow,
        ...request,
      });

      if (subaction === "search_events") {
        const searchQueries = await resolveCalendarSearchQueries(
          runtime,
          message,
          state,
          [...inferredQueries],
          intent,
          llmPlan,
          planningTimeZone,
        );
        const query = searchQueries[0];
        if (!query || searchQueries.length === 0) {
          return respond({
            success: false,
            text: await renderReply(
              "clarify_calendar_search",
              "I couldn't infer what to look for in your calendar yet. Try naming a person, place, trip, or date.",
              {
                missing: ["search target"],
              },
            ),
          });
        }
        const rankedEvents: RankedCalendarSearchCandidate[] = feed.events
          .map((event) => {
            const matchedQueries: string[] = [];
            let score = 0;
            for (const candidateQuery of searchQueries) {
              const queryScore = scoreCalendarEvent(event, candidateQuery);
              if (queryScore > 0) {
                matchedQueries.push(candidateQuery);
                score += queryScore;
              }
            }
            if (matchedQueries.length > 1) {
              score += (matchedQueries.length - 1) * 12;
            }
            return { event, score, matchedQueries };
          })
          .filter(
            (candidate) =>
              candidate.score > 0 && candidate.matchedQueries.length > 0,
          )
          .sort((left, right) => {
            if (right.score !== left.score) {
              return right.score - left.score;
            }
            return (
              Date.parse(left.event.startAt) - Date.parse(right.event.startAt)
            );
          });
        const strongestScore = rankedEvents[0]?.score ?? 0;
        const strongestThreshold =
          strongestScore >= 30 ? Math.max(16, strongestScore - 12) : 1;
        let filteredEvents = rankedEvents
          .filter((candidate) => candidate.score >= strongestThreshold)
          .map((candidate) => candidate.event);
        if (shouldGroundCalendarSearchWithLlm(query, rankedEvents)) {
          const groundedIds = await groundCalendarSearchMatchesWithLlm(
            runtime,
            state,
            intent,
            searchQueries,
            rankedEvents.slice(0, 6),
          );
          if (groundedIds) {
            const groundedIdSet = new Set(groundedIds);
            filteredEvents = rankedEvents
              .filter((candidate) => groundedIdSet.has(candidate.event.id))
              .map((candidate) => candidate.event);
          }
        }
        const fallback = formatCalendarSearchResults(
          filteredEvents,
          query,
          label,
          intent,
        );
        return respond({
          success: true,
          text: await renderReply("search_results", fallback, {
            query,
            queries: searchQueries,
            events: filteredEvents,
            label,
          }),
          data: toActionData({
            ...feed,
            query,
            queries: searchQueries,
            events: filteredEvents,
          }),
        });
      }

      const fallback = formatCalendarFeed(feed, label);
      return respond({
        success: true,
        text: await renderReply("feed_results", fallback, {
          label,
          events: feed.events,
        }),
        data: toActionData(feed),
      });
    } catch (error) {
      if (error instanceof LifeOpsServiceError) {
        const fallback = buildCalendarServiceErrorFallback(error, intent);
        return respond({
          success: false,
          text: await renderReply("service_error", fallback, {
            status: error.status,
            subaction,
          }),
        });
      }
      throw error;
    }
  },
  parameters: [
    {
      name: "subaction",
      description:
        "Calendar operation. Use search_events for flights, itinerary, travel, appointments, or keyword lookup; feed for agenda/schedule reads; next_event for the next upcoming event; create_event only when creating a new event.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "feed",
          "next_event",
          "search_events",
          "create_event",
          "update_event",
          "delete_event",
          "trip_window",
        ],
      },
    },
    {
      name: "intent",
      description:
        'Natural language calendar request, especially schedule or itinerary questions. Examples: "what is on my calendar today", "do i have any flights this week", "when do i fly back from denver", "create a meeting tomorrow at 3pm".',
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "title",
      description:
        "Event title when creating an event. Optional for read/search actions.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "query",
      description:
        "Short search phrase for search_events, such as flight, dentist, Denver, or return flight.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "queries",
      description:
        "Optional array of search phrases for search_events. The action will combine and dedupe them.",
      required: false,
      schema: {
        type: "array" as const,
        items: { type: "string" as const },
      },
    },
    {
      name: "details",
      description:
        "Optional structured calendar fields such as time bounds, timezone, calendar id, create-event timing, location, and attendees.",
      required: false,
      schema: { type: "object" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "What's on my calendar today?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Events today:\n- **Team sync** (10:00 AM – 10:30 AM)",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "What is my next meeting?" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "**Next event: Product review** (2:00 PM – 3:00 PM) — in 45 min",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Create a dentist appointment for tomorrow at 3pm." },
      },
      {
        name: "{{agentName}}",
        content: {
          text: 'Created calendar event "Dentist appointment" for tomorrow at 3:00 PM.',
        },
      },
    ],
  ] as ActionExample[][],
};
