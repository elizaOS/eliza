import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { executeRawSql, sqlQuote, toText } from "../sql.js";
import type {
  CheckinKind,
  CheckinReport,
  EscalationLevel,
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
 * Graceful degradation: if an upstream collector source is missing (e.g. no
 * meetings table yet), the collector logs once per process AND records the
 * error message in `CheckinReport.collectorErrors.<field>`. The rows list
 * remains `[]` but downstream renderers can now distinguish "no data" from
 * "SQL threw" via the error field — see L22 LARP fix.
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

async function ensureCheckinTable(runtime: IAgentRuntime): Promise<void> {
  await executeRawSql(
    runtime,
    `CREATE TABLE IF NOT EXISTS ${CHECKIN_REPORTS_TABLE} (
       id TEXT PRIMARY KEY,
       agent_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       generated_at TEXT NOT NULL,
       generated_at_ms BIGINT NOT NULL,
       escalation_level INTEGER NOT NULL,
       payload_json TEXT NOT NULL,
       acknowledged_at TEXT
     )`,
  );
  await executeRawSql(
    runtime,
    `CREATE INDEX IF NOT EXISTS idx_life_checkin_reports_agent_time
       ON ${CHECKIN_REPORTS_TABLE}(agent_id, generated_at_ms DESC)`,
  );
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

async function collectOverdueTodos(
  runtime: IAgentRuntime,
  now: Date,
): Promise<CollectorResult<OverdueTodo>> {
  const agentId = String(runtime.agentId);
  const nowIso = now.toISOString();
  try {
    const rows = await executeRawSql(
      runtime,
      `SELECT occ.id AS id,
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
      rows: rows.map((row) => ({
        id: toText(row.id),
        title: toText(row.title) || "(untitled)",
        dueAt: row.due_at == null ? null : toText(row.due_at),
      })),
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
    await ensureCheckinTable(this.runtime);
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
    await ensureCheckinTable(this.runtime);
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
    await ensureCheckinTable(this.runtime);
    const now = request.now ?? new Date();
    const [overdueTodos, todaysMeetings, yesterdaysWins] = await Promise.all([
      collectOverdueTodos(this.runtime, now),
      collectTodaysMeetings(this.runtime, now),
      collectYesterdaysWins(this.runtime, now),
    ]);
    const escalationLevel = await this.getEscalationLevel(now);
    const report: CheckinReport = {
      reportId: newReportId(),
      kind,
      generatedAt: now.toISOString(),
      escalationLevel,
      overdueTodos: overdueTodos.rows,
      todaysMeetings: todaysMeetings.rows,
      yesterdaysWins: yesterdaysWins.rows,
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
