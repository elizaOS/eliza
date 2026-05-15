import type { LifeOpsHealthSignal } from "../contracts/index.js";

export type TimeBucket =
  | "EARLY_MORNING" // 5-7
  | "MORNING" // 7-10
  | "MIDDAY" // 10-14
  | "AFTERNOON" // 14-17
  | "EVENING" // 17-21
  | "NIGHT" // 21-1
  | "LATE_NIGHT"; // 1-5

export const TIME_BUCKET_RANGES: Record<
  TimeBucket,
  { start: number; end: number }
> = {
  EARLY_MORNING: { start: 5, end: 7 },
  MORNING: { start: 7, end: 10 },
  MIDDAY: { start: 10, end: 14 },
  AFTERNOON: { start: 14, end: 17 },
  EVENING: { start: 17, end: 21 },
  NIGHT: { start: 21, end: 25 }, // 25 = 1 AM next day
  LATE_NIGHT: { start: 1, end: 5 },
};

export const ALL_TIME_BUCKETS: TimeBucket[] = [
  "EARLY_MORNING",
  "MORNING",
  "MIDDAY",
  "AFTERNOON",
  "EVENING",
  "NIGHT",
  "LATE_NIGHT",
];

export function emptyBucketCounts(): Record<TimeBucket, number> {
  return {
    EARLY_MORNING: 0,
    MORNING: 0,
    MIDDAY: 0,
    AFTERNOON: 0,
    EVENING: 0,
    NIGHT: 0,
    LATE_NIGHT: 0,
  };
}

export interface PlatformActivity {
  source: string;
  messageCount: number;
  bucketCounts: Record<TimeBucket, number>;
  lastMessageAt: number;
  averageMessagesPerDay: number;
}

export interface ActivitySignalRecord {
  source:
    | "app_lifecycle"
    | "page_visibility"
    | "desktop_power"
    | "desktop_interaction"
    | "connector_activity"
    | "imessage_outbound"
    | "mobile_device"
    | "mobile_health";
  platform: string;
  state: "active" | "idle" | "background" | "locked" | "sleeping";
  observedAt: number;
  idleState: "active" | "idle" | "locked" | "unknown" | null;
  idleTimeSeconds: number | null;
  onBattery: boolean | null;
  health: LifeOpsHealthSignal | null;
  metadata: Record<string, unknown>;
}

export interface ActivityProfile {
  ownerEntityId: string;
  analyzedAt: number;
  analysisWindowDays: number;
  timezone: string;
  totalMessages: number;
  sustainedInactivityThresholdMinutes: number;

  platforms: PlatformActivity[];
  primaryPlatform: string | null;
  secondaryPlatform: string | null;

  bucketCounts: Record<TimeBucket, number>;

  hasCalendarData: boolean;
  typicalFirstEventHour: number | null;
  typicalLastEventHour: number | null;
  avgWeekdayMeetings: number | null;

  typicalFirstActiveHour: number | null;
  typicalLastActiveHour: number | null;
  typicalWakeHour: number | null;
  typicalSleepHour: number | null;
  hasSleepData: boolean;
  isCurrentlySleeping: boolean;
  lastSleepSignalAt: number | null;
  lastWakeSignalAt: number | null;
  sleepSourcePlatform: string | null;
  sleepSource: string | null;
  typicalSleepDurationMinutes: number | null;

  lastSeenAt: number;
  lastSeenPlatform: string | null;
  isCurrentlyActive: boolean;
  hasOpenActivityCycle: boolean;
  currentActivityCycleStartedAt: number | null;
  currentActivityCycleLocalDate: string | null;
  effectiveDayKey: string;
  screenContextFocus:
    | "work"
    | "leisure"
    | "transition"
    | "idle"
    | "unknown"
    | null;
  screenContextSource: "disabled" | "browser-capture" | "vision" | null;
  screenContextSampledAt: number | null;
  screenContextConfidence: number | null;
  screenContextBusy: boolean;
  screenContextAvailable: boolean;
  screenContextStale: boolean;
}

export interface ProactiveAction {
  kind:
    | "gm"
    | "gn"
    | "pre_activity_nudge"
    | "goal_check_in"
    | "social_overuse_check";
  scheduledFor: number;
  targetPlatform: string;
  contextSummary: string;
  messageText: string;
  occurrenceId?: string;
  calendarEventId?: string;
  goalId?: string;
  status: "pending" | "fired" | "skipped";
  skipReason?: string;
}

export interface FiredActionsLog {
  date: string; // YYYY-MM-DD in local timezone
  gmFiredAt?: number;
  gnFiredAt?: number;
  nudgedOccurrenceIds: string[];
  nudgedCalendarEventIds: string[];
  checkedGoalIds?: string[];
  /**
   * Wave-2 W2-A: legacy `seedingOfferedAt` is preserved on the persisted
   * record for backward compatibility with old logs but the proactive
   * worker no longer writes or reads it. The legacy `onboarding_seed`
   * action kind has been removed.
   */
  seedingOfferedAt?: number;
  /** Epoch ms of the most recent social_overuse_check delivery, if any. */
  socialOveruseCheckedAt?: number;
}
