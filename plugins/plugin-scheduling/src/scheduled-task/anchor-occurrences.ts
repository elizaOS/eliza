/**
 * Candidate occurrences of a `relative_to_anchor` trigger, shared by the due
 * evaluation and the `next_fire_at` index so both name the same instant.
 *
 * A wall-clock anchor (wake, bedtime, lunch) recurs once per owner-local day,
 * but `anchor + offsetMinutes` can land on a different local day than its
 * anchor: wake 21:00 + 240 is 01:00 the next day, wake 06:00 - 480 is 22:00
 * the day before. Resolving only today's anchor leaves such a task perpetually
 * pending or fires it a day off, so the anchor is resolved for every local day
 * whose occurrence can land on yesterday, today or tomorrow.
 *
 * Selection: the due occurrence is the latest one at or before `now` that lies
 * on the owner's current local day. Occurrences on an earlier local day are
 * never replayed, the staleness bound the single-day resolution implied, and
 * a `firedAt` at or after the occurrence marks it spent. A fixed-instant
 * anchor (a calendar event start) has one occurrence, not one per day; it
 * stays due until fired even after the day rolls over, so an occurrence the
 * runner missed across midnight still fires once. The index candidate is the
 * unfired due occurrence when there is one, else the earliest occurrence
 * after `now`.
 *
 * Registry anchors are asked about adjacent days through `AnchorContext.nowIso`
 * placed at the last instant of an earlier day or the first instant of a later
 * one; an observed anchor answers with that day's latest observation or null,
 * and the static owner-fact anchor fills the gap.
 */

import type { AnchorRegistry } from "../anchors/anchor-registry.js";
import { resolveLocalHHMMToIso } from "./local-time.js";
import { isRepresentableMs } from "./time-range.js";
import type { OwnerFactsView, ScheduledTaskTrigger } from "./types.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/**
 * Local days evaluated relative to the day whose occurrence lands on today:
 * the day before it, the day itself, and two after so the earliest future
 * occurrence is present even when a DST shift pulls tomorrow's back onto
 * today.
 */
const DAY_SPAN: readonly number[] = [-1, 0, 1, 2];

type RelativeToAnchorTrigger = Extract<
  ScheduledTaskTrigger,
  { kind: "relative_to_anchor" }
>;

export interface AnchorOccurrenceContext {
  now: Date;
  ownerFacts: OwnerFactsView;
  anchors: AnchorRegistry | null | undefined;
  /** `state.firedAt` of the task; marks the due occurrence spent. */
  firedAtIso: string | undefined;
}

export type AnchorOccurrences =
  | { kind: "unresolved" }
  | { kind: "out_of_range" }
  | {
      kind: "resolved";
      /** Latest occurrence at or before `now` on the current local day. */
      currentMs: number | null;
      /** True when `firedAt` is at or after `currentMs`. */
      currentFired: boolean;
      /** Earliest occurrence after `now`. */
      nextMs: number | null;
    };

function parseIsoMs(value: string | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function staticAnchorIso(
  trigger: RelativeToAnchorTrigger,
  now: Date,
  ownerFacts: OwnerFactsView,
  timeZone: string,
  dayOffset: number,
): string | null {
  switch (trigger.anchorKey) {
    case "wake.confirmed":
    case "wake.observed":
    case "morning.start":
      return resolveLocalHHMMToIso(
        now,
        ownerFacts.morningWindow?.start,
        timeZone,
        dayOffset,
      );
    case "bedtime.target":
      return (
        resolveLocalHHMMToIso(
          now,
          ownerFacts.eveningWindow?.end,
          timeZone,
          dayOffset,
        ) ?? resolveLocalHHMMToIso(now, "22:30", timeZone, dayOffset)
      );
    case "night.start":
      return resolveLocalHHMMToIso(
        now,
        ownerFacts.eveningWindow?.start,
        timeZone,
        dayOffset,
      );
    case "lunch.start":
      return resolveLocalHHMMToIso(now, "12:00", timeZone, dayOffset);
    default:
      return null;
  }
}

/**
 * Reference instant handed to a registry anchor for local day `dayOffset`:
 * `now` for today, the last instant of that day for earlier days, its first
 * instant for later days. Both edges are derived from resolved local midnights
 * so DST gaps or repeats at midnight still land inside the intended day.
 */
function registryProbeMs(
  now: Date,
  timeZone: string,
  dayOffset: number,
): number | null {
  if (dayOffset === 0) return now.getTime();
  const edgeDay = dayOffset < 0 ? dayOffset + 1 : dayOffset;
  const midnightMs = parseIsoMs(
    resolveLocalHHMMToIso(now, "00:00", timeZone, edgeDay),
  );
  if (midnightMs === null) return null;
  return dayOffset < 0 ? midnightMs - 1 : midnightMs;
}

async function registryAnchorMs(
  trigger: RelativeToAnchorTrigger,
  context: AnchorOccurrenceContext,
  probeMs: number,
): Promise<number | null> {
  const contribution = context.anchors?.get(trigger.anchorKey) ?? null;
  if (contribution === null) return null;
  const resolved = await contribution.resolve({
    nowIso: new Date(probeMs).toISOString(),
    ownerFacts: context.ownerFacts,
  });
  return resolved === null ? null : parseIsoMs(resolved.atIso);
}

export async function resolveAnchorOccurrences(
  trigger: RelativeToAnchorTrigger,
  context: AnchorOccurrenceContext,
): Promise<AnchorOccurrences> {
  const { now, ownerFacts } = context;
  const timeZone = ownerFacts.timezone ?? "UTC";
  const nowMs = now.getTime();
  const offsetMs = trigger.offsetMinutes * MINUTE_MS;

  const anchorForDay = async (dayOffset: number): Promise<number | null> => {
    const probeMs = registryProbeMs(now, timeZone, dayOffset);
    if (probeMs === null) return null;
    const fromRegistry = await registryAnchorMs(trigger, context, probeMs);
    if (fromRegistry !== null) return fromRegistry;
    return parseIsoMs(
      staticAnchorIso(trigger, now, ownerFacts, timeZone, dayOffset),
    );
  };

  const baseAnchorMs = await anchorForDay(0);
  if (baseAnchorMs === null) return { kind: "unresolved" };
  // `offsetMinutes` is only schema-bounded to an integer. Every instant this
  // scan touches lies within a few days of `now ± offset`; an offset that
  // pushes that reach outside the Date range cannot be indexed or fired, and
  // must not surface as an Intl RangeError from the local-day math.
  const reachMs = Math.abs(offsetMs) + DAY_SPAN.length * DAY_MS;
  if (
    !isRepresentableMs(nowMs + reachMs) ||
    !isRepresentableMs(nowMs - reachMs) ||
    !isRepresentableMs(baseAnchorMs + offsetMs)
  ) {
    return { kind: "out_of_range" };
  }
  const todayStartMs = parseIsoMs(
    resolveLocalHHMMToIso(now, "00:00", timeZone, 0),
  );
  if (todayStartMs === null) return { kind: "unresolved" };

  // The local day whose anchor plus offset lands on today, measured from
  // today's anchor. DST makes a day 23 or 25 hours long, which the ±1 day
  // slack in DAY_SPAN absorbs.
  const landingDayShift = Math.floor(
    (baseAnchorMs - todayStartMs + offsetMs) / DAY_MS,
  );
  const occurrences = new Set<number>();
  for (const delta of DAY_SPAN) {
    const dayOffset = delta - landingDayShift;
    const anchorMs =
      dayOffset === 0 ? baseAnchorMs : await anchorForDay(dayOffset);
    if (anchorMs === null) continue;
    const occurrenceMs = anchorMs + offsetMs;
    if (isRepresentableMs(occurrenceMs)) occurrences.add(occurrenceMs);
  }

  // Every day probe resolving to the same instant means the anchor is a
  // fixed instant, not a daily wall-clock time; its single occurrence has no
  // successor to supersede it, so the current-local-day bound does not apply.
  const fixedInstant = occurrences.size === 1;
  let currentMs: number | null = null;
  let nextMs: number | null = null;
  for (const occurrenceMs of [...occurrences].sort(
    (left, right) => left - right,
  )) {
    if (occurrenceMs > nowMs) {
      nextMs = occurrenceMs;
      break;
    }
    if (fixedInstant || occurrenceMs >= todayStartMs) currentMs = occurrenceMs;
  }
  const firedAtMs = parseIsoMs(context.firedAtIso);
  const currentFired =
    currentMs !== null && firedAtMs !== null && firedAtMs >= currentMs;
  return { kind: "resolved", currentMs, currentFired, nextMs };
}
