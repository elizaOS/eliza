import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType, runWithTrajectoryContext } from "@elizaos/core";
import {
  type GetLifeOpsCalendarFeedRequest,
  type GetLifeOpsGmailTriageRequest,
  type GetLifeOpsInboxRequest,
  LIFEOPS_OCCURRENCE_STATES,
  type LifeOpsCalendarFeed,
  type LifeOpsGmailTriageFeed,
  type LifeOpsInbox,
  type LifeOpsOccurrence,
  type LifeOpsOccurrenceState,
  type LifeOpsXDm,
  type LifeOpsXFeedItem,
  type LifeOpsXFeedType,
} from "@elizaos/shared";
import {
  computeMissedOccurrenceStreak,
  computeOccurrenceStreaks,
} from "../service-helpers-occurrence.js";
import { executeRawSql, parseJsonRecord, sqlQuote, toText } from "../sql.js";
import { buildUtcDateFromLocalParts, getZonedDateParts } from "../time.js";
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

export const CHECKIN_REPORTS_TABLE = "life_checkin_reports";

const ACK_WINDOW_MS = 72 * 60 * 60 * 1000;
const DEFAULT_SECTION_LIMIT = 8;
const INTERNAL_URL = new URL("http://127.0.0.1/");
const ACTION_TEXT_RE =
  /\b(urgent|asap|blocked|deadline|today|tonight|tomorrow|confirm|review|send|reply|respond|need|please|important|agreement|agreed|promise|promised|follow up|circle back)\b/i;

export interface CheckinSourceService {
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
  syncXDms?(opts?: { limit?: number }): Promise<{ synced: number }>;
  getXDms?(opts?: {
    conversationId?: string;
    limit?: number;
  }): Promise<LifeOpsXDm[]>;
  syncXFeed?(
    feedType: LifeOpsXFeedType,
    opts?: { limit?: number; query?: string },
  ): Promise<{ synced: number }>;
  getXFeedItems?(
    feedType: LifeOpsXFeedType,
    opts?: { limit?: number },
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
 * bedtime line entirely rather than print a placeholder.
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
  const hours = Math.floor(durationMin / 60);
  const minutes = Math.round(durationMin - hours * 60);
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
  return JSON.stringify(report, (_key, value: unknown) => {
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
    "This is generated from LifeOps source data. Do not invent facts.",
    "Rank for genuinely interesting, important, reply-needed, or schedule-changing items.",
    "Include X/socials (timeline, mentions, DMs), inboxes/messages/Discord, Gmail, GitHub, calendar changes, completed work, contacts, promises, agreements, and follow-ups when present.",
    "When a source is unavailable, say that source is unavailable in one compact clause instead of pretending it was empty.",
    report.kind === "morning"
      ? "Tone: concise start-of-day briefing, with what matters now and first next steps."
      : "Tone: concise evening recap sent before the owner's predicted bedtime, with what happened, loose ends, and tomorrow carry-forward.",
    "Use short sections or tight bullets. No markdown table. No emojis.",
  ];

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

/** Exposed for tests that want to reset the process-level once-log. */
export function __resetCheckinMissingSourceLog(): void {
  loggedMissingSources.clear();
}

function newReportId(): string {
  const maybeCrypto = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (maybeCrypto?.randomUUID) return maybeCrypto.randomUUID();
  return `checkin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clip(text: string, maxLength = 220): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
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
): { start: Date; end: Date; key: string } {
  const parts = getZonedDateParts(date, timezone);
  const start = buildUtcDateFromLocalParts(timezone, {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: 0,
    minute: 0,
    second: 0,
  });
  const end = buildUtcDateFromLocalParts(timezone, {
    year: parts.year,
    month: parts.month,
    day: parts.day + 1,
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

function rankTextSignal(args: {
  text: string;
  occurredAt: string | null;
  unread?: boolean;
  inbound?: boolean;
  replyNeeded?: boolean;
  important?: boolean;
}): { score: number; reason: string | null } {
  const reasons: string[] = [];
  let score = 0;
  if (args.inbound) {
    score += 20;
    reasons.push("incoming");
  }
  if (args.unread) {
    score += 15;
    reasons.push("unread");
  }
  if (args.replyNeeded) {
    score += 25;
    reasons.push("needs reply");
  }
  if (args.important) {
    score += 20;
    reasons.push("important");
  }
  if (args.text.includes("?")) {
    score += 10;
    reasons.push("question");
  }
  if (ACTION_TEXT_RE.test(args.text)) {
    score += 20;
    reasons.push("action language");
  }
  const occurredAtMs = parseMs(args.occurredAt);
  if (
    occurredAtMs !== null &&
    Date.now() - occurredAtMs <= 24 * 60 * 60 * 1000
  ) {
    score += 10;
    reasons.push("recent");
  }
  return {
    score,
    reason: reasons.length > 0 ? reasons.join(", ") : null,
  };
}

function sortBriefingItems(
  entries: Array<CheckinBriefingItem & { score: number }>,
): CheckinBriefingItem[] {
  return entries
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return (parseMs(right.occurredAt) ?? 0) - (parseMs(left.occurredAt) ?? 0);
    })
    .slice(0, DEFAULT_SECTION_LIMIT)
    .map(({ score: _score, ...item }) => item);
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
  occurrence_state: unknown;
  occurrence_due_at: unknown;
  occurrence_updated_at: unknown;
};

type HabitOccurrence = {
  state: LifeOpsOccurrenceState;
  dueAtMs: number;
  updatedAtMs: number;
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

function buildHabitSummary(args: {
  definitionId: string;
  title: string;
  kind: "habit" | "routine";
  metadata: Record<string, unknown>;
  occurrences: HabitOccurrence[];
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
  return {
    definitionId: args.definitionId,
    title: args.title,
    kind: args.kind,
    currentOccurrenceStreak: pauseUntil ? 0 : completedStreak.current,
    bestOccurrenceStreak: completedStreak.best,
    missedOccurrenceStreak: pauseUntil ? 0 : missedStreak.current,
    pauseUntil,
    isPaused: pauseUntil !== null,
  };
}

async function collectHabitSummaries(
  runtime: IAgentRuntime,
  now: Date,
): Promise<
  CollectorResult<HabitSummary> & { pausedDefinitionIds: Set<string> }
> {
  const agentId = String(runtime.agentId);
  try {
    const definitionRows = await executeRawSql(
      runtime,
      `SELECT id AS definition_id,
              title AS definition_title,
              kind AS definition_kind,
              metadata_json AS definition_metadata_json
         FROM life_task_definitions
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
         FROM life_task_occurrences
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
      const current = occurrencesByDefinitionId.get(definitionId);
      const nextOccurrence: HabitOccurrence = {
        state,
        dueAtMs,
        updatedAtMs,
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
      if (!definitionId || !title || (kind !== "habit" && kind !== "routine")) {
        continue;
      }
      const summary = buildHabitSummary({
        definitionId,
        title,
        kind,
        metadata,
        occurrences: occurrencesByDefinitionId.get(definitionId) ?? [],
        now,
      });
      if (summary.isPaused) {
        pausedDefinitionIds.add(definitionId);
      }
      summaries.push(summary);
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
         FROM life_task_occurrences occ
         LEFT JOIN life_task_definitions def ON def.id = occ.definition_id
        WHERE occ.agent_id = ${sqlQuote(agentId)}
          AND occ.state IN ('pending', 'active', 'in_progress')
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
      `overdue-todos collector unavailable (life_task_occurrences not ready): ${message}`,
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
      `SELECT id, title, start_at, end_at
         FROM life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND start_at >= ${sqlQuote(day.start.toISOString())}
          AND start_at < ${sqlQuote(day.end.toISOString())}
        ORDER BY start_at ASC
        LIMIT 50`,
    );
    return {
      rows: rows.map((row) => ({
        id: toText(row.id),
        title: toText(row.title) || "(untitled)",
        startAt: toText(row.start_at),
        endAt: toText(row.end_at),
      })),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMissingOnce(
      "todays-meetings",
      `meetings collector unavailable (life_calendar_events not ready): ${message}`,
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
  const day =
    kind === "morning"
      ? localDayWindow(new Date(now.getTime() - 24 * 60 * 60 * 1000), timezone)
      : localDayWindow(now, timezone);
  const start = day.start;
  const end = kind === "morning" ? day.end : now;
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT occ.id AS id,
              COALESCE(def.title, '') AS title,
              occ.updated_at AS completed_at
         FROM life_task_occurrences occ
         LEFT JOIN life_task_definitions def ON def.id = occ.definition_id
        WHERE occ.agent_id = ${sqlQuote(agentId)}
          AND occ.state = 'completed'
          AND occ.updated_at >= ${sqlQuote(start.toISOString())}
          AND occ.updated_at <= ${sqlQuote(end.toISOString())}
        ORDER BY occ.updated_at DESC
        LIMIT 50`,
    );
    return {
      rows: rows.map((row) => ({
        id: toText(row.id),
        title: toText(row.title) || "(untitled)",
        completedAt: row.completed_at == null ? null : toText(row.completed_at),
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
        const ranked = rankTextSignal({
          text: dm.text,
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
          score: ranked.score,
        };
      }),
    );
    const actionNeeded = items.filter((item) =>
      item.reason?.includes("needs reply"),
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
        const raw = (feedItem.metadata?.raw ?? {}) as {
          referenced_tweets?: Array<{ type?: string }>;
          public_metrics?: Record<string, number>;
        };
        const referenceTypes = (raw.referenced_tweets ?? [])
          .map((reference) => reference.type)
          .filter((type): type is string => typeof type === "string");
        const isReply = referenceTypes.includes("replied_to");
        const metrics = raw.public_metrics ?? {};
        const engagement =
          (metrics.like_count ?? 0) +
          (metrics.reply_count ?? 0) * 3 +
          (metrics.retweet_count ?? 0) * 2 +
          (metrics.quote_count ?? 0) * 2;
        const ranked = rankTextSignal({
          text: feedItem.text,
          occurredAt: feedItem.createdAtSource,
          replyNeeded: isReply,
          important: engagement >= 25,
        });
        return {
          title: feedItem.authorHandle
            ? `@${feedItem.authorHandle}`
            : feedItem.authorId,
          detail: clip(feedItem.text),
          occurredAt: feedItem.createdAtSource,
          href: `https://x.com/i/web/status/${feedItem.externalTweetId}`,
          reason: ranked.reason,
          score: ranked.score + Math.min(30, engagement),
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
    const inbox = await source.getInbox({ limit: 50 });
    const counts = Object.entries(inbox.channelCounts)
      .filter(([, count]) => count.total > 0)
      .map(
        ([channel, count]) =>
          `${channel}: ${count.total}${count.unread > 0 ? `/${count.unread} unread` : ""}`,
      );
    const items = sortBriefingItems(
      inbox.messages.map((message) => {
        const text = `${message.subject ?? ""} ${message.snippet}`;
        const ranked = rankTextSignal({
          text,
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
          score: ranked.score,
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
): Promise<CheckinBriefingSection> {
  if (!source?.getGmailTriage) {
    return unavailableSection(
      "gmail",
      "Gmail",
      "Gmail triage reader is not registered on this runtime.",
    );
  }
  try {
    const feed = await source.getGmailTriage(
      INTERNAL_URL,
      { maxResults: 25 },
      now,
    );
    const items = sortBriefingItems(
      feed.messages.map((message) => {
        const text = `${message.subject} ${message.snippet}`;
        const ranked = rankTextSignal({
          text,
          occurredAt: message.receivedAt,
          unread: message.isUnread,
          inbound: true,
          replyNeeded: message.likelyReplyNeeded,
          important: message.isImportant,
        });
        return {
          title: `${message.from || "Unknown"}${
            message.subject ? `: ${message.subject}` : ""
          }`,
          detail: clip(message.snippet || message.triageReason),
          occurredAt: message.receivedAt,
          href: message.htmlLink,
          reason: ranked.reason ?? (message.triageReason || null),
          score: ranked.score + message.triageScore,
        };
      }),
    );
    return {
      key: "gmail",
      title: "Gmail",
      summary: `${feed.summary.unreadCount} unread, ${feed.summary.importantNewCount} important, ${feed.summary.likelyReplyNeededCount} likely needing reply.`,
      items,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSection("gmail", "Gmail", message);
  }
}

async function collectCalendarChangeSection(
  runtime: IAgentRuntime,
  now: Date,
  timezone: string,
): Promise<CheckinBriefingSection> {
  const agentId = String(runtime.agentId);
  const day = localDayWindow(now, timezone);
  const sinceIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT title, start_at, end_at, status, html_link, updated_at
         FROM life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND side = 'owner'
          AND (
            (start_at >= ${sqlQuote(day.start.toISOString())}
             AND start_at < ${sqlQuote(day.end.toISOString())})
            OR updated_at >= ${sqlQuote(sinceIso)}
          )
        ORDER BY
          CASE WHEN updated_at >= ${sqlQuote(sinceIso)} THEN 0 ELSE 1 END,
          start_at ASC
        LIMIT 40`,
    );
    const todayCount = rows.filter((row) => {
      const startMs = parseMs(toText(row.start_at));
      return (
        startMs !== null &&
        startMs >= day.start.getTime() &&
        startMs < day.end.getTime()
      );
    }).length;
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
        return {
          title,
          detail: `${toText(row.start_at)} - ${toText(row.end_at)}${
            status ? ` (${status})` : ""
          }`,
          occurredAt: updatedAt ?? toText(row.start_at),
          href: toText(row.html_link) || null,
          reason,
          score: (isChanged ? 30 : 10) + (status === "cancelled" ? 30 : 0),
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
           FROM life_gmail_messages
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
           FROM life_screen_time_sessions
          WHERE agent_id = ${sqlQuote(agentId)}
            AND start_at >= ${sqlQuote(day.start.toISOString())}
            AND start_at < ${sqlQuote(day.end.toISOString())}
            AND LOWER(identifier || ' ' || display_name) LIKE '%github%'
          ORDER BY start_at DESC
          LIMIT 12`,
      ),
    ]);
    const mailItems = mailRows.map((row) => {
      const text = `${toText(row.subject)} ${toText(row.snippet)}`;
      const ranked = rankTextSignal({
        text,
        occurredAt: toText(row.received_at),
        unread: toBoolean(row.is_unread),
        important: toBoolean(row.is_important),
        replyNeeded: toBoolean(row.likely_reply_needed),
        inbound: true,
      });
      return {
        title: `GitHub email: ${toText(row.subject) || "(no subject)"}`,
        detail: clip(toText(row.snippet) || toText(row.from_display)),
        occurredAt: toText(row.received_at) || null,
        href: toText(row.html_link) || null,
        reason: ranked.reason,
        score: ranked.score + Number(row.triage_score ?? 0),
      };
    });
    const screenItems = screenRows.map((row) => {
      const minutes = Math.round(Number(row.duration_seconds ?? 0) / 60);
      return {
        title: `GitHub activity: ${
          toText(row.display_name) || toText(row.identifier)
        }`,
        detail: `${minutes}m active`,
        occurredAt: toText(row.start_at) || null,
        href: null,
        reason: "workspace activity",
        score: 10 + Math.min(30, minutes),
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
    const rows = await executeRawSql(
      runtime,
      `SELECT COALESCE(rel.name, interaction.relationship_id) AS name,
              interaction.channel,
              interaction.direction,
              interaction.summary,
              interaction.occurred_at
         FROM life_relationship_interactions interaction
         LEFT JOIN life_relationships rel
           ON rel.agent_id = interaction.agent_id
          AND rel.id = interaction.relationship_id
        WHERE interaction.agent_id = ${sqlQuote(agentId)}
          AND interaction.occurred_at >= ${sqlQuote(day.start.toISOString())}
          AND interaction.occurred_at < ${sqlQuote(day.end.toISOString())}
        ORDER BY interaction.occurred_at DESC
        LIMIT 30`,
    );
    const uniqueNames = new Set(
      rows.map((row) => toText(row.name)).filter(Boolean),
    );
    const items = sortBriefingItems(
      rows.map((row) => ({
        title: `${toText(row.name) || "Unknown"} (${
          toText(row.channel) || "unknown"
        })`,
        detail: clip(toText(row.summary) || toText(row.direction)),
        occurredAt: toText(row.occurred_at) || null,
        href: null,
        reason: toText(row.direction) || null,
        score: 20,
      })),
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
  timezone: string,
): Promise<CheckinBriefingSection> {
  const agentId = String(runtime.agentId);
  const day = localDayWindow(now, timezone);
  const tomorrowIso = day.end.toISOString();
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT followup.reason,
              followup.status,
              followup.priority,
              followup.due_at,
              followup.completed_at,
              followup.updated_at,
              COALESCE(rel.name, followup.relationship_id) AS name
         FROM life_follow_ups followup
         LEFT JOIN life_relationships rel
           ON rel.agent_id = followup.agent_id
          AND rel.id = followup.relationship_id
        WHERE followup.agent_id = ${sqlQuote(agentId)}
          AND (
            followup.status = 'pending'
            OR followup.due_at < ${sqlQuote(tomorrowIso)}
            OR followup.updated_at >= ${sqlQuote(day.start.toISOString())}
          )
        ORDER BY
          CASE followup.status WHEN 'pending' THEN 0 ELSE 1 END,
          followup.priority ASC,
          followup.due_at ASC
        LIMIT 30`,
    );
    const pendingCount = rows.filter(
      (row) => toText(row.status) === "pending",
    ).length;
    const completedToday = rows.filter((row) => {
      const completedMs = parseMs(toText(row.completed_at));
      return (
        completedMs !== null &&
        completedMs >= day.start.getTime() &&
        completedMs < day.end.getTime()
      );
    }).length;
    const items = sortBriefingItems(
      rows.map((row) => {
        const status = toText(row.status);
        const priority = Number(row.priority ?? 3);
        return {
          title: `${toText(row.name) || "Follow-up"}: ${status}`,
          detail: clip(toText(row.reason)),
          occurredAt: toText(row.due_at) || toText(row.updated_at) || null,
          href: null,
          reason:
            status === "pending"
              ? "open promise/follow-up"
              : status === "completed"
                ? "completed"
                : status || null,
          score: (status === "pending" ? 40 : 10) + Math.max(0, 10 - priority),
        };
      }),
    );
    return {
      key: "promises",
      title: "Promises, agreements, and follow-ups",
      summary: `${summarizeCount(pendingCount, "open follow-up")} tracked; ${summarizeCount(completedToday, "completed today", "completed today")}.`,
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
  return Promise.all([
    collectXDmSection(args.source),
    collectXFeedSection(
      args.source,
      "x_timeline",
      "home_timeline",
      "X timeline",
    ),
    collectXFeedSection(args.source, "x_mentions", "mentions", "X mentions"),
    collectInboxSection(args.source),
    collectGmailSection(args.source, args.now),
    collectGitHubSection(args.runtime, args.now, args.timezone),
    collectCalendarChangeSection(args.runtime, args.now, args.timezone),
    collectContactSection(args.runtime, args.now, args.timezone),
    collectPromiseSection(args.runtime, args.now, args.timezone),
  ]);
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
      request.timezone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC";
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
      escalationLevel,
      overdueTodos: overdueTodos.rows,
      todaysMeetings: todaysMeetings.rows,
      yesterdaysWins: completedWins.rows,
      habitSummaries: habitCollector.rows,
      habitEscalationLevel,
      briefingSections,
      sleepRecap,
      collectorErrors: {
        overdueTodos: overdueTodos.error,
        todaysMeetings: todaysMeetings.error,
        yesterdaysWins: completedWins.error,
      },
    };
    const report: CheckinReport = {
      ...reportWithoutSummary,
      summaryText: await this.renderSummary(reportWithoutSummary),
    };
    await this.persistReport(report, now);
    return report;
  }

  private fallbackSummary(report: Omit<CheckinReport, "summaryText">): string {
    const prefix =
      report.kind === "morning" ? "Morning check-in" : "Night check-in";
    const winsLabel =
      report.kind === "morning" ? "yesterday's wins" : "wins today";
    const sourceLine = report.briefingSections
      .map((section) =>
        section.error
          ? `${section.title}: unavailable`
          : `${section.title}: ${section.summary}`,
      )
      .join(" ");
    return `${prefix}: ${summarizeCount(report.overdueTodos.length, "overdue todo")}, ${summarizeCount(report.todaysMeetings.length, "meeting")} today, ${summarizeCount(report.yesterdaysWins.length, winsLabel, winsLabel)}, and ${summarizeCount(report.habitSummaries.length, "tracked habit")}. ${sourceLine}`.trim();
  }

  private async renderSummary(
    report: Omit<CheckinReport, "summaryText">,
  ): Promise<string> {
    const fallback = this.fallbackSummary(report);
    if (typeof this.runtime.useModel !== "function") {
      return fallback;
    }
    const prompt = buildCheckinSummaryPrompt(report);
    try {
      const response = await runWithTrajectoryContext(
        { purpose: "lifeops-checkin-summary" },
        () =>
          this.runtime.useModel(ModelType.TEXT_LARGE, {
            prompt,
          }),
      );
      const text = typeof response === "string" ? response.trim() : "";
      return text.length > 0 ? text : fallback;
    } catch (error) {
      logMissingOnce(
        "checkin-summary-model",
        `summary model unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return fallback;
    }
  }

  private async persistReport(report: CheckinReport, now: Date): Promise<void> {
    const agentId = String(this.runtime.agentId);
    const payload = JSON.stringify({
      overdueTodos: report.overdueTodos,
      todaysMeetings: report.todaysMeetings,
      yesterdaysWins: report.yesterdaysWins,
      habitSummaries: report.habitSummaries,
      habitEscalationLevel: report.habitEscalationLevel,
      briefingSections: report.briefingSections,
      summaryText: report.summaryText,
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
