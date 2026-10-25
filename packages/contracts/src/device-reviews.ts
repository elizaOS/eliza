/**
 * Browser-safe contracts for device operations a phone resolves in a foreground local
 * review before anything is shared or changed: free/busy reads over owner-selected
 * calendars, local Notes search, and name-targeted edits disambiguated by the owner.
 *
 * Domain record validation (Notes, Calendar, reminder fields, exact selected-record
 * operations and their results) stays with the plugin that owns those records; callers
 * pass those validators in. Nothing here grants device permission.
 */

// ---- Calendar availability (free/busy) ----
/** Free/busy read over owner-selected calendars; shares busy intervals, never event content. */
export const CALENDAR_AVAILABILITY_CAPABILITY = "calendar.availability-read.v1";
/** Native range reads are bounded to seven days and 200 instances. */
export const CALENDAR_AVAILABILITY_MAX_MS = 7 * 86400000;
export const CALENDAR_AVAILABILITY_MAX_BUSY = 200;
export const CALENDAR_AVAILABILITY_MAX_CALENDARS = 16;
export interface CalendarAvailabilityOperation {
  type: "calendar_availability";
  start: string;
  end: string;
  timeZone: string;
}
/** Provider availability: Android AVAILABILITY_BUSY/FREE/TENTATIVE. */
export type CalendarEventAvailability = "busy" | "free" | "tentative";
export interface CalendarAvailabilityEvent {
  start: string;
  end: string;
  allDay: boolean;
  availability: CalendarEventAvailability;
}
export interface CalendarBusyInterval {
  start: string;
  end: string;
  allDay: boolean;
  tentative: boolean;
}
export interface CalendarAvailabilityResult {
  version: 1;
  kind: "calendar_availability";
  window: { start: string; end: string; timeZone: string };
  /** Number of owner-selected calendars that were read; never their identities. */
  calendarCount: number;
  status: "free" | "busy";
  busy: CalendarBusyInterval[];
  /** Events marked free (transparent) that overlapped and were ignored. */
  transparentIgnored: number;
}
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Calendar availability object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Unexpected Calendar availability fields");
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw Error("Invalid Calendar availability instant");
  return value;
}
function zone(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 128 ||
    value.includes("\0")
  )
    throw Error("Invalid Calendar availability timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
  } catch {
    throw Error("Invalid Calendar availability timezone");
  }
  return value;
}
function count(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw Error("Invalid Calendar availability count");
  return value;
}
export function isCalendarAvailabilityOperation(
  value: unknown,
): value is CalendarAvailabilityOperation {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "calendar_availability"
  );
}
export function validateCalendarAvailabilityOperation(
  value: unknown,
): CalendarAvailabilityOperation {
  const v = obj(value);
  keys(v, ["type", "start", "end", "timeZone"]);
  if (v.type !== "calendar_availability")
    throw Error("Unsupported Calendar availability operation");
  const start = instant(v.start),
    end = instant(v.end);
  const span = Date.parse(end) - Date.parse(start);
  if (Date.parse(start) < 0 || span <= 0 || span > CALENDAR_AVAILABILITY_MAX_MS)
    throw Error(
      "Calendar availability needs an end after start, at most seven days later",
    );
  return { type: v.type, start, end, timeZone: zone(v.timeZone) };
}
/** Midnight in timeZone of the civil date encoded by a UTC-midnight all-day bound. */
function civilMidnight(utcMidnight: number, timeZone: string): number {
  const date = new Date(utcMidnight);
  const y = date.getUTCFullYear(),
    m = date.getUTCMonth(),
    d = date.getUTCDate();
  // Resolve the zone offset at the local civil-day boundary.
  let guess = Date.UTC(y, m, d);
  for (let pass = 0; pass < 3; pass++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
        .formatToParts(guess)
        .map((part) => [part.type, part.value]),
    );
    const local = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    guess += Date.UTC(y, m, d) - local;
  }
  return guess;
}
/**
 * Computes the shared free/busy answer from provider rows the phone read locally.
 * Transparent (free) events never make the owner busy; tentative events do and are
 * flagged; all-day events block their whole owner-local civil days.
 */
export function calendarAvailability(
  operation: CalendarAvailabilityOperation,
  calendarCount: number,
  events: readonly CalendarAvailabilityEvent[],
): CalendarAvailabilityResult {
  const op = validateCalendarAvailabilityOperation(operation);
  count(calendarCount, 1, CALENDAR_AVAILABILITY_MAX_CALENDARS);
  if (!Array.isArray(events) || events.length > CALENDAR_AVAILABILITY_MAX_BUSY)
    throw Error("Calendar availability exceeds the reviewed event bound");
  const begin = Date.parse(op.start),
    finish = Date.parse(op.end);
  const busy: CalendarBusyInterval[] = [];
  let transparentIgnored = 0;
  for (const value of events) {
    const event = obj(value);
    keys(event, ["start", "end", "allDay", "availability"]);
    if (
      typeof event.allDay !== "boolean" ||
      typeof event.availability !== "string" ||
      !["busy", "free", "tentative"].includes(event.availability)
    )
      throw Error("Invalid Calendar availability event");
    let a = Date.parse(instant(event.start)),
      b = Date.parse(instant(event.end));
    if (event.allDay) {
      if (a % 86400000 !== 0 || b % 86400000 !== 0 || b <= a)
        throw Error("Invalid all-day civil interval");
      a = civilMidnight(a, op.timeZone);
      b = civilMidnight(b, op.timeZone);
    } else if (b < a) throw Error("Invalid Calendar availability interval");
    // Zero-length timed events occupy no time.
    if (b <= begin || a >= finish || b === a) continue;
    if (event.availability === "free") {
      transparentIgnored++;
      continue;
    }
    busy.push({
      start: new Date(Math.max(a, begin)).toISOString(),
      end: new Date(Math.min(b, finish)).toISOString(),
      allDay: event.allDay,
      tentative: event.availability === "tentative",
    });
  }
  busy.sort(
    (x, y) =>
      x.start.localeCompare(y.start) ||
      x.end.localeCompare(y.end) ||
      Number(x.allDay) - Number(y.allDay) ||
      Number(x.tentative) - Number(y.tentative),
  );
  return validateCalendarAvailabilityResult(op, {
    version: 1,
    kind: "calendar_availability",
    window: { start: op.start, end: op.end, timeZone: op.timeZone },
    calendarCount,
    status: busy.length ? "busy" : "free",
    busy,
    transparentIgnored,
  });
}
export function validateCalendarAvailabilityResult(
  operation: CalendarAvailabilityOperation,
  value: unknown,
): CalendarAvailabilityResult {
  operation = validateCalendarAvailabilityOperation(operation);
  const v = obj(value);
  keys(v, [
    "version",
    "kind",
    "window",
    "calendarCount",
    "status",
    "busy",
    "transparentIgnored",
  ]);
  const window = obj(v.window);
  keys(window, ["start", "end", "timeZone"]);
  if (
    v.version !== 1 ||
    v.kind !== "calendar_availability" ||
    window.start !== operation.start ||
    window.end !== operation.end ||
    window.timeZone !== operation.timeZone
  )
    throw Error("Calendar availability window changed");
  const begin = Date.parse(operation.start),
    finish = Date.parse(operation.end);
  if (!Array.isArray(v.busy) || v.busy.length > CALENDAR_AVAILABILITY_MAX_BUSY)
    throw Error("Invalid Calendar busy intervals");
  let previous = "";
  const busy = v.busy.map((item) => {
    const interval = obj(item);
    keys(interval, ["start", "end", "allDay", "tentative"]);
    const start = instant(interval.start),
      end = instant(interval.end);
    if (
      typeof interval.allDay !== "boolean" ||
      typeof interval.tentative !== "boolean" ||
      Date.parse(start) < begin ||
      Date.parse(end) > finish ||
      Date.parse(end) <= Date.parse(start) ||
      start < previous
    )
      throw Error("Calendar busy interval outside the approved window");
    previous = start;
    return {
      start,
      end,
      allDay: interval.allDay,
      tentative: interval.tentative,
    };
  });
  const status = busy.length ? "busy" : "free";
  if (v.status !== status) throw Error("Calendar availability status changed");
  return {
    version: 1,
    kind: "calendar_availability",
    window: {
      start: operation.start,
      end: operation.end,
      timeZone: operation.timeZone,
    },
    calendarCount: count(
      v.calendarCount,
      1,
      CALENDAR_AVAILABILITY_MAX_CALENDARS,
    ),
    status,
    busy,
    transparentIgnored: count(
      v.transparentIgnored,
      0,
      CALENDAR_AVAILABILITY_MAX_BUSY,
    ),
  };
}

// ---- Notes search ----
export const NOTES_SEARCH_CAPABILITY = "notes.search.v1";
export const NOTES_TITLES_LIMIT = 50;
/** Owner-chosen notes record as returned by the Notes plugin's selected read. */
export interface NotesSearchSelection<Target = unknown, Selected = unknown> {
  target: Target;
  record: Selected;
}
export type NotesSearchOperation = {
  type: "notes_search";
  query: { kind: "content"; text: string } | { kind: "titles"; limit: number };
};
export type NotesSearchResult<Target = unknown, Selected = unknown> =
  | {
      version: 1;
      kind: "notes_search";
      query: NotesSearchOperation["query"];
      basis: "no-match";
    }
  | {
      version: 1;
      kind: "notes_search";
      query: { kind: "content"; text: string };
      /** Content matched locally; the owner chose this note before its text was shared. */
      basis: "content-match";
      target: Target;
      record: Selected;
    }
  | {
      version: 1;
      kind: "notes_search";
      query: { kind: "titles"; limit: number };
      /** The owner reviewed exactly these titles before they were shared. */
      basis: "titles-reviewed";
      /** Most recently updated first; at most query.limit entries. */
      titles: string[];
      /** True when more saved notes exist than the reviewed listing shows. */
      truncated: boolean;
    };
function searchObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Notes search");
  return value as Record<string, unknown>;
}
function searchKeys(value: Record<string, unknown>, expected: string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Unexpected Notes search fields");
}
function notesSearchQuery(value: unknown): NotesSearchOperation["query"] {
  const q = searchObject(value);
  if (q.kind === "content") {
    searchKeys(q, ["kind", "text"]);
    if (
      typeof q.text !== "string" ||
      !q.text.trim() ||
      q.text.length > 256 ||
      q.text.includes("\0")
    )
      throw Error("Notes content search text is required");
    return { kind: "content", text: q.text };
  }
  if (q.kind === "titles") {
    searchKeys(q, ["kind", "limit"]);
    if (
      typeof q.limit !== "number" ||
      !Number.isSafeInteger(q.limit) ||
      q.limit < 1 ||
      q.limit > NOTES_TITLES_LIMIT
    )
      throw Error(`Notes titles listing is limited to 1-${NOTES_TITLES_LIMIT}`);
    return { kind: "titles", limit: q.limit };
  }
  throw Error("Unsupported Notes search");
}
export function isNotesSearchOperation(
  value: unknown,
): value is NotesSearchOperation {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "notes_search"
  );
}
export function validateNotesSearchOperation(
  value: unknown,
): NotesSearchOperation {
  const v = searchObject(value);
  searchKeys(v, ["type", "query"]);
  if (v.type !== "notes_search") throw Error("Invalid Notes search operation");
  return { type: "notes_search", query: notesSearchQuery(v.query) };
}
/**
 * selectedRead validates the chosen note's identity and its selected-read record with the
 * Notes contract; only that note's text may appear in a content-match result.
 */
export function validateNotesSearchResult<Target, Selected>(
  operation: NotesSearchOperation,
  value: unknown,
  selectedRead: (
    target: unknown,
    record: unknown,
  ) => NotesSearchSelection<Target, Selected>,
): NotesSearchResult<Target, Selected> {
  const op = validateNotesSearchOperation(operation);
  const v = searchObject(value);
  const base = ["version", "kind", "query", "basis"];
  searchKeys(
    v,
    v.basis === "no-match"
      ? base
      : v.basis === "titles-reviewed"
        ? [...base, "titles", "truncated"]
        : [...base, "target", "record"],
  );
  if (v.version !== 1 || v.kind !== "notes_search")
    throw Error("Invalid Notes search receipt");
  if (JSON.stringify(notesSearchQuery(v.query)) !== JSON.stringify(op.query))
    throw Error("Notes search changed");
  if (v.basis === "no-match")
    return {
      version: 1,
      kind: "notes_search",
      query: op.query,
      basis: "no-match",
    };
  if (op.query.kind === "titles") {
    if (v.basis !== "titles-reviewed")
      throw Error("Notes listing proof changed");
    if (
      !Array.isArray(v.titles) ||
      v.titles.length < 1 ||
      v.titles.length > op.query.limit ||
      typeof v.truncated !== "boolean" ||
      v.titles.some(
        (title) =>
          typeof title !== "string" ||
          title.length > 500 ||
          title.includes("\0"),
      )
    )
      throw Error("Invalid reviewed Notes titles");
    return {
      version: 1,
      kind: "notes_search",
      query: op.query,
      basis: "titles-reviewed",
      titles: [...(v.titles as string[])],
      truncated: v.truncated,
    };
  }
  if (v.basis !== "content-match") throw Error("Notes search proof changed");
  const selected = selectedRead(v.target, v.record);
  return {
    version: 1,
    kind: "notes_search",
    query: op.query,
    basis: "content-match",
    target: selected.target,
    record: selected.record,
  };
}

// ---- Name-targeted edits from Home ----
export const NAMED_TARGET_CAPABILITY = "device.named-target.v1";
/** Selected-record capability each named domain also requires. */
export const NAMED_TARGET_DOMAIN_CAPABILITY = {
  notes_named: "notes.local-record.v1",
  calendar_named: "calendar.local-event.v1",
  reminder_named: "reminders.local-record.v1",
} as const;
export type NamedTargetType = keyof typeof NAMED_TARGET_DOMAIN_CAPABILITY;
export interface NamedNotesFields {
  title: string;
  body: string;
}
export interface NamedCalendarFields {
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  timeZone: string;
}
export interface NamedReminderFields {
  title: string;
  body: string;
  schedule?: unknown;
}
export type NamedTargetOperation =
  | {
      type: "notes_named";
      action: "update";
      name: string;
      fields: NamedNotesFields;
    }
  | { type: "notes_named"; action: "delete"; name: string }
  | {
      type: "calendar_named";
      action: "update";
      name: string;
      fields: NamedCalendarFields;
    }
  | { type: "calendar_named"; action: "delete"; name: string }
  | {
      type: "reminder_named";
      action: "update";
      name: string;
      fields: NamedReminderFields;
    }
  | { type: "reminder_named"; action: "cancel"; name: string };
/** Exact selected-record operation the owner's local choice resolves to. */
export interface NamedTargetExact {
  type: string;
  target: unknown;
  fields?: unknown;
}
export type NamedTargetResult<Exact = NamedTargetExact, Applied = unknown> =
  | {
      version: 1;
      kind: NamedTargetType;
      action: NamedTargetOperation["action"];
      name: string;
      basis: "no-match";
    }
  | {
      version: 1;
      kind: NamedTargetType;
      action: NamedTargetOperation["action"];
      name: string;
      /** The owner chose this record among local matches (possibly the only one). */
      basis: "owner-chosen";
      operation: Exact;
      record: Applied;
    };
/** Domain validators supplied by the plugin that owns Notes, Calendar and reminder records. */
export interface NamedTargetValidators<
  Exact extends NamedTargetExact = NamedTargetExact,
  Applied = unknown,
> {
  notesFields(value: unknown): NamedNotesFields;
  calendarFields(value: unknown): NamedCalendarFields;
  reminderFields(value: unknown): NamedReminderFields;
  /** Validates an exact selected-record operation (for example notes_delete). */
  exact(value: NamedTargetExact): Exact;
  /** Validates the applied record result of that exact operation. */
  record(operation: Exact, value: unknown): Applied;
}
const NAMED_ACTIONS: Record<NamedTargetType, readonly string[]> = {
  notes_named: ["update", "delete"],
  calendar_named: ["update", "delete"],
  reminder_named: ["update", "cancel"],
};
function namedObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid named target object");
  return value as Record<string, unknown>;
}
function namedKeys(value: Record<string, unknown>, expected: string[]) {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    throw Error("Unexpected named target fields");
}
function recordName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    value.includes("\0")
  )
    throw Error("A record name is required");
  return value;
}
export function isNamedTargetOperation(
  value: unknown,
): value is NamedTargetOperation {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { type?: unknown }).type === "string" &&
    Object.hasOwn(
      NAMED_TARGET_DOMAIN_CAPABILITY,
      (value as { type: string }).type,
    )
  );
}
export function namedTargetCapabilityAvailable(
  type: string,
  capabilities?: readonly string[],
): boolean {
  const domain = NAMED_TARGET_DOMAIN_CAPABILITY[type as NamedTargetType];
  return (
    !!domain &&
    capabilities?.includes(NAMED_TARGET_CAPABILITY) === true &&
    (capabilities.includes(domain) ||
      (type === "reminder_named" &&
        capabilities.includes("reminders.local-record.v2")))
  );
}
/** Exact-target operation type the local review resolves to. */
export function namedTargetExactType(operation: NamedTargetOperation): string {
  if (operation.type === "notes_named")
    return operation.action === "update" ? "notes_update" : "notes_delete";
  if (operation.type === "calendar_named")
    return operation.action === "update"
      ? "calendar_update"
      : "calendar_delete";
  return operation.action === "update" ? "reminder_update" : "reminder_cancel";
}
export function validateNamedTargetOperation(
  value: unknown,
  validators: Pick<
    NamedTargetValidators,
    "notesFields" | "calendarFields" | "reminderFields"
  >,
): NamedTargetOperation {
  const v = namedObject(value);
  if (!isNamedTargetOperation(v)) throw Error("Unsupported named target");
  if (typeof v.action !== "string" || !NAMED_ACTIONS[v.type].includes(v.action))
    throw Error("Unsupported named target action");
  const name = recordName(v.name);
  if (v.action === "update") {
    namedKeys(v, ["type", "action", "name", "fields"]);
    if (v.type === "notes_named")
      return {
        type: v.type,
        action: "update",
        name,
        fields: validators.notesFields(v.fields),
      };
    if (v.type === "calendar_named")
      return {
        type: v.type,
        action: "update",
        name,
        fields: validators.calendarFields(v.fields),
      };
    return {
      type: "reminder_named",
      action: "update",
      name,
      fields: validators.reminderFields(v.fields),
    };
  }
  namedKeys(v, ["type", "action", "name"]);
  if (v.type === "notes_named") return { type: v.type, action: "delete", name };
  if (v.type === "calendar_named")
    return { type: v.type, action: "delete", name };
  return { type: "reminder_named", action: "cancel", name };
}
/**
 * Builds the exact selected-record operation for the record the owner chose. Fields
 * come from the reviewed named proposal, never from the local match.
 */
export function resolveNamedTarget<Exact extends NamedTargetExact>(
  operation: NamedTargetOperation,
  target: unknown,
  validators: Pick<
    NamedTargetValidators<Exact>,
    "notesFields" | "calendarFields" | "reminderFields" | "exact"
  >,
): Exact {
  const op = validateNamedTargetOperation(operation, validators);
  const type = namedTargetExactType(op);
  const exact = validators.exact(
    "fields" in op ? { type, target, fields: op.fields } : { type, target },
  );
  if (exact.type !== type)
    throw Error("Named target resolved to another operation");
  return exact;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}
export function validateNamedTargetResult<
  Exact extends NamedTargetExact,
  Applied,
>(
  operation: NamedTargetOperation,
  value: unknown,
  validators: NamedTargetValidators<Exact, Applied>,
): NamedTargetResult<Exact, Applied> {
  const op = validateNamedTargetOperation(operation, validators);
  const v = namedObject(value);
  const base = ["version", "kind", "action", "name", "basis"];
  namedKeys(
    v,
    v.basis === "no-match" ? base : [...base, "operation", "record"],
  );
  if (
    v.version !== 1 ||
    v.kind !== op.type ||
    v.action !== op.action ||
    v.name !== op.name
  )
    throw Error("Named target result scope changed");
  if (v.basis === "no-match")
    return {
      version: 1,
      kind: op.type,
      action: op.action,
      name: op.name,
      basis: "no-match",
    };
  if (v.basis !== "owner-chosen") throw Error("Named target proof changed");
  const exact = namedObject(v.operation);
  const resolved = resolveNamedTarget(op, exact.target, validators);
  if (JSON.stringify(canonical(resolved)) !== JSON.stringify(canonical(exact)))
    throw Error("Named target operation changed");
  return {
    version: 1,
    kind: op.type,
    action: op.action,
    name: op.name,
    basis: "owner-chosen",
    operation: resolved,
    record: validators.record(resolved, v.record),
  };
}

// ---- Shared dispatch ----
export const DEVICE_REVIEW_TYPES = [
  "calendar_availability",
  "notes_search",
  "notes_named",
  "calendar_named",
  "reminder_named",
] as const;
export type DeviceReviewOperation =
  | CalendarAvailabilityOperation
  | NotesSearchOperation
  | NamedTargetOperation;
export function isDeviceReviewType(type: unknown): boolean {
  return (DEVICE_REVIEW_TYPES as readonly unknown[]).includes(type);
}
export function isDeviceReviewOperation(
  value: unknown,
): value is DeviceReviewOperation {
  return (
    !!value &&
    typeof value === "object" &&
    isDeviceReviewType((value as { type?: unknown }).type)
  );
}
/** Each family requires its own negotiated capability (plus the domain record capability). */
export function deviceReviewCapabilityAvailable(
  type: string,
  capabilities?: readonly string[],
): boolean {
  if (type === "calendar_availability")
    return capabilities?.includes(CALENDAR_AVAILABILITY_CAPABILITY) === true;
  if (type === "notes_search")
    return (
      capabilities?.includes(NOTES_SEARCH_CAPABILITY) === true &&
      capabilities.includes(NAMED_TARGET_DOMAIN_CAPABILITY.notes_named)
    );
  return namedTargetCapabilityAvailable(type, capabilities);
}
