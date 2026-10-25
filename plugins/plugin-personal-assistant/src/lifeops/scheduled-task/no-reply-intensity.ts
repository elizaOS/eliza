/**
 * Pure reminder-intensity → no-reply-policy transforms (#12284 D3 items 6+8).
 *
 * The owner's `reminderIntensity` fact shapes how persistently the tick-driven
 * no-reply loop re-nudges when the owner does not reply. This is the structural
 * equivalent, on the ScheduledTask spine, of `applyReminderIntensityToPlan`
 * (which shapes the legacy reminder-plan steps): the initial fire always
 * happens; intensity only reshapes the *follow-up* ladder.
 *
 * The quiet-streak softener lives here too so the quiet-user-watcher signal
 * modulates behavior through the SAME intensity lookup instead of a second
 * policy mechanism: a ≥3-day silent streak steps the effective intensity one
 * notch down, and the regular intensity table does the rest.
 *
 * Kept as standalone pure functions so they are unit-testable without booting
 * the scheduler's runtime graph. `scheduler.ts` calls them against the default
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

/**
 * Step the effective reminder intensity one notch DOWN for a quiet streak
 * (#12284 item 8): when the owner has ignored ≥3 consecutive check-ins, the
 * next no-reply ladder is selected as if the owner had asked for one level
 * less chasing — never a guilt-framed extra poke. `minimal` has no lower
 * notch, and `high_priority_only` already suppresses everything non-critical,
 * so both are fixed points. An unset intensity softens like `normal`.
 */
export function softenReminderIntensityForQuietStreak(
  intensity: ReminderIntensity | undefined,
): ReminderIntensity {
  switch (intensity) {
    case "persistent":
      return "normal";
    case "minimal":
      return "minimal";
    case "high_priority_only":
      return "high_priority_only";
    default:
      return "minimal";
  }
}
