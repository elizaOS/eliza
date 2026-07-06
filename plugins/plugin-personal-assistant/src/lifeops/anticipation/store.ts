/**
 * Proactive-dispatch markers + rolling anticipation-feedback stats.
 *
 * Two small cache-backed records that let the `anticipation_feedback`
 * evaluator judge how the owner receives proactive (agent-initiated) messages:
 *
 * 1. **Dispatch markers** — written at the proactive dispatch site (the
 *    scheduler records one alongside each pending prompt it opens). The
 *    pending-prompts store itself cannot serve as the evaluator's signal:
 *    inbound-reply completion resolves those entries on `MESSAGE_RECEIVED`,
 *    *before* post-turn evaluation runs, so by evaluator time the prompt is
 *    gone. Markers live per room, are bounded, age out after
 *    {@link MARKER_RETENTION_HOURS}, and are removed exactly once when
 *    feedback for them is recorded — that removal is what makes the evaluator
 *    idempotent (no marker => `shouldRun` false => no double-processing).
 *
 * 2. **Rolling stats** — accepted / rejected / ignored counters plus a
 *    bounded recent-outcome ring, durable across restarts, so proactivity
 *    (frequency, intensity) can be tuned from observed owner reception.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { asCacheRuntime } from "../runtime-cache.js";

export const MARKER_RETENTION_HOURS = 24;
const MAX_MARKERS_PER_ROOM = 8;
const MAX_RECENT_OUTCOMES = 20;
const SNIPPET_MAX_LENGTH = 160;

const STATS_CACHE_KEY = "eliza:lifeops:anticipation:stats:v1";

function markersCacheKey(roomId: string): string {
  return `eliza:lifeops:anticipation:dispatches:${roomId}:v1`;
}

export interface ProactiveDispatchMarker {
  taskId: string;
  /** ISO-8601 instant the proactive message fired into the room. */
  firedAt: string;
  /** Clamped copy of the dispatched prompt, for the classifier's context. */
  snippet: string;
}

export type AnticipationOutcome = "accepted" | "rejected" | "ignored";

export interface AnticipationOutcomeEntry {
  taskId: string;
  firedAt: string;
  outcome: AnticipationOutcome;
  recordedAt: string;
}

export interface AnticipationStats {
  accepted: number;
  rejected: number;
  ignored: number;
  updatedAt: string;
  /** Newest-last bounded ring of individual outcomes. */
  recent: AnticipationOutcomeEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidIso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function isOutcome(value: unknown): value is AnticipationOutcome {
  return value === "accepted" || value === "rejected" || value === "ignored";
}

function clampSnippet(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= SNIPPET_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

function normalizeMarkers(value: unknown): ProactiveDispatchMarker[] {
  if (!Array.isArray(value)) return [];
  const markers: ProactiveDispatchMarker[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.taskId !== "string" || entry.taskId.length === 0) {
      continue;
    }
    if (!isValidIso(entry.firedAt)) continue;
    markers.push({
      taskId: entry.taskId,
      firedAt: entry.firedAt,
      snippet: typeof entry.snippet === "string" ? entry.snippet : "",
    });
  }
  return markers;
}

function nonNegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function normalizeStats(value: unknown, now: Date): AnticipationStats {
  const base: AnticipationStats = {
    accepted: 0,
    rejected: 0,
    ignored: 0,
    updatedAt: now.toISOString(),
    recent: [],
  };
  if (!isRecord(value)) return base;
  base.accepted = nonNegativeCount(value.accepted);
  base.rejected = nonNegativeCount(value.rejected);
  base.ignored = nonNegativeCount(value.ignored);
  if (isValidIso(value.updatedAt)) base.updatedAt = value.updatedAt;
  if (Array.isArray(value.recent)) {
    for (const entry of value.recent) {
      if (!isRecord(entry)) continue;
      if (typeof entry.taskId !== "string" || entry.taskId.length === 0) {
        continue;
      }
      if (!isValidIso(entry.firedAt) || !isValidIso(entry.recordedAt)) {
        continue;
      }
      if (!isOutcome(entry.outcome)) continue;
      base.recent.push({
        taskId: entry.taskId,
        firedAt: entry.firedAt,
        outcome: entry.outcome,
        recordedAt: entry.recordedAt,
      });
    }
    if (base.recent.length > MAX_RECENT_OUTCOMES) {
      base.recent = base.recent.slice(-MAX_RECENT_OUTCOMES);
    }
  }
  return base;
}

function liveMarkers(
  markers: ProactiveDispatchMarker[],
  now: Date,
): ProactiveDispatchMarker[] {
  const cutoffMs = now.getTime() - MARKER_RETENTION_HOURS * 3_600_000;
  return markers
    .filter((marker) => Date.parse(marker.firedAt) >= cutoffMs)
    .sort((a, b) => Date.parse(a.firedAt) - Date.parse(b.firedAt));
}

/**
 * Record that a proactive message fired into `roomId`. Called at the
 * scheduler's dispatch site right after the pending prompt is recorded.
 * Re-firing the same task replaces its marker (newest fire wins).
 */
export async function recordProactiveDispatch(
  runtime: IAgentRuntime,
  input: {
    roomId: string;
    taskId: string;
    firedAt: string;
    snippet: string;
  },
): Promise<void> {
  if (!input.roomId) {
    throw new Error("[anticipation-store] roomId is required");
  }
  if (!input.taskId) {
    throw new Error("[anticipation-store] taskId is required");
  }
  if (!isValidIso(input.firedAt)) {
    throw new Error("[anticipation-store] firedAt must be ISO-8601");
  }
  const cache = asCacheRuntime(runtime);
  const stored = normalizeMarkers(
    await cache.getCache<ProactiveDispatchMarker[]>(
      markersCacheKey(input.roomId),
    ),
  );
  const next = stored.filter((marker) => marker.taskId !== input.taskId);
  next.push({
    taskId: input.taskId,
    firedAt: input.firedAt,
    snippet: clampSnippet(input.snippet),
  });
  const bounded =
    next.length > MAX_MARKERS_PER_ROOM
      ? next
          .sort((a, b) => Date.parse(a.firedAt) - Date.parse(b.firedAt))
          .slice(-MAX_MARKERS_PER_ROOM)
      : next;
  await cache.setCache<ProactiveDispatchMarker[]>(
    markersCacheKey(input.roomId),
    bounded,
  );
}

/**
 * Markers in `roomId` that have not yet received feedback, oldest first.
 * Aged-out markers (past {@link MARKER_RETENTION_HOURS}) are dropped from
 * the result and pruned from the cache.
 */
export async function listUnprocessedDispatches(
  runtime: IAgentRuntime,
  roomId: string,
  opts: { now?: Date } = {},
): Promise<ProactiveDispatchMarker[]> {
  const now = opts.now ?? new Date();
  const cache = asCacheRuntime(runtime);
  const stored = normalizeMarkers(
    await cache.getCache<ProactiveDispatchMarker[]>(markersCacheKey(roomId)),
  );
  const live = liveMarkers(stored, now);
  if (live.length !== stored.length) {
    await cache.setCache<ProactiveDispatchMarker[]>(
      markersCacheKey(roomId),
      live,
    );
  }
  return live;
}

/**
 * Record outcomes for `roomId` markers and remove them so they are never
 * classified twice. Updates the rolling stats in the same pass.
 */
export async function recordAnticipationFeedback(
  runtime: IAgentRuntime,
  roomId: string,
  entries: Array<{
    marker: ProactiveDispatchMarker;
    outcome: AnticipationOutcome;
  }>,
  opts: { now?: Date } = {},
): Promise<AnticipationStats> {
  const now = opts.now ?? new Date();
  const cache = asCacheRuntime(runtime);

  if (entries.length > 0) {
    const stored = normalizeMarkers(
      await cache.getCache<ProactiveDispatchMarker[]>(markersCacheKey(roomId)),
    );
    const processedKeys = new Set(
      entries.map(({ marker }) => `${marker.taskId}:${marker.firedAt}`),
    );
    const remaining = stored.filter(
      (marker) => !processedKeys.has(`${marker.taskId}:${marker.firedAt}`),
    );
    await cache.setCache<ProactiveDispatchMarker[]>(
      markersCacheKey(roomId),
      remaining,
    );
  }

  const stats = normalizeStats(
    await cache.getCache<AnticipationStats>(STATS_CACHE_KEY),
    now,
  );
  const recordedAt = now.toISOString();
  for (const { marker, outcome } of entries) {
    stats[outcome] += 1;
    stats.recent.push({
      taskId: marker.taskId,
      firedAt: marker.firedAt,
      outcome,
      recordedAt,
    });
  }
  if (stats.recent.length > MAX_RECENT_OUTCOMES) {
    stats.recent = stats.recent.slice(-MAX_RECENT_OUTCOMES);
  }
  stats.updatedAt = recordedAt;
  await cache.setCache<AnticipationStats>(STATS_CACHE_KEY, stats);
  return stats;
}

/** Read the rolling anticipation-feedback stats (proactivity tuning input). */
export async function readAnticipationStats(
  runtime: IAgentRuntime,
  opts: { now?: Date } = {},
): Promise<AnticipationStats> {
  const cache = asCacheRuntime(runtime);
  return normalizeStats(
    await cache.getCache<AnticipationStats>(STATS_CACHE_KEY),
    opts.now ?? new Date(),
  );
}
