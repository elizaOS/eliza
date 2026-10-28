/**
 * External Clock handoff policy shared by every mobile brand.
 *
 * The system Clock app owns alarms. A host opens it with a reviewed request; the
 * receipt proves only that Clock opened. It never establishes that an alarm was
 * created, changed, dismissed, snoozed or that it rang. Hosts that own durable
 * alarms use `clock.alarms.v1` through the separate owned-alarm path; this
 * module never advertises, admits or describes those operations.
 */
import {
  assertClockObservation,
  CLOCK_CAPABILITY,
  CLOCK_REPEAT_CAPABILITY,
  type ClockDay,
  type ClockHandoffOperation,
  type ClockHandoffResult,
  clockDays,
  clockTimeZone,
  validateClockOperation,
  validateClockResult,
} from "./clock-contract.ts";

export const CLOCK_DAY_NAMES = [
  "Sun",
  "Mon",
  "Tue",
  "Wed",
  "Thu",
  "Fri",
  "Sat",
] as const;

/** Phone facts that bound what an external-handoff host may advertise. */
export interface ClockHandoffHostSupport {
  /** Capabilities the agent offered in its device-capability negotiation. */
  offered: readonly unknown[];
  /** A system Clock handler can receive AlarmClock intents on this phone. */
  handler: boolean;
  /** The native dispatcher carries AlarmClock.EXTRA_DAYS (repeat days). */
  repeatDays: boolean;
}

/**
 * The one capability policy for external Clock handoffs. Every brand advertises
 * `clock.handoff.v1` when the agent offers it and a Clock handler exists, adds
 * `clock.handoff.v2` only when its dispatcher also carries repeat days, and never
 * advertises `clock.alarms.v1` from the handoff path.
 */
export function clockHandoffCapabilities(
  support: ClockHandoffHostSupport,
): string[] {
  if (!support.handler || !Array.isArray(support.offered)) return [];
  const capabilities: string[] = [];
  if (support.offered.includes(CLOCK_CAPABILITY))
    capabilities.push(CLOCK_CAPABILITY);
  if (support.repeatDays && support.offered.includes(CLOCK_REPEAT_CAPABILITY))
    capabilities.push(CLOCK_REPEAT_CAPABILITY);
  return capabilities;
}

export function isClockHandoffOperation(
  value: unknown,
): value is ClockHandoffOperation {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "clock_handoff"
  );
}

/** Ascending AlarmClock.EXTRA_DAYS order (Sunday=1 through Saturday=7). */
function ascending(days: readonly ClockDay[]): ClockDay[] {
  return [...days].sort((a, b) => a - b);
}

/**
 * Validate one handoff request for dispatch to the system Clock. Owned-alarm
 * operations are refused. As the wire contract defines, an explicit empty
 * repeat list is a one-off alarm: it is dispatched without days, so Clock never
 * receives an empty EXTRA_DAYS. Nonempty days are dispatched in ascending order.
 */
export function validateClockHandoffDispatch(
  value: unknown,
): ClockHandoffOperation {
  const operation = validateClockOperation(value);
  if (operation.type !== "clock_handoff")
    throw Error("Invalid Clock handoff operation");
  if (operation.action !== "set" || operation.days === undefined)
    return operation;
  const { days, ...oneOff } = operation;
  return days.length ? { ...oneOff, days: ascending(days) } : oneOff;
}

/** Days chosen in a phone form: one to seven unique days, returned ascending. */
export function clockHandoffFormDays(value: unknown): ClockDay[] {
  let days: ClockDay[];
  try {
    days = clockDays(value);
  } catch {
    throw Error("Invalid Clock repeat days");
  }
  if (days.length === 0) throw Error("Invalid Clock repeat days");
  return ascending(days);
}

export function describeClockDays(days: readonly ClockDay[]): string {
  const sorted = ascending(days);
  if (sorted.length === 7) return "every day";
  if (sorted.join() === "2,3,4,5,6") return "weekdays";
  if (sorted.join() === "1,7") return "weekends";
  return sorted.map((day) => CLOCK_DAY_NAMES[day - 1]).join(", ");
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Owner-facing review text. It names what Clock will be asked to do and states
 * that the result is unverified; it never promises creation, dismissal,
 * snoozing or ringing. `product` is the brand name shown to the owner.
 */
export function describeClockHandoff(
  operation: ClockHandoffOperation,
  product: string,
): string {
  if (operation.action === "set")
    return `Ask Clock to set ${pad(operation.hour)}:${pad(operation.minute)} in ${operation.timeZone}${operation.days?.length ? `, repeating ${describeClockDays(operation.days)}` : ""}${operation.label ? ` named “${operation.label}”` : ""}. Review the alarm in Clock; ${product} cannot confirm creation or ringing.`;
  if (operation.action === "show") return "Open Clock’s alarms page.";
  if (operation.action === "snooze")
    return `Open Clock so you can choose the intended alarm and snooze it yourself. Select the duration there; ${operation.snoozeMinutes} minutes will not be applied automatically. Completion stays unverified.`;
  return `Open Clock so you can choose the intended alarm and dismiss it yourself. ${product} will not dismiss or disable an alarm automatically. Completion stays unverified.`;
}

/**
 * Normalize a runtime-reported IANA zone. Newer Android ICU/WebView builds
 * report the GMT default as an ISO zero offset; that known UTC equivalent maps
 * to "UTC". Every other unknown zone still fails closed.
 */
export function normalizeClockTimeZone(zone: unknown): string {
  return clockTimeZone(zone === "+00:00" || zone === "-00:00" ? "UTC" : zone);
}

/** The phone's current zone, as a Clock request must state it. */
export function currentClockTimeZone(): string {
  return normalizeClockTimeZone(
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
}

/**
 * A set request carries the zone the owner reviewed. Refuse dispatch when the
 * observed phone context or the current device zone no longer matches it.
 */
export function assertClockHandoffTimeZone(
  operation: ClockHandoffOperation,
  observed: string | undefined,
  current: string = currentClockTimeZone(),
): void {
  if (
    operation.action === "set" &&
    (operation.timeZone !== observed || operation.timeZone !== current)
  )
    throw Error("Phone time zone changed. Review the Clock request again.");
}

export function assertClockHandoffObservation(
  operation: ClockHandoffOperation,
  value: unknown,
): void {
  if (!isClockHandoffOperation(operation))
    throw Error("Invalid Clock handoff operation");
  assertClockObservation(operation, value);
}

/** Validate a handoff receipt against its reviewed operation and outcome. */
export function validateClockHandoffResult(
  operation: ClockHandoffOperation,
  value: unknown,
  outcome: unknown,
): ClockHandoffResult {
  if (!isClockHandoffOperation(operation))
    throw Error("Invalid Clock handoff operation");
  const result = validateClockResult(operation, value, outcome);
  if (result.kind !== "clock-handoff")
    throw Error("Clock result binding changed");
  return result;
}

/**
 * Bind a native dispatcher status to its typed receipt. `opened` is the only
 * applied status; `unknown` stays unknown; every other status is a failure.
 */
export function clockHandoffReceipt(
  operation: ClockHandoffOperation,
  value: unknown,
): ClockHandoffResult {
  const status =
    value && typeof value === "object"
      ? (value as { status?: unknown }).status
      : undefined;
  return validateClockHandoffResult(
    operation,
    value,
    status === "opened"
      ? "applied"
      : status === "unknown"
        ? "unknown"
        : "failed",
  );
}

/** A request reviewed in a phone form, before it becomes a native dispatch. */
export type ClockHandoffSetRequest = {
  action: "set";
  hour: number;
  minute: number;
  label: string;
  timeZone: string;
  reviewed: true;
  days?: ClockDay[];
};
export type ClockHandoffRequest =
  | ClockHandoffSetRequest
  | { action: "snooze"; snoozeMinutes: number; reviewed: true }
  | { action: "show" | "dismiss"; reviewed: true };

export interface ClockHandoffForm {
  action: "set" | "show" | "snooze" | "dismiss";
  /** Local wall time, HH:mm. */
  time: string;
  label: string;
  /** Snooze minutes as typed, 1 to 60. */
  snooze: string;
  /** Repeat days chosen in the form; empty is a one-time alarm. */
  days: readonly number[];
}

/** Pure form builder. An empty repeat is a one-time alarm and carries no days. */
export function buildClockHandoffRequest(
  form: ClockHandoffForm,
  timeZone: string,
): ClockHandoffRequest {
  if (form.action === "set") {
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time) ||
      typeof form.label !== "string" ||
      form.label.length > 200 ||
      form.label.includes("\0")
    )
      throw Error("Choose a valid time and a label up to 200 characters.");
    const [hour, minute] = form.time.split(":").map(Number);
    return {
      action: "set",
      hour,
      minute,
      label: form.label.trim(),
      timeZone: clockTimeZone(timeZone),
      reviewed: true,
      ...(form.days.length ? { days: clockHandoffFormDays(form.days) } : {}),
    };
  }
  if (form.action === "snooze") {
    if (
      !/^\d{1,2}$/.test(form.snooze) ||
      Number(form.snooze) < 1 ||
      Number(form.snooze) > 60
    )
      throw Error("Choose 1 to 60 snooze minutes.");
    return {
      action: "snooze",
      snoozeMinutes: Number(form.snooze),
      reviewed: true,
    };
  }
  if (form.action !== "show" && form.action !== "dismiss")
    throw Error("Invalid Clock action");
  return { action: form.action, reviewed: true };
}
