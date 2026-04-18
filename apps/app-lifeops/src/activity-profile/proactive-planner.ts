/**
 * Pure decision logic for proactive agent actions (GM, GN, nudges).
 * No runtime dependencies — fully unit-testable.
 *
 * Given an ActivityProfile + occurrence/calendar context, returns
 * ProactiveAction[] describing what to send, when, and where.
 */

import { getLocalDateKey, getZonedDateParts } from "../lifeops/time.js";
import { resolveEffectiveDayKey, wasActiveToday } from "./analyzer.js";
import type {
  ActivityProfile,
  FiredActionsLog,
  ProactiveAction,
} from "./types.js";

// ── Configuration ─────────────────────────────────────

/** Minutes before first event/activity to send GM. */
const GM_LEAD_MINUTES = 30;
/** Default GM hour (local) when no calendar or message data. */
const DEFAULT_GM_HOUR = 8;
/** Latest hour (local) to send GM — skip if past this. */
const GM_CUTOFF_HOUR = 11;
/** Minutes after last typical active hour to send GN. */
const GN_LAG_MINUTES = 30;
/** Default GN hour (local) when no data. */
const DEFAULT_GN_HOUR = 22;
/** Minutes before an occurrence/event to send a nudge. */
const NUDGE_LEAD_MINUTES = 30;
/** Maximum nudge lookahead window. */
const NUDGE_HORIZON_MINUTES = 45;
/** If user hasn't been active in this many ms, skip GM entirely. */
const INACTIVITY_SKIP_MS = 48 * 60 * 60 * 1000; // 48 hours
/** Days since last review before a goal is eligible for a check-in. */
const GOAL_CHECK_IN_COOLDOWN_DAYS = 3;

// ── Goal check-in contract ───────────────────────────

export interface GoalSlim {
  id: string;
  title: string;
  status: string;
  linkedDefinitionCount: number;
  /** 0-1 completion rate over the last 7 days. */
  recentCompletionRate: number;
  /** ISO datetime of the last goal review, or null if never reviewed. */
  lastReviewedAt: string | null;
}

// ── Occurrence / Calendar event contracts ─────────────

export interface OccurrenceSlim {
  id: string;
  title: string;
  dueAt: string | null; // ISO datetime
  state: string;
  definitionKind?: "task" | "habit" | "routine";
  cadence?: {
    kind: "once" | "daily" | "times_per_day" | "interval" | "weekly";
  };
  priority?: number;
}

export interface CalendarEventSlim {
  id: string;
  summary: string;
  startAt: string; // ISO datetime
  endAt: string;
  isAllDay: boolean;
  description?: string;
  location?: string;
  attendeeCount?: number;
  conferenceLink?: string | null;
  proactiveCheckIn?: boolean | null;
  proactiveCheckInReason?: string | null;
}

// ── GM planning ───────────────────────────────────────

export function planGm(
  profile: ActivityProfile,
  occurrences: OccurrenceSlim[],
  calendarEvents: CalendarEventSlim[],
  firedToday: FiredActionsLog | null,
  timezone: string,
  now?: Date,
): ProactiveAction | null {
  const currentTime = now ?? new Date();
  if (profile.isCurrentlySleeping) {
    return null;
  }

  // Already fired today
  if (firedToday?.gmFiredAt) {
    return null;
  }

  // User inactive for 48h+ — don't be annoying
  if (
    profile.lastSeenAt > 0 &&
    currentTime.getTime() - profile.lastSeenAt > INACTIVITY_SKIP_MS
  ) {
    return makeSkipped("gm", currentTime, profile, "user inactive for 48h+");
  }

  const localDateKey = getLocalDateKey(
    getZonedDateParts(currentTime, timezone),
  );
  if (resolveEffectiveDayKey(profile, timezone, currentTime) !== localDateKey) {
    return null;
  }

  // Determine GM target hour
  const gmHour = resolveGmHour(profile, calendarEvents, timezone, currentTime);
  const gmTime = localHourToEpoch(gmHour, timezone, currentTime);

  // Past cutoff — too late for GM
  const parts = getZonedDateParts(currentTime, timezone);
  if (parts.hour >= GM_CUTOFF_HOUR) {
    return null;
  }

  // Build context summary
  const contextParts: string[] = [];

  // Upcoming occurrences due in the morning
  const morningOccurrences = occurrences.filter((occ) => {
    if (!occ.dueAt || occ.state === "completed" || occ.state === "skipped")
      return false;
    const dueMs = new Date(occ.dueAt).getTime();
    const dueParts = getZonedDateParts(new Date(occ.dueAt), timezone);
    return dueMs >= currentTime.getTime() && dueParts.hour < 12;
  });

  if (morningOccurrences.length > 0) {
    const names = morningOccurrences.map((o) => o.title).join(", ");
    contextParts.push(`morning habits: ${names}`);
  }

  // Today's calendar events
  const todayEvents = getTodayActionableEvents(
    calendarEvents,
    timezone,
    currentTime,
  );
  if (todayEvents.length > 0) {
    const first = todayEvents[0];
    if (first) {
      const firstParts = getZonedDateParts(new Date(first.startAt), timezone);
      contextParts.push(
        `${todayEvents.length} meeting${todayEvents.length > 1 ? "s" : ""} today, first at ${firstParts.hour}:${String(firstParts.minute).padStart(2, "0")}`,
      );
    }
  }

  const contextSummary =
    contextParts.length > 0 ? `gm context: ${contextParts.join(" | ")}` : "gm";

  return {
    kind: "gm",
    scheduledFor: gmTime,
    targetPlatform: selectTargetPlatform(profile, false),
    contextSummary,
    messageText: buildGmMessage(contextParts),
    status: "pending",
  };
}

// ── GN planning ───────────────────────────────────────

export function planGn(
  profile: ActivityProfile,
  firedToday: FiredActionsLog | null,
  timezone: string,
  now?: Date,
): ProactiveAction | null {
  const currentTime = now ?? new Date();
  if (profile.isCurrentlySleeping) {
    return null;
  }

  // Already fired today
  if (firedToday?.gnFiredAt) {
    return null;
  }

  // User wasn't active at all in the current effective day — skip GN
  if (!wasActiveToday(profile, timezone, currentTime)) {
    return null;
  }

  // Determine GN target hour
  const gnHour = resolveGnHour(profile);
  const gnTime = localHourToEpoch(gnHour, timezone, currentTime);

  return {
    kind: "gn",
    scheduledFor: gnTime,
    targetPlatform: selectTargetPlatform(profile, true),
    contextSummary: "gn",
    messageText: "Good night.",
    status: "pending",
  };
}

// ── Nudge planning ────────────────────────────────────

export function planNudges(
  profile: ActivityProfile,
  occurrences: OccurrenceSlim[],
  calendarEvents: CalendarEventSlim[],
  firedToday: FiredActionsLog | null,
  timezone: string,
  now?: Date,
): ProactiveAction[] {
  const currentTime = now ?? new Date();
  if (profile.isCurrentlySleeping) {
    return [];
  }
  const actions: ProactiveAction[] = [];
  const nudgedIds = new Set(firedToday?.nudgedOccurrenceIds ?? []);
  const nudgedEventIds = new Set(firedToday?.nudgedCalendarEventIds ?? []);

  const horizonMs = currentTime.getTime() + NUDGE_HORIZON_MINUTES * 60 * 1000;
  const leadMs = NUDGE_LEAD_MINUTES * 60 * 1000;

  // Nudge for upcoming occurrences
  for (const occ of occurrences) {
    if (!occ.dueAt || occ.state === "completed" || occ.state === "skipped")
      continue;
    if (nudgedIds.has(occ.id)) continue;

    const dueMs = new Date(occ.dueAt).getTime();
    if (dueMs > horizonMs || dueMs < currentTime.getTime()) continue;

    // Find any calendar event starting right after this occurrence
    const nearbyEvent = findNearbyCalendarEvent(
      calendarEvents,
      dueMs,
      timezone,
      currentTime,
    );
    const contextParts = [occ.title];
    if (nearbyEvent) {
      const eventParts = getZonedDateParts(
        new Date(nearbyEvent.startAt),
        timezone,
      );
      contextParts.push(
        `before your ${eventParts.hour}:${String(eventParts.minute).padStart(2, "0")} ${nearbyEvent.summary}`,
      );
    }

    actions.push({
      kind: "pre_activity_nudge",
      scheduledFor: dueMs - leadMs,
      targetPlatform: selectTargetPlatform(profile, true),
      contextSummary: contextParts.join(" — "),
      messageText: contextParts.join(" — "),
      occurrenceId: occ.id,
      status: "pending",
    });
  }

  // Nudge for upcoming calendar events (if not already covered by an occurrence nudge)
  for (const event of calendarEvents) {
    if (!shouldNudgeCalendarEvent(event)) continue;
    if (nudgedEventIds.has(event.id)) continue;

    const startMs = new Date(event.startAt).getTime();
    if (startMs > horizonMs || startMs < currentTime.getTime()) continue;

    actions.push({
      kind: "pre_activity_nudge",
      scheduledFor: startMs - leadMs,
      targetPlatform: selectTargetPlatform(profile, true),
      contextSummary: event.summary,
      messageText: event.summary,
      calendarEventId: event.id,
      status: "pending",
    });
  }

  return actions;
}

// ── Downtime planning ─────────────────────────────────

export function planDowntimeNudges(
  profile: ActivityProfile,
  occurrences: OccurrenceSlim[],
  calendarEvents: CalendarEventSlim[],
  firedToday: FiredActionsLog | null,
  timezone: string,
  now?: Date,
): ProactiveAction[] {
  const currentTime = now ?? new Date();
  if (profile.isCurrentlySleeping) {
    return [];
  }
  if (isBusyDay(profile, calendarEvents, timezone, currentTime)) {
    return [];
  }

  const nudgedIds = new Set(firedToday?.nudgedOccurrenceIds ?? []);
  const urgentCutoffMs = currentTime.getTime() + 2 * 60 * 60 * 1000;

  if (
    occurrences.some((occ) => {
      if (occ.state === "completed" || occ.state === "skipped") return false;
      if (!occ.dueAt) return false;
      const dueMs = new Date(occ.dueAt).getTime();
      return dueMs >= currentTime.getTime() && dueMs <= urgentCutoffMs;
    })
  ) {
    return [];
  }

  const candidates = occurrences
    .filter((occ) => isOneOffOccurrence(occ))
    .filter((occ) => occ.state !== "completed" && occ.state !== "skipped")
    .filter((occ) => occ.dueAt !== null)
    .filter((occ) => !nudgedIds.has(occ.id))
    .map((occ) => {
      const dueMs = new Date(occ.dueAt as string).getTime();
      const overdueMs = Math.max(currentTime.getTime() - dueMs, 0);
      const dueSoonMinutes =
        Math.max(dueMs - currentTime.getTime(), 0) / 60_000;
      return {
        occ,
        score:
          overdueMs > 0
            ? 1_000_000 + overdueMs - occurrencePriorityScore(occ)
            : 100_000 - dueSoonMinutes - occurrencePriorityScore(occ),
      };
    })
    .sort((left, right) => right.score - left.score);

  const selected = candidates[0];
  if (!selected) {
    return [];
  }

  return [
    {
      kind: "pre_activity_nudge",
      scheduledFor: currentTime.getTime(),
      targetPlatform: selectTargetPlatform(profile, true),
      contextSummary: buildDowntimeContext(selected.occ, currentTime),
      messageText: buildDowntimeContext(selected.occ, currentTime),
      occurrenceId: selected.occ.id,
      status: "pending",
    },
  ];
}

// ── Goal check-in planning ───────────────────────────

export function planGoalCheckIns(
  profile: ActivityProfile,
  goals: GoalSlim[],
  firedToday: FiredActionsLog | null,
  _timezone: string,
  now?: Date,
): ProactiveAction[] {
  const currentTime = now ?? new Date();
  if (profile.isCurrentlySleeping) return [];

  const checkedGoalIds = new Set(firedToday?.checkedGoalIds ?? []);
  const cooldownMs = GOAL_CHECK_IN_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

  const candidates: ProactiveAction[] = [];

  for (const goal of goals) {
    if (goal.status !== "active") continue;
    if (checkedGoalIds.has(goal.id)) continue;

    // Only check in on goals that haven't been reviewed recently
    if (goal.lastReviewedAt) {
      const reviewedMs = new Date(goal.lastReviewedAt).getTime();
      if (
        Number.isFinite(reviewedMs) &&
        currentTime.getTime() - reviewedMs < cooldownMs
      ) {
        continue;
      }
    }

    const isStruggling = goal.recentCompletionRate < 0.5;
    const hasNoTasks = goal.linkedDefinitionCount === 0;

    let contextSummary: string;
    let messageText: string;

    if (hasNoTasks) {
      contextSummary = `Goal "${goal.title}" has no supporting tasks`;
      messageText = `Your goal "${goal.title}" doesn't have any linked tasks yet. Want me to help create a plan?`;
    } else if (isStruggling) {
      const pct = Math.round(goal.recentCompletionRate * 100);
      contextSummary = `Goal "${goal.title}" completion at ${pct}% this week`;
      messageText = `Checking in on "${goal.title}" — your linked tasks are at ${pct}% completion this week. Want to talk about what's getting in the way?`;
    } else {
      const pct = Math.round(goal.recentCompletionRate * 100);
      contextSummary = `Goal "${goal.title}" on track at ${pct}%`;
      messageText = `"${goal.title}" is going well — ${pct}% completion this week. Keep it up.`;
    }

    candidates.push({
      kind: "goal_check_in",
      scheduledFor: currentTime.getTime(),
      targetPlatform: selectTargetPlatform(profile, true),
      contextSummary,
      messageText,
      goalId: goal.id,
      status: "pending",
    });
  }

  // Only return the most important goal check-in (don't flood).
  // Priority: no tasks (3) > struggling (2) > on track (1).
  candidates.sort((a, b) => {
    const scoreFor = (action: ProactiveAction): number =>
      action.contextSummary.includes("no supporting tasks")
        ? 3
        : action.contextSummary.includes("completion at")
          ? 2
          : 1;
    return scoreFor(b) - scoreFor(a);
  });

  return candidates.slice(0, 1);
}

// ── Platform selection ────────────────────────────────

export function selectTargetPlatform(
  profile: ActivityProfile,
  preferCurrent: boolean,
): string {
  if (preferCurrent && profile.isCurrentlyActive && profile.lastSeenPlatform) {
    return profile.lastSeenPlatform;
  }
  return profile.primaryPlatform ?? "client_chat";
}

// ── Helpers ───────────────────────────────────────────

function resolveGmHour(
  profile: ActivityProfile,
  calendarEvents: CalendarEventSlim[],
  timezone: string,
  now: Date,
): number {
  // Priority 1: calendar — 30 min before first event
  const todayEvents = getTodayNonAllDayEvents(calendarEvents, timezone, now);
  const firstEvent = todayEvents[0];
  if (firstEvent) {
    const firstParts = getZonedDateParts(
      new Date(firstEvent.startAt),
      timezone,
    );
    const leadHour = firstParts.hour - GM_LEAD_MINUTES / 60;
    if (leadHour >= 5) return Math.floor(leadHour);
  }

  // Priority 2: message histogram — 30 min before typical first active hour
  if (profile.typicalWakeHour !== null) {
    const leadHour = profile.typicalWakeHour - GM_LEAD_MINUTES / 60;
    if (leadHour >= 5) return Math.floor(leadHour);
  }

  // Priority 3: message histogram — 30 min before typical first active hour
  if (profile.typicalFirstActiveHour !== null) {
    const leadHour = profile.typicalFirstActiveHour - GM_LEAD_MINUTES / 60;
    if (leadHour >= 5) return Math.floor(leadHour);
  }

  // Priority 4: calendar-derived first event hour
  if (profile.typicalFirstEventHour !== null) {
    const leadHour = profile.typicalFirstEventHour - GM_LEAD_MINUTES / 60;
    if (leadHour >= 5) return Math.floor(leadHour);
  }

  return DEFAULT_GM_HOUR;
}

function resolveGnHour(profile: ActivityProfile): number {
  if (profile.typicalLastActiveHour !== null) {
    const lagHour = profile.typicalLastActiveHour + GN_LAG_MINUTES / 60;
    return Math.min(Math.ceil(lagHour), 23);
  }
  return DEFAULT_GN_HOUR;
}

function buildGmMessage(contextParts: string[]): string {
  if (contextParts.length === 0) {
    return "Good morning.";
  }

  const normalizedParts = contextParts
    .map((part) => capitalizeSentence(part))
    .filter((part) => part.length > 0);

  if (normalizedParts.length === 0) {
    return "Good morning.";
  }

  return `Good morning. ${normalizedParts.join(". ")}.`;
}

function isOneOffOccurrence(occurrence: OccurrenceSlim): boolean {
  if (occurrence.cadence?.kind) {
    return occurrence.cadence.kind === "once";
  }
  return occurrence.definitionKind === "task";
}

function occurrencePriorityScore(occurrence: OccurrenceSlim): number {
  const priority = occurrence.priority ?? 0;
  if (!Number.isFinite(priority) || priority <= 0) {
    return 0;
  }
  return Math.min(priority, 10) * 5;
}

function buildDowntimeContext(occurrence: OccurrenceSlim, now: Date): string {
  if (!occurrence.dueAt) {
    return `Downtime suggestion: ${occurrence.title}`;
  }

  const dueMs = new Date(occurrence.dueAt).getTime();
  if (dueMs <= now.getTime()) {
    return `Downtime suggestion: ${occurrence.title} (overdue)`;
  }

  const minutesUntilDue = Math.max(
    Math.round((dueMs - now.getTime()) / 60_000),
    0,
  );
  return `Downtime suggestion: ${occurrence.title} (due in ${minutesUntilDue}m)`;
}

function capitalizeSentence(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function isBusyDay(
  profile: ActivityProfile,
  calendarEvents: CalendarEventSlim[],
  timezone: string,
  now: Date,
): boolean {
  if (isScreenBusy(profile, now)) {
    return true;
  }

  const todayEvents = getTodayActionableEvents(calendarEvents, timezone, now);
  if (todayEvents.length >= 4) {
    return true;
  }

  if (profile.avgWeekdayMeetings !== null && profile.avgWeekdayMeetings >= 4) {
    return true;
  }

  const nextEvent = todayEvents.find((event) => {
    const startMs = new Date(event.startAt).getTime();
    return startMs >= now.getTime();
  });
  if (!nextEvent) {
    return false;
  }

  const minutesUntilNextEvent =
    (new Date(nextEvent.startAt).getTime() - now.getTime()) / 60_000;
  return minutesUntilNextEvent <= 45;
}

function isScreenBusy(profile: ActivityProfile, now: Date): boolean {
  if (
    !profile.screenContextAvailable ||
    profile.screenContextStale ||
    !profile.screenContextBusy ||
    !profile.screenContextSampledAt
  ) {
    return false;
  }

  const ageMs = now.getTime() - profile.screenContextSampledAt;
  return ageMs >= 0 && ageMs < 15 * 60 * 1000;
}

function getTodayNonAllDayEvents(
  events: CalendarEventSlim[],
  timezone: string,
  now: Date,
): CalendarEventSlim[] {
  const todayParts = getZonedDateParts(now, timezone);
  return events
    .filter((e) => {
      if (e.isAllDay) return false;
      const startParts = getZonedDateParts(new Date(e.startAt), timezone);
      return (
        startParts.year === todayParts.year &&
        startParts.month === todayParts.month &&
        startParts.day === todayParts.day
      );
    })
    .sort(
      (a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime(),
    );
}

function getTodayActionableEvents(
  events: CalendarEventSlim[],
  timezone: string,
  now: Date,
): CalendarEventSlim[] {
  return getTodayNonAllDayEvents(events, timezone, now).filter(
    shouldNudgeCalendarEvent,
  );
}

function shouldNudgeCalendarEvent(event: CalendarEventSlim): boolean {
  return event.proactiveCheckIn === true;
}

function findNearbyCalendarEvent(
  events: CalendarEventSlim[],
  referenceMs: number,
  timezone: string,
  now: Date,
): CalendarEventSlim | null {
  const windowMs = 60 * 60 * 1000; // 1 hour after
  const todayEvents = getTodayActionableEvents(events, timezone, now);
  for (const event of todayEvents) {
    const startMs = new Date(event.startAt).getTime();
    if (startMs > referenceMs && startMs - referenceMs <= windowMs) {
      return event;
    }
  }
  return null;
}

function localHourToEpoch(
  hour: number,
  timezone: string,
  referenceDate: Date,
): number {
  // Build an ISO string for today at the target hour in the given timezone,
  // then convert to epoch ms. We approximate by getting today's date parts
  // and computing offset from midnight.
  const parts = getZonedDateParts(referenceDate, timezone);
  const dayOffset = Math.floor(hour / 24);
  const normalizedHour = ((hour % 24) + 24) % 24;
  const diffHours = normalizedHour + dayOffset * 24 - parts.hour;
  const diffMinutes = -parts.minute;
  return referenceDate.getTime() + (diffHours * 60 + diffMinutes) * 60 * 1000;
}

function makeSkipped(
  kind: ProactiveAction["kind"],
  now: Date,
  profile: ActivityProfile,
  reason: string,
): ProactiveAction {
  return {
    kind,
    scheduledFor: now.getTime(),
    targetPlatform: profile.primaryPlatform ?? "client_chat",
    contextSummary: "",
    messageText: "",
    status: "skipped",
    skipReason: reason,
  };
}
