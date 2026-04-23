import type { LifeOpsCircadianState } from "@elizaos/shared/contracts/lifeops";

export const MORNING_CHECKIN_WINDOW_MINUTES = 6 * 60;
export const NIGHT_CHECKIN_LEAD_MINUTES = 3 * 60;

export interface CheckinSleepCycleState {
  readonly circadianState: LifeOpsCircadianState;
  readonly wakeAt: string | null;
  readonly relativeTime: {
    readonly minutesUntilBedtimeTarget: number | null;
  };
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function shouldRunMorningCheckinFromSleepCycle(args: {
  readonly state: CheckinSleepCycleState | null;
  readonly now: Date;
}): boolean {
  if (!args.state || args.state.circadianState !== "awake") {
    return false;
  }
  const wakeAtMs = parseIsoMs(args.state.wakeAt);
  if (wakeAtMs === null) {
    return false;
  }
  const minutesSinceWake = (args.now.getTime() - wakeAtMs) / 60_000;
  return (
    minutesSinceWake >= 0 && minutesSinceWake <= MORNING_CHECKIN_WINDOW_MINUTES
  );
}

export function shouldRunNightCheckinFromSleepCycle(args: {
  readonly state: CheckinSleepCycleState | null;
}): boolean {
  if (
    !args.state ||
    (args.state.circadianState !== "awake" &&
      args.state.circadianState !== "waking")
  ) {
    return false;
  }
  const minutes = args.state.relativeTime.minutesUntilBedtimeTarget;
  return (
    typeof minutes === "number" &&
    Number.isFinite(minutes) &&
    minutes >= 0 &&
    minutes <= NIGHT_CHECKIN_LEAD_MINUTES
  );
}
