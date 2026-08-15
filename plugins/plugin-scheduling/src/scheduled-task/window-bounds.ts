/**
 * Resolves owner-configured daily scheduling windows into validated minute
 * bounds. Missing values use the scheduling defaults; present empty or malformed values
 * are rejected by the canonical local-time parser so due checks and indexing
 * cannot disagree about a window.
 */

import { parseLocalHHMM } from "./local-time.js";
import type { OwnerFactsView } from "./types.js";

export interface OwnerWindowBoundsMinutes {
  morningStart: number;
  morningEnd: number;
  eveningStart: number;
  eveningEnd: number;
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
  return {
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
}

export function formatLocalHHMM(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
