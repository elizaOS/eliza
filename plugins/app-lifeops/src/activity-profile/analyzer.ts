import { getLocalDateKey, getZonedDateParts } from "../lifeops/time.js";
import {
  type ActivityProfile,
  type ActivitySignalRecord,
  emptyBucketCounts,
  type PlatformActivity,
  type TimeBucket,
} from "./types.js";

// ── Time bucket classification ─────────────────────────

const BUCKET_RANGES: Array<{ bucket: TimeBucket; start: number; end: number }> =
  [
    { bucket: "EARLY_MORNING", start: 5, end: 7 },
    { bucket: "MORNING", start: 7, end: 10 },
    { bucket: "MIDDAY", start: 10, end: 14 },
    { bucket: "AFTERNOON", start: 14, end: 17 },
    { bucket: "EVENING", start: 17, end: 21 },
    { bucket: "NIGHT", start: 21, end: 24 },
    // LATE_NIGHT wraps: 0-5
  ];

// Buckets ordered by clock hour (00:00 → 23:59). ALL_TIME_BUCKETS lists
// LATE_NIGHT last for legacy reasons; this constant is for callers that
// genuinely need clock-order traversal (first/last active hour derivation).
const CLOCK_ORDERED_TIME_BUCKETS: TimeBucket[] = [
  "LATE_NIGHT",
  "EARLY_MORNING",
  "MORNING",
  "MIDDAY",
  "AFTERNOON",
  "EVENING",
  "NIGHT",
];

export function classifyTimeBucket(hour: number): TimeBucket {
  if (hour >= 0 && hour < 5) return "LATE_NIGHT";
  for (const { bucket, start, end } of BUCKET_RANGES) {
    if (hour >= start && hour < end) return bucket;
  }
  // hour === 24 shouldn't happen but treat as LATE_NIGHT
  return "LATE_NIGHT";
}

export function resolveCurrentBucket(timezone: string, now?: Date): TimeBucket {
  const date = now ?? new Date();
  const parts = getZonedDateParts(date, timezone);
  return classifyTimeBucket(parts.hour);
}

// ── Message analysis ───────────────────────────────────

export interface MessageRecord {
  entityId: string;
  roomId: string;
  createdAt: number; // epoch ms
}

export interface CalendarEventRecord {
  startAt: string; // ISO datetime
  endAt: string;
  isAllDay: boolean;
}

export const SUSTAINED_INACTIVITY_GAP_MS = 3 * 60 * 60 * 1000; // 3 hours
const ACTIVE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const SIGNIFICANT_BUCKET_SHARE = 0.1; // 10% of total messages
const SCREEN_ACTIVE_FOCUS = new Set(["work", "leisure", "transition"]);
const SCREEN_ACTIVITY_CONFIDENCE_FLOOR = 0.35;

type ActivitySession = {
  startAt: number;
  endAt: number;
  startHour: number;
  normalizedEndHour: number;
  startDayKey: string;
};

type InteractionSnapshot = {
  lastSeenAt: number;
  lastSeenPlatform: string | null;
};

type HealthSnapshot = {
  observedAt: number;
  platform: string;
  source: string;
  isSleeping: boolean;
  sleepStartedAt: number | null;
  sleepEndedAt: number | null;
  durationMinutes: number | null;
  biometricsSampleAt: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localDateKeyForTimestamp(timestamp: number, timezone: string): string {
  return getLocalDateKey(getZonedDateParts(new Date(timestamp), timezone));
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHealthSnapshot(
  signal: ActivitySignalRecord,
): HealthSnapshot | null {
  if (signal.source !== "mobile_health") {
    return null;
  }
  const health =
    signal.health ??
    (isRecord(signal.metadata.health) ? signal.metadata.health : null);
  if (!health) {
    return null;
  }
  const sleep = isRecord(health.sleep) ? health.sleep : null;
  const biometrics = isRecord(health.biometrics) ? health.biometrics : null;
  const isSleeping = Boolean(sleep?.isSleeping);
  const sleepStartedAt = parseTimestamp(
    typeof sleep?.asleepAt === "string" ? sleep.asleepAt : null,
  );
  const sleepEndedAt = parseTimestamp(
    typeof sleep?.awakeAt === "string" ? sleep.awakeAt : null,
  );
  const biometricsSampleAt = parseTimestamp(
    typeof biometrics?.sampleAt === "string" ? biometrics.sampleAt : null,
  );
  return {
    observedAt: signal.observedAt,
    platform: signal.platform,
    source: typeof health.source === "string" ? health.source : "healthkit",
    isSleeping,
    sleepStartedAt,
    sleepEndedAt,
    durationMinutes:
      typeof sleep?.durationMinutes === "number" &&
      Number.isFinite(sleep.durationMinutes)
        ? sleep.durationMinutes
        : null,
    biometricsSampleAt,
  };
}

function buildActivitySession(
  startAt: number,
  endAt: number,
  timezone: string,
): ActivitySession {
  const startParts = getZonedDateParts(new Date(startAt), timezone);
  const endParts = getZonedDateParts(new Date(endAt), timezone);
  const startDayKey = getLocalDateKey(startParts);
  const startDayOrdinal = Math.floor(
    Date.UTC(startParts.year, startParts.month - 1, startParts.day) /
      86_400_000,
  );
  const endDayOrdinal = Math.floor(
    Date.UTC(endParts.year, endParts.month - 1, endParts.day) / 86_400_000,
  );

  return {
    startAt,
    endAt,
    startHour: startParts.hour,
    normalizedEndHour: endParts.hour + (endDayOrdinal - startDayOrdinal) * 24,
    startDayKey,
  };
}

function buildActivitySessionsFromTimestamps(
  timestamps: number[],
  timezone: string,
): ActivitySession[] {
  if (timestamps.length === 0) {
    return [];
  }

  const sorted = [...timestamps].sort((left, right) => left - right);
  const sessions: ActivitySession[] = [];
  let sessionStartAt = sorted[0] ?? 0;
  let sessionEndAt = sorted[0] ?? 0;

  for (let index = 1; index < sorted.length; index += 1) {
    const current = sorted[index] ?? 0;
    if (current - sessionEndAt > SUSTAINED_INACTIVITY_GAP_MS) {
      sessions.push(
        buildActivitySession(sessionStartAt, sessionEndAt, timezone),
      );
      sessionStartAt = current;
    }
    sessionEndAt = current;
  }

  sessions.push(buildActivitySession(sessionStartAt, sessionEndAt, timezone));
  return sessions;
}

function isActiveSignal(signal: ActivitySignalRecord, nowMs: number): boolean {
  return signal.state === "active" && signal.observedAt <= nowMs;
}

function resolveLatestInteractionSnapshot(
  messages: MessageRecord[],
  ownerEntityId: string,
  roomSourceMap: Map<string, string>,
  currentTime: Date,
  activitySignals: ActivitySignalRecord[],
): InteractionSnapshot {
  let latestOwnerSeenAt = 0;
  let latestOwnerPlatform: string | null = null;
  let latestClientChatSeenAt = 0;
  let latestSignalSeenAt = 0;
  let latestSignalPlatform: string | null = null;

  for (const msg of messages) {
    if (msg.createdAt > currentTime.getTime()) {
      continue;
    }

    const source = roomSourceMap.get(msg.roomId) ?? "unknown";
    if (source === "client_chat" && msg.createdAt > latestClientChatSeenAt) {
      latestClientChatSeenAt = msg.createdAt;
    }
    if (msg.entityId === ownerEntityId && msg.createdAt > latestOwnerSeenAt) {
      latestOwnerSeenAt = msg.createdAt;
      latestOwnerPlatform = source;
    }
  }

  if (latestClientChatSeenAt > latestOwnerSeenAt) {
    latestOwnerSeenAt = latestClientChatSeenAt;
    latestOwnerPlatform = "client_chat";
  }

  for (const signal of activitySignals) {
    if (!isActiveSignal(signal, currentTime.getTime())) {
      continue;
    }
    if (signal.observedAt > latestSignalSeenAt) {
      latestSignalSeenAt = signal.observedAt;
      latestSignalPlatform = signal.platform;
    }
  }

  if (latestSignalSeenAt > latestOwnerSeenAt) {
    return {
      lastSeenAt: latestSignalSeenAt,
      lastSeenPlatform: latestSignalPlatform,
    };
  }

  return {
    lastSeenAt: latestOwnerSeenAt,
    lastSeenPlatform: latestOwnerPlatform,
  };
}

function resolveScreenHeartbeatAt(
  profile: Pick<
    ActivityProfile,
    | "screenContextAvailable"
    | "screenContextStale"
    | "screenContextFocus"
    | "screenContextSampledAt"
    | "screenContextConfidence"
  >,
): number {
  if (!profile.screenContextAvailable || profile.screenContextStale) {
    return 0;
  }
  const sampledAt = profile.screenContextSampledAt;
  if (sampledAt === null || sampledAt <= 0) {
    return 0;
  }
  if (!SCREEN_ACTIVE_FOCUS.has(profile.screenContextFocus ?? "unknown")) {
    return 0;
  }
  if (
    profile.screenContextConfidence !== null &&
    profile.screenContextConfidence < SCREEN_ACTIVITY_CONFIDENCE_FLOOR
  ) {
    return 0;
  }
  return sampledAt;
}

export type CurrentActivityState = Pick<
  ActivityProfile,
  | "lastSeenAt"
  | "lastSeenPlatform"
  | "isCurrentlyActive"
  | "hasOpenActivityCycle"
  | "currentActivityCycleStartedAt"
  | "currentActivityCycleLocalDate"
  | "effectiveDayKey"
>;

export function resolveCurrentActivityState(
  profile: Pick<
    ActivityProfile,
    | "timezone"
    | "lastSeenAt"
    | "lastSeenPlatform"
    | "isCurrentlySleeping"
    | "lastSleepSignalAt"
    | "lastWakeSignalAt"
    | "hasOpenActivityCycle"
    | "sustainedInactivityThresholdMinutes"
    | "currentActivityCycleStartedAt"
    | "currentActivityCycleLocalDate"
    | "screenContextAvailable"
    | "screenContextStale"
    | "screenContextFocus"
    | "screenContextSampledAt"
    | "screenContextConfidence"
  >,
  now: Date,
): CurrentActivityState {
  const currentTime = now.getTime();
  const thresholdMs = profile.sustainedInactivityThresholdMinutes * 60 * 1000;
  const screenHeartbeatAt = resolveScreenHeartbeatAt(profile);
  const sleeping = profile.isCurrentlySleeping === true;
  const sleepBoundaryAt =
    profile.lastSleepSignalAt ?? profile.lastWakeSignalAt ?? profile.lastSeenAt;
  const mostRecentActivityAt = sleeping
    ? sleepBoundaryAt
    : Math.max(profile.lastSeenAt, screenHeartbeatAt);
  const hasOpenActivityCycle =
    !sleeping &&
    mostRecentActivityAt > 0 &&
    currentTime - mostRecentActivityAt <= thresholdMs;
  const cycleStart =
    !sleeping &&
    profile.currentActivityCycleStartedAt &&
    (profile.hasOpenActivityCycle ||
      mostRecentActivityAt - profile.currentActivityCycleStartedAt <=
        thresholdMs)
      ? profile.currentActivityCycleStartedAt
      : hasOpenActivityCycle
        ? mostRecentActivityAt
        : profile.currentActivityCycleStartedAt;
  const currentActivityCycleLocalDate = cycleStart
    ? localDateKeyForTimestamp(cycleStart, profile.timezone)
    : sleeping
      ? sleepBoundaryAt > 0
        ? localDateKeyForTimestamp(sleepBoundaryAt, profile.timezone)
        : profile.currentActivityCycleLocalDate
      : profile.currentActivityCycleLocalDate;
  const effectiveDayKey = hasOpenActivityCycle
    ? (currentActivityCycleLocalDate ??
      localDateKeyForTimestamp(currentTime, profile.timezone))
    : sleeping
      ? (currentActivityCycleLocalDate ??
        localDateKeyForTimestamp(currentTime, profile.timezone))
      : localDateKeyForTimestamp(currentTime, profile.timezone);

  return {
    lastSeenAt: mostRecentActivityAt,
    lastSeenPlatform: profile.lastSeenPlatform,
    isCurrentlyActive:
      !sleeping &&
      mostRecentActivityAt > 0 &&
      currentTime - mostRecentActivityAt < ACTIVE_THRESHOLD_MS,
    hasOpenActivityCycle,
    currentActivityCycleStartedAt: sleeping ? null : (cycleStart ?? null),
    currentActivityCycleLocalDate,
    effectiveDayKey,
  };
}

export function resolveEffectiveDayKey(
  profile: Pick<
    ActivityProfile,
    | "hasOpenActivityCycle"
    | "currentActivityCycleStartedAt"
    | "currentActivityCycleLocalDate"
    | "lastSeenAt"
    | "lastSeenPlatform"
    | "isCurrentlySleeping"
    | "lastSleepSignalAt"
    | "lastWakeSignalAt"
    | "sustainedInactivityThresholdMinutes"
    | "screenContextAvailable"
    | "screenContextStale"
    | "screenContextFocus"
    | "screenContextSampledAt"
    | "screenContextConfidence"
  >,
  timezone: string,
  now: Date,
): string {
  return resolveCurrentActivityState(
    {
      ...profile,
      timezone,
    },
    now,
  ).effectiveDayKey;
}

function resolveLatestActivityDayKey(
  profile: Pick<
    ActivityProfile,
    | "hasOpenActivityCycle"
    | "currentActivityCycleStartedAt"
    | "currentActivityCycleLocalDate"
    | "lastSeenAt"
    | "lastSeenPlatform"
    | "isCurrentlySleeping"
    | "lastSleepSignalAt"
    | "lastWakeSignalAt"
    | "sustainedInactivityThresholdMinutes"
    | "screenContextAvailable"
    | "screenContextStale"
    | "screenContextFocus"
    | "screenContextSampledAt"
    | "screenContextConfidence"
  >,
  timezone: string,
  now: Date,
): string | null {
  const heartbeatAt = Math.max(
    profile.lastSeenAt,
    resolveScreenHeartbeatAt(profile),
  );
  if (heartbeatAt <= 0) {
    return null;
  }
  const thresholdMs = profile.sustainedInactivityThresholdMinutes * 60 * 1000;
  if (now.getTime() - heartbeatAt <= thresholdMs) {
    if (profile.hasOpenActivityCycle && profile.currentActivityCycleStartedAt) {
      return (
        profile.currentActivityCycleLocalDate ??
        localDateKeyForTimestamp(
          profile.currentActivityCycleStartedAt,
          timezone,
        )
      );
    }
    return localDateKeyForTimestamp(heartbeatAt, timezone);
  }
  return localDateKeyForTimestamp(heartbeatAt, timezone);
}

export function analyzeMessages(
  messages: MessageRecord[],
  roomSourceMap: Map<string, string>,
  ownerEntityId: string,
  timezone: string,
  windowDays: number,
  now?: Date,
): Omit<
  ActivityProfile,
  | "hasCalendarData"
  | "typicalFirstEventHour"
  | "typicalLastEventHour"
  | "avgWeekdayMeetings"
>;
export function analyzeMessages(
  messages: MessageRecord[],
  roomSourceMap: Map<string, string>,
  ownerEntityId: string,
  timezone: string,
  windowDays: number,
  now: Date,
  activitySignals: ActivitySignalRecord[],
): Omit<
  ActivityProfile,
  | "hasCalendarData"
  | "typicalFirstEventHour"
  | "typicalLastEventHour"
  | "avgWeekdayMeetings"
>;
export function analyzeMessages(
  messages: MessageRecord[],
  roomSourceMap: Map<string, string>,
  ownerEntityId: string,
  timezone: string,
  windowDays: number,
  activitySignals?: ActivitySignalRecord[],
  now?: Date,
): Omit<
  ActivityProfile,
  | "hasCalendarData"
  | "typicalFirstEventHour"
  | "typicalLastEventHour"
  | "avgWeekdayMeetings"
>;
export function analyzeMessages(
  messages: MessageRecord[],
  roomSourceMap: Map<string, string>,
  ownerEntityId: string,
  timezone: string,
  windowDays: number,
  firstOptionalArg?: Date | ActivitySignalRecord[],
  secondOptionalArg?: Date | ActivitySignalRecord[],
): Omit<
  ActivityProfile,
  | "hasCalendarData"
  | "typicalFirstEventHour"
  | "typicalLastEventHour"
  | "avgWeekdayMeetings"
> {
  const currentTime =
    firstOptionalArg instanceof Date
      ? firstOptionalArg
      : secondOptionalArg instanceof Date
        ? secondOptionalArg
        : new Date();
  const activitySignals = Array.isArray(firstOptionalArg)
    ? firstOptionalArg
    : Array.isArray(secondOptionalArg)
      ? secondOptionalArg
      : [];
  const windowStart = currentTime.getTime() - windowDays * 24 * 60 * 60 * 1000;

  const ownerMessages = messages.filter(
    (m) =>
      m.entityId === ownerEntityId &&
      m.createdAt >= windowStart &&
      m.createdAt <= currentTime.getTime(),
  );
  const activeSignals = activitySignals.filter(
    (signal) =>
      signal.observedAt >= windowStart &&
      isActiveSignal(signal, currentTime.getTime()),
  );
  const healthSnapshots = activitySignals
    .map((signal) => parseHealthSnapshot(signal))
    .filter((snapshot): snapshot is HealthSnapshot => snapshot !== null);

  const platformMap = new Map<
    string,
    {
      count: number;
      buckets: Record<TimeBucket, number>;
      lastAt: number;
    }
  >();

  const aggregateBuckets = emptyBucketCounts();

  for (const msg of ownerMessages) {
    const source = roomSourceMap.get(msg.roomId) ?? "unknown";
    let entry = platformMap.get(source);
    if (!entry) {
      entry = { count: 0, buckets: emptyBucketCounts(), lastAt: 0 };
      platformMap.set(source, entry);
    }

    entry.count++;
    if (msg.createdAt > entry.lastAt) entry.lastAt = msg.createdAt;

    const parts = getZonedDateParts(new Date(msg.createdAt), timezone);
    const bucket = classifyTimeBucket(parts.hour);
    entry.buckets[bucket]++;
    aggregateBuckets[bucket]++;
  }

  for (const signal of activeSignals) {
    const source =
      signal.platform.trim().length > 0 ? signal.platform : "client_chat";
    let entry = platformMap.get(source);
    if (!entry) {
      entry = { count: 0, buckets: emptyBucketCounts(), lastAt: 0 };
      platformMap.set(source, entry);
    }

    entry.count++;
    if (signal.observedAt > entry.lastAt) entry.lastAt = signal.observedAt;

    const parts = getZonedDateParts(new Date(signal.observedAt), timezone);
    const bucket = classifyTimeBucket(parts.hour);
    entry.buckets[bucket]++;
    aggregateBuckets[bucket]++;
  }

  const platforms: PlatformActivity[] = Array.from(platformMap.entries())
    .map(([source, data]) => ({
      source,
      messageCount: data.count,
      bucketCounts: data.buckets,
      lastMessageAt: data.lastAt,
      averageMessagesPerDay: windowDays > 0 ? data.count / windowDays : 0,
    }))
    .sort((a, b) => b.messageCount - a.messageCount);

  const totalMessages = ownerMessages.length;
  const activityPointCount = totalMessages + activeSignals.length;
  const threshold =
    activityPointCount > 0
      ? Math.max(activityPointCount * SIGNIFICANT_BUCKET_SHARE, 1)
      : Infinity;

  let typicalFirstActiveHour: number | null = null;
  let typicalLastActiveHour: number | null = null;

  // Walk buckets in chronological clock order so LATE_NIGHT (00:00–05:00) is
  // treated as the earliest part of the day, not the latest. ALL_TIME_BUCKETS
  // lists LATE_NIGHT last; iterating in that order would make a single 3 AM
  // message overwrite typicalLastActiveHour to 3, landing GN scheduling in
  // the past and causing it to spam every tick.
  for (const bucket of CLOCK_ORDERED_TIME_BUCKETS) {
    if (aggregateBuckets[bucket] >= threshold) {
      const midHour = bucketMidpointHour(bucket);
      if (typicalFirstActiveHour === null) typicalFirstActiveHour = midHour;
      typicalLastActiveHour = midHour;
    }
  }

  const sessions = buildActivitySessionsFromTimestamps(
    [
      ...ownerMessages.map((message) => message.createdAt),
      ...activeSignals.map((signal) => signal.observedAt),
    ],
    timezone,
  );
  const sleepHoursFromHealth = healthSnapshots
    .filter((snapshot) => snapshot.sleepStartedAt !== null)
    .map(
      (snapshot) =>
        getZonedDateParts(new Date(snapshot.sleepStartedAt ?? 0), timezone)
          .hour,
    );
  const wakeHoursFromHealth = healthSnapshots
    .filter((snapshot) => snapshot.sleepEndedAt !== null)
    .map(
      (snapshot) =>
        getZonedDateParts(new Date(snapshot.sleepEndedAt ?? 0), timezone).hour,
    );
  const wakeHours = sessions
    .map((session) => session.startHour)
    .concat(wakeHoursFromHealth)
    .sort((left, right) => left - right);
  const sleepHours = sessions
    .map((session) => session.normalizedEndHour)
    .concat(sleepHoursFromHealth)
    .sort((left, right) => left - right);
  const typicalWakeHour = wakeHours.length > 0 ? median(wakeHours) : null;
  const typicalSleepHour = sleepHours.length > 0 ? median(sleepHours) : null;
  const sleepDurations = healthSnapshots
    .map((snapshot) => snapshot.durationMinutes)
    .filter((value): value is number => typeof value === "number");
  const typicalSleepDurationMinutes =
    sleepDurations.length > 0
      ? Math.round(
          sleepDurations.reduce((sum, value) => sum + value, 0) /
            sleepDurations.length,
        )
      : null;
  const latestHealthSnapshot =
    healthSnapshots.length > 0
      ? ([...healthSnapshots].sort(
          (left, right) => right.observedAt - left.observedAt,
        )[0] ?? null)
      : null;
  const latestSleepingHealthSnapshot =
    [...healthSnapshots]
      .filter((snapshot) => snapshot.isSleeping)
      .sort((left, right) => right.observedAt - left.observedAt)[0] ?? null;
  const latestWakeHealthSnapshot =
    [...healthSnapshots]
      .filter((snapshot) => !snapshot.isSleeping)
      .sort((left, right) => right.observedAt - left.observedAt)[0] ?? null;

  const latestInteraction = resolveLatestInteractionSnapshot(
    messages,
    ownerEntityId,
    roomSourceMap,
    currentTime,
    activeSignals,
  );
  let lastSeenAt = latestInteraction.lastSeenAt;
  let lastSeenPlatform = latestInteraction.lastSeenPlatform;
  if (latestHealthSnapshot) {
    const healthBoundaryAt = latestHealthSnapshot.isSleeping
      ? (latestHealthSnapshot.sleepStartedAt ?? latestHealthSnapshot.observedAt)
      : (latestHealthSnapshot.sleepEndedAt ?? latestHealthSnapshot.observedAt);
    if (healthBoundaryAt > lastSeenAt) {
      lastSeenAt = healthBoundaryAt;
      lastSeenPlatform = latestHealthSnapshot.platform;
    }
  }
  const isCurrentlySleeping = latestHealthSnapshot?.isSleeping === true;
  const hasSleepData = healthSnapshots.length > 0;
  const lastSleepSignalAt =
    latestSleepingHealthSnapshot?.sleepStartedAt ??
    latestSleepingHealthSnapshot?.observedAt ??
    null;
  const lastWakeSignalAt =
    latestWakeHealthSnapshot?.sleepEndedAt ??
    latestWakeHealthSnapshot?.observedAt ??
    null;
  const hasOpenActivityCycle =
    !isCurrentlySleeping &&
    lastSeenAt > 0 &&
    currentTime.getTime() - lastSeenAt <= SUSTAINED_INACTIVITY_GAP_MS;
  const currentActivityCycle =
    sessions.length > 0 ? sessions[sessions.length - 1] : null;
  const latestInteractionStartsNewCycle =
    !isCurrentlySleeping &&
    lastSeenAt > 0 &&
    (!currentActivityCycle || lastSeenAt > currentActivityCycle.endAt);
  const currentActivityCycleStartedAt = latestInteractionStartsNewCycle
    ? lastSeenAt
    : isCurrentlySleeping
      ? null
      : (currentActivityCycle?.startAt ?? lastSeenAt);
  const currentActivityCycleLocalDate = latestInteractionStartsNewCycle
    ? localDateKeyForTimestamp(lastSeenAt, timezone)
    : isCurrentlySleeping
      ? lastSleepSignalAt !== null
        ? localDateKeyForTimestamp(lastSleepSignalAt, timezone)
        : localDateKeyForTimestamp(currentTime.getTime(), timezone)
      : (currentActivityCycle?.startDayKey ??
        localDateKeyForTimestamp(lastSeenAt, timezone));

  return {
    ownerEntityId,
    analyzedAt: currentTime.getTime(),
    analysisWindowDays: windowDays,
    timezone,
    totalMessages,
    sustainedInactivityThresholdMinutes: SUSTAINED_INACTIVITY_GAP_MS / 60_000,
    platforms,
    primaryPlatform: platforms[0]?.source ?? null,
    secondaryPlatform: platforms[1]?.source ?? null,
    bucketCounts: aggregateBuckets,
    typicalFirstActiveHour,
    typicalLastActiveHour,
    typicalWakeHour,
    typicalSleepHour,
    hasSleepData,
    isCurrentlySleeping,
    lastSleepSignalAt,
    lastWakeSignalAt,
    sleepSourcePlatform: latestHealthSnapshot?.platform ?? null,
    sleepSource: latestHealthSnapshot?.source ?? null,
    typicalSleepDurationMinutes,
    lastSeenAt,
    lastSeenPlatform,
    isCurrentlyActive:
      !isCurrentlySleeping &&
      currentTime.getTime() - lastSeenAt < ACTIVE_THRESHOLD_MS,
    hasOpenActivityCycle,
    currentActivityCycleStartedAt,
    currentActivityCycleLocalDate,
    effectiveDayKey: hasOpenActivityCycle
      ? (currentActivityCycleLocalDate ??
        localDateKeyForTimestamp(currentTime.getTime(), timezone))
      : isCurrentlySleeping
        ? (currentActivityCycleLocalDate ??
          (lastSleepSignalAt !== null
            ? localDateKeyForTimestamp(lastSleepSignalAt, timezone)
            : localDateKeyForTimestamp(currentTime.getTime(), timezone)))
        : localDateKeyForTimestamp(currentTime.getTime(), timezone),
    screenContextFocus: null,
    screenContextSource: null,
    screenContextSampledAt: null,
    screenContextConfidence: null,
    screenContextBusy: false,
    screenContextAvailable: false,
    screenContextStale: false,
  };
}

// ── Calendar enrichment ────────────────────────────────

export function enrichWithCalendar(
  profile: Omit<
    ActivityProfile,
    | "hasCalendarData"
    | "typicalFirstEventHour"
    | "typicalLastEventHour"
    | "avgWeekdayMeetings"
  >,
  calendarEvents: CalendarEventRecord[],
  timezone: string,
): ActivityProfile {
  if (calendarEvents.length === 0) {
    return {
      ...profile,
      hasCalendarData: false,
      typicalFirstEventHour: null,
      typicalLastEventHour: null,
      avgWeekdayMeetings: null,
    };
  }

  // Filter to non-all-day events and extract local hours
  const eventHours: {
    startHour: number;
    endHour: number;
    dayOfWeek: number;
  }[] = [];

  for (const event of calendarEvents) {
    if (event.isAllDay) continue;
    const start = new Date(event.startAt);
    const end = new Date(event.endAt);
    const startParts = getZonedDateParts(start, timezone);
    const endParts = getZonedDateParts(end, timezone);
    const date = new Date(start);
    eventHours.push({
      startHour: startParts.hour,
      endHour: endParts.hour,
      dayOfWeek: date.getDay(), // 0=Sun, 1=Mon, ...
    });
  }

  if (eventHours.length === 0) {
    return {
      ...profile,
      hasCalendarData: true,
      typicalFirstEventHour: null,
      typicalLastEventHour: null,
      avgWeekdayMeetings: null,
    };
  }

  // Weekday events only (Mon-Fri)
  const weekdayEvents = eventHours.filter(
    (e) => e.dayOfWeek >= 1 && e.dayOfWeek <= 5,
  );

  // Compute median first event hour on weekdays
  const firstHours = weekdayEvents
    .map((e) => e.startHour)
    .sort((a, b) => a - b);
  const lastHours = weekdayEvents.map((e) => e.endHour).sort((a, b) => a - b);

  const typicalFirstEventHour =
    firstHours.length > 0 ? median(firstHours) : null;
  const typicalLastEventHour = lastHours.length > 0 ? median(lastHours) : null;

  // Average weekday meetings: count unique weekdays, divide total by that
  const weekdaySet = new Set(weekdayEvents.map((e) => e.dayOfWeek));
  const avgWeekdayMeetings =
    weekdaySet.size > 0
      ? Math.round((weekdayEvents.length / weekdaySet.size) * 10) / 10
      : null;

  return {
    ...profile,
    hasCalendarData: true,
    typicalFirstEventHour,
    typicalLastEventHour,
    avgWeekdayMeetings,
  };
}

// ── Helpers ────────────────────────────────────────────

function bucketMidpointHour(bucket: TimeBucket): number {
  switch (bucket) {
    case "EARLY_MORNING":
      return 6;
    case "MORNING":
      return 8;
    case "MIDDAY":
      return 12;
    case "AFTERNOON":
      return 15;
    case "EVENING":
      return 19;
    case "NIGHT":
      return 22;
    case "LATE_NIGHT":
      return 3;
  }
}

function median(sorted: number[]): number {
  if (sorted.length === 0) {
    throw new Error("[activity-profile] median requires at least one value");
  }
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    const medianValue = sorted[mid];
    if (medianValue === undefined) {
      throw new Error("[activity-profile] median index out of bounds");
    }
    return medianValue;
  }

  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left === undefined || right === undefined) {
    throw new Error("[activity-profile] median pair is incomplete");
  }
  return Math.round((left + right) / 2);
}

export function wasActiveToday(
  profile: Pick<
    ActivityProfile,
    | "hasOpenActivityCycle"
    | "currentActivityCycleStartedAt"
    | "currentActivityCycleLocalDate"
    | "lastSeenAt"
    | "lastSeenPlatform"
    | "sustainedInactivityThresholdMinutes"
    | "isCurrentlySleeping"
    | "lastSleepSignalAt"
    | "lastWakeSignalAt"
    | "screenContextAvailable"
    | "screenContextStale"
    | "screenContextFocus"
    | "screenContextSampledAt"
    | "screenContextConfidence"
  >,
  timezone: string,
  now: Date,
): boolean {
  return (
    resolveLatestActivityDayKey(profile, timezone, now) ===
    resolveEffectiveDayKey(profile, timezone, now)
  );
}
