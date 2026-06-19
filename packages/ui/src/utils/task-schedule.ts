/**
 * task-schedule — encode/decode the TaskEditor schedule onto the
 * `WorkbenchTask.tags` array. Lives in a React-free module so it can
 * be unit tested in the node vitest environment without dragging in
 * the entire UI bundle.
 */

export type TaskScheduleKind = "once" | "recurring" | "event";

const SCHEDULE_TAG_PREFIX = "schedule:";
const EVENT_TAG_PREFIX = "event:";

export function encodeScheduleTags(
  kind: TaskScheduleKind,
  cronExpression: string,
  eventName: string,
): string[] {
  if (kind === "recurring" && cronExpression.trim()) {
    return [`${SCHEDULE_TAG_PREFIX}${cronExpression.trim()}`];
  }
  if (kind === "event" && eventName.trim()) {
    return [`${EVENT_TAG_PREFIX}${eventName.trim()}`];
  }
  return [];
}

export function decodeScheduleTags(tags: ReadonlyArray<string> | undefined): {
  kind: TaskScheduleKind;
  cronExpression: string;
  eventName: string;
} {
  for (const tag of tags ?? []) {
    if (tag.startsWith(SCHEDULE_TAG_PREFIX)) {
      return {
        kind: "recurring",
        cronExpression: tag.slice(SCHEDULE_TAG_PREFIX.length),
        eventName: "",
      };
    }
    if (tag.startsWith(EVENT_TAG_PREFIX)) {
      return {
        kind: "event",
        cronExpression: "",
        eventName: tag.slice(EVENT_TAG_PREFIX.length),
      };
    }
  }
  return { kind: "once", cronExpression: "", eventName: "" };
}
