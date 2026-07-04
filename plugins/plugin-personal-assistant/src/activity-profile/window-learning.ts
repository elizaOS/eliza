/**
 * ActivityProfile → OwnerFacts learning writer (issue #12186, D.2.1).
 *
 * Closes the observe→learn→schedule loop for flexible scheduling. The
 * `analyzer` computes `typicalWakeHour` / `typicalSleepHour` from observed
 * behaviour (messages + health sleep signals); this module maps those hours
 * into `OwnerFacts.morningWindow` / `eveningWindow` so `during_window` triggers
 * and `wake`/`bedtime` anchors track the user's real rhythm instead of a fixed
 * default.
 *
 * Two invariants make this safe to run on every profile rebuild:
 *   1. **User overrides win.** A window the user set in first-run or profile
 *      save (`provenance.source ∈ {first_run, profile_save}`) is never
 *      clobbered by learned data. Only defaults and previously-learned values
 *      (`connector_inferred` / `agent_inferred`) are updated.
 *   2. **Idempotent.** If the learned window equals the stored window, no write
 *      is issued — repeated runs converge and stop.
 *
 * The writer performs no scheduling and no prompt routing. It only patches
 * owner facts, which the existing structural trigger/anchor primitives read.
 */

import type {
  OwnerFacts,
  OwnerFactWindow,
} from "../lifeops/owner/fact-store.js";

/**
 * Windows derived from observed wake/sleep hours. Either field may be absent
 * when the profile has no signal for that boundary.
 */
export interface LearnedWindows {
  morningWindow?: OwnerFactWindow;
  eveningWindow?: OwnerFactWindow;
}

/** Minimal profile surface the mapping consumes. */
export interface RhythmSample {
  typicalWakeHour: number | null;
  typicalSleepHour: number | null;
}

/**
 * Provenance sources that represent an explicit user choice. A window carrying
 * one of these is treated as authoritative and never overwritten by learning.
 */
const USER_OWNED_SOURCES = new Set(["first_run", "profile_save"]);

/**
 * Morning window duration: from wake hour to `wake + MORNING_SPAN_HOURS`. The
 * span is the flexible band inside which a `during_window: "morning"` task may
 * fire, not a fixed instant.
 */
const MORNING_SPAN_HOURS = 3;

/**
 * Evening window: `[sleep - EVENING_LEAD_HOURS, sleep)`. The band closes at the
 * observed sleep hour so a `during_window: "evening"` task lands before the
 * user winds down, and starts a couple hours earlier so it stays flexible.
 */
const EVENING_LEAD_HOURS = 2;

function clampHour(hour: number): number {
  // Wrap into [0, 24). Sessions that end after midnight produce a
  // normalizedEndHour ≥ 24 in the analyzer; fold it back to a wall-clock hour.
  const wrapped = ((Math.round(hour) % 24) + 24) % 24;
  return wrapped;
}

function toHHMM(hour: number): string {
  const h = clampHour(hour);
  return `${String(h).padStart(2, "0")}:00`;
}

/**
 * Build a same-day `[startHour, endHour)` window, but ONLY when it is valid for
 * the plugin-scheduling `during_window` bounds resolver — which has NO
 * wraparound for morning/evening/afternoon (a segment is `[start, end)` matched
 * by `atMinutes >= start && atMinutes < end`). An inverted window
 * (`start >= end` after wrap-to-wall-clock) is unsatisfiable — it would
 * PERMANENTLY kill the trigger — so we decline to emit it rather than write a
 * window the reader can never satisfy. Returns `null` when invalid.
 */
function validSameDayWindow(
  startHour: number,
  endHour: number,
): OwnerFactWindow | null {
  const start = clampHour(startHour);
  const end = clampHour(endHour);
  if (start >= end) return null;
  return { startLocal: toHHMM(start), endLocal: toHHMM(end) };
}

/**
 * Map observed wake/sleep hours into flexible morning/evening windows. Pure:
 * no store access, no clock. Returns only the windows the sample can support
 * AND that resolve to a valid (non-inverted) `during_window` band — an edge
 * chronotype whose derived band would wrap past midnight is skipped, never
 * written as an unsatisfiable window.
 */
export function deriveWindowsFromRhythm(sample: RhythmSample): LearnedWindows {
  const result: LearnedWindows = {};

  if (
    typeof sample.typicalWakeHour === "number" &&
    Number.isFinite(sample.typicalWakeHour)
  ) {
    const morning = validSameDayWindow(
      sample.typicalWakeHour,
      sample.typicalWakeHour + MORNING_SPAN_HOURS,
    );
    if (morning) result.morningWindow = morning;
  }

  if (
    typeof sample.typicalSleepHour === "number" &&
    Number.isFinite(sample.typicalSleepHour)
  ) {
    const evening = validSameDayWindow(
      sample.typicalSleepHour - EVENING_LEAD_HOURS,
      sample.typicalSleepHour,
    );
    if (evening) result.eveningWindow = evening;
  }

  return result;
}

function windowsEqual(a: OwnerFactWindow, b: OwnerFactWindow): boolean {
  return a.startLocal === b.startLocal && a.endLocal === b.endLocal;
}

function isUserOwned(source: string | undefined): boolean {
  return source !== undefined && USER_OWNED_SOURCES.has(source);
}

/**
 * Decide which learned windows should actually be written, honouring the
 * user-override and idempotency invariants. Pure — the caller supplies the
 * current facts and the learned windows and applies the returned patch.
 *
 * Returns `null` when nothing should change (no writable delta).
 */
export function resolveWindowPatch(
  current: OwnerFacts,
  learned: LearnedWindows,
): { morningWindow?: OwnerFactWindow; eveningWindow?: OwnerFactWindow } | null {
  const patch: {
    morningWindow?: OwnerFactWindow;
    eveningWindow?: OwnerFactWindow;
  } = {};

  if (learned.morningWindow) {
    const existing = current.morningWindow;
    const userOwned = isUserOwned(existing?.provenance.source);
    const alreadyMatches =
      existing !== undefined &&
      windowsEqual(existing.value, learned.morningWindow);
    if (!userOwned && !alreadyMatches) {
      patch.morningWindow = learned.morningWindow;
    }
  }

  if (learned.eveningWindow) {
    const existing = current.eveningWindow;
    const userOwned = isUserOwned(existing?.provenance.source);
    const alreadyMatches =
      existing !== undefined &&
      windowsEqual(existing.value, learned.eveningWindow);
    if (!userOwned && !alreadyMatches) {
      patch.eveningWindow = learned.eveningWindow;
    }
  }

  if (patch.morningWindow === undefined && patch.eveningWindow === undefined) {
    return null;
  }
  return patch;
}
