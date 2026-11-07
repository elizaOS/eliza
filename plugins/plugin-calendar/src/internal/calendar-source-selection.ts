import { CalendarServiceError } from "./errors.js";
/** Merge only caller-supplied source IDs; never infer an account from a label. */
export function mergeCalendarSourceSelection(
  details: Record<string, unknown> | undefined,
  source: { grantId?: string; calendarId?: string },
): Record<string, unknown> {
  const result = { ...details };
  if (source.grantId === undefined) return result; // Preserve legacy calendarId-only calls.
  for (const field of ["grantId", "calendarId"] as const) {
    const value = source[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim())
      throw new CalendarServiceError(
        400,
        "Supply exact Calendar source identifiers.",
        "CALENDAR_SOURCE_INVALID",
      );
    if (result[field] !== undefined && result[field] !== value)
      throw new CalendarServiceError(
        400,
        "Calendar source identifiers disagree. Nothing was changed.",
        "CALENDAR_SOURCE_CONFLICT",
      );
    result[field] = value;
  }
  return result;
}
