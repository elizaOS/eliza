import {
  loadOwnerContactsConfig,
  resolveOwnerContactWithFallback,
} from "@elizaos/agent";
import { getAgentEventService } from "@elizaos/agent";
import type { IAgentRuntime, Task, TaskMetadata, UUID } from "@elizaos/core";
import {
  logger,
  ModelType,
  runWithTrajectoryContext,
  stringToUuid,
} from "@elizaos/core";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
import { buildSeedingOfferMessage } from "../default-packs/index.js";
import { loadLifeOpsAppState } from "../lifeops/app-state.js";
import {
  type BackgroundJobContext,
  BackgroundPlannerError,
  planJob,
} from "../lifeops/background-planner.js";
import { enqueueIfSensitive } from "../lifeops/background-planner-dispatch.js";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import { ensureRuntimeAgentRecord } from "../lifeops/runtime.js";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import { resolveEffectiveDayKey } from "./analyzer.js";
import {
  type CalendarEventSlim,
  type GoalSlim,
  type InboxDigestSlim,
  type OccurrenceSlim,
  type ProactiveRelativeTimeSlim,
  planDowntimeNudges,
  planGm,
  planGn,
  planGoalCheckIns,
  planNudges,
  planSocialOveruseCheck,
  SOCIAL_OVERUSE_WINDOW_MINUTES,
  type SocialHabitSummarySlim,
} from "./proactive-planner.js";
import {
  buildActivityProfile,
  profileNeedsRebuild,
  readFiredLogFromMetadata,
  readProfileFromMetadata,
  refreshCurrentState,
  resolveOwnerEntityId,
} from "./service.js";
import type {
  ActivityProfile,
  FiredActionsLog,
  ProactiveAction,
} from "./types.js";

export const PROACTIVE_TASK_NAME = "PROACTIVE_AGENT" as const;
export const PROACTIVE_TASK_TAGS = ["queue", "repeat", "proactive"] as const;
export const PROACTIVE_TASK_INTERVAL_MS = 60_000;
const SEEDING_MIN_IDLE_MS = 15 * 60_000;
const CALENDAR_PROACTIVE_CLASSIFICATION_HORIZON_DAYS = 21;
/**
 * Drop scheduled actions that were due more than this long ago. Without
 * this guard, any planner bug that lands `scheduledFor` in the past
 * would dispatch on every tick of the worker (60s).
 */
const STALE_ACTION_THRESHOLD_MS = 4 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveExecutionNow(options: Record<string, unknown> = {}): Date {
  const raw = options.now;
  if (raw instanceof Date) {
    return new Date(raw.getTime());
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date();
}

function isProactiveTask(task: Task): boolean {
  const metadata = isRecord(task.metadata) ? task.metadata : null;
  const agent = metadata?.proactiveAgent;
  return (
    task.name === PROACTIVE_TASK_NAME &&
    isRecord(agent) &&
    agent.kind === "runtime_runner"
  );
}

function buildProactiveMetadata(
  current: Record<string, unknown> | null = null,
): TaskMetadata {
  return {
    ...current,
    updateInterval: PROACTIVE_TASK_INTERVAL_MS,
    baseInterval: PROACTIVE_TASK_INTERVAL_MS,
    blocking: true,
    proactiveAgent: {
      kind: "runtime_runner",
      version: 1,
    },
  };
}

type ProactiveOwnerContact = {
  entityId?: string;
  channelId?: string;
  roomId?: string;
};

type CalendarEventProactiveDecision = {
  id: string;
  shouldCheckIn: boolean;
  reason?: string | null;
};

function normalizePlannerBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) {
      return true;
    }
    if (["false", "no", "0"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function formatPromptScalar(value: unknown, maxLength = 600): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function formatCalendarEventsForPrompt(events: CalendarEventSlim[]): string {
  return events
    .map((event, index) =>
      [
        `events[${index}]:`,
        `  id: ${formatPromptScalar(event.id, 200)}`,
        `  summary: ${formatPromptScalar(event.summary, 300)}`,
        `  description: ${formatPromptScalar(event.description ?? "", 500)}`,
        `  location: ${formatPromptScalar(event.location ?? "", 300)}`,
        `  startAt: ${formatPromptScalar(event.startAt, 80)}`,
        `  endAt: ${formatPromptScalar(event.endAt, 80)}`,
        `  isAllDay: ${event.isAllDay}`,
        `  attendeeCount: ${event.attendeeCount ?? 0}`,
        `  hasConferenceLink: ${Boolean(event.conferenceLink)}`,
      ].join("\n"),
    )
    .join("\n");
}

function normalizeCalendarEventProactiveDecisions(
  parsed: Record<string, unknown> | null,
  allowedIds: Set<string>,
): Map<string, CalendarEventProactiveDecision> {
  const records = Array.isArray(parsed?.events)
    ? parsed.events
    : Array.isArray(parsed?.decisions)
      ? parsed.decisions
      : Array.isArray(parsed)
        ? parsed
        : [];
  const decisions = new Map<string, CalendarEventProactiveDecision>();
  for (const item of records) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === "string" && record.id.trim().length > 0
        ? record.id.trim()
        : null;
    if (!id || !allowedIds.has(id)) {
      continue;
    }
    const shouldCheckIn = normalizePlannerBoolean(
      record.shouldCheckIn ?? record.should_check_in,
    );
    decisions.set(id, {
      id,
      shouldCheckIn: shouldCheckIn === true,
      reason:
        typeof record.reason === "string" && record.reason.trim().length > 0
          ? record.reason.trim()
          : null,
    });
  }
  return decisions;
}

function parseCalendarEventProactiveOutput(
  raw: string,
): Record<string, unknown> | null {
  return parseJsonModelRecord<Record<string, unknown>>(raw);
}

export async function classifyCalendarEventsForProactivePlanning(
  runtime: IAgentRuntime,
  events: CalendarEventSlim[],
  timezone: string,
  now: Date,
): Promise<Map<string, CalendarEventProactiveDecision> | null> {
  if (typeof runtime.useModel !== "function") {
    return null;
  }

  const horizonMs =
    now.getTime() +
    CALENDAR_PROACTIVE_CLASSIFICATION_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const candidateEvents = events
    .filter((event) => {
      const startMs = Date.parse(event.startAt);
      return (
        Number.isFinite(startMs) &&
        startMs >= now.getTime() &&
        startMs <= horizonMs
      );
    })
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))
    .slice(0, 40);
  if (candidateEvents.length === 0) {
    return new Map();
  }

  const prompt = [
    "Decide which calendar events deserve a proactive check-in or reminder from the assistant.",
    "Do not use fixed numeric weights. Judge naturally from the event details.",
    "A proactive check-in should be reserved for events where a gentle heads-up would actually help.",
    "Meetings, calls, interviews, appointments, therapy, coffee or dinner with people, and other short scheduled social/professional events usually deserve a check-in.",
    "Hotel stays, flights, travel blocks, reservations, check-in/check-out, passive itinerary items, and long all-day or near-all-day logistics usually do not deserve a check-in.",
    "If an event would be extremely hard to forget or has no clear actionability, mark shouldCheckIn=false.",
    'Return JSON only, for example {"events":[{"id":"matching event id","shouldCheckIn":true,"reason":"short reason"}]}.',
    "No prose, markdown, code fences, or <think>.",
    "",
    `Current timezone: ${timezone}`,
    `Current ISO datetime: ${now.toISOString()}`,
    "Events:",
    formatCalendarEventsForPrompt(candidateEvents),
  ].join("\n");

  try {
    const result = await runWithTrajectoryContext(
      { purpose: "lifeops-proactive-worker" },
      () => runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
    );
    const raw = typeof result === "string" ? result : "";
    const parsed = parseCalendarEventProactiveOutput(raw);
    if (!parsed) {
      return null;
    }
    return normalizeCalendarEventProactiveDecisions(
      parsed,
      new Set(candidateEvents.map((event) => event.id)),
    );
  } catch (error) {
    logger.warn(
      {
        boundary: "activity_profile",
        operation: "planner_calendar_event_classification",
        err: error instanceof Error ? error : undefined,
      },
      `[proactive] Failed to classify proactive calendar events: ${String(error)}`,
    );
    return null;
  }
}

export function resolveProactiveDeliverySource(targetPlatform: string): string {
  if (
    targetPlatform === "web_app" ||
    targetPlatform === "desktop_app" ||
    targetPlatform === "mobile_app"
  ) {
    return "client_chat";
  }
  return targetPlatform;
}

export function resolveProactiveOwnerContact(args: {
  targetPlatform: string;
  ownerEntityId: string;
  ownerContacts: Record<string, ProactiveOwnerContact>;
}): { source: string; contact: ProactiveOwnerContact } | null {
  const deliverySource = resolveProactiveDeliverySource(args.targetPlatform);
  if (deliverySource === "client_chat") {
    return {
      source: "client_chat",
      contact: { entityId: args.ownerEntityId },
    };
  }

  const resolved = resolveOwnerContactWithFallback({
    ownerContacts: args.ownerContacts,
    source: deliverySource,
    ownerEntityId: args.ownerEntityId,
  });
  if (resolved) {
    return {
      source: resolved.source,
      contact: resolved.contact,
    };
  }

  return null;
}

export async function executeProactiveTask(
  runtime: IAgentRuntime,
  options: Record<string, unknown> = {},
): Promise<{ nextInterval: number }> {
  const now = resolveExecutionNow(options);
  const timezone = resolveDefaultTimeZone();

  const ownerEntityId = await resolveOwnerEntityId(runtime);
  if (!ownerEntityId) {
    return { nextInterval: PROACTIVE_TASK_INTERVAL_MS };
  }

  // WS5: Route this tick through the shared LLM planner. The planner
  // decides whether any action is warranted and whether it requires
  // human approval. We invoke it up-front so every proactive tick is
  // observable via `planJob` and so sensitive actions are always
  // enqueued into the WS6 approval queue.
  const plannerContext: BackgroundJobContext = {
    jobKind: "daily_brief",
    subjectUserId: ownerEntityId,
    snapshot: {
      now: now.toISOString(),
      timezone,
    },
    availableChannels: ["internal"],
    trigger: "proactive_tick",
  };
  try {
    const plan = await planJob(runtime, plannerContext);
    await enqueueIfSensitive(runtime, plannerContext, plan);
  } catch (error) {
    if (error instanceof BackgroundPlannerError) {
      logger.warn(
        `[proactive] background planner unavailable — ${error.message}`,
      );
    } else {
      throw error;
    }
  }

  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...PROACTIVE_TASK_TAGS],
  });
  const task = tasks.find(isProactiveTask);
  if (!task?.id) {
    return { nextInterval: PROACTIVE_TASK_INTERVAL_MS };
  }

  const metadata = isRecord(task.metadata) ? task.metadata : {};
  const currentProfile = readProfileFromMetadata(metadata);
  let profile: ActivityProfile | null;
  if (profileNeedsRebuild(currentProfile, now)) {
    logger.info("[proactive] Building full activity profile");
    profile = await buildActivityProfile(runtime, ownerEntityId, timezone, now);
  } else if (currentProfile) {
    profile = await refreshCurrentState(
      runtime,
      ownerEntityId,
      currentProfile,
      now,
    );
  } else {
    profile = null;
  }

  if (!profile) {
    return { nextInterval: PROACTIVE_TASK_INTERVAL_MS };
  }

  const todayStr = resolveEffectiveDayKey(profile, timezone, now);
  let firedLog = readFiredLogFromMetadata(metadata, todayStr);
  let inboxDigest: InboxDigestSlim | null = null;
  const { occurrences, calendarEvents, goals, relativeTime } =
    await fetchPlannerContext(runtime, timezone, now);
  // NOTE: planGm/planGn apply their own time-of-day gating today; the
  // canonical source of truth for morning/night enforcement windows is
  // `src/lifeops/enforcement-windows.ts` (getCurrentEnforcementWindow).
  // If planner gating is ever consolidated, switch these helpers to use
  // that utility so the reminder pipeline and the proactive worker agree.
  const gmAction = planGm(
    profile,
    occurrences,
    calendarEvents,
    relativeTime,
    null,
    firedLog,
    timezone,
    now,
  );
  const gnAction = planGn(profile, relativeTime, null, firedLog, timezone, now);
  if (
    isDigestActionReady(gmAction, now) ||
    isDigestActionReady(gnAction, now)
  ) {
    inboxDigest = await loadInboxDigest(runtime);
  }
  const hydratedGmAction = planGm(
    profile,
    occurrences,
    calendarEvents,
    relativeTime,
    inboxDigest,
    firedLog,
    timezone,
    now,
  );
  const hydratedGnAction = planGn(
    profile,
    relativeTime,
    inboxDigest,
    firedLog,
    timezone,
    now,
  );
  const nudgeActions = planNudges(
    profile,
    occurrences,
    calendarEvents,
    firedLog,
    timezone,
    now,
  );
  const downtimeActions = planDowntimeNudges(
    profile,
    occurrences,
    calendarEvents,
    firedLog,
    timezone,
    now,
  );
  const goalCheckInActions = planGoalCheckIns(
    profile,
    goals,
    firedLog,
    timezone,
    now,
  );

  const socialSummary = await loadSocialOveruseSummary(runtime, now);
  const socialOveruseAction = socialSummary
    ? planSocialOveruseCheck(profile, socialSummary, firedLog, timezone, now)
    : null;

  const seedingAction = await planSeedingOffer(runtime, profile, firedLog, now);

  const allActions = [
    seedingAction,
    hydratedGmAction,
    hydratedGnAction,
    ...nudgeActions,
    ...downtimeActions,
    ...goalCheckInActions,
    socialOveruseAction,
  ].filter(
    (action): action is ProactiveAction =>
      action !== null && action.status === "pending",
  );

  const ownerContacts = loadOwnerContactsConfig({
    boundary: "activity_profile",
    operation: "owner_contacts_config",
    message:
      "[proactive] Failed to load owner contacts config; proactive messages cannot route to owner channels until config is available.",
  });
  for (const action of allActions) {
    if (action.scheduledFor > now.getTime()) {
      continue;
    }
    // Defensive: don't dispatch stale actions (e.g. a GN whose target
    // hour resolved to the past). Without this guard a single planner
    // miscomputation will fire every PROACTIVE_TASK_INTERVAL_MS.
    const ageMs = now.getTime() - action.scheduledFor;
    if (ageMs > STALE_ACTION_THRESHOLD_MS) {
      logger.warn(
        `[proactive] Skipping stale ${action.kind} (scheduledFor was ${Math.round(ageMs / 60000)} min ago)`,
      );
      continue;
    }

    const resolvedTarget = resolveProactiveOwnerContact({
      targetPlatform: action.targetPlatform,
      ownerEntityId,
      ownerContacts,
    });
    const contact = resolvedTarget?.contact;
    if (!resolvedTarget || !contact) {
      logger.warn(
        `[proactive] No owner contact for platform ${action.targetPlatform}, skipping ${action.kind}`,
      );
      continue;
    }

    if (!contact.entityId && !contact.channelId && !contact.roomId) {
      logger.warn(
        `[proactive] No owner contact for platform ${action.targetPlatform}, skipping ${action.kind}`,
      );
      continue;
    }

    try {
      if (resolvedTarget.source === "client_chat") {
        if (emitProactiveAssistantEvent(runtime, action)) {
          firedLog = recordFiredAction(firedLog, todayStr, action);
          if (action.kind === "onboarding_seed") {
            try {
              await new LifeOpsService(runtime).markSeedingOffered();
            } catch (err) {
              logger.warn(
                `[proactive] Failed to record onboarding seed offer audit: ${err}`,
              );
            }
          }
          logger.info(`[proactive] Emitted ${action.kind} as assistant event`);
          continue;
        }
        logger.warn(
          `[proactive] AGENT_EVENT emit unavailable for ${action.kind}; skipping in-app proactive delivery`,
        );
        continue;
      }

      await runtime.sendMessageToTarget(
        {
          source: resolvedTarget.source,
          entityId: contact.entityId as UUID | undefined,
          channelId: contact.channelId,
          roomId: contact.roomId as UUID | undefined,
        } as Parameters<typeof runtime.sendMessageToTarget>[0],
        buildProactiveDeliveryContent(action, resolvedTarget.source),
      );
      firedLog = recordFiredAction(firedLog, todayStr, action);
      if (action.kind === "onboarding_seed") {
        try {
          await new LifeOpsService(runtime).markSeedingOffered();
        } catch (err) {
          logger.warn(
            `[proactive] Failed to record onboarding seed offer audit: ${err}`,
          );
        }
      }
      logger.info(
        `[proactive] Fired ${action.kind} on ${resolvedTarget.source}`,
      );
    } catch (err) {
      logger.warn(`[proactive] Failed to send ${action.kind}: ${err}`);
    }
  }

  await runtime.updateTask(task.id, {
    metadata: {
      ...metadata,
      activityProfile: profile,
      firedActionsLog: firedLog,
    },
  });

  return { nextInterval: PROACTIVE_TASK_INTERVAL_MS };
}

// Generated from `default-packs/habit-starters.ts` metadata so adding /
// removing a habit starter updates the offer message automatically. Replaces
// the hardcoded literal flagged by HARDCODING_AUDIT and IMPL §3.4.
const SEEDING_MESSAGE = buildSeedingOfferMessage();

async function planSeedingOffer(
  runtime: IAgentRuntime,
  profile: ActivityProfile,
  firedLog: FiredActionsLog | null,
  now: Date,
): Promise<ProactiveAction | null> {
  // Only offer seeding once per day at most
  if (firedLog?.seedingOfferedAt) {
    return null;
  }
  if (
    profile.isCurrentlyActive ||
    now.getTime() - profile.lastSeenAt < SEEDING_MIN_IDLE_MS
  ) {
    return null;
  }

  try {
    const service = new LifeOpsService(runtime);
    const result = await service.checkAndOfferSeeding();
    if (!result.needsSeeding) {
      return null;
    }
  } catch (error) {
    logger.warn(`[proactive] Failed to check seeding status: ${error}`);
    return null;
  }

  return {
    kind: "onboarding_seed",
    scheduledFor: now.getTime(),
    targetPlatform: profile.primaryPlatform ?? "web_app",
    contextSummary: "No routines configured; offering seed templates",
    messageText: SEEDING_MESSAGE,
    status: "pending",
  };
}

async function fetchPlannerContext(
  runtime: IAgentRuntime,
  timezone: string,
  now: Date,
): Promise<{
  occurrences: OccurrenceSlim[];
  calendarEvents: CalendarEventSlim[];
  goals: GoalSlim[];
  relativeTime: ProactiveRelativeTimeSlim | null;
}> {
  const occurrences: OccurrenceSlim[] = [];
  const calendarEvents: CalendarEventSlim[] = [];
  const goals: GoalSlim[] = [];
  let relativeTime: ProactiveRelativeTimeSlim | null = null;
  const lifeOpsService = new LifeOpsService(runtime);

  try {
    const schedule = await lifeOpsService.getScheduleMergedState({
      timezone,
      scope: "effective",
      refresh: true,
      now,
    });
    relativeTime = schedule?.relativeTime
      ? {
          wakeAnchorAt: schedule.relativeTime.wakeAnchorAt,
          bedtimeTargetAt: schedule.relativeTime.bedtimeTargetAt,
          minutesSinceWake: schedule.relativeTime.minutesSinceWake,
          minutesUntilBedtimeTarget:
            schedule.relativeTime.minutesUntilBedtimeTarget,
        }
      : null;
  } catch (error) {
    logger.warn(
      {
        boundary: "activity_profile",
        operation: "planner_schedule_state",
        err: error instanceof Error ? error : undefined,
      },
      `[proactive] Failed to read schedule context for proactive planning: ${String(error)}`,
    );
  }

  try {
    const overview = await lifeOpsService.getOverview(now);

    for (const occ of overview.occurrences) {
      occurrences.push({
        id: occ.id,
        title: occ.title ?? occ.definitionId ?? "untitled",
        dueAt: occ.dueAt,
        state: occ.state,
        definitionKind: occ.definitionKind,
        cadence: occ.cadence ? { kind: occ.cadence.kind } : undefined,
        priority: occ.priority,
      });
    }
  } catch (error) {
    logger.warn(
      {
        boundary: "activity_profile",
        operation: "planner_overview",
        err: error instanceof Error ? error : undefined,
      },
      `[proactive] Failed to read LifeOps overview for planner context: ${String(error)}`,
    );
  }

  try {
    const feed = await lifeOpsService.getCalendarFeed(
      new URL("http://localhost/api/lifeops/calendar"),
      {},
      now,
    );
    const rawCalendarEvents: CalendarEventSlim[] = feed.events.map((event) => ({
      id: event.id,
      summary: event.title ?? "",
      startAt: event.startAt,
      endAt: event.endAt,
      isAllDay: event.isAllDay,
      description: event.description ?? "",
      location: event.location ?? "",
      attendeeCount: Array.isArray(event.attendees)
        ? event.attendees.length
        : 0,
      conferenceLink: event.conferenceLink ?? null,
    }));
    const decisions = await classifyCalendarEventsForProactivePlanning(
      runtime,
      rawCalendarEvents,
      timezone,
      now,
    );
    for (const event of feed.events) {
      const decision = decisions?.get(event.id) ?? null;
      calendarEvents.push({
        id: event.id,
        summary: event.title ?? "",
        startAt: event.startAt,
        endAt: event.endAt,
        isAllDay: event.isAllDay,
        description: event.description ?? "",
        location: event.location ?? "",
        attendeeCount: Array.isArray(event.attendees)
          ? event.attendees.length
          : 0,
        conferenceLink: event.conferenceLink ?? null,
        proactiveCheckIn: decision?.shouldCheckIn ?? null,
        proactiveCheckInReason: decision?.reason ?? null,
      });
    }
  } catch (error) {
    if (error instanceof LifeOpsServiceError && error.status === 409) {
      return { occurrences, calendarEvents, goals, relativeTime };
    }
    logger.warn(
      {
        boundary: "activity_profile",
        operation: "planner_calendar_feed",
        err: error instanceof Error ? error : undefined,
      },
      `[proactive] Failed to read calendar context for proactive planning: ${String(error)}`,
    );
  }

  try {
    const goalRecords = await lifeOpsService.listGoals();
    for (const record of goalRecords) {
      if (record.goal.status !== "active") continue;
      const review = await lifeOpsService.reviewGoal(record.goal.id, now);
      const scheduled =
        review.summary.activeOccurrenceCount +
        review.summary.overdueOccurrenceCount +
        review.summary.completedLast7Days;
      goals.push({
        id: record.goal.id,
        title: record.goal.title,
        status: record.goal.status,
        linkedDefinitionCount: review.summary.linkedDefinitionCount,
        recentCompletionRate:
          scheduled > 0 ? review.summary.completedLast7Days / scheduled : 0,
        lastReviewedAt: review.summary.lastActivityAt,
      });
    }
  } catch (error) {
    logger.warn(
      {
        boundary: "activity_profile",
        operation: "planner_goals",
        err: error instanceof Error ? error : undefined,
      },
      `[proactive] Failed to read goal context for proactive planning: ${String(error)}`,
    );
  }

  return { occurrences, calendarEvents, goals, relativeTime };
}

function isDigestActionReady(
  action: ProactiveAction | null,
  now: Date,
): boolean {
  return Boolean(
    action &&
      (action.kind === "gm" || action.kind === "gn") &&
      action.status === "pending" &&
      action.scheduledFor <= now.getTime(),
  );
}

async function loadInboxDigest(
  runtime: IAgentRuntime,
): Promise<InboxDigestSlim | null> {
  try {
    const inbox = await new LifeOpsService(runtime).getInbox({ limit: 24 });
    const unreadCount = Object.values(inbox.channelCounts).reduce(
      (sum, count) => sum + count.unread,
      0,
    );
    const channelCounts = Object.entries(inbox.channelCounts)
      .map(([channel, count]) => ({
        channel,
        unreadCount: count.unread,
      }))
      .filter((entry) => entry.unreadCount > 0)
      .sort((left, right) => right.unreadCount - left.unreadCount);
    const highlights = [...inbox.messages]
      .sort((left, right) => {
        const unreadDelta = Number(right.unread) - Number(left.unread);
        if (unreadDelta !== 0) {
          return unreadDelta;
        }
        return Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
      })
      .slice(0, 3)
      .map((message) => ({
        channel: message.channel,
        sender: message.sender.displayName,
        subject: message.subject,
        snippet: message.snippet,
        receivedAt: message.receivedAt,
        unread: message.unread,
      }));
    return {
      unreadCount,
      channelCounts,
      highlights,
    };
  } catch (error) {
    logger.warn(
      {
        boundary: "activity_profile",
        operation: "planner_inbox",
        err: error instanceof Error ? error : undefined,
      },
      `[proactive] Failed to read inbox for proactive digest: ${String(error)}`,
    );
    return null;
  }
}

function recordFiredAction(
  log: FiredActionsLog | null,
  todayStr: string,
  action: ProactiveAction,
): FiredActionsLog {
  const current: FiredActionsLog = {
    date: log?.date ?? todayStr,
    gmFiredAt: log?.gmFiredAt,
    gnFiredAt: log?.gnFiredAt,
    nudgedOccurrenceIds: [...(log?.nudgedOccurrenceIds ?? [])],
    nudgedCalendarEventIds: [...(log?.nudgedCalendarEventIds ?? [])],
    checkedGoalIds: [...(log?.checkedGoalIds ?? [])],
    seedingOfferedAt: log?.seedingOfferedAt,
    socialOveruseCheckedAt: log?.socialOveruseCheckedAt,
  };

  if (action.kind === "gm") {
    current.gmFiredAt = Date.now();
  } else if (action.kind === "gn") {
    current.gnFiredAt = Date.now();
  } else if (action.kind === "pre_activity_nudge") {
    if (
      action.occurrenceId &&
      !current.nudgedOccurrenceIds.includes(action.occurrenceId)
    ) {
      current.nudgedOccurrenceIds.push(action.occurrenceId);
    }
    if (
      action.calendarEventId &&
      !current.nudgedCalendarEventIds.includes(action.calendarEventId)
    ) {
      current.nudgedCalendarEventIds.push(action.calendarEventId);
    }
  } else if (action.kind === "goal_check_in") {
    if (action.goalId && !current.checkedGoalIds?.includes(action.goalId)) {
      current.checkedGoalIds?.push(action.goalId);
    }
  } else if (action.kind === "onboarding_seed") {
    current.seedingOfferedAt = Date.now();
  } else if (action.kind === "social_overuse_check") {
    current.socialOveruseCheckedAt = Date.now();
  }

  return current;
}

async function loadSocialOveruseSummary(
  runtime: IAgentRuntime,
  now: Date,
): Promise<SocialHabitSummarySlim | null> {
  const sinceMs = now.getTime() - SOCIAL_OVERUSE_WINDOW_MINUTES * 60_000;
  const since = new Date(sinceMs).toISOString();
  const until = now.toISOString();
  try {
    // Same pattern as `loadInboxDigest`/`fetchPlannerContext`: a transient
    // screen-time read failure must not abort the whole proactive tick or
    // suppress GM/GN/nudges. Logged and skipped; next tick retries.
    const summary = await new LifeOpsService(runtime).getSocialHabitSummary({
      since,
      until,
    });
    return {
      totalSeconds: summary.totalSeconds,
      services: summary.services.map((entry) => ({
        key: entry.key,
        label: entry.label,
        totalSeconds: entry.totalSeconds,
      })),
    };
  } catch (error) {
    logger.warn(
      {
        boundary: "activity_profile",
        operation: "planner_social_overuse_summary",
        err: error instanceof Error ? error : undefined,
      },
      `[proactive] Failed to read social-habit summary for overuse planner: ${String(error)}`,
    );
    return null;
  }
}

function buildProactiveDeliveryContent(
  action: ProactiveAction,
  deliverySource: string,
): { text: string; source: string } {
  const text = action.messageText.trim() || action.contextSummary.trim();
  return { text, source: deliverySource };
}

function emitProactiveAssistantEvent(
  runtime: IAgentRuntime,
  action: ProactiveAction,
): boolean {
  const eventService = getAgentEventService(runtime) as {
    emit?: (event: {
      runId: string;
      stream: string;
      data: Record<string, unknown>;
      agentId?: string;
    }) => void;
  } | null;
  if (!eventService?.emit) {
    return false;
  }

  const text = action.messageText.trim() || action.contextSummary.trim();
  eventService.emit({
    runId: crypto.randomUUID(),
    stream: "assistant",
    agentId: runtime.agentId,
    data: {
      text,
      source: resolveProactiveAssistantEventSource(action),
      kind: action.kind,
      scheduledFor: action.scheduledFor,
      targetPlatform: action.targetPlatform,
      occurrenceId: action.occurrenceId,
      calendarEventId: action.calendarEventId,
      goalId: action.goalId,
    },
  });
  return true;
}

function resolveProactiveAssistantEventSource(action: ProactiveAction): string {
  if (action.kind === "gm") {
    return "proactive-gm";
  }
  if (action.kind === "gn") {
    return "proactive-gn";
  }
  if (action.kind === "goal_check_in") {
    return "proactive-goal-check-in";
  }
  if (action.kind === "onboarding_seed") {
    return "proactive-onboarding";
  }
  if (action.kind === "social_overuse_check") {
    return "proactive-social-overuse";
  }
  return "proactive-nudge";
}

export function registerProactiveTaskWorker(runtime: IAgentRuntime): void {
  if (runtime.getTaskWorker(PROACTIVE_TASK_NAME)) {
    return;
  }
  runtime.registerTaskWorker({
    name: PROACTIVE_TASK_NAME,
    // Skip execution when the user has disabled LifeOps via the UI. The task
    // record and worker stay registered so toggling back on requires no
    // restart — cycles just become cheap no-ops while disabled.
    shouldRun: async (rt) => {
      try {
        const state = await loadLifeOpsAppState(rt as IAgentRuntime);
        return state.enabled;
      } catch (error) {
        logger.warn(
          `[proactive-worker] loadLifeOpsAppState failed; skipping proactive tick because LifeOps toggle state is unknown: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    },
    execute: (rt, options) =>
      executeProactiveTask(rt, isRecord(options) ? options : {}),
  });
}

type AutonomyServiceLike = {
  getAutonomousRoomId?: () => UUID;
};

export async function ensureProactiveAgentTask(
  runtime: IAgentRuntime,
): Promise<UUID> {
  await ensureRuntimeAgentRecord(runtime);
  const tasks = await runtime.getTasks({
    agentIds: [runtime.agentId],
    tags: [...PROACTIVE_TASK_TAGS],
  });
  const existing = tasks.find(isProactiveTask);
  const metadata = buildProactiveMetadata(
    isRecord(existing?.metadata) ? existing.metadata : null,
  );
  if (existing?.id) {
    await runtime.updateTask(existing.id, {
      description: "Proactive agent: GM/GN/nudges based on activity profile",
      metadata,
    });
    return existing.id;
  }

  const autonomy = runtime.getService("AUTONOMY") as AutonomyServiceLike | null;
  const roomId =
    autonomy?.getAutonomousRoomId?.() ??
    stringToUuid(`proactive-agent-room-${runtime.agentId}`);

  return runtime.createTask({
    name: PROACTIVE_TASK_NAME,
    description: "Proactive agent: GM/GN/nudges based on activity profile",
    roomId,
    tags: [...PROACTIVE_TASK_TAGS],
    metadata,
    dueAt: Date.now(),
  });
}
