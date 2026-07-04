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
  /**
   * Observed wake-boundary hours (session start hours + health wake hours),
   * surfaced additively by the analyzer. When ≥2 samples are present the
   * morning span is LEARNED from their spread (IQR) instead of a fixed
   * default; absent/sparse falls back to {@link FALLBACK_MORNING_SPAN_HOURS}.
   */
  wakeHours?: number[];
  /**
   * Observed sleep-boundary hours (session end + health sleep hours). Drives
   * the learned evening span the same way; falls back to
   * {@link FALLBACK_EVENING_SPAN_HOURS} when sparse.
   */
  sleepHours?: number[];
}

/**
 * Provenance sources that represent an explicit user choice. A window carrying
 * one of these is treated as authoritative and never overwritten by learning.
 */
const USER_OWNED_SOURCES = new Set(["first_run", "profile_save"]);

/**
 * Clamp band for a LEARNED span. The span is the flexible band inside which a
 * `during_window` task may fire. A very-regular owner (IQR≈0) yields a tight
 * window (never 0 — that would invert); a scattered owner yields a wider, more
 * forgiving band, capped so it never swallows the whole day.
 */
const MIN_SPAN_HOURS = 1;
const MAX_SPAN_HOURS = 6;

/**
 * Morning-window fallback span, used ONLY when there is no observed
 * distribution to learn from (<2 samples). Preserves the historical
 * `wake → wake + 3h` behaviour for back-compat.
 */
const FALLBACK_MORNING_SPAN_HOURS = 3;

/**
 * Evening-window fallback span: `[sleep - 2h, sleep)`. The band closes at the
 * observed sleep hour so a `during_window: "evening"` task lands before the
 * user winds down. Used only when there is no distribution to learn from.
 */
const FALLBACK_EVENING_SPAN_HOURS = 2;

/**
 * Linear-interpolated percentile of an ascending numeric sample (`p` in
 * `[0,1]`). Matches the robust-spread definition proven in the D1 prototype.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  if (sortedAsc.length === 1) return sortedAsc[0] as number;
  const idx = p * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return (
    (sortedAsc[lo] as number) +
    ((sortedAsc[hi] as number) - (sortedAsc[lo] as number)) * frac
  );
}

/**
 * Learn a span from the observed active-band width. Uses the inter-quartile
 * range (p75 − p25) as a robust "width of the band", clamped to
 * `[MIN_SPAN_HOURS, MAX_SPAN_HOURS]`. Needs ≥2 finite samples to have a spread;
 * otherwise returns the supplied fallback (back-compat with the fixed spans).
 */
function deriveSpanHours(
  hours: number[] | undefined,
  fallbackSpan: number,
): number {
  const clean = (hours ?? [])
    .filter((h) => Number.isFinite(h))
    .sort((a, b) => a - b);
  if (clean.length < 2) return fallbackSpan;
  const iqr = percentile(clean, 0.75) - percentile(clean, 0.25);
  if (!Number.isFinite(iqr)) return fallbackSpan;
  return Math.min(MAX_SPAN_HOURS, Math.max(MIN_SPAN_HOURS, iqr));
}

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
 * no store access, no clock. The band WIDTH is learned from the observed
 * activity distribution (IQR of the wake/sleep samples, clamped to
 * `[MIN_SPAN_HOURS, MAX_SPAN_HOURS]`) when ≥2 samples exist, and falls back to
 * the historical fixed spans otherwise. Returns only the windows the sample can
 * support AND that resolve to a valid (non-inverted) `during_window` band — an
 * edge chronotype whose derived band would wrap past midnight is skipped, never
 * written as an unsatisfiable window (the resolver has no wraparound; the
 * clamped span keeps this guard intact for every chronotype).
 */
export function deriveWindowsFromRhythm(sample: RhythmSample): LearnedWindows {
  const result: LearnedWindows = {};

  if (
    typeof sample.typicalWakeHour === "number" &&
    Number.isFinite(sample.typicalWakeHour)
  ) {
    const span = deriveSpanHours(sample.wakeHours, FALLBACK_MORNING_SPAN_HOURS);
    const morning = validSameDayWindow(
      sample.typicalWakeHour,
      sample.typicalWakeHour + span,
    );
    if (morning) result.morningWindow = morning;
  }

  if (
    typeof sample.typicalSleepHour === "number" &&
    Number.isFinite(sample.typicalSleepHour)
  ) {
    const span = deriveSpanHours(
      sample.sleepHours,
      FALLBACK_EVENING_SPAN_HOURS,
    );
    const evening = validSameDayWindow(
      sample.typicalSleepHour - span,
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
