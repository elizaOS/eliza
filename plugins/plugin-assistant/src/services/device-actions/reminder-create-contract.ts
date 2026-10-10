import {
  type ReminderFields,
  type ReminderSchedule,
  reminderFields,
} from "./reminder-contract.ts";
export const REMINDER_CREATE_CAPABILITY = "reminders.create.v1";
export type ReminderCreateOperation = {
  type: "reminder_create";
  fields: ReminderFields & {
    schedule: ReminderSchedule & { dueAt: number; alertMinutes: number | null };
  };
};
export type ReminderCreateResult = {
  version: 1;
  kind: "reminder_create";
  sourceId: string;
  reminderId: string;
  occurrenceId: string;
  revision: string;
  status: "pending" | "scheduled" | "permission-denied" | "scheduling-failed";
  at: number;
  dueAt: number;
  alertMinutes: number | null;
  fields: ReminderCreateOperation["fields"];
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid reminder creation");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: string[]) {
  if (
    Object.keys(value).length !== names.length ||
    names.some((k) => !Object.hasOwn(value, k))
  )
    throw Error("Unexpected reminder creation fields");
}
export function isReminderCreate(
  value: unknown,
): value is ReminderCreateOperation {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "reminder_create"
  );
}
export function validateReminderCreate(
  value: unknown,
): ReminderCreateOperation {
  const v = object(value);
  keys(v, ["type", "fields"]);
  if (v.type !== "reminder_create")
    throw Error("Unsupported reminder creation");
  const fields = reminderFields(v.fields);
  if (
    fields.title !== fields.title.trim() ||
    !fields.schedule ||
    fields.schedule.dueAt === undefined ||
    fields.schedule.alertMinutes === undefined
  )
    throw Error("Review exact reminder timing");
  return {
    type: "reminder_create",
    fields: fields as ReminderCreateOperation["fields"],
  };
}
export function validateReminderCreateResult(
  op: ReminderCreateOperation,
  value: unknown,
  operationId?: string,
): ReminderCreateResult {
  const v = object(value);
  keys(v, [
    "version",
    "kind",
    "sourceId",
    "reminderId",
    "occurrenceId",
    "revision",
    "status",
    "at",
    "dueAt",
    "alertMinutes",
    "fields",
  ]);
  for (const key of ["sourceId", "reminderId", "occurrenceId"])
    if (
      typeof v[key] !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v[key])
    )
      throw Error("Invalid created reminder identity");
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(String(v.reminderId)))
    throw Error("Invalid created reminder ID");
  if (
    v.version !== 1 ||
    v.kind !== op.type ||
    (operationId !== undefined && v.reminderId !== operationId) ||
    typeof v.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(v.revision)
  )
    throw Error("Reminder creation receipt changed");
  const fields = validateReminderCreate({
      type: "reminder_create",
      fields: v.fields,
    }).fields,
    s = op.fields.schedule;
  if (
    JSON.stringify(fields) !== JSON.stringify(op.fields) ||
    v.at !== s.at ||
    v.dueAt !== s.dueAt ||
    v.alertMinutes !== s.alertMinutes ||
    (s.alertMinutes === null
      ? v.status !== "pending"
      : // String() coercion would accept ["scheduled"], but the raw value is
        // returned below. Require an actual string.
        !(
          typeof v.status === "string" &&
          ["scheduled", "permission-denied", "scheduling-failed"].includes(
            v.status,
          )
        ))
  )
    throw Error("Reminder creation outcome changed");
  return { ...v, fields } as ReminderCreateResult;
}
