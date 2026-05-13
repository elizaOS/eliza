/**
 * Sleep recap surfaced to the night-summary check-in prompt.
 *
 * Canonical home is this file (sleep-domain). app-lifeops re-exports
 * `SleepRecap` from its checkin types for backward compatibility.
 */

import type { LifeOpsRegularityClass } from "../contracts/health.js";

export interface SleepRecap {
  /** Local bedtime hour in [12, 36) (next-day-normalized). Null when baseline insufficient. */
  readonly medianBedtimeLocalHour: number | null;
  /** Median sleep episode duration in minutes. Null when baseline insufficient. */
  readonly medianSleepDurationMin: number | null;
  /** Sleep regularity index in [0, 100]. */
  readonly sri: number;
  /** Classification bucket from `classifyRegularity`. */
  readonly regularityClass: LifeOpsRegularityClass;
}
