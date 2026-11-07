/** Apply the host's request policy at the selected Calendar source boundary. */
import { actionGateRejection } from "@elizaos/core";
import { CalendarServiceError } from "./errors.js";

export function calendarRecordPolicyFailure(): string | undefined {
  // The umbrella's role gate remains authoritative. This descriptor probes
  // only request-scoped record ownership; it does not authorize an action.
  const rejection = actionGateRejection(
    { name: "CALENDAR", tags: ["resource:calendar-records"] },
    {},
  );
  return rejection?.kind === "context" ? rejection.reason : undefined;
}

export function assertCalendarRecordsAllowed(): void {
  const failure = calendarRecordPolicyFailure();
  if (failure)
    throw new CalendarServiceError(
      403,
      failure,
      "CALENDAR_NATIVE_RECORD_OWNERSHIP_REQUIRED",
    );
}
