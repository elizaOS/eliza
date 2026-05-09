/**
 * Sleep recap surfaced to the night-summary check-in prompt.
 *
 * Originally defined in `app-lifeops/src/lifeops/checkin/types.ts`. Moved
 * here in Wave-1 (W1-B) because it is sleep-domain. app-lifeops re-exports
 * `SleepRecap` from its old location for backward compatibility.
 */

import type { LifeOpsRegularityClass } from "@elizaos/shared";

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
