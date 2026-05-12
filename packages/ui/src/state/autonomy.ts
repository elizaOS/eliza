import type { StreamEventEnvelope } from "../api/client";

export type AutonomyRunHealthStatus =
  | "ok"
  | "gap_detected"
  | "recovered"
  | "partial";

export interface AutonomyRunHealth {
  runId: string;
  status: AutonomyRunHealthStatus;
  lastSeq: number | null;
  missingSeqs: number[];
  gapCount: number;
  lastGapAt?: number;
  recoveredAt?: number;
  partialAt?: number;
}

export type AutonomyRunHealthMap = Record<string, AutonomyRunHealth>;

export interface AutonomyEventStore {
  eventsById: Record<string, StreamEventEnvelope>;
  eventOrder: string[];
  runIndex: Record<string, Record<number, string>>;
  watermark: string | null;
}

export interface MergeAutonomyEventsOptions {
  existingEvents?: StreamEventEnvelope[];
  store?: AutonomyEventStore;
  incomingEvents: StreamEventEnvelope[];
  runHealthByRunId: AutonomyRunHealthMap;
  maxEvents?: number;
  replay?: boolean;
}

export interface MergeAutonomyEventsResult {
  store: AutonomyEventStore;
  events: StreamEventEnvelope[];
  latestEventId: string | null;
  runHealthByRunId: AutonomyRunHealthMap;
  insertedCount: number;
  duplicateCount: number;
  runsWithNewGaps: string[];
  runsRecovered: string[];
  hasUnresolvedGaps: boolean;
}

const DEFAULT_MAX_EVENTS = 1200;

function cloneRunHealthMap(
  runHealthByRunId: AutonomyRunHealthMap,
): AutonomyRunHealthMap {
  return Object.fromEntries(
    Object.entries(runHealthByRunId).map(([runId, health]) => [
      runId,
      {
        ...health,
        missingSeqs: [...health.missingSeqs],
      },
    ]),
  );
}

function createEmptyStore(): AutonomyEventStore {
  return {
    eventsById: {},
    eventOrder: [],
    runIndex: {},
    watermark: null,
  };
}

function cloneAutonomyStore(store: AutonomyEventStore): AutonomyEventStore {
  return {
    eventsById: { ...store.eventsById },
    eventOrder: [...store.eventOrder],
    runIndex: Object.fromEntries(
      Object.entries(store.runIndex).map(([runId, bySeq]) => [
        runId,
        { ...bySeq },
      ]),
    ),
    watermark: store.watermark,
  };
}

function fallbackDedupKey(event: StreamEventEnvelope): string | null {
  if (typeof event.runId !== "string" || event.runId.length === 0) return null;
  if (typeof event.stream !== "string" || event.stream.length === 0)
    return null;
  if (typeof event.seq !== "number" || !Number.isFinite(event.seq)) return null;
  return `${event.runId}:${event.seq}:${event.stream}`;
}

function hasRunIdAndSeq(
  event: StreamEventEnvelope,
): event is StreamEventEnvelope & {
  runId: string;
  seq: number;
} {
  return (
    typeof event.runId === "string" &&
    event.runId.length > 0 &&
    typeof event.seq === "number" &&
    Number.isFinite(event.seq)
  );
}

function ensureRunHealth(
  runHealthByRunId: AutonomyRunHealthMap,
  runId: string,
): AutonomyRunHealth {
  let health = runHealthByRunId[runId];
  if (!health) {
    health = {
      runId,
      status: "ok",
      lastSeq: null,
      missingSeqs: [],
      gapCount: 0,
    };
    runHealthByRunId[runId] = health;
  }
  return health;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function parseEventOrdinal(eventId: string): number | null {
  const match = /^evt-(\d+)$/.exec(eventId);
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(value) ? value : null;
}

function nextWatermark(current: string | null, candidate: string): string {
  if (!current) return candidate;
  if (current === candidate) return current;

  const currentOrdinal = parseEventOrdinal(current);
  const candidateOrdinal = parseEventOrdinal(candidate);
  if (currentOrdinal !== null && candidateOrdinal !== null) {
    return candidateOrdinal > currentOrdinal ? candidate : current;
  }

  return candidate;
}

function recomputeWatermark(store: AutonomyEventStore): void {
  let watermark: string | null = null;
  for (const eventId of store.eventOrder) {
    if (!store.eventsById[eventId]) continue;
    watermark = nextWatermark(watermark, eventId);
  }
  store.watermark = watermark;
}

function indexRunEvent(
  store: AutonomyEventStore,
  event: StreamEventEnvelope,
): void {
  if (!hasRunIdAndSeq(event)) return;
  const runId = event.runId;
  if (runId === "__proto__" || runId === "constructor" || runId === "prototype")
    return;
  const seq = Math.trunc(event.seq);
  const bySeq = store.runIndex[runId] ?? Object.create(null);
  bySeq[seq] = event.eventId;
  store.runIndex[runId] = bySeq;
}

function addEventToStore(
  store: AutonomyEventStore,
  event: StreamEventEnvelope,
): void {
  store.eventsById[event.eventId] = event;
  store.eventOrder.push(event.eventId);
  indexRunEvent(store, event);
  store.watermark = nextWatermark(store.watermark, event.eventId);
}

function removeEventFromStore(
  store: AutonomyEventStore,
  eventId: string,
): void {
  const event = store.eventsById[eventId];
  if (!event) return;
  delete store.eventsById[eventId];

  if (hasRunIdAndSeq(event)) {
    const runId = event.runId;
    if (
      runId === "__proto__" ||
      runId === "constructor" ||
      runId === "prototype"
    )
      return;
    const seq = Math.trunc(event.seq);
    const bySeq = store.runIndex[runId];
    if (bySeq && bySeq[seq] === eventId) {
      delete bySeq[seq];
      if (Object.keys(bySeq).length === 0) {
        delete store.runIndex[runId];
      }
    }
  }
}

function trimStore(store: AutonomyEventStore, maxEvents: number): void {
  if (store.eventOrder.length <= maxEvents) {
    recomputeWatermark(store);
    return;
  }

  const removeCount = store.eventOrder.length - maxEvents;
  const removedIds = store.eventOrder.splice(0, removeCount);
  for (const eventId of removedIds) {
    removeEventFromStore(store, eventId);
  }
  recomputeWatermark(store);
}

function hydrateRunHealthFromStore(
  runHealthByRunId: AutonomyRunHealthMap,
  store: AutonomyEventStore,
): void {
  for (const [runId, bySeq] of Object.entries(store.runIndex)) {
    const health = ensureRunHealth(runHealthByRunId, runId);
    const observedSeqs = uniqueSorted(
      Object.keys(bySeq)
        .map((seq) => Number(seq))
        .filter((seq) => Number.isFinite(seq)),
    );
    const observedSet = new Set(observedSeqs);

    const missingFromObserved: number[] = [];
    for (let idx = 1; idx < observedSeqs.length; idx += 1) {
      const previous = observedSeqs[idx - 1];
      const current = observedSeqs[idx];
      if (current <= previous + 1) continue;
      for (let missing = previous + 1; missing < current; missing += 1) {
        missingFromObserved.push(missing);
      }
    }

    if (observedSeqs.length > 0) {
      const observedLastSeq = observedSeqs[observedSeqs.length - 1] ?? null;
      if (
        observedLastSeq !== null &&
        (health.lastSeq === null || observedLastSeq > health.lastSeq)
      ) {
        health.lastSeq = observedLastSeq;
      }
    }

    const mergedMissing = uniqueSorted([
      ...health.missingSeqs,
      ...missingFromObserved,
    ]).filter((missing) => !observedSet.has(missing));
    health.missingSeqs = mergedMissing;

    if (health.missingSeqs.length > 0) {
      if (health.status === "ok" || health.status === "recovered") {
        health.status = "gap_detected";
      }
      if (missingFromObserved.length > 0) {
        health.gapCount = Math.max(health.gapCount, 1);
      }
    }
  }
}

function buildStoreFromEvents(
  existingEvents: StreamEventEnvelope[],
  maxEvents: number,
): AutonomyEventStore {
  const store = createEmptyStore();
  const seenEventIds = new Set<string>();
  const seenFallbackKeys = new Set<string>();

  for (const event of existingEvents) {
    const key = fallbackDedupKey(event);
    const duplicate =
      seenEventIds.has(event.eventId) ||
      (key ? seenFallbackKeys.has(key) : false);
    if (duplicate) continue;

    seenEventIds.add(event.eventId);
    if (key) seenFallbackKeys.add(key);
    addEventToStore(store, event);
  }

  trimStore(store, maxEvents);
  return store;
}

export interface AutonomyGapReplayRequest {
  runId: string;
  fromSeq: number;
  missingSeqs: number[];
}

export function buildAutonomyGapReplayRequests(
  runHealthByRunId: AutonomyRunHealthMap,
  store: AutonomyEventStore,
): AutonomyGapReplayRequest[] {
  const requests: AutonomyGapReplayRequest[] = [];

  for (const health of Object.values(runHealthByRunId)) {
    if (health.missingSeqs.length === 0) continue;
    const indexedSeqs = store.runIndex[health.runId] ?? {};
    const unresolved = health.missingSeqs.filter(
      (seq) => indexedSeqs[seq] === undefined,
    );
    if (unresolved.length === 0) continue;
    requests.push({
      runId: health.runId,
      fromSeq: Math.min(...unresolved),
      missingSeqs: unresolved,
    });
  }

  return requests.sort((left, right) => left.fromSeq - right.fromSeq);
}

export function hasPendingAutonomyGaps(
  runHealthByRunId: AutonomyRunHealthMap,
): boolean {
  return Object.values(runHealthByRunId).some(
    (health) => health.missingSeqs.length > 0,
  );
}

export function markPendingAutonomyGapsPartial(
  runHealthByRunId: AutonomyRunHealthMap,
  ts = Date.now(),
): AutonomyRunHealthMap {
  const next = cloneRunHealthMap(runHealthByRunId);
  for (const health of Object.values(next)) {
    if (health.missingSeqs.length === 0) continue;
    health.status = "partial";
    health.partialAt = ts;
  }
  return next;
}

export function mergeAutonomyEvents({
  existingEvents,
  store,
  incomingEvents,
  runHealthByRunId,
  maxEvents = DEFAULT_MAX_EVENTS,
  replay = false,
}: MergeAutonomyEventsOptions): MergeAutonomyEventsResult {
  const initialStore = store
    ? cloneAutonomyStore(store)
    : buildStoreFromEvents(existingEvents ?? [], maxEvents);
  const nextStore = initialStore;
  const nextRunHealthByRunId = cloneRunHealthMap(runHealthByRunId);
  hydrateRunHealthFromStore(nextRunHealthByRunId, nextStore);

  if (incomingEvents.length === 0 && !replay) {
    const events = nextStore.eventOrder
      .map((eventId) => nextStore.eventsById[eventId])
      .filter((event): event is StreamEventEnvelope => Boolean(event));
    return {
      store: nextStore,
      events,
      latestEventId: nextStore.watermark,
      runHealthByRunId: nextRunHealthByRunId,
      insertedCount: 0,
      duplicateCount: 0,
      runsWithNewGaps: [],
      runsRecovered: [],
      hasUnresolvedGaps: hasPendingAutonomyGaps(nextRunHealthByRunId),
    };
  }

  const seenEventIds = new Set<string>();
  const seenFallbackKeys = new Set<string>();

  for (const eventId of nextStore.eventOrder) {
    const event = nextStore.eventsById[eventId];
    if (!event) continue;
    seenEventIds.add(eventId);
    const key = fallbackDedupKey(event);
    if (key) seenFallbackKeys.add(key);
  }

  let duplicateCount = 0;
  let insertedCount = 0;
  const runsWithNewGaps = new Set<string>();
  const runsRecovered = new Set<string>();

  for (const event of incomingEvents) {
    const key = fallbackDedupKey(event);
    const duplicate =
      seenEventIds.has(event.eventId) ||
      (key ? seenFallbackKeys.has(key) : false);
    if (duplicate) {
      duplicateCount += 1;
      continue;
    }

    seenEventIds.add(event.eventId);
    if (key) seenFallbackKeys.add(key);

    addEventToStore(nextStore, event);
    insertedCount += 1;

    if (!hasRunIdAndSeq(event)) {
      continue;
    }

    const health = ensureRunHealth(nextRunHealthByRunId, event.runId);
    const seq = Math.trunc(event.seq);
    const previousLastSeq = health.lastSeq;

    if (previousLastSeq !== null && seq > previousLastSeq + 1) {
      const missingSeqs: number[] = [];
      for (let current = previousLastSeq + 1; current < seq; current += 1) {
        missingSeqs.push(current);
      }
      health.missingSeqs = uniqueSorted([
        ...health.missingSeqs,
        ...missingSeqs,
      ]);
      health.status = "gap_detected";
      health.gapCount += 1;
      health.lastGapAt = event.ts;
      runsWithNewGaps.add(event.runId);
    }

    if (health.missingSeqs.length > 0) {
      health.missingSeqs = health.missingSeqs.filter(
        (missing) => missing !== seq,
      );
    }

    if (health.lastSeq === null || seq > health.lastSeq) {
      health.lastSeq = seq;
    }

    if (
      health.missingSeqs.length === 0 &&
      (health.status === "gap_detected" || health.status === "partial")
    ) {
      health.status = "recovered";
      health.recoveredAt = event.ts;
      runsRecovered.add(event.runId);
    }
  }

  if (replay) {
    const replayTs = Date.now();
    for (const health of Object.values(nextRunHealthByRunId)) {
      if (health.missingSeqs.length === 0) continue;
      health.status = "partial";
      health.partialAt = replayTs;
    }
  }

  trimStore(nextStore, maxEvents);

  const boundedEvents = nextStore.eventOrder
    .map((eventId) => nextStore.eventsById[eventId])
    .filter((event): event is StreamEventEnvelope => Boolean(event));
  const latestEventId = nextStore.watermark;

  return {
    store: nextStore,
    events: boundedEvents,
    latestEventId,
    runHealthByRunId: nextRunHealthByRunId,
    insertedCount,
    duplicateCount,
    runsWithNewGaps: [...runsWithNewGaps],
    runsRecovered: [...runsRecovered],
    hasUnresolvedGaps: hasPendingAutonomyGaps(nextRunHealthByRunId),
  };
}
