/** Provider-neutral, closed Calendar device contract. No observation grants permission. */
export const CALENDAR_CAPABILITY = "calendar.local-event.v1";
export const CALENDAR_CREATE_CAPABILITY = "calendar.create.v1";
export const CALENDAR_NEXT_CAPABILITY = "calendar.next-read.v1";
export interface CalendarWindow {
  start: string;
  end: string;
  timeZone: string;
}
export function calendarCapabilityAvailable(
  type: CalendarOperation["type"],
  capabilities?: readonly string[],
): boolean {
  return (
    capabilities?.includes(
      type === "calendar_create_local"
        ? CALENDAR_CREATE_CAPABILITY
        : type === "calendar_read_next"
          ? CALENDAR_NEXT_CAPABILITY
          : CALENDAR_CAPABILITY,
    ) === true
  );
}
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
  | { type: "calendar_create_local"; fields: CalendarFields }
  | { type: "calendar_read_next" }
  | { type: "calendar_create"; source: CalendarSource; fields: CalendarFields }
  | { type: "calendar_read_selected"; target: CalendarTarget }
  | { type: "calendar_update"; target: CalendarTarget; fields: CalendarFields }
  | { type: "calendar_delete"; target: CalendarTarget };
export interface CalendarRecordResult {
  version: 1;
  kind: Exclude<CalendarOperation["type"], "calendar_read_next">;
  sourceId: string;
  eventId: string;
  revision: string;
  fields?: CalendarFields;
}
export interface CalendarNextResult {
  version: 1;
  kind: "calendar_read_next";
  window: CalendarWindow;
  event: null | {
    title: string;
    start: string;
    end: string;
    allDay: boolean;
    timing: "ongoing" | "upcoming";
    timeZone: string;
  };
}
export type CalendarResult = CalendarRecordResult | CalendarNextResult;
export function calendarWindow(value: unknown): CalendarWindow {
  const v = obj(value);
  keys(v, ["start", "end", "timeZone"]);
  const start = instant(v.start),
    end = instant(v.end),
    timeZone = string(v.timeZone, 128);
  if (
    Date.parse(start) < 0 ||
    Date.parse(end) <= Date.parse(start) ||
    Date.parse(end) - Date.parse(start) > 31 * 86400000
  )
    throw Error("Calendar discovery window must be at most thirty-one days");
  new Intl.DateTimeFormat("en", { timeZone }).format(0);
  return { start, end, timeZone };
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
      "calendar_create_local",
      "calendar_read_next",
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
    case "calendar_create_local":
      keys(v, ["type", "fields"]);
      return { type: v.type, fields: calendarFields(v.fields) };
    case "calendar_read_next":
      keys(v, ["type"]);
      return { type: v.type };
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
  if (operation.type === "calendar_read_next") {
    keys(v, ["version", "kind", "window", "event"]);
    const window = calendarWindow(v.window);
    if (v.version !== 1 || v.kind !== operation.type)
      throw Error("Calendar discovery result window changed");
    const civil = (at: number) => {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en", {
          timeZone: window.timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .formatToParts(at)
          .map((p) => [p.type, p.value]),
      );
      return Date.parse(
        `${parts.year}-${parts.month}-${parts.day}T00:00:00.000Z`,
      );
    };
    const endParts = new Intl.DateTimeFormat("en", {
      timeZone: window.timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(Date.parse(window.end));
    if (
      civil(Date.parse(window.end)) - civil(Date.parse(window.start)) !==
        30 * 86400000 ||
      endParts.some(
        (p) =>
          ["hour", "minute", "second"].includes(p.type) &&
          Number(p.value) !== 0,
      ) ||
      Date.parse(window.end) % 1000 !== 0
    )
      throw Error(
        "Calendar discovery must cover the native thirty-local-day window",
      );
    if (v.event === null)
      return { version: 1, kind: operation.type, window, event: null };
    const e = obj(v.event);
    keys(e, ["title", "start", "end", "allDay", "timing", "timeZone"]);
    const start = instant(e.start),
      end = instant(e.end);
    if (
      typeof e.allDay !== "boolean" ||
      e.timeZone !== window.timeZone ||
      (e.allDay
        ? Date.parse(end) <= Date.parse(start) ||
          Date.parse(start) % 86400000 !== 0 ||
          Date.parse(end) % 86400000 !== 0
        : Date.parse(end) < Date.parse(start))
    )
      throw Error("Invalid discovered event");
    const startParts = new Intl.DateTimeFormat("en", {
      timeZone: window.timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(Date.parse(window.start));
    const afterMidnight =
      Date.parse(window.start) % 1000 !== 0 ||
      startParts.some(
        (p) =>
          ["hour", "minute", "second"].includes(p.type) &&
          Number(p.value) !== 0,
      );
    const ongoing =
      e.allDay &&
      (Date.parse(start) < civil(Date.parse(window.start)) ||
        (Date.parse(start) === civil(Date.parse(window.start)) &&
          afterMidnight));
    if (
      e.timing !== (ongoing ? "ongoing" : "upcoming") ||
      (!e.allDay && Date.parse(start) < Date.parse(window.start))
    )
      throw Error("Calendar next-event timing changed");
    const begin = e.allDay
      ? civil(Date.parse(window.start))
      : Date.parse(window.start);
    const endDay = e.allDay
      ? civil(Date.parse(window.end) - 1) + 86400000
      : Date.parse(window.end);
    if (
      Date.parse(start) >= endDay ||
      (start === end ? Date.parse(start) < begin : Date.parse(end) <= begin)
    )
      throw Error("Discovered event outside approved window");
    return {
      version: 1,
      kind: operation.type,
      window,
      event: {
        title: string(e.title, 1000, true),
        start,
        end,
        allDay: e.allDay,
        timing: ongoing ? "ongoing" : "upcoming",
        timeZone: window.timeZone,
      },
    };
  }
  keys(
    v,
    operation.type === "calendar_read_selected"
      ? ["version", "kind", "sourceId", "eventId", "revision", "fields"]
      : ["version", "kind", "sourceId", "eventId", "revision"],
  );
  const source =
    operation.type === "calendar_create_local"
      ? undefined
      : operation.type === "calendar_create"
        ? operation.source
        : operation.target;
  if (
    v.version !== 1 ||
    v.kind !== operation.type ||
    (source !== undefined && v.sourceId !== source.sourceId)
  )
    throw Error("Calendar result scope mismatch");
  const result: CalendarRecordResult = {
    version: 1,
    kind: operation.type,
    sourceId: id(v.sourceId),
    eventId: id(v.eventId),
    revision: revision(v.revision),
  };
  if (
    operation.type !== "calendar_create" &&
    operation.type !== "calendar_create_local" &&
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
