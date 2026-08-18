/**
 * Resolves owner-configured daily scheduling windows into validated minute
 * bounds and non-overlapping active segments. Missing values use the scheduling
 * defaults; present empty or malformed values are rejected by the canonical
 * local-time parser so due checks and indexing cannot disagree about a window.
 */

import { parseLocalHHMM } from "./local-time.js";
import type { OwnerFactsView } from "./types.js";

export interface OwnerWindowBoundsMinutes {
  morningStart: number;
  morningEnd: number;
  eveningStart: number;
  eveningEnd: number;
}

export interface OwnerWindowSegment {
  name: "morning" | "afternoon" | "evening" | "night";
  start: number;
  end: number;
}

const DEFAULT_WINDOW_BOUNDS: OwnerWindowBoundsMinutes = {
  morningStart: 6 * 60,
  morningEnd: 11 * 60,
  eveningStart: 18 * 60,
  eveningEnd: 22 * 60,
};

export function resolveOwnerWindowBoundsMinutes(
  ownerFacts: OwnerFactsView,
): OwnerWindowBoundsMinutes {
  const bounds = {
    morningStart:
      parseLocalHHMM(ownerFacts.morningWindow?.start) ??
      DEFAULT_WINDOW_BOUNDS.morningStart,
    morningEnd:
      parseLocalHHMM(ownerFacts.morningWindow?.end) ??
      DEFAULT_WINDOW_BOUNDS.morningEnd,
    eveningStart:
      parseLocalHHMM(ownerFacts.eveningWindow?.start) ??
      DEFAULT_WINDOW_BOUNDS.eveningStart,
    eveningEnd:
      parseLocalHHMM(ownerFacts.eveningWindow?.end) ??
      DEFAULT_WINDOW_BOUNDS.eveningEnd,
  };
  // An owner window whose end equals its start is invalid: it is ambiguous
  // between "zero minutes" and "the full 24 hours", and either reading makes
  // during_window tasks misbehave. Treat it like a malformed value and fall
  // back to that window's defaults. `end < start` is NOT degenerate — it is a
  // window wrapping past midnight, split into two segments by the consumers.
  if (bounds.morningStart === bounds.morningEnd) {
    bounds.morningStart = DEFAULT_WINDOW_BOUNDS.morningStart;
    bounds.morningEnd = DEFAULT_WINDOW_BOUNDS.morningEnd;
  }
  if (bounds.eveningStart === bounds.eveningEnd) {
    bounds.eveningStart = DEFAULT_WINDOW_BOUNDS.eveningStart;
    bounds.eveningEnd = DEFAULT_WINDOW_BOUNDS.eveningEnd;
  }
  return bounds;
}

function cyclicSegments(
  name: OwnerWindowSegment["name"],
  start: number,
  end: number,
): OwnerWindowSegment[] {
  if (end === start) return [];
  if (end > start) return [{ name, start, end }];
  return [
    { name, start, end: 24 * 60 },
    { name, start: 0, end },
  ];
}

function segmentsOverlap(
  left: OwnerWindowSegment,
  right: OwnerWindowSegment,
): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * Resolves a named daily window into non-wrapping minute segments. Explicit
 * owner windows may wrap midnight. Derived afternoon/night gaps are retained
 * only when they do not overlap either explicit window; this prevents an
 * overlapping or contained owner configuration from turning a nominal gap
 * into an almost-all-day active period.
 */
export function resolveOwnerWindowSegments(
  windowKey: string,
  ownerFacts: OwnerFactsView,
): OwnerWindowSegment[] {
  const { morningStart, morningEnd, eveningStart, eveningEnd } =
    resolveOwnerWindowBoundsMinutes(ownerFacts);
  const morning = cyclicSegments("morning", morningStart, morningEnd);
  const evening = cyclicSegments("evening", eveningStart, eveningEnd);
  const explicit = [...morning, ...evening];
  const derivedGap = (
    name: "afternoon" | "night",
    start: number,
    end: number,
  ): OwnerWindowSegment[] => {
    const candidate = cyclicSegments(name, start, end);
    return candidate.some((segment) =>
      explicit.some((ownerSegment) => segmentsOverlap(segment, ownerSegment)),
    )
      ? []
      : candidate;
  };
  const afternoon = derivedGap("afternoon", morningEnd, eveningStart);
  const night = derivedGap("night", eveningEnd, morningStart);
  const windows: Record<string, OwnerWindowSegment[]> = {
    morning,
    afternoon,
    evening,
    night,
    morning_or_night: [...morning, ...night],
    morning_or_evening: [...morning, ...evening],
  };
  return windows[windowKey] ?? [];
}

export function formatLocalHHMM(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
