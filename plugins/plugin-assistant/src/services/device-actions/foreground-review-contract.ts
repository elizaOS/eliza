/**
 * Binds the shared @elizaos/contracts device-review contracts (free/busy reads, Notes
 * search, name-targeted edits) to this plugin's Notes, Calendar and reminder record
 * validators. A phone resolves each operation in a foreground local review; each family
 * requires its own negotiated capability.
 */
import {
  type CalendarAvailabilityResult,
  DEVICE_REVIEW_TYPES,
  type DeviceReviewOperation,
  deviceReviewCapabilityAvailable,
  isCalendarAvailabilityOperation,
  isDeviceReviewOperation,
  isDeviceReviewType,
  isNamedTargetOperation,
  isNotesSearchOperation,
  type NamedTargetResult,
  type NamedTargetValidators,
  type NotesSearchResult,
  validateCalendarAvailabilityOperation,
  validateCalendarAvailabilityResult,
  validateNamedTargetOperation,
  validateNamedTargetResult,
  validateNotesSearchOperation,
  validateNotesSearchResult,
} from "@elizaos/contracts";
import {
  type CalendarOperation,
  type CalendarRecordResult,
  calendarFields,
  isCalendarOperation,
  validateCalendarOperation,
  validateCalendarResult,
} from "./calendar-contract.ts";
import {
  isNotesOperation,
  type NotesOperation,
  type NotesResult,
  type NotesTarget,
  notesFields,
  validateNotesOperation,
  validateNotesResult,
} from "./notes-contract.ts";
import {
  isReminderOperation,
  REMINDER_TIMING_CAPABILITY,
  type ReminderOperation,
  type ReminderResult,
  reminderCapabilityAvailable,
  reminderFields,
  validateReminderOperation,
  validateReminderResult,
} from "./reminder-contract.ts";

export const FOREGROUND_REVIEW_TYPES = DEVICE_REVIEW_TYPES;
export type ForegroundReviewOperation = DeviceReviewOperation;
/** Exact selected-record operations (each carries the chosen record's target). */
export type NamedTargetExactOperation = Extract<
  NotesOperation | CalendarOperation | ReminderOperation,
  { target: unknown }
>;
type NamedRecord = NotesResult | CalendarRecordResult | ReminderResult;
export type ForegroundReviewResult =
  | CalendarAvailabilityResult
  | NotesSearchResult<NotesTarget, NotesResult>
  | NamedTargetResult<NamedTargetExactOperation, NamedRecord>;
export const isForegroundReviewType = isDeviceReviewType;
export const isForegroundReviewOperation = isDeviceReviewOperation;
export const foregroundReviewCapabilityAvailable =
  deviceReviewCapabilityAvailable;

/** Domain validators for name-targeted edits; the shared contract fixes the exact type. */
export const namedTargetValidators: NamedTargetValidators<
  NamedTargetExactOperation,
  NamedRecord
> = {
  notesFields,
  calendarFields,
  reminderFields,
  exact(value) {
    const exact = isNotesOperation(value)
      ? validateNotesOperation(value)
      : isCalendarOperation(value)
        ? validateCalendarOperation(value)
        : isReminderOperation(value)
          ? validateReminderOperation(value)
          : undefined;
    if (!exact || !("target" in exact))
      throw Error("Unsupported named target operation");
    return exact;
  },
  record(operation, value) {
    if (isNotesOperation(operation))
      return validateNotesResult(operation, value);
    if (isCalendarOperation(operation)) {
      const result = validateCalendarResult(operation, value);
      if (result.kind === "calendar_read_next")
        throw Error("Unexpected Calendar discovery result");
      return result;
    }
    return validateReminderResult(operation as ReminderOperation, value);
  },
};
export function selectedNotesRead(
  target: unknown,
  record: unknown,
): { target: NotesTarget; record: NotesResult } {
  const selected = validateNotesOperation({
    type: "notes_read_selected",
    target,
  });
  if (selected.type !== "notes_read_selected")
    throw Error("Invalid selected Notes read");
  return {
    target: selected.target,
    record: validateNotesResult(selected, record),
  };
}
export function validateForegroundReviewOperation(
  value: unknown,
): ForegroundReviewOperation {
  if (isCalendarAvailabilityOperation(value))
    return validateCalendarAvailabilityOperation(value);
  if (isNotesSearchOperation(value)) return validateNotesSearchOperation(value);
  if (isNamedTargetOperation(value))
    return validateNamedTargetOperation(value, namedTargetValidators);
  throw Error("Unsupported foreground review operation");
}
export function validateForegroundReviewResult(
  operation: ForegroundReviewOperation,
  value: unknown,
  capabilities?: readonly string[],
): ForegroundReviewResult {
  if (operation.type === "calendar_availability")
    return validateCalendarAvailabilityResult(operation, value);
  if (operation.type === "notes_search")
    return validateNotesSearchResult(operation, value, selectedNotesRead);
  const result = validateNamedTargetResult(
    operation,
    value,
    namedTargetValidators,
  );
  if (
    capabilities &&
    result.basis === "owner-chosen" &&
    isReminderOperation(result.operation) &&
    !reminderCapabilityAvailable(result.operation, capabilities)
  )
    throw Error("Reminder capability unavailable");
  return result;
}

/** Named proposals have no target yet, but timing fields still need a v2 peer. */
export function foregroundReviewOperationAvailable(
  operation: ForegroundReviewOperation,
  capabilities: readonly string[] | undefined,
): boolean {
  if (!foregroundReviewCapabilityAvailable(operation.type, capabilities))
    return false;
  return (
    operation.type !== "reminder_named" ||
    operation.action !== "update" ||
    reminderFields(operation.fields).schedule?.alertMinutes === undefined ||
    capabilities?.includes(REMINDER_TIMING_CAPABILITY) === true
  );
}
