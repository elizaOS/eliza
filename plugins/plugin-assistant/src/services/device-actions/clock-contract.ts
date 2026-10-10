/** Native Clock operations. Legacy handoff receipts prove dispatch; owned receipts prove the recorded alarm change. */
export const CLOCK_CAPABILITY = "clock.handoff.v1";
/** Explicit days require v2 so an older adapter cannot silently drop recurrence. */
export const CLOCK_REPEAT_CAPABILITY = "clock.handoff.v2";
/** Eliza owns these durable alarms; no external Clock intent is dispatched. */
export const CLOCK_ALARMS_CAPABILITY = "clock.alarms.v1";
/** Android AlarmClock.EXTRA_DAYS uses Calendar.SUNDAY=1 through SATURDAY=7. */
export const CLOCK_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type ClockDay = (typeof CLOCK_DAYS)[number];
export type ClockHandoffOperation =
  | {
      type: "clock_handoff";
      action: "set";
      hour: number;
      minute: number;
      label: string;
      timeZone: string;
      /** Omitted: legacy v1 one-off. []: explicit one-off. Otherwise exact weekly days. */
      days?: ClockDay[];
    }
  | { type: "clock_handoff"; action: "snooze"; snoozeMinutes: number }
  | { type: "clock_handoff"; action: "show" | "dismiss" };
export type ClockAlarmOperation =
  | ({ type: "clock_alarm"; action: "set" } & ClockAlarmFields)
  | ({
      type: "clock_alarm";
      action: "update";
      alarmId: string;
    } & ClockAlarmFields)
  | { type: "clock_alarm"; action: "delete" | "dismiss"; alarmId: string }
  | { type: "clock_alarm"; action: "enable"; alarmId: string; enabled: boolean }
  | { type: "clock_alarm"; action: "snooze"; alarmId: string; minutes: number }
  | { type: "clock_alarm"; action: "show" };
export interface ClockAlarmFields {
  hour: number;
  minute: number;
  label: string;
  timeZone: string;
  /** [] is one-off. Values are Sunday=1 through Saturday=7. */
  days: ClockDay[];
}
export type ClockOperation = ClockHandoffOperation | ClockAlarmOperation;
export interface ClockHandoffResult {
  kind: "clock-handoff";
  action: ClockHandoffOperation["action"];
  status: "opened" | "unavailable" | "denied" | "failed" | "unknown";
}
export interface ClockAlarmResult {
  kind: "clock-alarm";
  action: ClockAlarmOperation["action"];
  status:
    | "scheduled"
    | "updated"
    | "deleted"
    | "enabled"
    | "disabled"
    | "dismissed"
    | "snoozed"
    | "shown"
    | "unavailable"
    | "denied"
    | "failed"
    | "unknown";
  alarmId?: string;
  nextAt?: number | null;
}
export type ClockResult = ClockHandoffResult | ClockAlarmResult;
export const CLOCK_ALARM_SCHEDULE_STATES = [
  "scheduled",
  "disabled",
  "permission_required",
  "schedule_unknown",
  "firing",
  "snoozed",
] as const;
export interface ClockAlarmRecord extends ClockAlarmFields {
  id: string;
  enabled: boolean;
  nextAt: number | null;
  scheduleState: (typeof CLOCK_ALARM_SCHEDULE_STATES)[number];
  generation: number;
  /** Recorded occurrence outcome; it does not independently prove audible delivery. */
  lastOutcome: string;
}
export interface ClockAlarmContext {
  revision: number;
  sensitive: false;
  timeZone: string;
  alarmsStatus: "available" | "stale" | "unavailable";
  alarmsObservedAt: number;
  alarmsRevision: number;
  alarms: ClockAlarmRecord[];
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Clock object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[]) {
  if (
    Object.keys(value).length !== required.length ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Unexpected Clock fields");
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw Error("Invalid Clock number");
  return value;
}
export function clockDays(value: unknown): ClockDay[] {
  if (!Array.isArray(value) || value.length > CLOCK_DAYS.length)
    throw Error("Invalid Clock repeat days");
  const days = Array.from(value, (day) => integer(day, 1, 7) as ClockDay);
  if (new Set(days).size !== days.length)
    throw Error("Duplicate Clock repeat days");
  return days;
}
export function clockCapabilityAvailable(
  operation: ClockOperation,
  capabilities: readonly string[] | undefined,
): boolean {
  if (operation.type === "clock_alarm")
    return capabilities?.includes(CLOCK_ALARMS_CAPABILITY) === true;
  if (operation.action === "set" && Object.hasOwn(operation, "days"))
    return capabilities?.includes(CLOCK_REPEAT_CAPABILITY) === true;
  return (
    capabilities?.includes(CLOCK_CAPABILITY) === true ||
    capabilities?.includes(CLOCK_REPEAT_CAPABILITY) === true
  );
}
export function clockTimeZone(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 100 ||
    !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value)
  )
    throw Error("Invalid Clock time zone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    throw Error("Invalid Clock time zone");
  }
  return value;
}
export function isClockOperation(value: unknown): value is ClockOperation {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    ["clock_handoff", "clock_alarm"].includes(
      String((value as { type?: unknown }).type),
    )
  );
}
function alarmId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
  )
    throw Error("Invalid Clock alarm identifier");
  return value.toLowerCase();
}
function label(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw Error("Invalid Clock label");
  return value;
}
function alarmFields(v: Record<string, unknown>): ClockAlarmFields {
  return {
    hour: integer(v.hour, 0, 23),
    minute: integer(v.minute, 0, 59),
    label: label(v.label),
    timeZone: clockTimeZone(v.timeZone),
    days: clockDays(v.days),
  };
}
function nextAt(value: unknown): number | null {
  return value === null ? null : integer(value, 1, Number.MAX_SAFE_INTEGER);
}
export function validateClockAlarmContext(value: unknown): ClockAlarmContext {
  const v = object(value);
  if (
    v.sensitive !== false ||
    !["available", "stale", "unavailable"].includes(String(v.alarmsStatus)) ||
    !Array.isArray(v.alarms)
  )
    throw Error("Clock alarm snapshot unavailable");
  const alarms = Array.from(v.alarms, (entry) => {
    const a = object(entry);
    keys(a, [
      "id",
      "hour",
      "minute",
      "label",
      "timeZone",
      "days",
      "enabled",
      "nextAt",
      "scheduleState",
      "generation",
      "lastOutcome",
    ]);
    if (
      typeof a.enabled !== "boolean" ||
      !(CLOCK_ALARM_SCHEDULE_STATES as readonly unknown[]).includes(
        a.scheduleState,
      )
    )
      throw Error("Invalid Clock alarm state");
    if (
      typeof a.lastOutcome !== "string" ||
      a.lastOutcome.length > 100 ||
      [...a.lastOutcome].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw Error("Invalid Clock occurrence outcome");
    return {
      ...alarmFields(a),
      id: alarmId(a.id),
      enabled: a.enabled,
      nextAt: nextAt(a.nextAt),
      scheduleState: a.scheduleState as ClockAlarmRecord["scheduleState"],
      generation: integer(a.generation, 1, Number.MAX_SAFE_INTEGER),
      lastOutcome: a.lastOutcome,
    };
  });
  if (new Set(alarms.map((alarm) => alarm.id)).size !== alarms.length)
    throw Error("Duplicate Clock alarm identifiers");
  return {
    revision: integer(v.revision, 0, Number.MAX_SAFE_INTEGER),
    sensitive: false,
    timeZone: clockTimeZone(v.timeZone),
    alarmsStatus: v.alarmsStatus as ClockAlarmContext["alarmsStatus"],
    alarmsObservedAt: integer(v.alarmsObservedAt, 1, Number.MAX_SAFE_INTEGER),
    alarmsRevision: integer(v.alarmsRevision, 0, Number.MAX_SAFE_INTEGER),
    alarms,
  };
}
export function validateClockOperation(value: unknown): ClockOperation {
  const v = object(value);
  if (v.type === "clock_alarm") {
    if (v.action === "set" || v.action === "update") {
      keys(v, [
        "type",
        "action",
        "hour",
        "minute",
        "label",
        "timeZone",
        "days",
        ...(v.action === "update" ? ["alarmId"] : []),
      ]);
      return v.action === "set"
        ? { type: v.type, action: v.action, ...alarmFields(v) }
        : {
            type: v.type,
            action: v.action,
            alarmId: alarmId(v.alarmId),
            ...alarmFields(v),
          };
    }
    if (v.action === "show") {
      keys(v, ["type", "action"]);
      return { type: v.type, action: v.action };
    }
    if (v.action === "delete" || v.action === "dismiss") {
      keys(v, ["type", "action", "alarmId"]);
      return { type: v.type, action: v.action, alarmId: alarmId(v.alarmId) };
    }
    if (v.action === "enable") {
      keys(v, ["type", "action", "alarmId", "enabled"]);
      if (typeof v.enabled !== "boolean")
        throw Error("Invalid Clock enable state");
      return {
        type: v.type,
        action: v.action,
        alarmId: alarmId(v.alarmId),
        enabled: v.enabled,
      };
    }
    if (v.action === "snooze") {
      keys(v, ["type", "action", "alarmId", "minutes"]);
      return {
        type: v.type,
        action: v.action,
        alarmId: alarmId(v.alarmId),
        minutes: integer(v.minutes, 1, 60),
      };
    }
    throw Error("Invalid Clock alarm action");
  }
  if (v.type !== "clock_handoff") throw Error("Invalid Clock operation");
  if (v.action === "set") {
    const hasDays = Object.hasOwn(v, "days");
    keys(v, [
      "type",
      "action",
      "hour",
      "minute",
      "label",
      "timeZone",
      ...(hasDays ? ["days"] : []),
    ]);
    return {
      type: v.type,
      action: v.action,
      hour: integer(v.hour, 0, 23),
      minute: integer(v.minute, 0, 59),
      label: label(v.label),
      timeZone: clockTimeZone(v.timeZone),
      ...(hasDays ? { days: clockDays(v.days) } : {}),
    };
  }
  if (v.action === "snooze") {
    keys(v, ["type", "action", "snoozeMinutes"]);
    return {
      type: v.type,
      action: v.action,
      snoozeMinutes: integer(v.snoozeMinutes, 1, 60),
    };
  }
  keys(v, ["type", "action"]);
  if (v.action !== "show" && v.action !== "dismiss")
    throw Error("Invalid Clock action");
  return { type: v.type, action: v.action };
}
export function assertClockObservation(
  operation: ClockOperation,
  value: unknown,
): ClockAlarmContext | undefined {
  if (operation.type === "clock_alarm") {
    const context = validateClockAlarmContext(value);
    if (context.alarmsStatus !== "available")
      throw Error("Clock alarm snapshot is not current");
    if (
      (operation.action === "set" || operation.action === "update") &&
      context.timeZone !== operation.timeZone
    )
      throw Error("Clock time zone observation changed");
    if (
      "alarmId" in operation &&
      !context.alarms.some((alarm) => alarm.id === operation.alarmId)
    )
      throw Error("Clock alarm target unavailable");
    return context;
  }
  if (operation.action !== "set") return;
  const v = object(value);
  if (
    v.sensitive !== false ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 0 ||
    clockTimeZone(v.timeZone) !== operation.timeZone
  )
    throw Error("Clock time zone observation unavailable or changed");
}
export function validateClockResult(
  operation: ClockOperation,
  value: unknown,
  outcome: unknown,
  operationId?: string,
): ClockResult {
  const v = object(value);
  if (operation.type === "clock_alarm") {
    if (v.kind !== "clock-alarm" || v.action !== operation.action)
      throw Error("Clock result binding changed");
    const successful = {
      set: "scheduled",
      update: "updated",
      delete: "deleted",
      enable: "enabled",
      dismiss: "dismissed",
      snooze: "snoozed",
      show: "shown",
    }[operation.action];
    const status =
      operation.action === "enable" && !operation.enabled
        ? "disabled"
        : successful;
    if (outcome !== "applied") {
      keys(v, ["kind", "action", "status"]);
      // String() coercion would accept ["failed"]; the un-coerced value is
      // stored below, so require an actual string.
      if (
        !(outcome === "unknown"
          ? v.status === "unknown"
          : (outcome === "failed" || outcome === "not_applied") &&
            typeof v.status === "string" &&
            ["unavailable", "denied", "failed"].includes(v.status))
      )
        throw Error("Clock result cannot establish this outcome");
      return {
        kind: "clock-alarm",
        action: operation.action,
        status: v.status as ClockAlarmResult["status"],
      };
    }
    if (v.status !== status)
      throw Error("Clock result cannot establish this outcome");
    if (operation.action === "show") {
      keys(v, ["kind", "action", "status"]);
      return { kind: "clock-alarm", action: operation.action, status: "shown" };
    }
    const hasNextAt = operation.action !== "delete";
    keys(v, [
      "kind",
      "action",
      "status",
      "alarmId",
      ...(hasNextAt ? ["nextAt"] : []),
    ]);
    const id = alarmId(v.alarmId);
    if (
      ("alarmId" in operation && operation.alarmId !== id) ||
      (operation.action === "set" &&
        operationId !== undefined &&
        alarmId(operationId) !== id)
    )
      throw Error("Clock alarm result target changed");
    const at = hasNextAt ? nextAt(v.nextAt) : undefined;
    if (
      (operation.action === "set" ||
        operation.action === "snooze" ||
        (operation.action === "enable" && operation.enabled)) &&
      at === null
    )
      throw Error("Clock result has no scheduled occurrence");
    if (operation.action === "enable" && !operation.enabled && at !== null)
      throw Error("Disabled Clock result still has a schedule");
    return {
      kind: "clock-alarm",
      action: operation.action,
      status: status as ClockAlarmResult["status"],
      alarmId: id,
      ...(hasNextAt ? { nextAt: at as number | null } : {}),
    };
  }
  keys(v, ["kind", "action", "status"]);
  if (v.kind !== "clock-handoff" || v.action !== operation.action)
    throw Error("Clock result binding changed");
  const valid =
    outcome === "applied"
      ? v.status === "opened"
      : outcome === "unknown"
        ? v.status === "unknown"
        : outcome === "failed" || outcome === "not_applied"
          ? typeof v.status === "string" &&
            ["unavailable", "denied", "failed"].includes(v.status)
          : false;
  if (!valid) throw Error("Clock result cannot establish this outcome");
  return {
    kind: v.kind,
    action: operation.action,
    status: v.status as ClockHandoffResult["status"],
  };
}
