/**
 * Runtime binding that assembles the owner ActivityProfile from LifeOpsService
 * data plus the screen-context sampler, and decides when it needs a rebuild.
 * The pure classification lives in `analyzer.ts`; this module reads live
 * signals, invokes the analyzer, and exposes the fired-log accessor over the
 * PROACTIVE_AGENT task metadata where the profile is persisted.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import type { LifeOpsActivitySignal } from "../contracts/index.js";
import { resolveDefaultTimeZone } from "../lifeops/defaults.js";
import {
  LifeOpsScreenContextSampler,
  type LifeOpsScreenContextSummary,
} from "../lifeops/screen-context.js";
import { LifeOpsService } from "../lifeops/service.js";

export { resolveOwnerEntityId } from "@elizaos/agent";

import {
  analyzeMessages,
  type CalendarEventRecord,
  enrichWithCalendar,
  type MessageRecord,
  resolveCurrentActivityState,
  SUSTAINED_INACTIVITY_GAP_MS,
} from "./analyzer.js";
import type {
  ActivityProfile,
  ActivitySignalRecord,
  FiredActionsLog,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

// ── Constants ─────────────────────────────────────────

const PROFILE_MAX_AGE_MS = 60 * 60 * 1000; // 60 min full rebuild threshold
const MESSAGES_WINDOW_DAYS = 7;
const MESSAGE_PAGE_SIZE = 500;

let screenContextSampler: LifeOpsScreenContextSampler | null = null;

export function setScreenContextSamplerForTesting(
  sampler: LifeOpsScreenContextSampler | null,
): void {
  screenContextSampler = sampler;
}

function getScreenContextSampler(): LifeOpsScreenContextSampler {
  if (!screenContextSampler) {
    screenContextSampler = new LifeOpsScreenContextSampler();
  }
  return screenContextSampler;
}

async function sampleScreenContext(
  currentTime: Date,
): Promise<LifeOpsScreenContextSummary> {
  return await getScreenContextSampler().sample(currentTime.getTime());
}

function mapActivitySignalRecord(
  signal: LifeOpsActivitySignal,
): ActivitySignalRecord {
  return {
    source: signal.source,
    platform: signal.platform,
    state: signal.state,
    observedAt: Date.parse(signal.observedAt),
    idleState: signal.idleState,
    idleTimeSeconds: signal.idleTimeSeconds,
    onBattery: signal.onBattery,
    health: signal.health,
    metadata: signal.metadata,
  };
}

async function loadWindowActivitySignals(
  runtime: IAgentRuntime,
  currentTime: Date,
): Promise<ActivitySignalRecord[]> {
  const lifeOpsService = new LifeOpsService(runtime);
  const sinceAt = new Date(
    currentTime.getTime() - MESSAGES_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const signals = await lifeOpsService.listActivitySignals({
    sinceAt,
  });
  return signals
    .map(mapActivitySignalRecord)
    .filter((signal) => Number.isFinite(signal.observedAt));
}

async function loadRecentActivitySignals(
  runtime: IAgentRuntime,
): Promise<ActivitySignalRecord[]> {
  const lifeOpsService = new LifeOpsService(runtime);
  const signals = await lifeOpsService.listActivitySignals();
  return signals
    .map(mapActivitySignalRecord)
    .filter((signal) => Number.isFinite(signal.observedAt));
}

/** Load every message for the supplied rooms through lossless offset pages. */
export async function loadAllRoomMessagesForActivityProfile(
  runtime: IAgentRuntime,
  roomIds: UUID[],
): Promise<Memory[]> {
  const messages: Memory[] = [];
  const seenMemoryIds = new Set<UUID>();

  for (let offset = 0; ; offset += MESSAGE_PAGE_SIZE) {
    const page = await runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds,
      limit: MESSAGE_PAGE_SIZE,
      offset,
    });
    if (page.length === MESSAGE_PAGE_SIZE) {
      const pageIds = page.map((memory) => memory.id);
      if (
        pageIds.some((id) => !id) ||
        pageIds.every((id) => seenMemoryIds.has(id as UUID))
      ) {
        throw new ElizaError(
          "Activity profile message pagination made no progress",
          {
            code: "ACTIVITY_PROFILE_MESSAGE_PAGINATION_STALLED",
            context: { offset, pageSize: MESSAGE_PAGE_SIZE },
            severity: "fatal",
          },
        );
      }
      for (const id of pageIds) seenMemoryIds.add(id as UUID);
    }
    messages.push(...page);
    if (page.length < MESSAGE_PAGE_SIZE) return messages;
  }
}

function mergeScreenContext(
  profile: ActivityProfile,
  screenContext: LifeOpsScreenContextSummary | null,
  now: Date,
): ActivityProfile {
  const updatedProfile: ActivityProfile = {
    ...profile,
    screenContextFocus: screenContext?.focus ?? null,
    screenContextSource: screenContext?.source ?? null,
    screenContextSampledAt: screenContext?.sampledAtMs ?? null,
    screenContextConfidence: screenContext?.confidence ?? null,
    screenContextBusy: screenContext?.busy ?? false,
    screenContextAvailable: screenContext?.available ?? false,
    screenContextStale: screenContext?.stale ?? false,
  };
  const activityState = resolveCurrentActivityState(updatedProfile, now);
  return {
    ...updatedProfile,
    ...activityState,
    effectiveDayKey: activityState.effectiveDayKey,
  };
}

// ── Profile building ──────────────────────────────────

export async function buildActivityProfile(
  runtime: IAgentRuntime,
  ownerEntityId: string,
  timezone?: string,
  now?: Date,
): Promise<ActivityProfile> {
  const tz = timezone ?? resolveDefaultTimeZone();
  const currentTime = now ?? new Date();
  const activitySignals = await loadWindowActivitySignals(runtime, currentTime);

  // 1. Get all rooms the owner participates in
  const roomIds = await runtime.getRoomsForParticipant(ownerEntityId as UUID);

  // 2. Build room → source map
  const roomSourceMap = new Map<string, string>();
  await Promise.all(
    roomIds.map(async (roomId) => {
      try {
        const room = await runtime.getRoom(roomId);
        if (room?.source) {
          roomSourceMap.set(roomId, room.source);
        }
      } catch (cause) {
        // Room read can fail for deleted/migrated rooms during batch fetch.
        // Missing source is non-fatal for the profile build; log so repeated
        // misses surface in telemetry.
        logger.debug(
          { err: cause, roomId },
          "[ActivityProfile] room source lookup failed",
        );
      }
    }),
  );

  // 3. Fetch messages
  const messages: MessageRecord[] = [];
  if (roomIds.length > 0) {
    const memories = await loadAllRoomMessagesForActivityProfile(
      runtime,
      roomIds,
    );
    for (const mem of memories) {
      messages.push({
        entityId: mem.entityId,
        roomId: mem.roomId,
        createdAt: mem.createdAt ?? 0,
      });
    }
  }

  // 4. Analyze messages
  const baseProfile = analyzeMessages(
    messages,
    roomSourceMap,
    ownerEntityId,
    tz,
    MESSAGES_WINDOW_DAYS,
    activitySignals,
    currentTime,
  );

  // 5. Enrich with calendar if available
  let calendarEvents: CalendarEventRecord[] = [];
  try {
    const lifeOpsService = new LifeOpsService(runtime);
    const feed = await lifeOpsService.getCalendarFeed(
      new URL("http://localhost/api/lifeops/calendar"),
      {},
      currentTime,
    );
    calendarEvents = feed.events.map((e) => ({
      startAt: e.startAt,
      endAt: e.endAt,
      isAllDay: e.isAllDay,
    }));
  } catch (err) {
    logger.debug(
      {
        boundary: "activity_profile",
        operation: "calendar_enrichment",
        err: err instanceof Error ? err : undefined,
      },
      "[activity-profile] Calendar not available for profile enrichment; proceeding without calendar data.",
    );
  }

  const withCalendar = enrichWithCalendar(baseProfile, calendarEvents, tz);
  const screenContext = await sampleScreenContext(currentTime);
  return mergeScreenContext(withCalendar, screenContext, currentTime);
}

// ── Lightweight current-state refresh ─────────────────

export async function refreshCurrentState(
  runtime: IAgentRuntime,
  ownerEntityId: string,
  profile: ActivityProfile,
  now?: Date,
): Promise<ActivityProfile> {
  const currentTime = now ?? new Date();
  const roomIds = await runtime.getRoomsForParticipant(ownerEntityId as UUID);
  const screenContext = await sampleScreenContext(currentTime);
  const activitySignals = await loadRecentActivitySignals(runtime);

  const roomSourceMap = new Map<string, string>();
  if (roomIds.length > 0) {
    await Promise.all(
      roomIds.map(async (roomId) => {
        try {
          const room = await runtime.getRoom(roomId);
          if (room?.source) {
            roomSourceMap.set(roomId, room.source);
          }
        } catch (cause) {
          logger.debug(
            { err: cause, roomId },
            "[ActivityProfile] room source lookup failed during refresh",
          );
        }
      }),
    );
  }

  let lastSeenAt = profile.lastSeenAt;
  let lastSeenPlatform = profile.lastSeenPlatform;
  if (roomIds.length > 0) {
    const memories = await loadAllRoomMessagesForActivityProfile(
      runtime,
      roomIds,
    );

    for (const memory of memories) {
      const createdAt = memory.createdAt ?? 0;
      if (createdAt > currentTime.getTime()) {
        continue;
      }

      const source = roomSourceMap.get(memory.roomId) ?? "unknown";
      const isOwnerMessage = memory.entityId === ownerEntityId;
      const isClientChatSignal = source === "client_chat";
      if (!isOwnerMessage && !isClientChatSignal) {
        continue;
      }

      if (createdAt >= lastSeenAt) {
        lastSeenAt = createdAt;
        lastSeenPlatform = isClientChatSignal ? "client_chat" : source;
      }
    }
  }

  for (const signal of activitySignals) {
    if (
      signal.state !== "active" ||
      signal.observedAt > currentTime.getTime()
    ) {
      continue;
    }
    if (signal.observedAt >= lastSeenAt) {
      lastSeenAt = signal.observedAt;
      lastSeenPlatform = signal.platform;
    }
  }

  return mergeScreenContext(
    {
      ...profile,
      lastSeenAt,
      lastSeenPlatform,
      sustainedInactivityThresholdMinutes:
        profile.sustainedInactivityThresholdMinutes ||
        SUSTAINED_INACTIVITY_GAP_MS / 60_000,
    },
    screenContext,
    currentTime,
  );
}

// ── Metadata persistence helpers ──────────────────────

// Re-export from dedicated module to preserve public API while breaking the
// circular dependency between activity-profile/service and lifeops/service.
export { readProfileFromMetadata } from "./profile-metadata.js";

export function readFiredLogFromMetadata(
  metadata: Record<string, unknown> | null,
  todayDateStr: string,
): FiredActionsLog | null {
  if (!metadata?.firedActionsLog) return null;
  const log = metadata.firedActionsLog;
  if (!isRecord(log)) return null;
  if (typeof log.date !== "string") return null;
  if (!Array.isArray(log.nudgedOccurrenceIds)) return null;
  // If the log was written under a different effective day key, drop the
  // per-day arrays (nudges/goals) but preserve the timestamps so the
  // planner's timestamp-based once-per-day gate still sees the prior
  // GM/GN fires. See planner `firedRecently()` for the consumer side.
  if (log.date !== todayDateStr) {
    return {
      date: todayDateStr,
      gmFiredAt: typeof log.gmFiredAt === "number" ? log.gmFiredAt : undefined,
      gnFiredAt: typeof log.gnFiredAt === "number" ? log.gnFiredAt : undefined,
      seedingOfferedAt:
        typeof log.seedingOfferedAt === "number"
          ? log.seedingOfferedAt
          : undefined,
      nudgedOccurrenceIds: [],
      nudgedCalendarEventIds: [],
      checkedGoalIds: [],
    };
  }
  return {
    date: log.date,
    gmFiredAt: typeof log.gmFiredAt === "number" ? log.gmFiredAt : undefined,
    gnFiredAt: typeof log.gnFiredAt === "number" ? log.gnFiredAt : undefined,
    seedingOfferedAt:
      typeof log.seedingOfferedAt === "number"
        ? log.seedingOfferedAt
        : undefined,
    socialOveruseCheckedAt:
      typeof log.socialOveruseCheckedAt === "number"
        ? log.socialOveruseCheckedAt
        : undefined,
    nudgedOccurrenceIds: isStringArray(log.nudgedOccurrenceIds)
      ? log.nudgedOccurrenceIds
      : [],
    nudgedCalendarEventIds: isStringArray(log.nudgedCalendarEventIds)
      ? log.nudgedCalendarEventIds
      : [],
    checkedGoalIds: isStringArray(log.checkedGoalIds) ? log.checkedGoalIds : [],
  };
}

export function profileNeedsRebuild(
  profile: ActivityProfile | null,
  now: Date,
): boolean {
  if (!profile) return true;
  return now.getTime() - profile.analyzedAt > PROFILE_MAX_AGE_MS;
}
