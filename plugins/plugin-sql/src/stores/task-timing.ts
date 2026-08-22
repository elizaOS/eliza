/** Converts the public task due-time field to and from its canonical SQL metadata representation. */

import type { TaskMetadata } from "@elizaos/core";

export class TaskTimingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskTimingValidationError";
  }
}

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
  const numeric = typeof dueAt === "bigint" ? Number(dueAt) : dueAt;
  return new Date(safeTimestamp(numeric, "task dueAt")).toISOString();
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
  const parsed = Date.parse(scheduledAt);
  if (Number.isNaN(parsed)) {
    throw new TaskTimingValidationError("task metadata.scheduledAt must be an ISO-8601 string");
  }
  return safeTimestamp(parsed, "task metadata.scheduledAt");
}
