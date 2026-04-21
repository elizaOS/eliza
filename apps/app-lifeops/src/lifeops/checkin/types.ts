/**
 * Check-in engine types (T9f — Morning/night check-in routine engine, plan §6.23).
 *
 * Scope: types used by CheckinService and its actions. Weekly/quarterly review,
 * pause/resume/snooze, and cron wiring are intentionally deferred to follow-up PRs.
 */

export type CheckinKind = "morning" | "night";

/** 0 = new, 1 = one missed, 2 = two missed, 3 = three+ missed (escalate tone). */
export type EscalationLevel = 0 | 1 | 2 | 3;

export interface OverdueTodo {
  readonly id: string;
  readonly title: string;
  readonly dueAt: string | null;
}

export interface MeetingEntry {
  readonly id: string;
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
}

export interface RecentWin {
  readonly id: string;
  readonly title: string;
  readonly completedAt: string | null;
}

export interface HabitSummary {
  readonly definitionId: string;
  readonly title: string;
  readonly kind: "habit" | "routine";
  readonly currentOccurrenceStreak: number;
  readonly bestOccurrenceStreak: number;
  readonly missedOccurrenceStreak: number;
  readonly pauseUntil: string | null;
  readonly isPaused: boolean;
}

export interface CheckinCollectorErrors {
  readonly overdueTodos: string | null;
  readonly todaysMeetings: string | null;
  readonly yesterdaysWins: string | null;
}

export interface CheckinReport {
  readonly reportId: string;
  readonly kind: CheckinKind;
  readonly generatedAt: string;
  readonly escalationLevel: EscalationLevel;
  readonly overdueTodos: readonly OverdueTodo[];
  readonly todaysMeetings: readonly MeetingEntry[];
  readonly yesterdaysWins: readonly RecentWin[];
  readonly habitSummaries: readonly HabitSummary[];
  readonly habitEscalationLevel: EscalationLevel;
  readonly collectorErrors: CheckinCollectorErrors;
}

export interface RunCheckinRequest {
  readonly roomId?: string;
  readonly now?: Date;
}

export interface RecordAcknowledgementRequest {
  readonly reportId: string;
}
