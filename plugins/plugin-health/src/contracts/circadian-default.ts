/**
 * Default `CircadianInsightContract` registered by `plugin-health` during
 * `init`. Consumers (e.g. `app-lifeops` SCHEDULE / SCHEDULED_TASK) read
 * through this contract instead of importing plugin-health internals.
 *
 * The default implementation is intentionally conservative: it returns
 * `state=null` / `recommendedAtIso=null` until a richer impl is registered
 * (e.g. by app-lifeops once its scheduler tick produces a fresh insight).
 * This keeps the contract honest — callers can always tell whether
 * inference is calibrated, and never mistake an uninitialized field for a
 * meaningful zero.
 */

import type {
  CircadianInsightContract,
  SchedulingWindow,
  SleepWindow,
} from "./circadian.js";

export function createDefaultCircadianInsightContract(): CircadianInsightContract {
  return {
    async getCurrentSleepWindow(): Promise<SleepWindow> {
      return {
        state: null,
        confidence: 0,
        lastWakeAtIso: null,
        currentSleepStartedAtIso: null,
        bedtimeTargetAtIso: null,
      };
    },
    async inferOptimalSchedulingWindow(): Promise<SchedulingWindow> {
      return {
        recommendedAtIso: null,
        nextMealLabel: null,
        windowStartIso: null,
        windowEndIso: null,
        confidence: 0,
        reason: "circadian inference not calibrated",
      };
    },
    async getLatestInsight() {
      return null;
    },
  };
}
