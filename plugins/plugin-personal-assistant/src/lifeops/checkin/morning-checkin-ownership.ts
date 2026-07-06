/**
 * Explicit cross-engine ownership for the owner-visible morning check-in.
 *
 * The scheduled-task spine gets first claim because it is the one scheduler that
 * can consolidate wake.confirmed work and call the morning-brief assembler.
 * The sleep-cycle RemindersDomain remains a fallback only when no morning
 * check-in report exists for the local day; when the spine already assembled
 * one, this module makes that suppressed duplicate visible in ordinary logs.
 */
import { type IAgentRuntime, logger } from "@elizaos/core";

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

/**
 * Cross-engine ownership rule for the owner-visible morning check-in.
 *
 * The scheduled-task spine owns morning delivery because it is the single
 * scheduler that already consolidates wake.confirmed records and invokes the
 * morning-brief assembler. The sleep-cycle RemindersDomain may still own night
 * check-ins, but it must not race the spine for the morning surface.
 */
export function shouldSuppressSleepCycleMorningCheckin(): boolean {
  return true;
}

export function reportSuppressedSleepCycleMorningCheckin(
  _runtime: IAgentRuntime,
  context: SleepCycleMorningCheckinSuppressionContext,
): void {
  const metadata = {
    ...context,
    ownerEngine: MORNING_CHECKIN_OWNER_ENGINE,
    suppressedEngine: MORNING_CHECKIN_SUPPRESSED_ENGINE,
    deliveryBasis: "sleep_cycle",
  };
  logger.info(
    {
      src: "lifeops:morning-checkin-ownership",
      ...metadata,
    },
    "Suppressed duplicate sleep-cycle morning check-in; scheduled-task spine owns morning delivery.",
  );
}
