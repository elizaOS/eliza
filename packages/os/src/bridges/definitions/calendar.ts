// spec/os/android/calendar.md, "Story: Read my calendar and open Android's editor"; spec/os/android/calendar.md, "Story: Change exactly the event I reviewed"; spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
import type { HandoffOutcome, WriteGate, WriteOutcome } from "../../../gen/os__android__bridge.ts";
import type { CalendarEdit, LiveException, ProviderChange, SelectedRow, SeriesSync } from "../../../gen/os__android__calendar.ts";
import type { DeletionClock, DeletionDeadline } from "../../../gen/os__android__deletionWindow.ts";

export interface AndroidCalendarExpected {
  title: string;
  body: string;
  location: string;
  begin: number;
  end: number;
}

export interface AndroidCalendarRow {
  id: string;
  name?: string;
  account?: string;
  writable: boolean;
  local: boolean;
}

export interface AndroidCalendarEvent {
  id: string;
  calendarId: string;
  title?: string;
  body?: string;
  location?: string;
  begin: number;
  end: number;
  allDay: boolean;
  recurring: boolean;
  creationId?: string;
}

export interface AndroidCalendarSelection {
  id: string;
  calendarId: string;
  expected: AndroidCalendarExpected;
}

export interface AndroidCalendarEditorFields {
  title: string;
  body?: string;
  location?: string;
  begin: number;
  end: number;
}

export type AndroidCalendarSave = AndroidCalendarEditorFields & {
  id: string;
  calendarId: string;
  expected: AndroidCalendarExpected & { revision: string };
};

export interface AndroidCalendarHandoffEvent {
  title: string;
  body?: string;
  location?: string;
  begin: number;
  end: number;
  allDay: boolean;
  timeZone?: string;
  rrule?: string;
  attendees?: string[];
  alerts?: number[];
}

export type AndroidCalendarDeletionScope = "event" | "occurrence" | "series";

export type AndroidCalendarRecurrence = "one-off" | "rule" | "date-list";

export interface AndroidCalendarScopeEvidence {
  selectedRow: SelectedRow;
  sync: SeriesSync;
  sourceCurrent: boolean;
  bounded: boolean;
  otherExceptions: boolean;
  liveException: LiveException;
  instances: number;
  begin: number;
  finish: number;
  exceptionOriginal: number;
}

export interface AndroidCalendarDeletionTarget {
  id: string;
  calendarId: string;
  revision: string;
  sourceRevision: string;
  change: Exclude<ProviderChange, "UpdateFields">;
  originalStart: number;
}

export interface AndroidCalendarReadback {
  parentAfter: "ParentGone" | "ParentLive";
  fieldsMatch: boolean;
  exclusionExact: boolean;
  cancelledAtStart: number;
  instanceRemains: boolean;
}

export type AndroidCalendarAccess = { status: "granted" | "denied" };

export type AndroidCalendarPermissionState = "granted" | "denied" | "prompt" | "prompt-with-rationale";

export type AndroidCalendarList =
  | { status: "ready"; calendars: AndroidCalendarRow[]; events: AndroidCalendarEvent[]; truncated: boolean }
  | { status: "permission-required" };

export type AndroidCalendarInspection =
  | { status: "ready"; revision: string; sourceRevision: string }
  | { status: "permission-required" | "unavailable" | "conflict" | "external" };

export type AndroidCalendarSaveReply =
  | { status: "saved"; id: string; calendarId: string }
  | { status: "permission-required" | "conflict" };

export type AndroidCalendarDeletionInspection =
  | {
      status: "ready";
      recurrence: AndroidCalendarRecurrence;
      writable: boolean;
      revision: string;
      sourceRevision: string;
      evidence: AndroidCalendarScopeEvidence;
    }
  | { status: "permission-required" | "unavailable" | "conflict" };

export type AndroidCalendarDeletionReply =
  | { status: "committed"; readback: AndroidCalendarReadback }
  | { status: "permission-required" | "conflict" | "unknown" };

export type AndroidCalendarInsertHandoff =
  | { status: "opened"; alertsPrefilled: boolean }
  | { status: "unavailable" | "invalid" | "unknown" };

export interface AndroidCalendarPlugin {
  checkPermissions(): Promise<{ calendar: AndroidCalendarPermissionState }>;
  requestAccess(): Promise<AndroidCalendarAccess>;
  list(input: { begin: number; end: number }): Promise<AndroidCalendarList>;
  open(input: { id: string; begin?: number; end?: number }): Promise<{ status: "opened" }>;
  insertHandoff(input: { event: AndroidCalendarHandoffEvent }): Promise<AndroidCalendarInsertHandoff>;
  inspect(input: AndroidCalendarSelection): Promise<AndroidCalendarInspection>;
  save(input: AndroidCalendarSave): Promise<AndroidCalendarSaveReply>;
  inspectDeletion(input: AndroidCalendarSelection & { scope?: AndroidCalendarDeletionScope }): Promise<AndroidCalendarDeletionInspection>;
  dispatchDeletion(input: AndroidCalendarDeletionTarget): Promise<AndroidCalendarDeletionReply>;
}

export type CalendarTicket = number & { readonly __brand: "CalendarTicket" };

export interface CalendarRange {
  begin: number;
  end: number;
}

export interface CalendarPick {
  event: AndroidCalendarEvent;
  calendar: AndroidCalendarRow;
}

export type CalendarInspectionResult =
  | { kind: "ready"; ticket: CalendarTicket; change: ProviderChange }
  | { kind: "editor" }
  | { kind: "conflict" };

export type CalendarFieldsProblem = "empty-title" | "title-too-long" | "body-too-long" | "location-too-long" | "invalid-range";

export interface CalendarHandoffReport {
  outcome: HandoffOutcome;
  reply: AndroidCalendarInsertHandoff;
}

export interface CalendarReview {
  state(): Promise<CalendarEdit>;
  openEditor(): Promise<HandoffOutcome>;
  inspectUpdate(): Promise<CalendarInspectionResult>;
  save(ticket: CalendarTicket, fields: AndroidCalendarEditorFields): Promise<WriteOutcome>;
  inspectDeletion(scope?: AndroidCalendarDeletionScope): Promise<CalendarInspectionResult>;
  stageDeletion(ticket: CalendarTicket): Promise<DeletionDeadline>;
  undoDeletion(): Promise<void>;
  dispatchDeletion(): Promise<WriteOutcome>;
  pause(): Promise<void>;
  refresh(): Promise<WriteGate>;
}

export interface CalendarClient {
  requestAccess(): Promise<AndroidCalendarAccess>;
  list(range: CalendarRange): Promise<AndroidCalendarList>;
  insertHandoff(event: AndroidCalendarHandoffEvent): Promise<CalendarHandoffReport>;
  review(pick: CalendarPick): CalendarReview;
}

export interface CalendarClientOptions {
  clock?: () => DeletionClock;
  plugin?: AndroidCalendarPlugin;
  name?: string;
}
