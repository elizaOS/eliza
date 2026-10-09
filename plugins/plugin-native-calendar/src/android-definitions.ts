/** Android provider contract. Promise rejection is separate from resolved status results. */
export interface AndroidCalendarSource {
  sourceId: string;
  sourceRevision: string;
}
export interface AndroidCalendarTarget extends AndroidCalendarSource {
  eventId: string;
  revision: string;
}
export interface AndroidCalendarFields {
  title: string;
  description: string;
  location: string;
  start: string;
  end: string;
  timeZone: string;
}
export interface AndroidCalendarExpected {
  title: string;
  body: string;
  location: string;
  begin: number;
  end: number;
}
export type AndroidCalendarOperation =
  | { type: "calendar_create_local"; fields: AndroidCalendarFields }
  | { type: "calendar_read_next" }
  | {
      type: "calendar_create";
      source: AndroidCalendarSource;
      fields: AndroidCalendarFields;
    }
  | {
      type: "calendar_update";
      target: AndroidCalendarTarget;
      fields: AndroidCalendarFields;
    }
  | {
      type: "calendar_delete" | "calendar_read_selected";
      target: AndroidCalendarTarget;
    };
export interface AndroidCalendarReceipt {
  version: 1;
  kind: Exclude<AndroidCalendarOperation["type"], "calendar_read_next">;
  sourceId: string;
  eventId: string;
  revision: string;
}
export type AndroidCalendarAgentResult =
  | {
      status: "applied";
      result: AndroidCalendarReceipt &
        (
          | { kind: "calendar_read_selected"; fields: AndroidCalendarFields }
          | {
              kind:
                | "calendar_create_local"
                | "calendar_create"
                | "calendar_update"
                | "calendar_delete";
            }
        );
    }
  | {
      status: "applied";
      result: {
        version: 1;
        kind: "calendar_read_next";
        window: { start: string; end: string; timeZone: string };
        event:
          | null
          | (Pick<
              AndroidCalendarFields,
              "title" | "start" | "end" | "timeZone"
            > & {
              allDay: boolean;
              timing: "ongoing" | "upcoming";
            });
      };
    }
  | {
      status:
        | "permission-required"
        | "unavailable"
        | "busy"
        | "conflict"
        | "cancelled"
        | "unknown";
    };
export type AndroidCalendarCreation =
  | { status: "saved"; creationId: string; id: string; calendarId: string }
  | { status: "unknown"; creationId: string };
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
}
export interface AndroidCalendarEditorFields {
  title: string;
  body?: string;
  location?: string;
  begin: number;
  end: number;
  calendarId?: string;
}
export type AndroidCalendarSave = AndroidCalendarEditorFields &
  (
    | { id?: ""; creationId: string; separateCreation?: boolean }
    | { id: string; expected: AndroidCalendarExpected & { revision: string } }
  );
export interface AndroidCalendarPlugin {
  requestAccess(): Promise<{ status: "granted" | "denied" }>;
  requestWorkflowReadAccess(): Promise<{ status: "granted" | "denied" }>;
  list(input: { begin: number; end: number }): Promise<
    | {
        status: "ready";
        calendars: AndroidCalendarRow[];
        events: AndroidCalendarEvent[];
        truncated: boolean;
      }
    | { status: "permission-required" }
  >;
  workflowCalendars(): Promise<
    | {
        status: "ready";
        calendars: Array<{ id: string; name: string; account: string }>;
      }
    | { status: "permission-required" }
  >;
  readWorkflowRange(input: {
    calendarIds: string[];
    start: string;
    end: string;
    maximumEvents: number;
  }): Promise<
    | {
        status: "ready";
        events: Array<{
          id: string;
          calendarId: string;
          title: string;
          start: string;
          end: string;
          allDay: boolean;
        }>;
      }
    | { status: "permission-required" }
  >;
  open(input: {
    id: string;
    begin?: number;
    end?: number;
  }): Promise<{ status: "opened" }>;
  inspect(input: {
    id: string;
    calendarId: string;
    expected: AndroidCalendarExpected;
  }): Promise<
    | { status: "ready"; revision: string; sourceRevision: string }
    | {
        status: "permission-required" | "unavailable" | "conflict" | "external";
      }
  >;
  remove(input: {
    id: string;
    calendarId: string;
    expected: AndroidCalendarExpected;
    revision: string;
  }): Promise<
    | { status: "deleted"; id: string; calendarId: string; revision: string }
    | {
        status:
          | "permission-required"
          | "unavailable"
          | "busy"
          | "conflict"
          | "external"
          | "cancelled"
          | "unknown";
      }
  >;
  save(
    input: AndroidCalendarSave,
  ): Promise<
    | AndroidCalendarCreation
    | { status: "saved"; id: string; calendarId: string }
    | { status: "permission-required" | "conflict" | "pending-creation" }
  >;
  pendingCreations(): Promise<
    | { status: "ready"; creations: AndroidCalendarCreation[] }
    | { status: "permission-required" }
  >;
  acknowledgeCreation(input: {
    creationId: string;
  }): Promise<{ status: "acknowledged" | "permission-required" }>;
  prepareAgentSource(): Promise<
    | ({ status: "ready" } & AndroidCalendarSource)
    | { status: "permission-required" | "unavailable" }
  >;
  executeAgent(input: {
    operationId: string;
    operation: AndroidCalendarOperation;
  }): Promise<AndroidCalendarAgentResult>;
  cancelAgent(input: { operationId: string }): Promise<{ status: "cancelled" }>;
}
