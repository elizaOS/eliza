/** Selected device records only. Observations never grant execution authority. */
export const REMINDER_CAPABILITY = "reminders.local-record.v1";
export const REMINDER_TIMING_CAPABILITY = "reminders.local-record.v2";
export type ReminderTiming = { dueAt?: number; alertMinutes?: number | null };
export function reminderTiming(value: ReminderTiming): ReminderTiming {
  return value.alertMinutes === undefined
    ? {}
    : { dueAt: value.dueAt, alertMinutes: value.alertMinutes };
}
export interface ReminderTarget {
  timingVersion?: 2;
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
  dueAt?: number;
  alertMinutes?: number | null;
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
  dueAt?: number;
  alertMinutes?: number | null;
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
  keys(
    v,
    ["sourceId", "sourceRevision", "reminderId", "occurrenceId", "revision"],
    ["timingVersion"],
  );
  if (v.timingVersion !== undefined && v.timingVersion !== 2)
    throw Error("Invalid reminder timing version");
  const reminderId = id(v.reminderId, 100);
  if (!/^[A-Za-z0-9_-]+$/.test(reminderId)) throw Error("Invalid reminder ID");
  return {
    ...(v.timingVersion === 2 ? { timingVersion: 2 as const } : {}),
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
    keys(s, ["at", "recurrence"], ["dueAt", "alertMinutes"]);
    let recurrence: ReminderRepeat | null = null;
    if (s.recurrence !== null) {
      const r = object(s.recurrence);
      keys(r, ["rule", "zone", "date", "time", "leadMinutes"]);
      // String() coercion would accept ["daily"] or {toString: () => "daily"};
      // the un-coerced value is stored below, so require an actual string.
      if (typeof r.rule !== "string" || !["daily", "weekdays", "weekly"].includes(r.rule))
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
    const timing = checkedTiming(s);
    if (timing.alertMinutes !== undefined) {
      if (
        timing.dueAt === undefined ||
        result.schedule.at !==
          timing.dueAt - (timing.alertMinutes ?? 0) * 60000 ||
        (recurrence && recurrence.leadMinutes !== (timing.alertMinutes ?? 0))
      )
        throw Error("Reminder timing changed");
      Object.assign(result.schedule, timing);
    }
  }
  return result;
}
function checkedTiming(v: Record<string, unknown>): ReminderTiming {
  if ((v.dueAt === undefined) !== (v.alertMinutes === undefined))
    throw Error("Incomplete reminder timing");
  if (v.alertMinutes === undefined) return {};
  if (
    v.alertMinutes !== null &&
    (typeof v.alertMinutes !== "number" ||
      !Number.isInteger(v.alertMinutes) ||
      v.alertMinutes < 0 ||
      v.alertMinutes > 10080)
  )
    throw Error("Invalid reminder alert");
  return {
    dueAt: instant(v.dueAt),
    alertMinutes: v.alertMinutes as number | null,
  };
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
  if (v.type === "reminder_update" && target.timingVersion === 2) {
    const fields = reminderFields(v.fields);
    if (fields.schedule && fields.schedule.alertMinutes === undefined)
      throw Error("Explicit reminder timing cannot be discarded");
  }
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
    op.type === "reminder_read_selected"
      ? ["fields", "dueAt", "alertMinutes"]
      : ["dueAt", "alertMinutes"],
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
    "pending",
  ];
  // String() coercion would accept ["cancelled"], but the operation checks
  // below compare the un-coerced value strictly. Require an actual string.
  if (typeof v.status !== "string" || !statuses.includes(v.status))
    throw Error("Invalid reminder result status");
  const timing = checkedTiming(v);
  if (timing.alertMinutes !== undefined && !reminderRequiresV2(op))
    throw Error("Unexpected reminder timing result");
  if (
    (op.target.timingVersion === 2 ||
      (op.type === "reminder_update" &&
        op.fields.schedule?.alertMinutes !== undefined)) &&
    timing.alertMinutes === undefined
  )
    throw Error("Missing reminder timing result");
  if (
    (v.status === "pending" && timing.alertMinutes !== null) ||
    (timing.alertMinutes === null &&
      !["pending", "completed", "cancelled"].includes(String(v.status)))
  )
    throw Error("Invalid no-alert reminder result");
  if (
    op.type === "reminder_update" &&
    op.fields.schedule?.alertMinutes !== undefined &&
    (timing.dueAt !== op.fields.schedule.dueAt ||
      timing.alertMinutes !== op.fields.schedule.alertMinutes ||
      v.at !== op.fields.schedule.at)
  )
    throw Error("Reminder timing result changed");
  const result: ReminderResult = {
    ...timing,
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
    if (
      timing.alertMinutes !== undefined &&
      (result.fields.schedule?.dueAt !== timing.dueAt ||
        result.fields.schedule?.alertMinutes !== timing.alertMinutes)
    )
      throw Error("Reminder read timing changed");
  }
  if (op.type === "reminder_cancel" && v.status !== "cancelled")
    throw Error("Reminder was not cancelled");
  if (
    op.type === "reminder_complete" &&
    v.status !== "completed" &&
    (![
      "scheduled",
      "pending",
      "permission-denied",
      "scheduling-failed",
    ].includes(String(v.status)) ||
      v.occurrenceId === op.target.occurrenceId)
  )
    throw Error("Reminder was not completed");
  if (op.type === "reminder_snooze" && timing.alertMinutes === null)
    throw Error("No-alert reminder cannot be snoozed");
  if (
    op.type === "reminder_snooze" &&
    v.occurrenceId !== op.target.occurrenceId
  )
    throw Error("Snooze occurrence changed");
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32000)
    throw Error("Reminder result exceeds bound");
  return result;
}
/** Extended timing is explicit and never downgraded for an older peer. */
export function reminderRequiresV2(operation: ReminderOperation): boolean {
  return (
    operation.target.timingVersion === 2 ||
    (operation.type === "reminder_update" &&
      operation.fields.schedule?.alertMinutes !== undefined)
  );
}
export function reminderCapabilityAvailable(
  operation: ReminderOperation,
  capabilities: readonly string[] | undefined,
): boolean {
  return (
    !!capabilities?.includes(REMINDER_TIMING_CAPABILITY) ||
    (!reminderRequiresV2(operation) &&
      !!capabilities?.includes(REMINDER_CAPABILITY))
  );
}
