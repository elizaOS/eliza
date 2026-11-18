// spec/os/android/calendar.md, "Story: Read my calendar and open Android's editor"; spec/os/android/calendar.md, "Story: Change exactly the event I reviewed"; spec/os/android/calendar.md, "Story: Delete the event, one occurrence or the whole series as I chose"
import type { LiveException, ProviderChange, SelectedRow, SeriesSync } from "../../../gen/os__android__calendar.ts";

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
  requestAccess(): Promise<AndroidCalendarAccess>;
  list(input: { begin: number; end: number }): Promise<AndroidCalendarList>;
  open(input: { id: string; begin?: number; end?: number }): Promise<{ status: "opened" }>;
  insertHandoff(input: { event: AndroidCalendarHandoffEvent }): Promise<AndroidCalendarInsertHandoff>;
  inspect(input: AndroidCalendarSelection): Promise<AndroidCalendarInspection>;
  save(input: AndroidCalendarSave): Promise<AndroidCalendarSaveReply>;
  inspectDeletion(input: AndroidCalendarSelection & { scope?: AndroidCalendarDeletionScope }): Promise<AndroidCalendarDeletionInspection>;
  dispatchDeletion(input: AndroidCalendarDeletionTarget): Promise<AndroidCalendarDeletionReply>;
}
