/**
 * Pure decision helper for the stretch reminder dispatch loop.
 *
 * The runtime's reminder loop already handles channel selection, quiet
 * hours, and activity gating. This helper layers in stretch-specific
 * pacing rules so the dispatch site can ask one question — "should the
 * stretch nudge fire right now?" — without re-deriving the same logic
 * inline next to every other reminder type.
 *
 * The rules encoded here:
 *   - Honor the configured cadence: don't fire twice inside the same
 *     interval window. Default is 6 hours (matches `seed-routines.ts`).
 *   - If the user went outside / took a walk after the last stretch,
 *     reset the cooldown — the body movement covered what stretching
 *     would have provided.
 *   - Skip stretch nudges entirely on busy days. Stretch is soft
 *     self-care; on packed days the user does not want a low-priority
 *     ping competing with meeting traffic.
 *   - Skip late-evening fires (>= 21:00 local) — by then the user is
 *     winding down and another stretch ping is just noise.
 *   - Skip weekends. Stretch nudges target sedentary work patterns;
 *     weekends usually break that pattern naturally.
 *
 * This module deliberately takes plain primitives rather than the
 * runtime's `LifeOpsAttentionContext` so the same logic can be unit
 * tested without standing up the full reminder service.
 */

const DEFAULT_STRETCH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const LATE_EVENING_HOUR = 21;
const SUNDAY = 0;
const SATURDAY = 6;

export interface ShouldStretchNowInput {
  /** Current epoch milliseconds. */
  nowMs: number;
  /** Epoch ms of the last delivered stretch nudge, or null if never. */
  lastStretchMs: number | null;
  /**
   * Epoch ms of the most recent "user went outside / took a walk"
   * signal, or null if the activity profile cannot tell. When this is
   * more recent than `lastStretchMs`, the stretch cooldown resets so we
   * do not double-nudge a user who just got fresh body movement.
   */
  lastWalkOutMs: number | null;
  /**
   * Caller-computed busy-day verdict. Stretch is soft self-care and
   * should never compete with calendar-busy or screen-busy days.
   */
  isBusyDay: boolean;
  /** Local day-of-week, 0 (Sunday) through 6 (Saturday). */
  dayOfWeek: number;
  /** Local hour-of-day, 0–23. Used for the late-evening cutoff. */
  hourOfDay: number;
  /**
   * Optional override of the inter-fire cooldown. Defaults to
   * `DEFAULT_STRETCH_INTERVAL_MS` (6h) which matches the routine seed.
   */
  intervalMs?: number;
}

export interface ShouldStretchNowResult {
  shouldFire: boolean;
  reason: string;
}

export function shouldStretchNow(
  input: ShouldStretchNowInput,
): ShouldStretchNowResult {
  const intervalMs = input.intervalMs ?? DEFAULT_STRETCH_INTERVAL_MS;

  if (input.dayOfWeek === SATURDAY || input.dayOfWeek === SUNDAY) {
    return { shouldFire: false, reason: "weekend_skip" };
  }

  if (input.isBusyDay) {
    return { shouldFire: false, reason: "busy_day_skip" };
  }

  if (input.hourOfDay >= LATE_EVENING_HOUR) {
    return { shouldFire: false, reason: "late_evening_skip" };
  }

  // The walk-out reset takes precedence: if we know the user went
  // outside more recently than the last stretch fire, treat that as
  // satisfying the stretch goal and rearm the cadence from the walk.
  const effectiveAnchorMs =
    input.lastWalkOutMs !== null &&
    (input.lastStretchMs === null || input.lastWalkOutMs > input.lastStretchMs)
      ? input.lastWalkOutMs
      : input.lastStretchMs;

  if (effectiveAnchorMs === null) {
    return { shouldFire: true, reason: "first_fire" };
  }

  const elapsedMs = input.nowMs - effectiveAnchorMs;
  if (elapsedMs >= intervalMs) {
    const anchor =
      effectiveAnchorMs === input.lastWalkOutMs
        ? "walk_reset"
        : "interval_elapsed";
    return { shouldFire: true, reason: anchor };
  }

  return { shouldFire: false, reason: "within_cooldown" };
}

/**
 * Natural-sounding stretch reminder copy variants. The dispatch site
 * picks one deterministically (e.g. day-of-year mod count) so a given
 * day always produces the same nudge — useful for tests and for not
 * spamming the user with two visibly different copies in the same
 * window if a backfill fires later.
 */
export const STRETCH_REMINDER_VARIANTS: readonly string[] = [
  "Quick stretch break — roll your shoulders, open your hips, breathe out the tension.",
  "Stand up for a sec. A slow neck roll and a deep breath go a long way right now.",
  "Time to unkink. Hands overhead, gentle side bend, then the other side.",
  "Reset moment — step away from the screen for a minute and stretch out your back.",
  "Body check: shoulders relaxed? Jaw soft? Take 60 seconds to loosen up.",
];

export interface StretchReminderCopyInput {
  /** Local day-of-year (1–366) used as the deterministic rotation key. */
  dayOfYear: number;
}

export function pickStretchReminderCopy(
  input: StretchReminderCopyInput,
): string {
  const length = STRETCH_REMINDER_VARIANTS.length;
  const day = Math.trunc(input.dayOfYear);
  // Branchless positive modulo so negative day-of-year inputs (which
  // shouldn't happen in practice) still land on a real index.
  const safeIndex = ((day % length) + length) % length;
  const variant = STRETCH_REMINDER_VARIANTS[safeIndex];
  if (variant === undefined) {
    // Unreachable: STRETCH_REMINDER_VARIANTS is a non-empty literal.
    throw new Error("STRETCH_REMINDER_VARIANTS is empty");
  }
  return variant;
}
