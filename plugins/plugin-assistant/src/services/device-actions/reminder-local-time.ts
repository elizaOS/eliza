/** Normal app tool inputs use civil time; canonical device contracts retain epochs. */
import type { ActionParameterSchema } from "@elizaos/core";
import {
  buildUtcDateFromLocalParts,
  getZonedDateParts,
  isRealCalendarDay,
} from "../../../../plugin-calendar/src/internal/time.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid reminder timing");
  return value as Record<string, unknown>;
}
export function readableReminderOperationSchema(
  type: string,
  schema: ActionParameterSchema,
): ActionParameterSchema {
  if (type !== "reminder_create" && type !== "reminder_update") return schema;
  const copy = structuredClone(schema),
    branch = copy.anyOf?.[0],
    fields = branch?.properties?.fields as ActionParameterSchema | undefined,
    schedule = fields?.properties?.schedule as
      | ActionParameterSchema
      | undefined;
  if (!schedule?.properties)
    throw Error("Canonical reminder schedule unavailable");
  delete schedule.properties.at;
  delete schedule.properties.dueAt;
  schedule.properties.localDate = {
    type: "string",
    description:
      "Exact requested local date YYYY-MM-DD. Do not calculate epoch milliseconds.",
  };
  schedule.properties.localTime = {
    type: "string",
    description: "Exact requested 24-hour local wall time HH:mm or HH:mm:ss.",
  };
  schedule.properties.timeZone = {
    type: "string",
    description:
      "Exact current/requested IANA timezone, e.g. America/Los_Angeles. No inferred UTC offset.",
  };
  schedule.required = [
    "localDate",
    "localTime",
    "timeZone",
    "alertMinutes",
    "recurrence",
  ];
  return copy;
}
export function resolveReadableReminderOperation(
  input: unknown,
): Record<string, unknown> {
  const operation = object(input);
  if (
    operation.type !== "reminder_create" &&
    operation.type !== "reminder_update"
  )
    return operation;
  const fields = object(operation.fields);
  if (operation.type === "reminder_update" && fields.schedule === undefined)
    return operation;
  const schedule = object(fields.schedule),
    keys = Object.keys(schedule);
  if (
    keys.length !== 5 ||
    !["localDate", "localTime", "timeZone", "alertMinutes", "recurrence"].every(
      (k) => Object.hasOwn(schedule, k),
    )
  )
    throw Error("Exact readable reminder schedule required");
  const date =
      typeof schedule.localDate === "string" &&
      /^(\d{4})-(\d{2})-(\d{2})$/.exec(schedule.localDate),
    time =
      typeof schedule.localTime === "string" &&
      /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(schedule.localTime);
  if (
    !date ||
    !time ||
    typeof schedule.timeZone !== "string" ||
    schedule.timeZone.trim() !== schedule.timeZone ||
    !schedule.timeZone
  )
    throw Error("Invalid local time");
  const parts = {
    year: Number(date[1]),
    month: Number(date[2]),
    day: Number(date[3]),
    hour: Number(time[1]),
    minute: Number(time[2]),
    second: Number(time[3] ?? 0),
  };
  if (
    parts.year < 1 ||
    !isRealCalendarDay(parts.year, parts.month, parts.day) ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  )
    throw Error("Invalid civil date");
  const zone = schedule.timeZone;
  new Intl.DateTimeFormat("en-US", { timeZone: zone });
  const instant = buildUtcDateFromLocalParts(zone, parts, "reject"),
    roundtrip = getZonedDateParts(instant, zone);
  if (
    Object.entries(parts).some(
      ([key, value]) => roundtrip[key as keyof typeof roundtrip] !== value,
    )
  )
    throw Error("Local time roundtrip failed");
  const dueAt = instant.getTime(),
    lead = schedule.alertMinutes;
  if (
    lead !== null &&
    (!Number.isSafeInteger(lead) ||
      (lead as number) < 0 ||
      (lead as number) > 10080)
  )
    throw Error("Invalid alert minutes");
  const recurrence = schedule.recurrence;
  if (recurrence !== null) {
    const row = object(recurrence);
    if (
      row.zone !== zone ||
      row.date !== schedule.localDate ||
      row.time !== schedule.localTime ||
      row.leadMinutes !== (lead ?? 0)
    )
      throw Error("Recurrence and local due time disagree");
  }
  const at = dueAt - (lead === null ? 0 : (lead as number) * 60000);
  if (!Number.isSafeInteger(at)) throw Error("Invalid reminder epoch");
  return {
    ...operation,
    fields: {
      ...fields,
      schedule: { at, dueAt, alertMinutes: lead, recurrence },
    },
  };
}
