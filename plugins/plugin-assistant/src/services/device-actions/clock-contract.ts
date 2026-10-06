/** Approved Android Clock requests may mutate alarms. A dispatch receipt never proves the final alarm state. */
export const CLOCK_CAPABILITY = "clock.handoff.v1";
/** Explicit days require v2 so an older adapter cannot silently drop recurrence. */
export const CLOCK_REPEAT_CAPABILITY = "clock.handoff.v2";
/** Android AlarmClock.EXTRA_DAYS uses Calendar.SUNDAY=1 through SATURDAY=7. */
export const CLOCK_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type ClockDay = (typeof CLOCK_DAYS)[number];
export type ClockOperation =
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
export interface ClockResult {
  kind: "clock-handoff";
  action: ClockOperation["action"];
  status: "opened" | "unavailable" | "denied" | "failed" | "unknown";
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
    (value as { type?: unknown }).type === "clock_handoff"
  );
}
export function validateClockOperation(value: unknown): ClockOperation {
  const v = object(value);
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
    if (
      typeof v.label !== "string" ||
      v.label.length > 200 ||
      [...v.label].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      throw Error("Invalid Clock label");
    return {
      type: v.type,
      action: v.action,
      hour: integer(v.hour, 0, 23),
      minute: integer(v.minute, 0, 59),
      label: v.label,
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
) {
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
): ClockResult {
  const v = object(value);
  keys(v, ["kind", "action", "status"]);
  if (v.kind !== "clock-handoff" || v.action !== operation.action)
    throw Error("Clock result binding changed");
  const valid =
    outcome === "applied"
      ? v.status === "opened"
      : outcome === "unknown"
        ? v.status === "unknown"
        : outcome === "failed" || outcome === "not_applied"
          ? ["unavailable", "denied", "failed"].includes(String(v.status))
          : false;
  if (!valid) throw Error("Clock result cannot establish this outcome");
  return {
    kind: v.kind,
    action: operation.action,
    status: v.status as ClockResult["status"],
  };
}
