/**
 * Check-in service: assembles the owner's morning/evening check-in — pulling
 * calendar, inbox/Gmail triage, and occurrence context and running it through
 * the model to produce the check-in message. Check-ins fire as structural
 * scheduled tasks routed through the shared runner, not on prompt-text matching.
 */

import type {
  GetLifeOpsCalendarFeedRequest,
  LifeOpsCalendarFeed,
} from "@elizaos/contracts";
import {
  type GetLifeOpsGmailTriageRequest,
  type GetLifeOpsInboxRequest,
  LIFEOPS_INBOX_CHANNELS,
  LIFEOPS_OCCURRENCE_STATES,
  type LifeOpsCadence,
  type LifeOpsConnectorMode,
  type LifeOpsConnectorSide,
  type LifeOpsGmailTriageFeed,
  type LifeOpsGoogleConnectorStatus,
  type LifeOpsInbox,
  type LifeOpsOccurrence,
  type LifeOpsOccurrenceState,
  type LifeOpsXConnectorStatus,
  type LifeOpsXDm,
  type LifeOpsXFeedItem,
  type LifeOpsXFeedType,
} from "@elizaos/contracts";
import {
  ElizaError,
  type IAgentRuntime,
  logger,
  ModelType,
  runWithTrajectoryPurpose,
  toWellFormedUnicode,
} from "@elizaos/core";
import { resolveKnowledgeGraphService } from "@elizaos/plugin-relationships";
import { computeOverdueFollowups } from "../../followup/followup-tracker.js";
import { resolveOwnerDefinitionSurface } from "../definition-owner-surface.js";
import { formatCalendarEventTimeRange } from "../google/format-helpers.js";
import {
  computeMissedOccurrenceStreak,
  computeOccurrenceStreaks,
} from "../service-helpers-occurrence.js";
import { executeRawSql, parseJsonRecord, sqlQuote, toText } from "../sql.js";
import {
  addDaysToLocalDate,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
} from "../time.js";
import {
  type BriefingEngagement,
  buildBriefingSignals,
  sortBriefingItems,
  toFiniteNonNegativeNumber,
} from "./checkin-briefing-ranking.js";
import type {
  CheckinBriefingItem,
  CheckinBriefingSection,
  CheckinKind,
  CheckinReport,
  EscalationLevel,
  HabitSummary,
  MeetingEntry,
  OverdueTodo,
  RecentWin,
  RecordAcknowledgementRequest,
  RunCheckinRequest,
  SleepRecap,
} from "./types.js";
/**
 * Check-in engine (T9f). Assembles morning/night reports from existing LifeOps data
 * and tracks acknowledgement state for tone escalation.
 *
 * CQRS: read methods return typed shapes; write methods return void or an id.
 * Graceful degradation: if an upstream collector source is missing, the
 * collector logs once per process and records the error message in
 * `CheckinReport.collectorErrors.<field>` so callers can distinguish empty
 * data from an unavailable source.
 */
export const CHECKIN_REPORTS_TABLE = "app_lifeops.life_checkin_reports";
export function getCheckinSummaryTrajectoryPurpose(
  kind: CheckinKind,
): "morning_brief" | "health_checkin" {
  return kind === "morning" ? "morning_brief" : "health_checkin";
}
const ACK_WINDOW_MS = 72 * 60 * 60 * 1000;
const INTERNAL_URL = new URL("http://127.0.0.1/");
export interface CheckinSourceService {
  getGoogleConnectorAccounts?(
    requestUrl: URL,
    side?: LifeOpsConnectorSide,
  ): Promise<LifeOpsGoogleConnectorStatus[]>;
  getXConnectorStatus?(
    mode?: LifeOpsConnectorMode,
    side?: LifeOpsConnectorSide,
    accountId?: string | null,
  ): Promise<LifeOpsXConnectorStatus>;

  getInbox?(request?: GetLifeOpsInboxRequest): Promise<LifeOpsInbox>;
  getGmailTriage?(
    requestUrl: URL,
    request?: GetLifeOpsGmailTriageRequest,
    now?: Date,
  ): Promise<LifeOpsGmailTriageFeed>;
  getCalendarFeed?(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
    now?: Date,
  ): Promise<LifeOpsCalendarFeed>;
  syncXDms?(opts?: { limit?: number }): Promise<{
    synced: number;
  }>;
  getXDms?(opts?: {
    conversationId?: string;
    limit?: number;
  }): Promise<LifeOpsXDm[]>;
  syncXFeed?(
    feedType: LifeOpsXFeedType,
    opts?: {
      limit?: number;
      query?: string;
    },
  ): Promise<{
    synced: number;
  }>;
  getXFeedItems?(
    feedType: LifeOpsXFeedType,
    opts?: {
      limit?: number;
    },
  ): Promise<LifeOpsXFeedItem[]>;
}
export interface CheckinServiceOptions {
  readonly sources?: CheckinSourceService;
}
// Single-shot logging for graceful-degradation paths.
const loggedMissingSources = new Set<string>();
function logMissingOnce(key: string, message: string): void {
  if (loggedMissingSources.has(key)) return;
  loggedMissingSources.add(key);
  logger.info(`[CheckinService] ${message}`);
}
/**
 * Format a `medianBedtimeLocalHour` (in [12, 36)) as a local HH:MM string.
 * Hours >= 24 wrap into the next day, e.g. 24.5 → "00:30". Returns null when
 * the input is null or non-finite — the prompt builder uses this to omit the
 * bedtime line entirely rather than print filler text.
 */
function formatBedtimeHour(hour: number | null): string | null {
  if (hour === null || !Number.isFinite(hour)) {
    return null;
  }
  const wrapped = ((hour % 24) + 24) % 24;
  const hh = Math.floor(wrapped);
  const mm = Math.round((wrapped - hh) * 60);
  // Round-up edge: 23.999... → 24:00 → wrap to 00:00.
  const normHh = mm === 60 ? (hh + 1) % 24 : hh;
  const normMm = mm === 60 ? 0 : mm;
  return `${String(normHh).padStart(2, "0")}:${String(normMm).padStart(2, "0")}`;
}
function formatDurationMinutes(durationMin: number | null): string | null {
  if (
    durationMin === null ||
    !Number.isFinite(durationMin) ||
    durationMin <= 0
  ) {
    return null;
  }
  // Round the whole duration first. 59.5 minutes becomes 60, which is 1h,
  // not "60m". 119.5 minutes becomes 2h, not "1h60m".
  const total = Math.round(durationMin);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h${minutes}m`;
}
function formatPromptScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const text =
    value instanceof Date ? value.toISOString() : String(value).trim();
  return text.replace(/\s+/g, " ").trim();
}
function formatCheckinReportForPrompt(
  report: Omit<CheckinReport, "summaryText">,
): string {
  const withRecordedMisses = report.habitSummaries.filter(
    (habit) => habit.missedOccurrenceStreak > 0,
  );
  const withoutRecordedMisses = report.habitSummaries.filter(
    (habit) => !(habit.missedOccurrenceStreak > 0),
  );
  const modelReport = {
    ...report,
    overdueTodos:
      report.collectorErrors.overdueTodos === null ? report.overdueTodos : null,
    todaysMeetings:
      report.collectorErrors.todaysMeetings === null
        ? report.todaysMeetings
        : null,
    yesterdaysWins:
      report.collectorErrors.yesterdaysWins === null
        ? report.yesterdaysWins
        : null,
    habitSummaries:
      report.collectorErrors.habitSummaries === null
        ? {
            withRecordedMisses: {
              count: withRecordedMisses.length,
              records: withRecordedMisses,
            },
            withoutRecordedMisses: {
              count: withoutRecordedMisses.length,
              records: withoutRecordedMisses,
            },
          }
        : null,
    briefingSections: {
      available: report.briefingSections.filter(
        (section) => !section.error || section.coverage === "partial",
      ),
      unavailable: report.briefingSections.filter(
        (section) => section.error && section.coverage !== "partial",
      ),
    },
  };
  return JSON.stringify(modelReport, (_key, value: unknown) => {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "string") {
      return formatPromptScalar(value);
    }
    return value;
  });
}
/**
 * Build the LLM prompt for a check-in summary. Exported for direct unit
 * testing of prompt content (especially the night-only sleep recap section).
 */
export function buildCheckinSummaryPrompt(
  report: Omit<CheckinReport, "summaryText">,
): string {
  const lines: string[] = [
    report.kind === "morning"
      ? "Write the owner's morning personal-assistant intro summary."
      : "Write the owner's night personal-assistant closeout summary.",
    "Use the supplied source data. Do not invent facts.",
    "Describe recorded states and counts without inventing their cause: a missed occurrence is not evidence of failed delivery, abandoned work, or a system fault. Missed streaks have no occurrence dates here; do not assign those misses to today or yesterday.",
    "Streak counters count occurrences, not days. Report empty collections as no collected items, not proof that no urgent work or messages exist outside the available sources.",
    "Habit group counts are supplied by code and count habit records, not missed occurrences. Use only supplied totals; do not invent counts for subsets or calculate a total from streaks.",
    "Rank for genuinely interesting, important, reply-needed, or schedule-changing items.",
    "Include X/socials (timeline, mentions, DMs), inboxes/messages/Discord, Gmail, GitHub, calendar changes, completed work, contacts, promises, agreements, and follow-ups when present.",
    "When a source is unavailable, say that source is unavailable in one compact clause instead of pretending it was empty.",
    "An unavailable or disconnected source is a coverage limitation, not evidence that a service is down, critical, or needs repair. Do not make reconnecting optional sources a priority unless the report establishes an owner task or affected commitment.",
    report.kind === "morning"
      ? "Tone: concise start-of-day briefing, with what matters now and first next steps."
      : "Tone: concise evening recap sent before the owner's predicted bedtime, with what happened, loose ends, and tomorrow carry-forward.",
    "Write a short, natural message for the owner. Use plain words and only a few paragraphs or bullets. Do not mention internal names such as LifeOps, report JSON, collectors, operational status, or escalation levels. No markdown table or emojis.",
    "Do not put a date or time in the heading. If the body mentions the report time, copy the supplied local report time exactly; do not calculate or invent another date.",
  ];
  if (report.timezone) {
    lines.push(
      `Report time: ${new Intl.DateTimeFormat("en-US", {
        timeZone: report.timezone,
        dateStyle: "full",
        timeStyle: "short",
      }).format(new Date(report.generatedAt))} (${report.timezone}).`,
    );
  } else {
    lines.push(
      "The owner timezone is unavailable; do not invent a local date or time.",
    );
  }
  if (report.kind === "night" && report.sleepRecap) {
    const recap = report.sleepRecap;
    const bedtime = formatBedtimeHour(recap.medianBedtimeLocalHour);
    const duration = formatDurationMinutes(recap.medianSleepDurationMin);
    const recapBullets: string[] = [];
    if (bedtime !== null) {
      recapBullets.push(`- typical bedtime: ${bedtime} local`);
    }
    if (duration !== null) {
      recapBullets.push(`- typical sleep duration: ${duration}`);
    }
    recapBullets.push(`- sleep regularity index (SRI): ${recap.sri}/100`);
    recapBullets.push(`- regularity class: ${recap.regularityClass}`);
    lines.push(
      "",
      "Sleep recap (use these facts only — do not invent sleep numbers):",
      ...recapBullets,
      'Include a short "Sleep recap" section in the summary using these numbers when present. If `regularityClass` is `irregular` or `very_irregular`, suggest one concrete step toward consistency. If it is `insufficient_data`, say so plainly and skip recommendations.',
    );
  }
  lines.push(
    "",
    "Report JSON:",
    formatCheckinReportForPrompt(report),
    "",
    "Summary:",
  );
  return lines.join("\n");
}
function newReportId(): string {
  const maybeCrypto = (
    globalThis as {
      crypto?: {
        randomUUID?: () => string;
      };
    }
  ).crypto;
  if (maybeCrypto?.randomUUID) return maybeCrypto.randomUUID();
  return `checkin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function morningBriefExcerpt(text: string): string {
  const characters = Array.from(clip(text));
  return characters.length > 220
    ? `${characters.slice(0, 220).join("")}… (excerpt)`
    : characters.join("");
}

/** Render morning facts from the existing report; retain every raw record in storage. */
export function renderMorningCheckinReport(
  report: Omit<CheckinReport, "summaryText">,
): string {
  const reference = report.timezone
    ? `${new Intl.DateTimeFormat("en-US", {
        timeZone: report.timezone,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(new Date(report.generatedAt))}`
    : report.generatedAt;
  const paragraphs = ["Good morning."];
  const unavailable: string[] = [];
  const emptySummaries: string[] = [];
  const calendarSection = report.briefingSections.find(
    (section) =>
      section.key === "calendar_changes" &&
      (!section.error || section.coverage === "partial"),
  );
  const combinedCalendarItems = new Set<CheckinBriefingItem>();
  const clearDay =
    !report.collectorErrors.todaysMeetings &&
    !report.collectorErrors.overdueTodos &&
    report.todaysMeetings.length === 0 &&
    report.overdueTodos.length === 0;
  const lists = [
    {
      key: "todaysMeetings" as const,
      title: "Calendar today",
      empty: "No Calendar events listed for today.",
      rows: report.todaysMeetings,
    },
    {
      key: "overdueTodos" as const,
      title: "Overdue tasks",
      empty: "No overdue tasks listed.",
      rows: report.overdueTodos,
    },
    {
      key: "yesterdaysWins" as const,
      title: "Finished yesterday",
      empty: "No completed items were recorded yesterday.",
      rows: report.yesterdaysWins,
    },
  ];
  for (const list of lists) {
    if (report.collectorErrors[list.key]) {
      unavailable.push(list.title);
      continue;
    }
    if (list.rows.length === 0) {
      if (list.key !== "yesterdaysWins" && !clearDay)
        emptySummaries.push(list.empty);
      continue;
    }
    const highlights = list.rows.slice(0, 3).map((row) => {
      if (!("startAt" in row)) return `- ${morningBriefExcerpt(row.title)}`;
      const calendarItem = calendarSection?.items.find((item) => {
        const event = item.calendarEvent;
        return (
          Boolean(event?.id) &&
          event?.id === row.id &&
          item.title === row.title &&
          parseMs(event.startAt) !== null &&
          parseMs(event.startAt) === parseMs(row.startAt) &&
          parseMs(event.endAt) !== null &&
          parseMs(event.endAt) === parseMs(row.endAt) &&
          row.status !== undefined &&
          event.status === row.status &&
          event.isAllDay === row.isAllDay
        );
      });
      if (calendarItem) combinedCalendarItems.add(calendarItem);
      const facts = [
        row.status?.toLowerCase() === "confirmed" ? null : row.status,
        calendarItem?.reason === "on schedule" ? null : calendarItem?.reason,
      ]
        .filter(Boolean)
        .join("; ");
      return `- ${formatCalendarEventTimeRange({ ...row, timezone: report.timezone })}: ${morningBriefExcerpt(row.title)}${facts ? ` (${facts})` : ""}`;
    });
    const extra = list.rows.length - highlights.length;
    paragraphs.push(
      `${list.title}: ${list.rows.length}.${highlights.length ? `\n${highlights.join("\n")}` : ""}${extra ? `\n${extra} more items.` : ""}`,
    );
  }
  if (clearDay)
    paragraphs.push(
      "No Calendar events or overdue tasks are listed for today.",
    );
  if (emptySummaries.length > 0) paragraphs.push(emptySummaries.join(" "));
  const xUnavailable: { label: string; setupUnavailable: boolean }[] = [];
  let gmailDisconnected = false;
  for (const section of report.briefingSections) {
    if (
      section.key === "calendar_changes" &&
      section.error &&
      section.coverage === "partial"
    )
      unavailable.push("Some Calendar information");
    if (section.error && section.coverage !== "partial") {
      if (section.key === "x") {
        unavailable.push("X");
        continue;
      }
      if (
        section.key === "gmail" &&
        section.error === "Google Gmail is not connected."
      ) {
        gmailDisconnected = true;
      } else if (
        section.key === "x_dms" ||
        section.key === "x_timeline" ||
        section.key === "x_mentions"
      ) {
        const expectedError =
          section.key === "x_dms"
            ? "[x_read_dms] X runtime service fetchConnectorMessages is not registered."
            : section.key === "x_timeline"
              ? "[x_read_feed_home_timeline] X runtime service fetchFeedForAccount is not registered."
              : "[x_read_feed_mentions] X runtime service fetchFeedForAccount is not registered.";
        xUnavailable.push({
          label:
            section.key === "x_dms"
              ? "DMs"
              : section.key === "x_timeline"
                ? "timeline"
                : "mentions",
          setupUnavailable: section.error === expectedError,
        });
      } else {
        unavailable.push(section.title);
      }
      continue;
    }
    const items = section.items.filter(
      (item) => !combinedCalendarItems.has(item),
    );
    const highlights = items.slice(0, 3).map((item) => {
      const detail = item.calendarEvent
        ? `${formatCalendarEventTimeRange({ ...item.calendarEvent, timezone: report.timezone })}${item.calendarEvent.status && item.calendarEvent.status.toLowerCase() !== "confirmed" ? ` (${item.calendarEvent.status})` : ""}${item.reason && item.reason !== "on schedule" ? `; ${item.reason}` : ""}`
        : item.detail;
      return `- ${morningBriefExcerpt(item.title)}${detail ? `: ${morningBriefExcerpt(detail)}` : ""}`;
    });
    const extra = items.length - highlights.length;
    if (
      section.key === "gmail" &&
      section.coverage === "partial" &&
      highlights.length === 0
    )
      paragraphs.push("Some Gmail inboxes couldn't be checked.");
    if (highlights.length > 0) {
      paragraphs.push(
        `${section.summary}\n${highlights.join("\n")}${extra ? `\n${extra} more items.` : ""}`,
      );
    } else if (section.key === "calendar_changes" && section.items.length > 0) {
      paragraphs.push(section.summary);
    }
  }
  if (report.collectorErrors.habitSummaries) {
    unavailable.push("Habit tracking");
  } else if (report.habitSummaries.length > 0) {
    const missed = report.habitSummaries.filter(
      (habit) => habit.missedOccurrenceStreak > 0,
    ).length;
    paragraphs.push(
      `${missed} of ${report.habitSummaries.length} tracked items have missed check-ins.`,
    );
  }
  const coverage = [
    ...(gmailDisconnected ? ["Gmail isn't connected"] : []),
    ...(xUnavailable.length > 0
      ? [
          xUnavailable.length === 3 &&
          xUnavailable.every((source) => source.setupUnavailable)
            ? "X isn't available in this setup"
            : `X (${xUnavailable.map((source) => source.label).join(", ")}) couldn't be checked`,
        ]
      : []),
    ...(unavailable.length > 0
      ? [`${unavailable.join(", ")} unavailable`]
      : []),
  ];
  if (coverage.length > 0) paragraphs.push(`${coverage.join(". ")}.`);
  paragraphs.push(`As of ${reference}.`);
  return paragraphs.join("\n\n");
}
export function clip(text: string, maxLength = 220): string {
  void maxLength;
  return toWellFormedUnicode(text.replace(/\s+/g, " ").trim());
}
function parseMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const text = toText(value).toLowerCase();
  return text === "true" || text === "1" || text === "yes";
}
function summarizeCount(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
function localDayWindow(
  date: Date,
  timezone: string,
  dayOffset = 0,
): {
  start: Date;
  end: Date;
  key: string;
} {
  const parts = addDaysToLocalDate(
    getZonedDateParts(date, timezone),
    dayOffset,
  );
  const start = buildUtcDateFromLocalParts(timezone, {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const end = buildUtcDateFromLocalParts(timezone, {
    ...addDaysToLocalDate(parts, 1),
    hour: 0,
    minute: 0,
    second: 0,
  });
  return {
    start,
    end,
    key: `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
  };
}

/** All-day bounds are civil dates encoded at UTC midnight, not zoned instants. */
function calendarDayPredicate(day: ReturnType<typeof localDayWindow>): string {
  return `(
    (is_all_day = true
     AND LEFT(start_at, 10) <= ${sqlQuote(day.key)}
     AND LEFT(end_at, 10) > ${sqlQuote(day.key)})
    OR (is_all_day = false
        AND start_at >= ${sqlQuote(day.start.toISOString())}
        AND start_at < ${sqlQuote(day.end.toISOString())})
  )`;
}
function unavailableSection(
  key: CheckinBriefingSection["key"],
  title: string,
  message: string,
): CheckinBriefingSection {
  return {
    key,
    title,
    summary: `${title} unavailable.`,
    items: [],
    error: message,
  };
}
interface CollectorResult<T> {
  readonly rows: T[];
  readonly error: string | null;
}
type HabitCollectorRow = {
  definition_id: unknown;
  definition_title: unknown;
  definition_kind: unknown;
  definition_metadata_json: unknown;
  definition_cadence_json: unknown;
  occurrence_state: unknown;
  occurrence_due_at: unknown;
  occurrence_updated_at: unknown;
  occurrence_progress_total: unknown;
};
export type HabitOccurrence = {
  state: LifeOpsOccurrenceState;
  dueAtMs: number;
  updatedAtMs: number;
  progressTotal: number;
};
const LIFEOPS_OCCURRENCE_STATE_SET: ReadonlySet<string> = new Set(
  LIFEOPS_OCCURRENCE_STATES,
);
function parseHabitOccurrenceState(
  value: unknown,
): LifeOpsOccurrenceState | null {
  const state = toText(value);
  return LIFEOPS_OCCURRENCE_STATE_SET.has(state)
    ? (state as LifeOpsOccurrenceState)
    : null;
}
function asFiniteMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function resolvePausedUntil(
  metadata: Record<string, unknown>,
  now: Date,
): string | null {
  const rawPauseUntil = metadata.pauseUntil;
  if (typeof rawPauseUntil !== "string") {
    return null;
  }
  const pauseUntil = rawPauseUntil.trim();
  if (!pauseUntil) {
    return null;
  }
  const pauseUntilMs = Date.parse(pauseUntil);
  if (!Number.isFinite(pauseUntilMs) || pauseUntilMs <= now.getTime()) {
    return null;
  }
  return new Date(pauseUntilMs).toISOString();
}
/**
 * Projects one definition's occurrences into the client-facing `HabitSummary`.
 * For `count_per_day` cadences the summary carries the server-derived quota
 * progress for the current active day so clients render remaining counts
 * instead of recomputing them; every other cadence gets `progress: null`.
 */
export function buildHabitSummary(args: {
  definitionId: string;
  title: string;
  kind: "habit" | "routine";
  metadata: Record<string, unknown>;
  occurrences: HabitOccurrence[];
  cadence: LifeOpsCadence;
  now: Date;
}): HabitSummary {
  const pauseUntil = resolvePausedUntil(args.metadata, args.now);
  const dueOccurrences = args.occurrences
    .filter((occurrence) => occurrence.dueAtMs <= args.now.getTime())
    .sort((left, right) => {
      if (left.dueAtMs !== right.dueAtMs) {
        return left.dueAtMs - right.dueAtMs;
      }
      return left.updatedAtMs - right.updatedAtMs;
    });
  const streakInput = dueOccurrences.map((occurrence) => ({
    state: occurrence.state as LifeOpsOccurrence["state"],
  }));
  const completedStreak = computeOccurrenceStreaks(streakInput);
  const missedStreak = computeMissedOccurrenceStreak(streakInput);
  const quotaOccurrence =
    args.cadence.kind === "count_per_day"
      ? args.occurrences
          .filter((occurrence) => occurrence.dueAtMs >= args.now.getTime())
          .sort((left, right) => left.dueAtMs - right.dueAtMs)[0]
      : undefined;
  const completedCount = quotaOccurrence
    ? Math.min(
        quotaOccurrence.progressTotal,
        args.cadence.kind === "count_per_day" ? args.cadence.targetCount : 0,
      )
    : 0;
  return {
    definitionId: args.definitionId,
    title: args.title,
    kind: args.kind,
    currentOccurrenceStreak: pauseUntil ? 0 : completedStreak.current,
    bestOccurrenceStreak: completedStreak.best,
    missedOccurrenceStreak: pauseUntil ? 0 : missedStreak.current,
    pauseUntil,
    isPaused: pauseUntil !== null,
    progress:
      args.cadence.kind === "count_per_day" && quotaOccurrence
        ? {
            completedCount,
            targetCount: args.cadence.targetCount,
            remainingCount: Math.max(
              args.cadence.targetCount - completedCount,
              0,
            ),
            unit: args.cadence.unit,
            perOccurrenceWork: args.cadence.perOccurrenceWork,
          }
        : null,
  };
}
async function collectHabitSummaries(
  runtime: IAgentRuntime,
  now: Date,
): Promise<
  CollectorResult<HabitSummary> & {
    pausedDefinitionIds: Set<string>;
  }
> {
  const agentId = String(runtime.agentId);
  try {
    const definitionRows = await executeRawSql(
      runtime,
      `SELECT id AS definition_id,
              title AS definition_title,
              kind AS definition_kind,
              metadata_json AS definition_metadata_json
              ,cadence_json AS definition_cadence_json
         FROM app_lifeops.life_task_definitions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND kind IN ('habit', 'routine')
          AND status IN ('active', 'paused')
        ORDER BY title ASC`,
    );
    if (definitionRows.length === 0) {
      return { rows: [], error: null, pausedDefinitionIds: new Set() };
    }
    const occurrencesRows = await executeRawSql(
      runtime,
      `SELECT definition_id,
              state AS occurrence_state,
              due_at AS occurrence_due_at,
              updated_at AS occurrence_updated_at
              ,(SELECT COALESCE(SUM(progress.quantity), 0)
                  FROM app_lifeops.life_task_progress_events progress
                 WHERE progress.agent_id = app_lifeops.life_task_occurrences.agent_id
                   AND progress.occurrence_id = app_lifeops.life_task_occurrences.id) AS occurrence_progress_total
         FROM app_lifeops.life_task_occurrences
        WHERE agent_id = ${sqlQuote(agentId)}
          AND definition_id IN (${definitionRows.map((row) => sqlQuote(toText(row.definition_id))).join(", ")})
        ORDER BY definition_id ASC, due_at ASC, updated_at ASC`,
    );
    const occurrencesByDefinitionId = new Map<string, HabitOccurrence[]>();
    for (const row of occurrencesRows as HabitCollectorRow[]) {
      const definitionId = toText(row.definition_id);
      const dueAtMs = asFiniteMs(toText(row.occurrence_due_at));
      const updatedAtMs = asFiniteMs(toText(row.occurrence_updated_at));
      const state = parseHabitOccurrenceState(row.occurrence_state);
      if (
        !definitionId ||
        dueAtMs === null ||
        updatedAtMs === null ||
        state === null
      ) {
        continue;
      }
      const rawProgressTotal = Number(row.occurrence_progress_total);
      if (!Number.isFinite(rawProgressTotal)) {
        throw new Error(
          `Invalid quota progress total for LifeOps definition ${definitionId}`,
        );
      }
      const current = occurrencesByDefinitionId.get(definitionId);
      const nextOccurrence: HabitOccurrence = {
        state,
        dueAtMs,
        updatedAtMs,
        progressTotal: Math.max(0, Math.trunc(rawProgressTotal)),
      };
      if (current) {
        current.push(nextOccurrence);
      } else {
        occurrencesByDefinitionId.set(definitionId, [nextOccurrence]);
      }
    }
    const summaries: HabitSummary[] = [];
    const pausedDefinitionIds = new Set<string>();
    for (const row of definitionRows as HabitCollectorRow[]) {
      const definitionId = toText(row.definition_id);
      const title = toText(row.definition_title);
      const kind = toText(row.definition_kind);
      const metadata = parseJsonRecord(row.definition_metadata_json);
      const cadence = parseJsonRecord(
        row.definition_cadence_json,
      ) as LifeOpsCadence;
      if (!definitionId || !title || (kind !== "habit" && kind !== "routine")) {
        continue;
      }
      const summary = buildHabitSummary({
        definitionId,
        title,
        kind,
        metadata,
        cadence,
        occurrences: occurrencesByDefinitionId.get(definitionId) ?? [],
        now,
      });
      if (summary.isPaused) {
        pausedDefinitionIds.add(definitionId);
      }
      if (
        resolveOwnerDefinitionSurface({ kind, metadata }) !== "OWNER_REMINDERS"
      ) {
        summaries.push(summary);
      }
    }
    return { rows: summaries, error: null, pausedDefinitionIds };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMissingOnce(
      "habit-summaries",
      `habit summaries collector unavailable: ${message}`,
    );
    return { rows: [], error: message, pausedDefinitionIds: new Set() };
  }
}
async function collectOverdueTodos(
  runtime: IAgentRuntime,
  now: Date,
  pausedDefinitionIds: ReadonlySet<string>,
): Promise<CollectorResult<OverdueTodo>> {
  const agentId = String(runtime.agentId);
  const nowIso = now.toISOString();
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT occ.id AS id,
              occ.definition_id AS definition_id,
              COALESCE(def.title, '') AS title,
              occ.due_at AS due_at
         FROM app_lifeops.life_task_occurrences occ
         JOIN app_lifeops.life_task_definitions def
           ON def.id = occ.definition_id AND def.agent_id = occ.agent_id
        WHERE occ.agent_id = ${sqlQuote(agentId)}
          AND def.kind = 'task'
          AND occ.state IN ('pending', 'visible')
          AND occ.due_at IS NOT NULL
          AND occ.due_at < ${sqlQuote(nowIso)}
        ORDER BY occ.due_at ASC
        LIMIT 50`,
    );
    return {
      rows: rows.flatMap((row) => {
        const definitionId = toText(row.definition_id);
        if (definitionId && pausedDefinitionIds.has(definitionId)) {
          return [];
        }
        return [
          {
            id: toText(row.id),
            title: toText(row.title) || "(untitled)",
            dueAt: row.due_at == null ? null : toText(row.due_at),
          },
        ];
      }),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMissingOnce(
      "overdue-todos",
      `overdue-todos collector unavailable (app_lifeops.life_task_occurrences not ready): ${message}`,
    );
    return { rows: [], error: message };
  }
}
async function collectTodaysMeetings(
  runtime: IAgentRuntime,
  now: Date,
  timezone: string,
): Promise<CollectorResult<MeetingEntry>> {
  const agentId = String(runtime.agentId);
  const day = localDayWindow(now, timezone);
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT id, title, start_at, end_at, status, is_all_day
         FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND ${calendarDayPredicate(day)}
        ORDER BY start_at ASC
        LIMIT 50`,
    );
    return {
      rows: rows.map((row) => ({
        id: toText(row.id),
        title: toText(row.title) || "(untitled)",
        startAt: toText(row.start_at),
        endAt: toText(row.end_at),
        status: toText(row.status),
        isAllDay: toBoolean(row.is_all_day),
      })),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMissingOnce(
      "todays-meetings",
      `meetings collector unavailable (app_calendar.life_calendar_events not ready): ${message}`,
    );
    return { rows: [], error: message };
  }
}
async function collectCompletedWins(
  runtime: IAgentRuntime,
  kind: CheckinKind,
  now: Date,
  timezone: string,
): Promise<CollectorResult<RecentWin>> {
  const agentId = String(runtime.agentId);
  const day = localDayWindow(now, timezone, kind === "morning" ? -1 : 0);
  const start = day.start;
  const end = kind === "morning" ? day.end : now;
  // Use the same canonical writer timestamp policy as dated owner recaps.
  // This collector's existing joins/scopes differ from the overview repository.
  const completedAt = `(occ.completion_payload_json::jsonb ->> 'completedAt')`;
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT occ.id AS id,
              COALESCE(def.title, '') AS title,
              ${completedAt} AS completed_at
         FROM app_lifeops.life_task_occurrences occ
         LEFT JOIN app_lifeops.life_task_definitions def ON def.id = occ.definition_id
        WHERE occ.agent_id = ${sqlQuote(agentId)}
          AND occ.state = 'completed'
          AND jsonb_typeof(occ.completion_payload_json::jsonb -> 'completedAt') = 'string'
          AND ${completedAt} ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$'
          AND ${completedAt} >= ${sqlQuote(start.toISOString())}
          AND ${completedAt} ${kind === "morning" ? "<" : "<="} ${sqlQuote(end.toISOString())}
        ORDER BY ${completedAt} DESC, occ.id ASC
        LIMIT 50`,
    );
    return {
      rows: rows
        .filter((row) => {
          const instant = toText(row.completed_at);
          const ms = Date.parse(instant);
          return Number.isFinite(ms) && new Date(ms).toISOString() === instant;
        })
        .map((row) => ({
          id: toText(row.id),
          title: toText(row.title) || "(untitled)",
          completedAt: toText(row.completed_at),
        })),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMissingOnce(
      "yesterdays-wins",
      `completed-wins collector unavailable: ${message}`,
    );
    return { rows: [], error: message };
  }
}
function clampEscalation(count: number): EscalationLevel {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count === 2) return 2;
  return 3;
}
function resolveHabitEscalationLevel(
  summaries: readonly HabitSummary[],
): EscalationLevel {
  const maxMissedStreak = summaries.reduce(
    (max, summary) => Math.max(max, summary.missedOccurrenceStreak),
    0,
  );
  return clampEscalation(maxMissedStreak);
}
async function collectXDmSection(
  source: CheckinSourceService | undefined,
): Promise<CheckinBriefingSection> {
  if (!source?.syncXDms || !source.getXDms) {
    return unavailableSection(
      "x_dms",
      "X DMs",
      "X DM reader is not registered on this runtime.",
    );
  }
  try {
    await source.syncXDms({ limit: 30 });
    const dms = await source.getXDms({ limit: 30 });
    const items = sortBriefingItems(
      dms.map((dm) => {
        const ranked = buildBriefingSignals({
          occurredAt: dm.receivedAt,
          inbound: dm.isInbound,
          unread: dm.readAt === null,
          replyNeeded: dm.isInbound && dm.repliedAt === null,
        });
        return {
          title: dm.senderHandle ? `@${dm.senderHandle}` : dm.senderId,
          detail: clip(dm.text),
          occurredAt: dm.receivedAt,
          href: null,
          reason: ranked.reason,
          signals: ranked.signals,
          sort: { ...ranked.signals, occurredAt: dm.receivedAt },
        };
      }),
    );
    const actionNeeded = items.filter(
      (item) => item.signals?.replyNeeded,
    ).length;
    return {
      key: "x_dms",
      title: "X DMs",
      summary:
        dms.length === 0
          ? "No recent X DMs found."
          : `${summarizeCount(dms.length, "recent X DM")} checked; ${summarizeCount(actionNeeded, "looks reply-needed", "look reply-needed")}.`,
      items,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSection("x_dms", "X DMs", message);
  }
}
async function collectXFeedSection(
  source: CheckinSourceService | undefined,
  key: Extract<CheckinBriefingSection["key"], "x_timeline" | "x_mentions">,
  feedType: Extract<LifeOpsXFeedType, "home_timeline" | "mentions">,
  title: string,
): Promise<CheckinBriefingSection> {
  if (!source?.syncXFeed || !source.getXFeedItems) {
    return unavailableSection(
      key,
      title,
      "X feed reader is not registered on this runtime.",
    );
  }
  try {
    await source.syncXFeed(feedType, { limit: 30 });
    const feedItems = await source.getXFeedItems(feedType, { limit: 30 });
    const items = sortBriefingItems(
      feedItems.map((feedItem) => {
        const raw = (feedItem.metadata.raw ?? {}) as {
          referenced_tweets?: Array<{
            type?: string;
          }>;
          public_metrics?: Record<string, number>;
        };
        const referenceTypes = (raw.referenced_tweets ?? [])
          .map((reference) => reference.type)
          .filter((type): type is string => typeof type === "string");
        const isReply = referenceTypes.includes("replied_to");
        const metrics = raw.public_metrics ?? {};
        const engagement: BriefingEngagement = {
          likeCount: toFiniteNonNegativeNumber(metrics.like_count),
          replyCount: toFiniteNonNegativeNumber(metrics.reply_count),
          repostCount: toFiniteNonNegativeNumber(metrics.retweet_count),
          quoteCount: toFiniteNonNegativeNumber(metrics.quote_count),
          totalCount:
            toFiniteNonNegativeNumber(metrics.like_count) +
            toFiniteNonNegativeNumber(metrics.reply_count) +
            toFiniteNonNegativeNumber(metrics.retweet_count) +
            toFiniteNonNegativeNumber(metrics.quote_count),
        };
        const ranked = buildBriefingSignals({
          occurredAt: feedItem.createdAtSource,
          replyNeeded: isReply,
          engagement,
        });
        return {
          title: feedItem.authorHandle
            ? `@${feedItem.authorHandle}`
            : feedItem.authorId,
          detail: clip(feedItem.text),
          occurredAt: feedItem.createdAtSource,
          href: `https://x.com/i/web/status/${feedItem.externalTweetId}`,
          reason: ranked.reason,
          signals: ranked.signals,
          sort: { ...ranked.signals, occurredAt: feedItem.createdAtSource },
        };
      }),
    );
    return {
      key,
      title,
      summary:
        feedItems.length === 0
          ? `No recent ${title.toLowerCase()} items found.`
          : `${summarizeCount(feedItems.length, "item")} scanned from ${title.toLowerCase()}.`,
      items,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSection(key, title, message);
  }
}
async function collectInboxSection(
  source: CheckinSourceService | undefined,
): Promise<CheckinBriefingSection> {
  if (!source?.getInbox) {
    return unavailableSection(
      "inbox",
      "Inbox",
      "Inbox reader is not registered on this runtime.",
    );
  }
  try {
    // Gmail/X have dedicated status-gated collectors. Keep other cached
    // channels without re-reading those accounts through the aggregate inbox.
    const inbox = await source.getInbox({
      limit: 50,
      channels: LIFEOPS_INBOX_CHANNELS.filter(
        (channel) => channel !== "gmail" && channel !== "x_dm",
      ),
    });
    const counts = Object.entries(inbox.channelCounts)
      .filter(([, count]) => count.total > 0)
      .map(
        ([channel, count]) =>
          `${channel}: ${count.total}${count.unread > 0 ? `/${count.unread} unread` : ""}`,
      );
    const items = sortBriefingItems(
      inbox.messages.map((message) => {
        const ranked = buildBriefingSignals({
          occurredAt: message.receivedAt,
          unread: message.unread,
          inbound: true,
        });
        return {
          title: `${message.channel}: ${message.sender.displayName}`,
          detail: clip(
            message.subject
              ? `${message.subject}: ${message.snippet}`
              : message.snippet,
          ),
          occurredAt: message.receivedAt,
          href: message.deepLink,
          reason: ranked.reason,
          signals: ranked.signals,
          sort: { ...ranked.signals, occurredAt: message.receivedAt },
        };
      }),
    );
    return {
      key: "inbox",
      title: "Inbox",
      summary:
        counts.length === 0
          ? "No inbox items found across connected channels."
          : `Inbox channels scanned: ${counts.join(", ")}.`,
      items,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSection("inbox", "Inbox", message);
  }
}
async function collectGmailSection(
  source: CheckinSourceService | undefined,
  now: Date,
): Promise<CheckinBriefingSection | undefined> {
  if (!source?.getGoogleConnectorAccounts) return undefined;
  try {
    const accounts = (
      await source.getGoogleConnectorAccounts(INTERNAL_URL, "owner")
    ).filter(
      (account) =>
        account.configured &&
        (account.connected || account.reason === "needs_reauth") &&
        account.grantedCapabilities.includes("google.gmail.triage"),
    );
    if (accounts.length === 0) return undefined;
    if (!source.getGmailTriage)
      return unavailableSection(
        "gmail",
        "Gmail",
        "The configured Gmail triage reader is not registered.",
      );
    const getGmailTriage = source.getGmailTriage.bind(source);
    const results = await Promise.all(
      accounts.map(async (account) => {
        try {
          if (!account.grant?.id || !account.grant.connectorAccountId)
            throw new ElizaError(
              "The configured Gmail account reference is unavailable.",
              { code: "CHECKIN_GMAIL_ACCOUNT_REFERENCE_UNAVAILABLE" },
            );
          return {
            feed: await getGmailTriage(
              INTERNAL_URL,
              { maxResults: 25, side: "owner", grantId: account.grant.id },
              now,
            ),
            error: null,
          };
        } catch (error) {
          return {
            feed: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const feeds = results.flatMap((result) =>
      result.feed ? [result.feed] : [],
    );
    const errors = results.flatMap((result) =>
      result.error ? [result.error] : [],
    );
    const items = sortBriefingItems(
      feeds
        .flatMap((feed) => feed.messages)
        .map((message) => {
          const ranked = buildBriefingSignals({
            occurredAt: message.receivedAt,
            unread: message.isUnread,
            inbound: true,
            replyNeeded: message.likelyReplyNeeded,
            important: message.isImportant,
            sourcePriority: message.triageScore,
          });
          return {
            title: `${message.from || "Unknown"}${message.subject ? `: ${message.subject}` : ""}`,
            detail: clip(message.snippet || message.triageReason),
            occurredAt: message.receivedAt,
            href: message.htmlLink,
            reason: ranked.reason ?? (message.triageReason || null),
            signals: ranked.signals,
            sort: { ...ranked.signals, occurredAt: message.receivedAt },
          };
        }),
    );
    const counts = feeds.reduce(
      (sum, feed) => ({
        unread: sum.unread + feed.summary.unreadCount,
        important: sum.important + feed.summary.importantNewCount,
        reply: sum.reply + feed.summary.likelyReplyNeededCount,
      }),
      { unread: 0, important: 0, reply: 0 },
    );
    return {
      key: "gmail",
      title: "Gmail",
      summary:
        feeds.length > 0
          ? `${counts.unread} unread, ${counts.important} important, ${counts.reply} likely needing reply${errors.length ? "; some connected inboxes couldn't be checked" : ""}.`
          : "Connected Gmail inboxes couldn't be checked.",
      items,
      error: errors.length ? errors.join("; ") : null,
      ...(errors.length > 0 && feeds.length > 0
        ? { coverage: "partial" as const }
        : {}),
    };
  } catch (error) {
    return unavailableSection(
      "gmail",
      "Gmail",
      error instanceof Error ? error.message : String(error),
    );
  }
}
async function collectCalendarChangeSection(
  runtime: IAgentRuntime,
  now: Date,
  timezone: string,
): Promise<CheckinBriefingSection> {
  const agentId = String(runtime.agentId);
  const day = localDayWindow(now, timezone);
  const today = calendarDayPredicate(day);
  const sinceIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT id, title, start_at, end_at, status, is_all_day, html_link, updated_at,
              ${today} AS is_today
         FROM app_calendar.life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND side = 'owner'
          AND (
            ${today}
            OR updated_at >= ${sqlQuote(sinceIso)}
          )
        ORDER BY
          CASE WHEN updated_at >= ${sqlQuote(sinceIso)} THEN 0 ELSE 1 END,
          start_at ASC
        LIMIT 40`,
    );
    const todayCount = rows.filter((row) => toBoolean(row.is_today)).length;
    const changedCount = rows.filter(
      (row) => (parseMs(toText(row.updated_at)) ?? 0) >= Date.parse(sinceIso),
    ).length;
    const items = sortBriefingItems(
      rows.map((row) => {
        const status = toText(row.status);
        const title = toText(row.title) || "(untitled event)";
        const updatedAt = toText(row.updated_at) || null;
        const isChanged = (parseMs(updatedAt) ?? 0) >= Date.parse(sinceIso);
        const reason =
          status.toLowerCase() === "cancelled"
            ? "removed/cancelled"
            : isChanged
              ? "added or updated"
              : "on schedule";
        const ranked = buildBriefingSignals({
          occurredAt: updatedAt ?? toText(row.start_at),
          important: status.toLowerCase() === "cancelled" || isChanged,
        });
        return {
          title,
          detail: `${toText(row.start_at)} - ${toText(row.end_at)}${status ? ` (${status})` : ""}`,
          calendarEvent: {
            id: toText(row.id),
            startAt: toText(row.start_at),
            endAt: toText(row.end_at),
            status,
            isAllDay: toBoolean(row.is_all_day),
          },
          occurredAt: updatedAt ?? toText(row.start_at),
          href: toText(row.html_link) || null,
          reason,
          signals: ranked.signals,
          sort: {
            ...ranked.signals,
            occurredAt: updatedAt ?? toText(row.start_at),
          },
        };
      }),
    );
    return {
      key: "calendar_changes",
      title: "Calendar and schedule changes",
      summary: `${summarizeCount(todayCount, "event")} on today's calendar; ${summarizeCount(changedCount, "calendar item")} added or updated in the last 24h.`,
      items,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSection(
      "calendar_changes",
      "Calendar and schedule changes",
      message,
    );
  }
}
async function collectGitHubSection(
  runtime: IAgentRuntime,
  now: Date,
  timezone: string,
): Promise<CheckinBriefingSection> {
  const agentId = String(runtime.agentId);
  const day = localDayWindow(now, timezone);
  const sinceIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const [mailRows, screenRows] = await Promise.all([
      executeRawSql(
        runtime,
        `SELECT subject, from_display, snippet, received_at, html_link,
                is_unread, is_important, likely_reply_needed, triage_score
           FROM app_lifeops.life_gmail_messages
          WHERE agent_id = ${sqlQuote(agentId)}
            AND side = 'owner'
            AND received_at >= ${sqlQuote(sinceIso)}
            AND LOWER(COALESCE(subject, '') || ' ' || COALESCE(from_display, '') || ' ' || COALESCE(snippet, '')) LIKE '%github%'
          ORDER BY received_at DESC
          LIMIT 12`,
      ),
      executeRawSql(
        runtime,
        `SELECT identifier, display_name, start_at, duration_seconds
           FROM app_lifeops.life_screen_time_sessions
          WHERE agent_id = ${sqlQuote(agentId)}
            AND start_at >= ${sqlQuote(day.start.toISOString())}
            AND start_at < ${sqlQuote(day.end.toISOString())}
            AND LOWER(identifier || ' ' || display_name) LIKE '%github%'
          ORDER BY start_at DESC
          LIMIT 12`,
      ),
    ]);
    const mailItems = mailRows.map((row) => {
      const sourcePriority = Number(row.triage_score ?? 0);
      const ranked = buildBriefingSignals({
        occurredAt: toText(row.received_at),
        unread: toBoolean(row.is_unread),
        important: toBoolean(row.is_important),
        replyNeeded: toBoolean(row.likely_reply_needed),
        inbound: true,
        sourcePriority: Number.isFinite(sourcePriority) ? sourcePriority : 0,
      });
      return {
        title: `GitHub email: ${toText(row.subject) || "(no subject)"}`,
        detail: clip(toText(row.snippet) || toText(row.from_display)),
        occurredAt: toText(row.received_at) || null,
        href: toText(row.html_link) || null,
        reason: ranked.reason,
        signals: ranked.signals,
        sort: {
          ...ranked.signals,
          occurredAt: toText(row.received_at) || null,
        },
      };
    });
    const screenItems = screenRows.map((row) => {
      const minutes = Math.round(Number(row.duration_seconds ?? 0) / 60);
      const engagement: BriefingEngagement = {
        likeCount: 0,
        replyCount: 0,
        repostCount: 0,
        quoteCount: 0,
        totalCount: Number.isFinite(minutes) && minutes > 0 ? minutes : 0,
      };
      const ranked = buildBriefingSignals({
        occurredAt: toText(row.start_at) || null,
        engagement,
      });
      return {
        title: `GitHub activity: ${toText(row.display_name) || toText(row.identifier)}`,
        detail: `${Number.isFinite(minutes) && minutes > 0 ? minutes : 0}m active`,
        occurredAt: toText(row.start_at) || null,
        href: null,
        reason: "workspace activity",
        signals: ranked.signals,
        sort: { ...ranked.signals, occurredAt: toText(row.start_at) || null },
      };
    });
    const items = sortBriefingItems([...mailItems, ...screenItems]);
    return {
      key: "github",
      title: "GitHub",
      summary:
        items.length === 0
          ? "No GitHub-specific email or activity signals found in the last day."
          : `${summarizeCount(mailRows.length, "GitHub email")} and ${summarizeCount(screenRows.length, "GitHub activity session")} found.`,
      items,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSection("github", "GitHub", message);
  }
}
async function collectContactSection(
  runtime: IAgentRuntime,
  now: Date,
  timezone: string,
): Promise<CheckinBriefingSection> {
  const agentId = String(runtime.agentId);
  const day = localDayWindow(now, timezone);
  try {
    // Interactions are keyed by the graph entityId; resolve display names from
    // the runtime knowledge graph (there is no flat life_relationships table).
    const rows = await executeRawSql(
      runtime,
      `SELECT relationship_id,
              channel,
              direction,
              summary,
              occurred_at
         FROM app_lifeops.life_relationship_interactions
        WHERE agent_id = ${sqlQuote(agentId)}
          AND occurred_at >= ${sqlQuote(day.start.toISOString())}
          AND occurred_at < ${sqlQuote(day.end.toISOString())}
        ORDER BY occurred_at DESC
        LIMIT 30`,
    );
    const entityStore = resolveKnowledgeGraphService(runtime)?.getEntityStore(
      runtime.agentId,
    );
    const nameByEntityId = new Map<string, string>();
    if (entityStore) {
      const entityIds = new Set(
        rows.map((row) => toText(row.relationship_id)).filter(Boolean),
      );
      for (const entityId of entityIds) {
        const entity = await entityStore.get(entityId);
        if (entity) {
          nameByEntityId.set(entityId, entity.preferredName);
        }
      }
    }
    const nameFor = (row: Record<string, unknown>): string => {
      const entityId = toText(row.relationship_id);
      return nameByEntityId.get(entityId) || entityId;
    };
    const uniqueNames = new Set(rows.map(nameFor).filter(Boolean));
    const items = sortBriefingItems(
      rows.map((row) => {
        const occurredAt = toText(row.occurred_at) || null;
        const ranked = buildBriefingSignals({ occurredAt });
        return {
          title: `${nameFor(row) || "Unknown"} (${toText(row.channel) || "unknown"})`,
          detail: clip(toText(row.summary) || toText(row.direction)),
          occurredAt,
          href: null,
          reason: toText(row.direction) || ranked.reason,
          signals: ranked.signals,
          sort: { ...ranked.signals, occurredAt },
        };
      }),
    );
    return {
      key: "contacts",
      title: "Contacts and conversations",
      summary:
        rows.length === 0
          ? "No relationship interactions logged today."
          : `${summarizeCount(uniqueNames.size, "person", "people")} contacted across ${summarizeCount(rows.length, "logged interaction")}.`,
      items,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSection(
      "contacts",
      "Contacts and conversations",
      message,
    );
  }
}
async function collectPromiseSection(
  runtime: IAgentRuntime,
  now: Date,
): Promise<CheckinBriefingSection> {
  try {
    // Overdue follow-ups are derived from the runtime knowledge graph
    // (contacts past their cadence), the single canonical source shared with
    // the follow-up tracker and the LIST_OVERDUE_FOLLOWUPS action. There is no
    // separate LifeOps follow-up table.
    const digest = await computeOverdueFollowups(runtime, now.getTime());
    const items = sortBriefingItems(
      digest.overdue.map((entry) => {
        const ranked = buildBriefingSignals({
          occurredAt: entry.lastContactedAt,
          important: true,
        });
        return {
          title: `${entry.displayName}: ${entry.daysOverdue}d overdue`,
          detail: clip(
            `Last contacted ${entry.lastContactedAt} (cadence ${entry.thresholdDays}d)`,
          ),
          occurredAt: entry.lastContactedAt,
          href: null,
          reason: "overdue follow-up",
          signals: ranked.signals,
          sort: { ...ranked.signals, occurredAt: entry.lastContactedAt },
        };
      }),
    );
    return {
      key: "promises",
      title: "Promises, agreements, and follow-ups",
      summary:
        digest.overdue.length === 0
          ? "No overdue follow-ups."
          : `${summarizeCount(digest.overdue.length, "overdue follow-up")} to reconnect.`,
      items,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSection(
      "promises",
      "Promises, agreements, and follow-ups",
      message,
    );
  }
}
async function collectBriefingSections(args: {
  runtime: IAgentRuntime;
  source: CheckinSourceService | undefined;
  now: Date;
  timezone: string;
}): Promise<CheckinBriefingSection[]> {
  let xStatus: LifeOpsXConnectorStatus | undefined;
  let xError: string | null = null;
  if (args.source?.getXConnectorStatus) {
    try {
      xStatus = await args.source.getXConnectorStatus(
        undefined,
        "owner",
        undefined,
      );
    } catch (error) {
      xError = error instanceof Error ? error.message : String(error);
    }
  }
  if (xStatus?.probeError) xError = xStatus.probeError;
  if (xStatus?.reason === "needs_reauth")
    xError = "The configured X connection needs reauthorization.";
  const readableX = xStatus?.connected;
  const sections = await Promise.all([
    ...(xError ? [Promise.resolve(unavailableSection("x", "X", xError))] : []),
    ...(readableX && xStatus?.dmRead ? [collectXDmSection(args.source)] : []),
    ...(readableX && xStatus?.feedRead
      ? [
          collectXFeedSection(
            args.source,
            "x_timeline",
            "home_timeline",
            "X timeline",
          ),
          collectXFeedSection(
            args.source,
            "x_mentions",
            "mentions",
            "X mentions",
          ),
        ]
      : []),
    collectInboxSection(args.source),
    collectGmailSection(args.source, args.now),
    collectGitHubSection(args.runtime, args.now, args.timezone),
    collectCalendarChangeSection(args.runtime, args.now, args.timezone),
    collectContactSection(args.runtime, args.now, args.timezone),
    collectPromiseSection(args.runtime, args.now),
  ]);
  return sections.filter(
    (section): section is CheckinBriefingSection => section !== undefined,
  );
}
export class CheckinService {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly options: CheckinServiceOptions = {},
  ) {}
  async runMorningCheckin(
    request: RunCheckinRequest = {},
  ): Promise<CheckinReport> {
    return this.runCheckin("morning", request);
  }
  async runNightCheckin(
    request: RunCheckinRequest = {},
  ): Promise<CheckinReport> {
    return this.runCheckin("night", request);
  }
  async getEscalationLevel(now: Date = new Date()): Promise<EscalationLevel> {
    const agentId = String(this.runtime.agentId);
    const windowStartMs = now.getTime() - ACK_WINDOW_MS;
    const rows = await executeRawSql(
      this.runtime,
      `SELECT COUNT(*) AS unack_count
         FROM ${CHECKIN_REPORTS_TABLE}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND generated_at_ms >= ${windowStartMs}
          AND acknowledged_at IS NULL`,
    );
    const countRaw = rows[0]?.unack_count;
    const count =
      typeof countRaw === "number"
        ? countRaw
        : Number.parseInt(toText(countRaw), 10);
    return clampEscalation(Number.isFinite(count) ? count : 0);
  }
  async hasCheckinForLocalDay(args: {
    kind: CheckinKind;
    now: Date;
    timezone: string;
  }): Promise<boolean> {
    const agentId = String(this.runtime.agentId);
    const day = localDayWindow(args.now, args.timezone);
    const rows = await executeRawSql(
      this.runtime,
      `SELECT id
         FROM ${CHECKIN_REPORTS_TABLE}
        WHERE agent_id = ${sqlQuote(agentId)}
          AND kind = ${sqlQuote(args.kind)}
          AND generated_at_ms >= ${day.start.getTime()}
          AND generated_at_ms < ${day.end.getTime()}
        LIMIT 1`,
    );
    return rows.length > 0;
  }
  async recordCheckinAcknowledgement(
    request: RecordAcknowledgementRequest,
  ): Promise<void> {
    const reportId = request.reportId.trim();
    if (!reportId) {
      throw new Error(
        "[CheckinService] recordCheckinAcknowledgement: reportId is required",
      );
    }
    const agentId = String(this.runtime.agentId);
    await executeRawSql(
      this.runtime,
      `UPDATE ${CHECKIN_REPORTS_TABLE}
          SET acknowledged_at = ${sqlQuote(new Date().toISOString())}
        WHERE id = ${sqlQuote(reportId)}
          AND agent_id = ${sqlQuote(agentId)}`,
    );
  }
  private async runCheckin(
    kind: CheckinKind,
    request: RunCheckinRequest,
  ): Promise<CheckinReport> {
    const now = request.now ?? new Date();
    const timezone =
      request.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const habitCollector = await collectHabitSummaries(this.runtime, now);
    const [overdueTodos, todaysMeetings, completedWins, briefingSections] =
      await Promise.all([
        collectOverdueTodos(
          this.runtime,
          now,
          habitCollector.pausedDefinitionIds,
        ),
        collectTodaysMeetings(this.runtime, now, timezone),
        collectCompletedWins(this.runtime, kind, now, timezone),
        collectBriefingSections({
          runtime: this.runtime,
          source: this.options.sources,
          now,
          timezone,
        }),
      ]);
    const escalationLevel = await this.getEscalationLevel(now);
    const habitEscalationLevel = resolveHabitEscalationLevel(
      habitCollector.rows,
    );
    // sleepRecap is night-only by design (the morning prompt does not surface
    // sleep stats today). Drop it on morning runs even if a caller passes one
    // in to keep the night/morning report shapes diverging on this field.
    const sleepRecap: SleepRecap | null =
      kind === "night" ? (request.sleepRecap ?? null) : null;
    const reportWithoutSummary = {
      reportId: newReportId(),
      kind,
      generatedAt: now.toISOString(),
      timezone,
      escalationLevel,
      overdueTodos: overdueTodos.rows,
      todaysMeetings: todaysMeetings.rows,
      yesterdaysWins: completedWins.rows,
      habitSummaries: habitCollector.rows,
      habitEscalationLevel,
      briefingSections,
      sleepRecap,
      collectorErrors: {
        habitSummaries: habitCollector.error,
        overdueTodos: overdueTodos.error,
        todaysMeetings: todaysMeetings.error,
        yesterdaysWins: completedWins.error,
      },
    };
    const report: CheckinReport = {
      ...reportWithoutSummary,
      summaryText: await this.renderSummary(reportWithoutSummary),
    };
    if (request.persist !== false) {
      await this.persistReport(report, now);
    }
    return report;
  }
  public async persistCheckinReport(
    report: CheckinReport,
    now = new Date(report.generatedAt),
  ): Promise<void> {
    await this.persistReport(report, now);
  }
  private async renderSummary(
    report: Omit<CheckinReport, "summaryText">,
  ): Promise<string> {
    if (report.kind === "morning") return renderMorningCheckinReport(report);
    if (typeof this.runtime.useModel !== "function") {
      throw new ElizaError(
        "Check-in summary requires a configured text model",
        {
          code: "CHECKIN_MODEL_UNAVAILABLE",
        },
      );
    }
    const response = await runWithTrajectoryPurpose(
      getCheckinSummaryTrajectoryPurpose(report.kind),
      () =>
        this.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: buildCheckinSummaryPrompt(report),
        }),
    );
    if (typeof response !== "string" || !response.trim()) {
      throw new ElizaError("Check-in summary model returned no text", {
        code: "CHECKIN_SUMMARY_EMPTY",
      });
    }
    return response.trim();
  }
  private async persistReport(report: CheckinReport, now: Date): Promise<void> {
    const agentId = String(this.runtime.agentId);
    const payload = JSON.stringify({
      timezone: report.timezone,
      overdueTodos: report.overdueTodos,
      todaysMeetings: report.todaysMeetings,
      yesterdaysWins: report.yesterdaysWins,
      habitSummaries: report.habitSummaries,
      habitEscalationLevel: report.habitEscalationLevel,
      briefingSections: report.briefingSections,
      summaryText: report.summaryText,
      collectorErrors: report.collectorErrors,
      sleepRecap: report.sleepRecap,
    }).replace(/'/g, "''");
    await executeRawSql(
      this.runtime,
      `INSERT INTO ${CHECKIN_REPORTS_TABLE}
         (id, agent_id, kind, generated_at, generated_at_ms, escalation_level, payload_json, acknowledged_at)
       VALUES (
         ${sqlQuote(report.reportId)},
         ${sqlQuote(agentId)},
         ${sqlQuote(report.kind)},
         ${sqlQuote(report.generatedAt)},
         ${now.getTime()},
         ${report.escalationLevel},
         '${payload}',
         NULL
       )`,
    );
  }
}
