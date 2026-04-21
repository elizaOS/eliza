import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { executeRawSql, parseJsonRecord, sqlQuote, toText } from "../sql.js";
import {
  computeMissedOccurrenceStreak,
  computeOccurrenceStreaks,
} from "../service-helpers-occurrence.js";
import type { LifeOpsOccurrence } from "@elizaos/shared/contracts/lifeops";
import type {
  CheckinKind,
  CheckinReport,
  EscalationLevel,
  HabitSummary,
  MeetingEntry,
  OverdueTodo,
  RecentWin,
  RecordAcknowledgementRequest,
  RunCheckinRequest,
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

// Single-shot logging for graceful-degradation paths.
const loggedMissingSources = new Set<string>();
function logMissingOnce(key: string, message: string): void {
  if (loggedMissingSources.has(key)) return;
  loggedMissingSources.add(key);
  logger.info(`[CheckinService] ${message}`);
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
  state: string;
  dueAtMs: number;
  updatedAtMs: number;
};

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
      if (!definitionId || dueAtMs === null || updatedAtMs === null) {
        continue;
      }
      const current = occurrencesByDefinitionId.get(definitionId);
      const nextOccurrence: HabitOccurrence = {
        state: toText(row.occurrence_state),
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
): Promise<CollectorResult<MeetingEntry>> {
  const agentId = String(runtime.agentId);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT id, title, start_at, end_at
         FROM life_calendar_events
        WHERE agent_id = ${sqlQuote(agentId)}
          AND start_at >= ${sqlQuote(startOfDay.toISOString())}
          AND start_at <= ${sqlQuote(endOfDay.toISOString())}
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

async function collectYesterdaysWins(
  runtime: IAgentRuntime,
  now: Date,
): Promise<CollectorResult<RecentWin>> {
  const agentId = String(runtime.agentId);
  const startOfYesterday = new Date(now);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  startOfYesterday.setHours(0, 0, 0, 0);
  const endOfYesterday = new Date(startOfYesterday);
  endOfYesterday.setHours(23, 59, 59, 999);
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
          AND occ.updated_at >= ${sqlQuote(startOfYesterday.toISOString())}
          AND occ.updated_at <= ${sqlQuote(endOfYesterday.toISOString())}
        ORDER BY occ.updated_at DESC
        LIMIT 50`,
    );
    return {
      rows: rows.map((row) => ({
        id: toText(row.id),
        title: toText(row.title) || "(untitled)",
        completedAt:
          row.completed_at == null ? null : toText(row.completed_at),
      })),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logMissingOnce(
      "yesterdays-wins",
      `yesterdays-wins collector unavailable: ${message}`,
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

function resolveHabitEscalationLevel(summaries: readonly HabitSummary[]): EscalationLevel {
  const maxMissedStreak = summaries.reduce(
    (max, summary) => Math.max(max, summary.missedOccurrenceStreak),
    0,
  );
  return clampEscalation(maxMissedStreak);
}

export class CheckinService {
  constructor(private readonly runtime: IAgentRuntime) {}

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
    const habitCollector = await collectHabitSummaries(this.runtime, now);
    const [overdueTodos, todaysMeetings, yesterdaysWins] = await Promise.all([
      collectOverdueTodos(this.runtime, now, habitCollector.pausedDefinitionIds),
      collectTodaysMeetings(this.runtime, now),
      collectYesterdaysWins(this.runtime, now),
    ]);
    const escalationLevel = await this.getEscalationLevel(now);
    const habitEscalationLevel = resolveHabitEscalationLevel(
      habitCollector.rows,
    );
    const report: CheckinReport = {
      reportId: newReportId(),
      kind,
      generatedAt: now.toISOString(),
      escalationLevel,
      overdueTodos: overdueTodos.rows,
      todaysMeetings: todaysMeetings.rows,
      yesterdaysWins: yesterdaysWins.rows,
      habitSummaries: habitCollector.rows,
      habitEscalationLevel,
      collectorErrors: {
        overdueTodos: overdueTodos.error,
        todaysMeetings: todaysMeetings.error,
        yesterdaysWins: yesterdaysWins.error,
      },
    };
    await this.persistReport(report, now);
    return report;
  }

  private async persistReport(
    report: CheckinReport,
    now: Date,
  ): Promise<void> {
    const agentId = String(this.runtime.agentId);
    const payload = JSON.stringify({
      overdueTodos: report.overdueTodos,
      todaysMeetings: report.todaysMeetings,
      yesterdaysWins: report.yesterdaysWins,
      habitSummaries: report.habitSummaries,
      habitEscalationLevel: report.habitEscalationLevel,
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
