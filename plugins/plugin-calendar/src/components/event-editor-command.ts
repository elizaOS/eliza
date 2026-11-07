/** Pure command projection shared by editors. UI parsing, drafts, authority and dispatch stay with callers. */
import type {
  CreateLifeOpsCalendarEventRequest,
  LifeOpsCalendarEvent,
  LifeOpsCalendarEventUpdate,
} from "@elizaos/contracts";
export type CalendarEditorRange =
  | { allDay: { startDate: string; endDateExclusive: string } }
  | { startAt: string; endAt: string };
export type CalendarEditorFields = {
  title: string;
  notes?: string;
  location?: string;
  timeZone?: string;
  attendees?: CreateLifeOpsCalendarEventRequest["attendees"];
  recurrence?: string[];
  recurrenceScope?: LifeOpsCalendarEventUpdate["recurrenceScope"];
};
type Common = { fields: CalendarEditorFields; operationKey: string };
type Create = Common & {
  kind: "create";
  range: CalendarEditorRange;
  source?: Pick<
    CreateLifeOpsCalendarEventRequest,
    "side" | "grantId" | "calendarId"
  >;
};
type Update = Common & {
  kind: "update";
  event: LifeOpsCalendarEvent;
  range?: CalendarEditorRange;
  changed: { timing: boolean; zone: boolean };
  source?: Pick<LifeOpsCalendarEventUpdate, "side" | "grantId" | "calendarId">;
  expectedProviderVersion?: string;
};
export type CalendarEditorCreateCommand = CreateLifeOpsCalendarEventRequest & {
  idempotencyKey: string;
};
export type CalendarEditorUpdateCommand = LifeOpsCalendarEventUpdate & {
  idempotencyKey: string;
  expectedProviderVersion?: string;
};
export function calendarEditorCommand(
  input: Create,
): CalendarEditorCreateCommand;
export function calendarEditorCommand(
  input: Update & { expectedProviderVersion: string },
): CalendarEditorUpdateCommand & { expectedProviderVersion: string };
export function calendarEditorCommand(
  input: Update,
): CalendarEditorUpdateCommand;
export function calendarEditorCommand(
  input: Create | Update,
): CalendarEditorCreateCommand | CalendarEditorUpdateCommand {
  const f = input.fields;
  if (!input.operationKey.trim())
    throw Error("Retain the editor operation key");
  if (input.kind === "create")
    return {
      ...input.source,
      title: f.title,
      ...(f.notes === undefined ? {} : { description: f.notes }),
      ...(f.location === undefined ? {} : { location: f.location }),
      ...structuredClone(input.range),
      ...(f.timeZone === undefined ? {} : { timeZone: f.timeZone }),
      ...(f.attendees === undefined
        ? {}
        : { attendees: structuredClone(f.attendees) }),
      ...(f.recurrence === undefined ? {} : { recurrence: [...f.recurrence] }),
      idempotencyKey: input.operationKey,
      notifyAttendees: false,
    };
  const e = input.event,
    patch: CalendarEditorUpdateCommand = {
      ...input.source,
      idempotencyKey: input.operationKey,
      notifyAttendees: false,
      ...(input.expectedProviderVersion === undefined
        ? {}
        : { expectedProviderVersion: input.expectedProviderVersion }),
      ...(f.recurrenceScope ? { recurrenceScope: f.recurrenceScope } : {}),
    };
  if (f.title !== e.title) patch.title = f.title;
  if (f.notes !== undefined && f.notes !== e.description) patch.notes = f.notes;
  if (f.location !== undefined && f.location !== e.location)
    patch.location = f.location;
  if (
    input.changed.zone &&
    f.timeZone !== undefined &&
    f.timeZone !== (e.timezone ?? f.timeZone)
  )
    patch.timeZone = f.timeZone;
  if (input.changed.timing) {
    const range = input.range;
    if (!range) throw Error("Review the changed event range");
    if ("allDay" in range) {
      const previous = {
        startDate: e.startAt.slice(0, 10),
        endDateExclusive: e.endAt.slice(0, 10),
      };
      if (
        !e.isAllDay ||
        JSON.stringify(range.allDay) !== JSON.stringify(previous)
      )
        patch.allDay = { ...range.allDay };
    } else {
      if (e.isAllDay || range.startAt !== e.startAt)
        patch.startAt = range.startAt;
      if (e.isAllDay || range.endAt !== e.endAt) patch.endAt = range.endAt;
    }
  }
  if (
    f.recurrence !== undefined &&
    JSON.stringify(f.recurrence) !== JSON.stringify(e.recurrence ?? [])
  ) {
    if (
      (e.recurringEventId || e.recurrence?.length) &&
      f.recurrenceScope !== "series"
    )
      throw Error("Choose entire-series scope to replace or remove recurrence");
    patch.recurrence = [...f.recurrence];
  }
  if (f.attendees !== undefined) patch.attendees = structuredClone(f.attendees);
  return patch;
}
