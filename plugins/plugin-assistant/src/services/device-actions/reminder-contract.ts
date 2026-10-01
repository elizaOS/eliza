/** Selected device records only. Observations never grant execution authority. */
export const REMINDER_CAPABILITY = "reminders.local-record.v1";
export interface ReminderTarget {
  sourceId: string;
  sourceRevision: string;
  reminderId: string;
  occurrenceId: string;
  revision: string;
}
export interface ReminderRepeat {
  rule: "daily" | "weekdays" | "weekly";
  zone: string;
  date: string;
  time: string;
  leadMinutes: number;
}
export type ReminderSchedule = {
  at: number;
  recurrence: ReminderRepeat | null;
};
export interface ReminderFields {
  title: string;
  body: string;
  schedule?: ReminderSchedule;
}
export type ReminderOperation =
  | { type: "reminder_update"; target: ReminderTarget; fields: ReminderFields }
  | {
      type:
        | "reminder_read_selected"
        | "reminder_complete"
        | "reminder_snooze"
        | "reminder_cancel";
      target: ReminderTarget;
    };
export interface ReminderResult {
  version: 1;
  kind: ReminderOperation["type"];
  sourceId: string;
  reminderId: string;
  occurrenceId: string;
  revision: string;
  status: string;
  at: number;
  fields?: ReminderFields;
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("Invalid reminder object");
  return v as Record<string, unknown>;
}
function keys(
  v: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
) {
  if (
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.keys(v).some((k) => !required.includes(k) && !optional.includes(k))
  )
    throw Error("Unexpected reminder fields");
}
function text(v: unknown, max: number, empty = false) {
  if (
    typeof v !== "string" ||
    v.length > max ||
    (!empty && !v.trim()) ||
    v.includes("\0")
  )
    throw Error("Invalid reminder text");
  return v;
}
function id(v: unknown, max = 128) {
  const s = text(v, max);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s))
    throw Error("Invalid reminder identity");
  return s;
}
function revision(v: unknown) {
  const s = text(v, 64);
  if (!/^[a-f0-9]{64}$/.test(s)) throw Error("Invalid reminder revision");
  return s;
}
function instant(v: unknown) {
  if (
    typeof v !== "number" ||
    !Number.isSafeInteger(v) ||
    v < 0 ||
    v > 8640000000000000
  )
    throw Error("Invalid reminder instant");
  return v;
}
export function reminderTarget(value: unknown): ReminderTarget {
  const v = object(value);
  keys(v, [
    "sourceId",
    "sourceRevision",
    "reminderId",
    "occurrenceId",
    "revision",
  ]);
  const reminderId = id(v.reminderId, 100);
  if (!/^[A-Za-z0-9_-]+$/.test(reminderId)) throw Error("Invalid reminder ID");
  return {
    sourceId: id(v.sourceId),
    sourceRevision: revision(v.sourceRevision),
    reminderId,
    occurrenceId: id(v.occurrenceId),
    revision: revision(v.revision),
  };
}
export function reminderFields(value: unknown): ReminderFields {
  const v = object(value);
  keys(v, ["title", "body"], ["schedule"]);
  const result: ReminderFields = {
    title: text(v.title, 200),
    body: text(v.body, 4000, true),
  };
  if (v.schedule !== undefined) {
    const s = object(v.schedule);
    keys(s, ["at", "recurrence"]);
    let recurrence: ReminderRepeat | null = null;
    if (s.recurrence !== null) {
      const r = object(s.recurrence);
      keys(r, ["rule", "zone", "date", "time", "leadMinutes"]);
      if (!["daily", "weekdays", "weekly"].includes(String(r.rule)))
        throw Error("Unsupported reminder repeat");
      const zone = text(r.zone, 128),
        date = text(r.date, 10),
        time = text(r.time, 5);
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
      } catch {
        throw Error("Invalid reminder zone");
      }
      if (
        !/^\d{4}-\d\d-\d\d$/.test(date) ||
        new Date(date + "T00:00:00Z").toISOString().slice(0, 10) !== date ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
        typeof r.leadMinutes !== "number" ||
        !Number.isInteger(r.leadMinutes) ||
        r.leadMinutes < 0 ||
        r.leadMinutes > 10080
      )
        throw Error("Invalid reminder civil time");
      recurrence = {
        rule: r.rule as ReminderRepeat["rule"],
        zone,
        date,
        time,
        leadMinutes: r.leadMinutes,
      };
    }
    result.schedule = { at: instant(s.at), recurrence };
  }
  return result;
}
export function isReminderOperation(
  value: unknown,
): value is ReminderOperation {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    [
      "reminder_read_selected",
      "reminder_update",
      "reminder_complete",
      "reminder_snooze",
      "reminder_cancel",
    ].includes(String((value as { type?: unknown }).type))
  );
}
export function validateReminderOperation(value: unknown): ReminderOperation {
  const v = object(value);
  if (!isReminderOperation(v)) throw Error("Unsupported reminder operation");
  keys(
    v,
    v.type === "reminder_update"
      ? ["type", "target", "fields"]
      : ["type", "target"],
  );
  const target = reminderTarget(v.target);
  return v.type === "reminder_update"
    ? { type: v.type, target, fields: reminderFields(v.fields) }
    : { type: v.type, target };
}
export function validateReminderResult(
  op: ReminderOperation,
  value: unknown,
): ReminderResult {
  const v = object(value);
  keys(
    v,
    [
      "version",
      "kind",
      "sourceId",
      "reminderId",
      "occurrenceId",
      "revision",
      "status",
      "at",
    ],
    op.type === "reminder_read_selected" ? ["fields"] : [],
  );
  if (
    v.version !== 1 ||
    v.kind !== op.type ||
    v.sourceId !== op.target.sourceId ||
    v.reminderId !== op.target.reminderId
  )
    throw Error("Reminder result binding changed");
  const statuses = [
    "scheduled",
    "posted",
    "completed",
    "cancelled",
    "permission-denied",
    "scheduling-failed",
  ];
  if (!statuses.includes(String(v.status)))
    throw Error("Invalid reminder result status");
  const result: ReminderResult = {
    version: 1,
    kind: op.type,
    sourceId: id(v.sourceId),
    reminderId: id(v.reminderId),
    occurrenceId: id(v.occurrenceId),
    revision: revision(v.revision),
    status: String(v.status),
    at: instant(v.at),
  };
  if (op.type === "reminder_read_selected") {
    if (
      v.revision !== op.target.revision ||
      v.occurrenceId !== op.target.occurrenceId
    )
      throw Error("Reminder read changed");
    result.fields = reminderFields(v.fields);
  }
  if (op.type === "reminder_cancel" && v.status !== "cancelled")
    throw Error("Reminder was not cancelled");
  if (
    op.type === "reminder_snooze" &&
    v.occurrenceId !== op.target.occurrenceId
  )
    throw Error("Snooze occurrence changed");
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32000)
    throw Error("Reminder result exceeds bound");
  return result;
}
