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
/** Earliest hour of day a GN message is allowed to fire. */
const GN_MIN_HOUR = 17;
/**
 * Minimum interval between two GM (or two GN) deliveries. Acts as a
 * timestamp-based once-per-day cooldown that survives effective-day-key
 * flips (e.g. when an open activity cycle's start-date moves between
 * worker ticks). 12h is short enough that yesterday's GN never blocks
 * today's GN, but long enough that no single calendar day fires twice.
 */
const ONCE_PER_DAY_GUARD_MS = 12 * 60 * 60 * 1000;
/** Minutes before an occurrence/event to send a nudge. */
const NUDGE_LEAD_MINUTES = 30;
/** Maximum nudge lookahead window. */
const NUDGE_HORIZON_MINUTES = 45;
/** If user hasn't been active in this many ms, skip GM entirely. */
const INACTIVITY_SKIP_MS = 48 * 60 * 60 * 1000; // 48 hours
/** Days since last review before a goal is eligible for a check-in. */
const GOAL_CHECK_IN_COOLDOWN_DAYS = 3;

/**
 * Trailing window the social-overuse planner looks back over. The worker
 * fetches `getSocialHabitSummary` over `[now - SOCIAL_OVERUSE_WINDOW_MINUTES,
 * now]` and the planner trips when the windowed total clears the threshold.
 */
export const SOCIAL_OVERUSE_WINDOW_MINUTES = 90;
/**
 * Minimum total social-app minutes inside the trailing window required to
 * fire a social_overuse_check intent.
 */
export const SOCIAL_OVERUSE_THRESHOLD_MINUTES = 60;
/**
 * Minimum gap between two consecutive social_overuse_check deliveries. The
 * worker writes `socialOveruseCheckedAt` on every fire; the planner refuses
 * to emit again until this much time has passed since the last write.
 */
export const SOCIAL_OVERUSE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h

/**
 * True if `firedAt` is set and the gap to `now` is shorter than the
 * once-per-day guard window. Future timestamps (firedAt > now) — which
 * shouldn't happen but indicate a clock glitch — are also treated as
 * recent so we don't fire again.
 */
function firedRecently(firedAt: number | undefined, now: Date): boolean {
  if (!firedAt) return false;
  const elapsedMs = now.getTime() - firedAt;
  if (elapsedMs < 0) return true;
  return elapsedMs < ONCE_PER_DAY_GUARD_MS;
}

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

export interface ProactiveRelativeTimeSlim {
  wakeAnchorAt: string | null;
  bedtimeTargetAt: string | null;
  minutesSinceWake: number | null;
  minutesUntilBedtimeTarget: number | null;
}

export interface InboxDigestHighlightSlim {
  channel: string;
  sender: string;
  subject: string | null;
  snippet: string;
  receivedAt: string;
  unread: boolean;
}

export interface InboxDigestSlim {
  unreadCount: number;
  channelCounts: Array<{
    channel: string;
    unreadCount: number;
  }>;
  highlights: InboxDigestHighlightSlim[];
}

// ── Social-overuse planning ──────────────────────────

/**
 * Per-service totals consumed by `planSocialOveruseCheck`. Maps directly
 * onto `LifeOpsSocialHabitSummary.services`/`.sessions` entries: each entry
 * is one labelled bucket of social-app dwell time inside the trailing
 * window the worker fetched.
 */
export interface SocialServiceBucketSlim {
  key: string;
  label: string;
  totalSeconds: number;
}

export interface SocialHabitSummarySlim {
  /** Total social-bucket dwell seconds inside the trailing window. */
  totalSeconds: number;
  /** Per-service breakdown, sorted by `totalSeconds` descending. */
  services: SocialServiceBucketSlim[];
}

// ── GM planning ───────────────────────────────────────

export function planGm(
  profile: ActivityProfile,
  occurrences: OccurrenceSlim[],
  calendarEvents: CalendarEventSlim[],
  relativeTime: ProactiveRelativeTimeSlim | null,
  inboxDigest: InboxDigestSlim | null,
  firedToday: FiredActionsLog | null,
  timezone: string,
  now?: Date,
): ProactiveAction | null {
  const currentTime = now ?? new Date();
  if (profile.isCurrentlySleeping) {
    return null;
  }

  // Already fired recently — timestamp-based gate so a flipping effective
  // day key (which can null out firedToday) cannot cause repeated GMs.
  if (firedRecently(firedToday?.gmFiredAt, currentTime)) {
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

  const gmTime =
    resolveWakeTriggeredGmTime(relativeTime, timezone, currentTime) ??
    localHourToEpoch(
      resolveGmHour(profile, calendarEvents, timezone, currentTime),
      timezone,
      currentTime,
    );

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

  appendInboxDigestContext(contextParts, inboxDigest);

  const contextSummary =
    contextParts.length > 0 ? `gm context: ${contextParts.join(" | ")}` : "gm";

  return {
    kind: "gm",
    scheduledFor: gmTime,
    targetPlatform: selectTargetPlatform(profile, false),
    contextSummary,
    messageText: buildDigestMessage("gm", contextParts, inboxDigest),
    status: "pending",
  };
}

// ── GN planning ───────────────────────────────────────

/**
 * Plan a "good night" proactive action — the activity-feed counterpart to the
 * authoritative night summary.
 *
 * Division of responsibility (intentional, do NOT consolidate without a
 * design discussion — see review #10 P0.1 + wave-3 punt notes):
 *
 * - **Chat surface (the user-visible night summary):** owned by
 *   `processSleepCycleCheckins` →
 *   `CheckinService.runNightCheckin` (`plugins/app-lifeops/src/lifeops/checkin/checkin-service.ts`).
 *   That path collects briefing sections (X DMs, Gmail, GitHub, calendar,
 *   contacts, promises, habit summaries, sleep recap), runs them through
 *   `useModel(TEXT_LARGE, ...)`, and persists a `CheckinReport`. Anti-spam
 *   is the once-per-local-day SQL gate against `life_checkin_reports`. The
 *   resulting `lifeops-checkin` event is **not** in
 *   `CHAT_SUPPRESSED_AUTONOMY_SOURCES`, so it lands in the active
 *   conversation.
 *
 * - **Activity-feed surface (this function):** plans a `proactive-gn`
 *   action with a hard-coded message stub for the activity timeline only.
 *   The `proactive-gn` source **is** in `CHAT_SUPPRESSED_AUTONOMY_SOURCES`
 *   (`packages/agent/src/api/server-helpers-swarm.ts`), so this never
 *   posts to chat — it only powers the activity-feed widget. Anti-spam is
 *   a separate 12h `firedRecently` timestamp gate (`firedToday.gnFiredAt`).
 *
 * Both paths are scheduled off the same `bedtimeTargetAt` source but
 * diverge on window (3h vs 2h), gate (per-day SQL vs 12h timestamp),
 * content (LLM briefing vs hard-coded stub), and chat-suppression. They
 * are not redundant: the chat night summary is the user-visible artifact;
 * this is feed-only telemetry. Future maintainers: a unifying sweep would
 * need a routing-layer redesign (collapse the two sources, then choose a
 * single content path), not just a delete here.
 */
export function planGn(
  profile: ActivityProfile,
  relativeTime: ProactiveRelativeTimeSlim | null,
  inboxDigest: InboxDigestSlim | null,
  firedToday: FiredActionsLog | null,
  timezone: string,
  now?: Date,
): ProactiveAction | null {
  const currentTime = now ?? new Date();
  if (profile.isCurrentlySleeping) {
    return null;
  }

  // Already fired recently — timestamp-based gate so a flipping effective
  // day key (which can null out firedToday) cannot cause repeated GNs.
  if (firedRecently(firedToday?.gnFiredAt, currentTime)) {
    return null;
  }

  // User wasn't active at all in the current effective day — skip GN
  if (!wasActiveToday(profile, timezone, currentTime)) {
    return null;
  }

  const gnTime =
    resolveNightSummaryTime(relativeTime, timezone, currentTime) ??
    localHourToEpoch(resolveGnHour(profile), timezone, currentTime);
  const contextParts: string[] = [];
  appendInboxDigestContext(contextParts, inboxDigest);

  return {
    kind: "gn",
    scheduledFor: gnTime,
    targetPlatform: selectTargetPlatform(profile, true),
    contextSummary:
      contextParts.length > 0
        ? `gn context: ${contextParts.join(" | ")}`
        : "gn",
    messageText: buildDigestMessage("gn", contextParts, inboxDigest),
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

// ── Social-overuse check planning ────────────────────

/**
 * Decide whether to interrupt the user with a "you've been on {app} for a
 * while, you good?" intent. Pure: takes a slim social-habit summary scoped
 * to the trailing `SOCIAL_OVERUSE_WINDOW_MINUTES` and returns a single
 * pending action when the threshold + cooldown are both satisfied.
 *
 * Scope (intentionally minimal — see §10 of the gap report for what's
 * deferred): emits the proactive intent only. The follow-up reply turn
 * (block-this/suggest-todo) is not implemented here.
 */
export function planSocialOveruseCheck(
  profile: ActivityProfile,
  socialSummary: SocialHabitSummarySlim,
  firedToday: FiredActionsLog | null,
  _timezone: string,
  now?: Date,
): ProactiveAction | null {
  const currentTime = now ?? new Date();
  if (profile.isCurrentlySleeping) {
    return null;
  }

  const totalMinutes = socialSummary.totalSeconds / 60;
  if (totalMinutes <= SOCIAL_OVERUSE_THRESHOLD_MINUTES) {
    return null;
  }

  const lastFiredAt = firedToday?.socialOveruseCheckedAt;
  if (typeof lastFiredAt === "number") {
    const elapsedMs = currentTime.getTime() - lastFiredAt;
    // Future timestamps shouldn't happen, but treat them as "still in
    // cooldown" so a clock glitch never causes a re-fire.
    if (elapsedMs < SOCIAL_OVERUSE_COOLDOWN_MS) {
      return null;
    }
  }

  const topService = pickTopSocialService(socialSummary.services);
  const appName = topService?.label ?? "social media";
  const roundedMinutes = Math.max(1, Math.round(totalMinutes));

  const messageText =
    `Hey — you've been on ${appName} for ${roundedMinutes}m in the last 90 min. ` +
    `You good? Want me to suggest something from your todos, or block it for a bit?`;
  const contextSummary =
    `social_overuse_check: ${appName} ${roundedMinutes}m / ` +
    `${SOCIAL_OVERUSE_WINDOW_MINUTES}m window ` +
    `(threshold ${SOCIAL_OVERUSE_THRESHOLD_MINUTES}m)`;

  return {
    kind: "social_overuse_check",
    scheduledFor: currentTime.getTime(),
    targetPlatform: selectTargetPlatform(profile, true),
    contextSummary,
    messageText,
    status: "pending",
  };
}

function pickTopSocialService(
  services: SocialServiceBucketSlim[],
): SocialServiceBucketSlim | null {
  let best: SocialServiceBucketSlim | null = null;
  for (const entry of services) {
    if (!entry || typeof entry.totalSeconds !== "number") continue;
    if (entry.totalSeconds <= 0) continue;
    if (!best || entry.totalSeconds > best.totalSeconds) {
      best = entry;
    }
  }
  return best;
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
  // Ignore typicalLastActiveHour values that fall before noon: those almost
  // certainly come from the LATE_NIGHT bucket (00:00–05:00 midpoint = 3),
  // which historically wins the chronological-last race when a user has
  // any overnight activity at all. Treating that as "go to bed at 4 AM"
  // schedules GN in the past and causes per-tick spam. Fall back to the
  // sensible default and clamp to the evening floor either way.
  if (
    profile.typicalLastActiveHour !== null &&
    profile.typicalLastActiveHour >= 12
  ) {
    const lagHour = profile.typicalLastActiveHour + GN_LAG_MINUTES / 60;
    const ceiled = Math.min(Math.ceil(lagHour), 23);
    return Math.max(ceiled, GN_MIN_HOUR);
  }
  return DEFAULT_GN_HOUR;
}

function buildDigestMessage(
  kind: "gm" | "gn",
  contextParts: string[],
  inboxDigest: InboxDigestSlim | null,
): string {
  const normalizedParts = contextParts
    .map((part) => capitalizeSentence(part))
    .filter((part) => part.length > 0);
  const opening =
    kind === "gm"
      ? "Good morning."
      : inboxDigest && inboxDigest.unreadCount > 0
        ? "Night summary."
        : "Night summary. Inbox is quiet.";
  if (normalizedParts.length === 0) {
    return opening;
  }
  return `${opening} ${normalizedParts.join(". ")}.`;
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

function appendInboxDigestContext(
  contextParts: string[],
  inboxDigest: InboxDigestSlim | null,
): void {
  if (!inboxDigest) {
    return;
  }

  if (inboxDigest.unreadCount > 0) {
    const channelSummary = inboxDigest.channelCounts
      .slice(0, 3)
      .map((entry) => `${entry.channel} ${entry.unreadCount}`)
      .join(", ");
    contextParts.push(
      `inbox: ${inboxDigest.unreadCount} unread${channelSummary ? ` across ${channelSummary}` : ""}`,
    );
  } else {
    contextParts.push("inbox is quiet");
  }

  const topHighlights = inboxDigest.highlights
    .slice(0, 2)
    .map((highlight) => formatInboxHighlight(highlight))
    .filter((highlight) => highlight.length > 0);
  if (topHighlights.length > 0) {
    contextParts.push(`top items: ${topHighlights.join("; ")}`);
  }
}

function formatInboxHighlight(highlight: InboxDigestHighlightSlim): string {
  const subject =
    highlight.subject && highlight.subject.trim().length > 0
      ? highlight.subject.trim()
      : null;
  const snippet = summarizeSnippet(highlight.snippet);
  const messageCore =
    subject && snippet
      ? `${subject} — ${snippet}`
      : (subject ?? snippet ?? highlight.channel);
  return `${highlight.sender} on ${highlight.channel}: ${messageCore}`;
}

function summarizeSnippet(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length <= 72) {
    return trimmed;
  }
  return `${trimmed.slice(0, 69).trimEnd()}...`;
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

function resolveWakeTriggeredGmTime(
  relativeTime: ProactiveRelativeTimeSlim | null,
  timezone: string,
  now: Date,
): number | null {
  const wakeAnchorMs = parseIsoMs(relativeTime?.wakeAnchorAt);
  if (wakeAnchorMs === null) {
    return null;
  }
  if (
    getLocalDateKey(getZonedDateParts(new Date(wakeAnchorMs), timezone)) !==
    getLocalDateKey(getZonedDateParts(now, timezone))
  ) {
    return null;
  }
  return wakeAnchorMs;
}

function resolveNightSummaryTime(
  relativeTime: ProactiveRelativeTimeSlim | null,
  timezone: string,
  now: Date,
): number | null {
  const bedtimeTargetMs = parseIsoMs(relativeTime?.bedtimeTargetAt);
  if (bedtimeTargetMs === null) {
    return null;
  }
  const summaryAtMs = bedtimeTargetMs - 2 * 60 * 60 * 1000;
  if (
    getLocalDateKey(getZonedDateParts(new Date(summaryAtMs), timezone)) !==
    getLocalDateKey(getZonedDateParts(now, timezone))
  ) {
    return null;
  }
  return summaryAtMs;
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
