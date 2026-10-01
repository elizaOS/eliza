/** Provider-neutral, closed Calendar device contract. No observation grants permission. */
export const CALENDAR_CAPABILITY = "calendar.local-event.v1";
export interface CalendarSource {
  sourceId: string;
  sourceRevision: string;
}
export interface CalendarTarget extends CalendarSource {
  eventId: string;
  revision: string;
}
export interface CalendarFields {
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  timeZone: string;
}
export type CalendarOperation =
  | { type: "calendar_create"; source: CalendarSource; fields: CalendarFields }
  | { type: "calendar_read_selected"; target: CalendarTarget }
  | { type: "calendar_update"; target: CalendarTarget; fields: CalendarFields }
  | { type: "calendar_delete"; target: CalendarTarget };
export interface CalendarResult {
  version: 1;
  kind: CalendarOperation["type"];
  sourceId: string;
  eventId: string;
  revision: string;
  fields?: CalendarFields;
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Calendar object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((k) => !Object.hasOwn(value, k))
  )
    throw Error("Unexpected Calendar fields");
}
function string(value: unknown, max: number, empty = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    value.includes("\0")
  )
    throw Error("Invalid Calendar text");
  return value;
}
function id(value: unknown) {
  const text = string(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text))
    throw Error("Invalid Calendar identity");
  return text;
}
function revision(value: unknown) {
  const text = string(value, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) throw Error("Invalid Calendar revision");
  return text;
}
function instant(value: unknown) {
  const text = string(value, 24);
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text) ||
    !Number.isFinite(Date.parse(text)) ||
    new Date(text).toISOString() !== text
  )
    throw Error("Invalid Calendar instant");
  return text;
}
export function calendarFields(value: unknown): CalendarFields {
  const v = obj(value);
  keys(v, ["title", "description", "location", "start", "end", "timeZone"]);
  const start = instant(v.start),
    end = instant(v.end),
    zone = string(v.timeZone, 128);
  if (
    Date.parse(start) < 0 ||
    Date.parse(end) <= Date.parse(start) ||
    Date.parse(end) - Date.parse(start) > 370 * 86400000
  )
    throw Error("Invalid Calendar interval");
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
  } catch {
    throw Error("Invalid Calendar timezone");
  }
  return {
    title: string(v.title, 500),
    description: string(v.description, 16000, true),
    location: string(v.location, 2000, true),
    start,
    end,
    timeZone: zone,
  };
}
export function calendarSource(value: unknown): CalendarSource {
  const v = obj(value);
  keys(v, ["sourceId", "sourceRevision"]);
  return {
    sourceId: id(v.sourceId),
    sourceRevision: revision(v.sourceRevision),
  };
}
export function calendarTarget(value: unknown): CalendarTarget {
  const v = obj(value);
  keys(v, ["sourceId", "sourceRevision", "eventId", "revision"]);
  return {
    sourceId: id(v.sourceId),
    sourceRevision: revision(v.sourceRevision),
    eventId: id(v.eventId),
    revision: revision(v.revision),
  };
}
export function isCalendarOperation(
  value: unknown,
): value is CalendarOperation {
  return (
    !!value &&
    typeof value === "object" &&
    [
      "calendar_create",
      "calendar_read_selected",
      "calendar_update",
      "calendar_delete",
    ].includes(String((value as { type?: unknown }).type))
  );
}
export function validateCalendarOperation(value: unknown): CalendarOperation {
  const v = obj(value);
  switch (v.type) {
    case "calendar_create":
      keys(v, ["type", "source", "fields"]);
      return {
        type: v.type,
        source: calendarSource(v.source),
        fields: calendarFields(v.fields),
      };
    case "calendar_update":
      keys(v, ["type", "target", "fields"]);
      return {
        type: v.type,
        target: calendarTarget(v.target),
        fields: calendarFields(v.fields),
      };
    case "calendar_delete":
    case "calendar_read_selected":
      keys(v, ["type", "target"]);
      return { type: v.type, target: calendarTarget(v.target) };
    default:
      throw Error("Unsupported Calendar operation");
  }
}
export function validateCalendarResult(
  operation: CalendarOperation,
  value: unknown,
): CalendarResult {
  const v = obj(value);
  keys(
    v,
    operation.type === "calendar_read_selected"
      ? ["version", "kind", "sourceId", "eventId", "revision", "fields"]
      : ["version", "kind", "sourceId", "eventId", "revision"],
  );
  const source =
    operation.type === "calendar_create" ? operation.source : operation.target;
  if (
    v.version !== 1 ||
    v.kind !== operation.type ||
    v.sourceId !== source.sourceId
  )
    throw Error("Calendar result scope mismatch");
  const result: CalendarResult = {
    version: 1,
    kind: operation.type,
    sourceId: id(v.sourceId),
    eventId: id(v.eventId),
    revision: revision(v.revision),
  };
  if (
    operation.type !== "calendar_create" &&
    result.eventId !== operation.target.eventId
  )
    throw Error("Calendar event changed");
  if (
    (operation.type === "calendar_delete" ||
      operation.type === "calendar_read_selected") &&
    result.revision !== operation.target.revision
  )
    throw Error("Calendar revision changed");
  if (operation.type === "calendar_read_selected")
    result.fields = calendarFields(v.fields);
  return result;
}
