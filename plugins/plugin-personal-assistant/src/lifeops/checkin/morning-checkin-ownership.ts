/**
 * Log-side ownership record for the owner-visible morning check-in.
 *
 * Two engines can assemble the morning check-in: the scheduled-task spine
 * (wake.confirmed watcher delegating to the morning-brief assembler) and the
 * sleep-cycle RemindersDomain. Both persist through
 * `CheckinService.runMorningCheckin`, so the `life_checkin_reports` row is the
 * dedupe arbiter — whichever engine fires second sees `hasCheckinForLocalDay`
 * and skips. This module names the engines and makes the sleep-cycle skip
 * observable in ordinary logs; the skip itself lives with the report check in
 * `RemindersDomain` (and its spine-side twin in `runtime-wiring.ts`).
 */
import { logger } from "@elizaos/core";

export const MORNING_CHECKIN_OWNER_ENGINE = "scheduled-task-spine" as const;
export const MORNING_CHECKIN_SUPPRESSED_ENGINE =
  "reminders-domain-sleep-cycle" as const;
export interface SleepCycleMorningCheckinSuppressionContext {
  agentId: string;
  nowIso: string;
  timezone: string;
  circadianState?: string | null;
  wakeAt?: string | null;
}

export function reportSuppressedSleepCycleMorningCheckin(
  context: SleepCycleMorningCheckinSuppressionContext,
): void {
  logger.info(
    {
      src: "lifeops:morning-checkin-ownership",
      ...context,
      ownerEngine: MORNING_CHECKIN_OWNER_ENGINE,
      suppressedEngine: MORNING_CHECKIN_SUPPRESSED_ENGINE,
      deliveryBasis: "sleep_cycle",
    },
    "Suppressed duplicate sleep-cycle morning check-in; scheduled-task spine owns morning delivery.",
  );
}
