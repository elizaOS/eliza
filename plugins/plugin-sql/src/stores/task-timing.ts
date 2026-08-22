/** Converts the public task due-time field to and from its canonical SQL metadata representation. */

import { ElizaError, type TaskMetadata } from "@elizaos/core";

export class TaskTimingValidationError extends ElizaError {
  constructor(message: string) {
    super(message, { code: "TASK_TIMING_INVALID" });
  }
}

const CANONICAL_ISO_INSTANT = /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

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
  } else {
    readTaskDueAt(result);
  }
  return result;
}

export function readTaskDueAt(metadata: TaskMetadata): number | undefined {
  const scheduledAt: unknown = metadata.scheduledAt;
  if (scheduledAt === undefined) return undefined;
  if (typeof scheduledAt === "number") {
    return safeTimestamp(scheduledAt, "task metadata.scheduledAt");
  }
  if (typeof scheduledAt !== "string" || scheduledAt.trim().length === 0) {
    throw new TaskTimingValidationError("task metadata.scheduledAt must be an ISO-8601 string");
  }
  if (!CANONICAL_ISO_INSTANT.test(scheduledAt)) {
    throw new TaskTimingValidationError("task metadata.scheduledAt must be an ISO-8601 string");
  }
  const parsed = safeTimestamp(Date.parse(scheduledAt), "task metadata.scheduledAt");
  if (new Date(parsed).toISOString() !== scheduledAt) {
    throw new TaskTimingValidationError(
      "task metadata.scheduledAt must be a canonical ISO-8601 instant"
    );
  }
  return parsed;
}
