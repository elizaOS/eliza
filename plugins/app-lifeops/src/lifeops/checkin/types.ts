/**
 * Check-in engine types (T9f — Morning/night check-in routine engine, plan §6.23).
 *
 * Scope: types used by CheckinService and its actions. Weekly/quarterly review,
 * pause/resume/snooze, and cron wiring are intentionally deferred to follow-up PRs.
 */

import type { LifeOpsRegularityClass } from "@elizaos/shared";

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

export type CheckinBriefingSectionKey =
  | "x_dms"
  | "x_timeline"
  | "x_mentions"
  | "inbox"
  | "gmail"
  | "github"
  | "calendar_changes"
  | "contacts"
  | "promises";

export interface CheckinBriefingItem {
  readonly title: string;
  readonly detail: string;
  readonly occurredAt: string | null;
  readonly href: string | null;
  readonly reason: string | null;
}

export interface CheckinBriefingSection {
  readonly key: CheckinBriefingSectionKey;
  readonly title: string;
  readonly summary: string;
  readonly items: readonly CheckinBriefingItem[];
  readonly error: string | null;
}

export interface CheckinCollectorErrors {
  readonly overdueTodos: string | null;
  readonly todaysMeetings: string | null;
  readonly yesterdaysWins: string | null;
}

/**
 * Sleep recap surfaced to the night-summary prompt. Sourced from the merged
 * schedule-state record's `baseline` (median bedtime / sleep duration) and
 * `regularity` (sleep regularity index, classification). The dispatcher in
 * `service-mixin-reminders.ts#processSleepCycleCheckins` reads these from
 * `currentSchedule.{baseline,regularity}` and threads them into
 * `runNightCheckin`. Always optional — the morning path does not surface
 * sleep stats today, and the night path falls back gracefully when the
 * baseline has fewer than 5 episodes (`baseline === null`).
 *
 * Moved to `@elizaos/plugin-health` in Wave-1 (W1-B). Re-exported here for
 * backward compatibility with the existing `from "./types.js"` importers,
 * and brought into local scope for downstream `SleepRecap | null` usages
 * inside this file.
 */
import type { SleepRecap } from "@elizaos/plugin-health";

export type { SleepRecap };

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
  readonly briefingSections: readonly CheckinBriefingSection[];
  readonly summaryText: string;
  readonly collectorErrors: CheckinCollectorErrors;
  /**
   * Night-only. Present when the dispatcher has a current
   * `LifeOpsScheduleMergedStateRecord` to read from; null otherwise. Morning
   * reports leave this null.
   */
  readonly sleepRecap: SleepRecap | null;
}

export interface RunCheckinRequest {
  readonly roomId?: string;
  readonly now?: Date;
  readonly timezone?: string;
  /**
   * Night-only sleep recap to thread into the night-summary prompt. Built by
   * `processSleepCycleCheckins` from the merged schedule-state record. Ignored
   * for morning check-ins.
   */
  readonly sleepRecap?: SleepRecap | null;
}

export interface RecordAcknowledgementRequest {
  readonly reportId: string;
}
