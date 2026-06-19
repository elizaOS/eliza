import type { LifeOpsReminderStep } from "@elizaos/shared";

export const GOOGLE_PRIMARY_CALENDAR_ID = "primary";
export const DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS = 30;

export const GOOGLE_GMAIL_READ_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";

export const DEFAULT_CALENDAR_REMINDER_STEPS: LifeOpsReminderStep[] = [
  {
    channel: "in_app",
    offsetMinutes: 30,
    label: "30m before event",
  },
];

export const CALENDAR_TIME_ZONE_ALIASES: Record<string, string> = {
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  pt: "America/Los_Angeles",
  pacific: "America/Los_Angeles",
  mst: "America/Denver",
  mdt: "America/Denver",
  mt: "America/Denver",
  mountain: "America/Denver",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  ct: "America/Chicago",
  central: "America/Chicago",
  est: "America/New_York",
  edt: "America/New_York",
  et: "America/New_York",
  eastern: "America/New_York",
  utc: "UTC",
  gmt: "UTC",
};

export function resolveDefaultTimeZone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved && resolved.trim().length > 0 ? resolved : "UTC";
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
