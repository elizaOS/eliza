/**
 * Pure reminder-intensity → no-reply-policy transform (#12284 D3).
 *
 * The owner's `reminderIntensity` fact shapes how persistently the tick-driven
 * no-reply loop re-nudges when the owner does not reply. This is the structural
 * equivalent, on the ScheduledTask spine, of `applyReminderIntensityToPlan`
 * (which shapes the legacy reminder-plan steps): the initial fire always
 * happens; intensity only reshapes the *follow-up* ladder.
 *
 * Kept as a standalone pure function so it is unit-testable without booting the
 * scheduler's runtime graph. `scheduler.ts` calls it against the default
 * per-kind policy before merging any explicit per-task `metadata.noReplyPolicy`
 * override (which still wins).
 */
import type { ReminderIntensity } from "../owner/fact-store.js";

/** The subset of a no-reply policy that reminder intensity reshapes. */
export interface NoReplyLadder {
  maxRetries: number;
  retryCadenceMinutes: number[];
}

type TaskPriority = "low" | "medium" | "high";

/**
 * Reshape a no-reply follow-up ladder by the owner's reminder intensity.
 *
 *  - `minimal`: fire once, never re-nudge (drop all retries).
 *  - `persistent`: one extra nudge at the same trailing cadence (mirrors the
 *    legacy plan's appended in-app follow-up).
 *  - `high_priority_only`: only high-priority tasks keep their nudges;
 *    everything else fires once.
 *  - `normal` / unset: unchanged.
 */
export function applyReminderIntensityToNoReplyPolicy<T extends NoReplyLadder>(
  policy: T,
  intensity: ReminderIntensity | undefined,
  priority: TaskPriority,
): T {
  switch (intensity) {
    case "minimal":
      return { ...policy, maxRetries: 0, retryCadenceMinutes: [] };
    case "high_priority_only":
      return priority === "high"
        ? policy
        : { ...policy, maxRetries: 0, retryCadenceMinutes: [] };
    case "persistent": {
      const cadence = policy.retryCadenceMinutes;
      const trailing = cadence.length > 0 ? cadence[cadence.length - 1] : 60;
      return {
        ...policy,
        maxRetries: policy.maxRetries + 1,
        retryCadenceMinutes: [...cadence, trailing],
      };
    }
    default:
      return policy;
  }
}
