/**
 * Pure derivation of the `scheduleStyle` / `chronotype` owner-facts from the
 * owner's observed sleep episodes (issue #12284, WI-5). The heavy lifting —
 * SRI, circular stddevs, personal baseline — is plugin-health's
 * `computeSleepRegularity` / `computePersonalBaseline`; this module maps those
 * already-computed classes onto the queryable owner-fact vocabulary and adds
 * the one distinction they cannot express: a *rotating* (shift-work) pattern,
 * whose wake times form two internally-tight clusters far apart on the clock,
 * versus a merely *irregular* (noisy) one.
 *
 * Everything here is a pure function over episode data — no store, no clock,
 * no runtime — so the classification rules are unit-testable in isolation.
 * The runtime binding lives in `schedule-style-writer.ts`, which follows the
 * same user-override + idempotency contract as the window learner
 * (`activity-profile/window-learning.ts`).
 */

import type {
  LifeOpsPersonalBaseline,
  LifeOpsScheduleRegularity,
  SleepRegularityEpisodeLike,
} from "@elizaos/plugin-health";
import {
  computePersonalBaseline,
  computeSleepRegularity,
} from "@elizaos/plugin-health";
import { getZonedDateParts } from "../time.js";
import type {
  OwnerChronotype,
  OwnerFacts,
  OwnerFactsPatch,
  OwnerScheduleStyle,
} from "./fact-store.js";

/** Inputs the style/chronotype derivation consumes, one analysis pass. */
export interface ScheduleStyleSample {
  regularity: LifeOpsScheduleRegularity;
  baseline: LifeOpsPersonalBaseline | null;
  /**
   * Local wake minute-of-day for each qualifying episode, in episode order.
   * Feeds the rotating-pattern cluster detection.
   */
  wakeMinutesLocal: readonly number[];
}

const MINUTES_PER_DAY = 24 * 60;

/** Minimum qualifying-episode duration, mirroring plugin-health's filter. */
const MIN_EPISODE_MINUTES = 180;

/** Rotating detection: each wake cluster must span at most this many minutes. */
const ROTATING_CLUSTER_MAX_SPAN_MIN = 120;

/** Rotating detection: clusters must sit at least this far apart (minutes). */
const ROTATING_MIN_SEPARATION_MIN = 240;

/** Rotating detection: each cluster needs at least this many wake samples. */
const ROTATING_MIN_CLUSTER_SIZE = 2;

/**
 * Chronotype thresholds on the mid-sleep hour, approximating MCTQ terciles:
 * mid-sleep before 02:30 reads as an early type, after 04:30 as a late type.
 */
const CHRONOTYPE_EARLY_MAX_MIDSLEEP_HOUR = 2.5;
const CHRONOTYPE_LATE_MIN_MIDSLEEP_HOUR = 4.5;

/**
 * Build a `ScheduleStyleSample` from raw sleep episodes: runs plugin-health's
 * regularity + baseline computations and extracts the qualifying local wake
 * minutes (same qualification rule plugin-health applies: closed, non-nap,
 * ended by `nowMs`, at least 3h long) for the rotating detector.
 */
export function buildScheduleStyleSample(args: {
  episodes: readonly SleepRegularityEpisodeLike[];
  timezone: string;
  nowMs: number;
}): ScheduleStyleSample {
  const regularity = computeSleepRegularity({
    episodes: args.episodes,
    timezone: args.timezone,
    nowMs: args.nowMs,
  });
  const baseline = computePersonalBaseline({
    episodes: args.episodes,
    timezone: args.timezone,
    nowMs: args.nowMs,
  });
  const wakeMinutesLocal: number[] = [];
  for (const episode of args.episodes) {
    if (episode.cycleType === "nap" || episode.endAt === null) continue;
    const startMs = Date.parse(episode.startAt);
    const endMs = Date.parse(episode.endAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs || endMs > args.nowMs) continue;
    if ((endMs - startMs) / 60_000 < MIN_EPISODE_MINUTES) continue;
    const parts = getZonedDateParts(new Date(endMs), args.timezone);
    wakeMinutesLocal.push(parts.hour * 60 + parts.minute);
  }
  return { regularity, baseline, wakeMinutesLocal };
}

/**
 * Detect a rotating (shift-work-like) wake pattern: the wake minutes split
 * into exactly two internally-tight clusters separated by a large arc on the
 * 24h circle. Implementation: sort the minutes, take the two largest circular
 * gaps as the cluster boundary; both resulting arcs must be populated, tight,
 * and far apart. A merely noisy sleeper fails the tightness test; a
 * consistent sleeper fails the two-populated-clusters test.
 */
export function detectRotatingWakePattern(
  wakeMinutes: readonly number[],
): boolean {
  if (wakeMinutes.length < ROTATING_MIN_CLUSTER_SIZE * 2) return false;
  const sorted = [...wakeMinutes].sort((left, right) => left - right);
  const n = sorted.length;

  // Circular gap after sorted[i]; the final entry wraps to the first.
  const gaps: number[] = [];
  for (let index = 0; index < n; index += 1) {
    const current = sorted[index] as number;
    const next =
      index === n - 1
        ? (sorted[0] as number) + MINUTES_PER_DAY
        : (sorted[index + 1] as number);
    gaps.push(next - current);
  }

  let firstGapIndex = 0;
  let secondGapIndex = -1;
  for (let index = 1; index < n; index += 1) {
    const gap = gaps[index] as number;
    if (gap > (gaps[firstGapIndex] as number)) {
      secondGapIndex = firstGapIndex;
      firstGapIndex = index;
    } else if (
      secondGapIndex === -1 ||
      gap > (gaps[secondGapIndex] as number)
    ) {
      secondGapIndex = index;
    }
  }
  if (secondGapIndex === -1) return false;

  const [cutA, cutB] = [firstGapIndex, secondGapIndex].sort(
    (left, right) => left - right,
  ) as [number, number];

  // Arc 1: indices (cutA, cutB]; arc 2: (cutB, n-1] ∪ [0, cutA] (wrapping).
  const clusterA = sorted.slice(cutA + 1, cutB + 1);
  const clusterB = [...sorted.slice(cutB + 1), ...sorted.slice(0, cutA + 1)];
  if (
    clusterA.length < ROTATING_MIN_CLUSTER_SIZE ||
    clusterB.length < ROTATING_MIN_CLUSTER_SIZE
  ) {
    return false;
  }

  // Each arc's span is the total circular extent between its extremes, i.e.
  // everything except the two boundary gaps and the other arc.
  const spanA = arcSpan(clusterA);
  const spanB = arcSpan(clusterB);
  if (
    spanA > ROTATING_CLUSTER_MAX_SPAN_MIN ||
    spanB > ROTATING_CLUSTER_MAX_SPAN_MIN
  ) {
    return false;
  }

  const separation = Math.min(
    gaps[firstGapIndex] as number,
    gaps[secondGapIndex] as number,
  );
  return separation >= ROTATING_MIN_SEPARATION_MIN;
}

/**
 * Circular extent of a cluster built from consecutive sorted minutes (the
 * second cluster may wrap midnight, so spans are computed modulo 24h from
 * first to last member).
 */
function arcSpan(cluster: readonly number[]): number {
  if (cluster.length <= 1) return 0;
  const first = cluster[0] as number;
  const last = cluster[cluster.length - 1] as number;
  return (
    (((last - first) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  );
}

/**
 * Map the computed regularity (plus the rotating cluster check) onto the
 * owner-fact vocabulary. Returns `null` on insufficient data — a null never
 * clears a previously-learned value; classifications only move on evidence.
 */
export function deriveScheduleStyle(
  sample: ScheduleStyleSample,
): OwnerScheduleStyle | null {
  switch (sample.regularity.regularityClass) {
    case "insufficient_data":
      return null;
    case "very_regular":
    case "regular":
      return "regular";
    case "irregular":
    case "very_irregular":
      // A block-rotating shift pattern can land in either irregular class
      // (its SRI depends on block length), so the cluster test runs for both.
      return detectRotatingWakePattern(sample.wakeMinutesLocal)
        ? "rotating"
        : "irregular";
  }
}

/**
 * Derive the chronotype label from the personal baseline's mid-sleep point.
 * Returns `null` without a baseline or with a degenerate (zero-length) sleep
 * duration. Callers should skip chronotype for rotating sleepers — a circular
 * mean over mixed shift blocks is an artifact, not a trait.
 */
export function deriveChronotype(
  baseline: LifeOpsPersonalBaseline | null,
): OwnerChronotype | null {
  if (!baseline) return null;
  const bedWall = ((baseline.medianBedtimeLocalHour % 24) + 24) % 24;
  const wake = baseline.medianWakeLocalHour;
  const durationHours = (((wake - bedWall) % 24) + 24) % 24;
  if (durationHours === 0) return null;
  const midSleep = (bedWall + durationHours / 2) % 24;
  // Fold onto [-12, 12) around midnight so a pre-midnight mid-sleep (extreme
  // early type) compares below the early threshold instead of above 22.
  const folded = midSleep >= 12 ? midSleep - 24 : midSleep;
  if (folded < CHRONOTYPE_EARLY_MAX_MIDSLEEP_HOUR) return "early";
  if (folded > CHRONOTYPE_LATE_MIN_MIDSLEEP_HOUR) return "late";
  return "intermediate";
}

/**
 * Provenance sources that represent an explicit user choice; a fact carrying
 * one is never overwritten by learning (same contract as window-learning).
 */
const USER_OWNED_SOURCES = new Set(["first_run", "profile_save"]);

/**
 * Decide which derived classifications should actually be written, honouring
 * the user-override and idempotency invariants. Returns `null` when nothing
 * should change, so periodic callers converge and stop writing.
 */
export function resolveScheduleStylePatch(
  current: OwnerFacts,
  derived: {
    scheduleStyle: OwnerScheduleStyle | null;
    chronotype: OwnerChronotype | null;
  },
): OwnerFactsPatch | null {
  const patch: OwnerFactsPatch = {};

  if (derived.scheduleStyle !== null) {
    const existing = current.scheduleStyle;
    const userOwned =
      existing !== undefined &&
      USER_OWNED_SOURCES.has(existing.provenance.source);
    if (!userOwned && existing?.value !== derived.scheduleStyle) {
      patch.scheduleStyle = derived.scheduleStyle;
    }
  }

  if (derived.chronotype !== null) {
    const existing = current.chronotype;
    const userOwned =
      existing !== undefined &&
      USER_OWNED_SOURCES.has(existing.provenance.source);
    if (!userOwned && existing?.value !== derived.chronotype) {
      patch.chronotype = derived.chronotype;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
