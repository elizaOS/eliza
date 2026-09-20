/**
 * Converts the public task due-time field to and from its canonical SQL metadata representation.
 *
 * Storage holds `metadata.scheduledAt` as the millisecond ISO-8601 UTC instant that
 * `Date#toISOString` produces. Every adapter write path must pass caller-authored
 * metadata through `taskMetadataForWrite` or `taskMetadataPatchForWrite`, which accept
 * any unambiguous ISO-8601 date-time (an explicit `Z` or `±HH:MM` offset is required)
 * and canonicalise it; anything else is rejected so the stored value can never be an
 * engine-specific `Date.parse` guess. Reads accept the same grammar so rows written
 * before the write guards existed still resolve to a due time.
 */

import { ElizaError, type TaskMetadata, type TaskMetadataPatch } from "@elizaos/core";

export class TaskTimingValidationError extends ElizaError {
  constructor(message: string) {
    super(message, { code: "TASK_TIMING_INVALID" });
  }
}

export const TASK_SCHEDULED_AT_FORMAT_MESSAGE =
  "task metadata.scheduledAt must be an ISO-8601 date-time with an explicit UTC offset, canonically YYYY-MM-DDTHH:MM:SS.mmmZ";

const ISO_DATE_TIME_WITH_OFFSET =
  /^(?<year>\d{4}|[+-]\d{6})-(?<month>\d{2})-(?<day>\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function safeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new TaskTimingValidationError(`${label} must be a safe integer millisecond timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TaskTimingValidationError(`${label} is outside the supported date range`);
  }
  return value;
}

/**
 * Parses an ISO-8601 date-time that carries an explicit offset. `Date.parse` silently
 * rolls an overflowing calendar day into the next month, so the date part is checked
 * against the calendar before the engine parse is trusted.
 */
function parseScheduledAtString(value: string): number {
  const match = ISO_DATE_TIME_WITH_OFFSET.exec(value);
  if (!match?.groups) {
    throw new TaskTimingValidationError(TASK_SCHEDULED_AT_FORMAT_MESSAGE);
  }
  const year = Number(match.groups.year);
  const month = Number(match.groups.month);
  const day = Number(match.groups.day);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new TaskTimingValidationError(
      "task metadata.scheduledAt names a non-existent calendar day"
    );
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new TaskTimingValidationError(TASK_SCHEDULED_AT_FORMAT_MESSAGE);
  }
  return safeTimestamp(parsed, "task metadata.scheduledAt");
}

export function serializeTaskDueAt(dueAt: number | bigint): string {
  if (
    typeof dueAt === "bigint" &&
    (dueAt < BigInt(Number.MIN_SAFE_INTEGER) || dueAt > BigInt(Number.MAX_SAFE_INTEGER))
  ) {
    throw new TaskTimingValidationError("task dueAt must be a safe integer millisecond timestamp");
  }
  const numeric = typeof dueAt === "bigint" ? Number(dueAt) : dueAt;
  return new Date(safeTimestamp(numeric, "task dueAt")).toISOString();
}

/** Canonicalise a caller-authored `scheduledAt` value to the stored millisecond form. */
export function canonicalizeTaskScheduledAt(scheduledAt: unknown): string {
  if (typeof scheduledAt === "number") {
    return new Date(safeTimestamp(scheduledAt, "task metadata.scheduledAt")).toISOString();
  }
  if (typeof scheduledAt !== "string") {
    throw new TaskTimingValidationError(TASK_SCHEDULED_AT_FORMAT_MESSAGE);
  }
  return new Date(parseScheduledAtString(scheduledAt)).toISOString();
}

/** Build caller-authored metadata before retry admission, preserving explicit clear semantics. */
export function taskMetadataForWrite(
  metadata: TaskMetadata | undefined,
  dueAt: number | bigint | null | undefined
): TaskMetadata {
  const result: TaskMetadata = { ...(metadata || {}) };
  if (dueAt === null) {
    delete result.scheduledAt;
  } else if (dueAt !== undefined) {
    result.scheduledAt = serializeTaskDueAt(dueAt);
  } else if (result.scheduledAt !== undefined) {
    result.scheduledAt = canonicalizeTaskScheduledAt(result.scheduledAt);
  }
  return result;
}

/**
 * Canonicalise the `scheduledAt` key of a metadata patch before it is merged in
 * storage, so a key-level patch obeys the same contract as a whole-object write.
 * An `undefined` value is left alone because `JSON.stringify` drops it from the merge.
 */
export function taskMetadataPatchForWrite(patch: TaskMetadataPatch): TaskMetadataPatch {
  if (patch.set === undefined || patch.set.scheduledAt === undefined) return patch;
  return {
    ...patch,
    set: { ...patch.set, scheduledAt: canonicalizeTaskScheduledAt(patch.set.scheduledAt) },
  };
}

export function readTaskDueAt(metadata: TaskMetadata): number | undefined {
  const scheduledAt: unknown = metadata.scheduledAt;
  if (scheduledAt === undefined) return undefined;
  if (typeof scheduledAt === "number") {
    return safeTimestamp(scheduledAt, "task metadata.scheduledAt");
  }
  if (typeof scheduledAt !== "string") {
    throw new TaskTimingValidationError(TASK_SCHEDULED_AT_FORMAT_MESSAGE);
  }
  return parseScheduledAtString(scheduledAt);
}
