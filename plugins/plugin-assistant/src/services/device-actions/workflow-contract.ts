/** Canonical device proposal extension. These are data scopes, never executable code. */
export interface WorkflowDeviceBinding {
  workflowId: string;
  versionId: string;
  runId: string;
  stepId: string;
  specDigest: string;
}
export interface WorkflowDeviceTarget {
  installationId: string;
  enrollmentId: string;
}
export type WorkflowReadOperation =
  | {
      type: "read_selected_notes";
      /** 1..16 explicitly selected IDs. Revision is SHA256 of JSON.stringify([title,text]). */
      notes: Array<{ id: string; revision: string }>;
    }
  | {
      type: "read_calendar_range";
      /** 1..16 opaque CalendarProvider IDs; native permission rechecked at execution. */
      calendarIds: string[];
      /** Canonical UTC ISO strings, exclusive end; maximum seven days. */
      start: string;
      end: string;
      /** Human review zone, validated as an IANA identifier. */
      timeZone: string;
      /** 1..200. Overflow fails explicitly; it is never presented as complete. */
      maximumEvents: number;
    };
export type WorkflowPresentationOperation =
  | { type: "post_notification"; title: string; body: string }
  | { type: "speak_text"; text: string };

export type WorkflowReadResult =
  | {
      kind: "notes";
      notes: Array<{
        id: string;
        revision: string;
        title: string;
        text: string;
      }>;
    }
  | {
      kind: "calendar";
      events: Array<{
        id: string;
        calendarId: string;
        revision: string;
        title: string;
        start: string;
        end: string;
        allDay: boolean;
      }>;
    };
/**
 * Existing payload keeps action=device_action, version=1, installationId/enrollmentId.
 * Optional workflow binding is digest-covered and displayed on every review.
 * Read operations are only legal WITH a workflow binding; existing create_note supports it.
 * Applied read receipts add result:WorkflowReadResult to outcome/operationId.
 * Phone journals exact result before upload; receipt reconciliation never repeats the read.
 * Full encoded result <=64KiB; no truncation. Server validates exact selected IDs/revisions,
 * calendar membership/range and count before committing the canonical queue receipt.
 * Run/step/spec/owner/device are checked by trusted server dispatch, not request body claims.
 */
export interface WorkflowDeviceDispatch {
  binding: WorkflowDeviceBinding;
  target: WorkflowDeviceTarget;
  operation:
    | WorkflowReadOperation
    | WorkflowPresentationOperation
    | { type: "create_note"; title: string; body: string };
}

import { createHash } from "node:crypto";
import {
  DeviceActionError,
  exactKeys,
  identifier,
  object,
  text,
} from "./contract.ts";

function reject(message: string): never {
  throw new DeviceActionError(message);
}
export function workflowDigest(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-f0-9]{64}$/.test(result)) return reject("Invalid workflow digest");
  return result;
}
export function validateWorkflowBinding(value: unknown): WorkflowDeviceBinding {
  const p = object(value);
  exactKeys(p, ["workflowId", "versionId", "runId", "stepId", "specDigest"]);
  return {
    workflowId: identifier(p.workflowId),
    versionId: identifier(p.versionId),
    runId: identifier(p.runId),
    stepId: identifier(p.stepId),
    specDigest: workflowDigest(p.specDigest),
  };
}
function utc(value: unknown): string {
  const result = text(value, 30);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    return reject("Calendar time requires canonical UTC milliseconds");
  return result;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum)
    return reject("Invalid selected source count");
  return value;
}
export function validateWorkflowReadOperation(
  value: unknown,
): WorkflowReadOperation {
  const p = object(value);
  if (p.type === "read_selected_notes") {
    exactKeys(p, ["type", "notes"]);
    const notes = list(p.notes, 16).map((raw) => {
      const note = object(raw);
      exactKeys(note, ["id", "revision"]);
      return {
        id: identifier(note.id),
        revision: workflowDigest(note.revision),
      };
    });
    if (new Set(notes.map((note) => note.id)).size !== notes.length)
      return reject("Duplicate selected note");
    return { type: p.type, notes };
  }
  if (p.type === "read_calendar_range") {
    exactKeys(p, [
      "type",
      "calendarIds",
      "start",
      "end",
      "timeZone",
      "maximumEvents",
    ]);
    const calendarIds = list(p.calendarIds, 16).map(identifier),
      start = utc(p.start),
      end = utc(p.end);
    if (new Set(calendarIds).size !== calendarIds.length)
      return reject("Duplicate calendar");
    if (
      Date.parse(end) <= Date.parse(start) ||
      Date.parse(end) - Date.parse(start) > 7 * 86400000
    )
      return reject("Calendar range exceeds reviewed bound");
    const timeZone = text(p.timeZone, 100);
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    } catch {
      return reject("Invalid calendar review time zone");
    }
    if (
      typeof p.maximumEvents !== "number" ||
      !Number.isInteger(p.maximumEvents) ||
      p.maximumEvents < 1 ||
      p.maximumEvents > 200
    )
      return reject("Invalid calendar event bound");
    return {
      type: p.type,
      calendarIds,
      start,
      end,
      timeZone,
      maximumEvents: p.maximumEvents,
    };
  }
  return reject("Unsupported workflow read operation");
}
export function validateWorkflowReadResult(
  operation: WorkflowReadOperation,
  value: unknown,
): WorkflowReadResult {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 65536)
    return reject("Workflow read result exceeds reviewed bound");
  const p = object(value);
  if (operation.type === "read_selected_notes") {
    exactKeys(p, ["kind", "notes"]);
    if (
      p.kind !== "notes" ||
      !Array.isArray(p.notes) ||
      p.notes.length !== operation.notes.length
    )
      return reject("Selected note result is incomplete");
    const notes = p.notes.map((raw, index) => {
      const note = object(raw);
      exactKeys(note, ["id", "revision", "title", "text"]);
      const expected = operation.notes[index];
      const result = {
        id: identifier(note.id),
        revision: workflowDigest(note.revision),
        title: text(note.title, 256, true),
        text: text(note.text, 32000, true),
      };
      const revision = createHash("sha256")
        .update(JSON.stringify([result.title, result.text]))
        .digest("hex");
      if (
        result.id !== expected.id ||
        result.revision !== expected.revision ||
        revision !== result.revision
      )
        return reject("Selected note changed or result binding mismatched");
      return result;
    });
    return { kind: "notes", notes };
  }
  exactKeys(p, ["kind", "events"]);
  if (
    p.kind !== "calendar" ||
    !Array.isArray(p.events) ||
    p.events.length > operation.maximumEvents
  )
    return reject("Calendar result exceeds selected scope");
  const events = p.events.map((raw) => {
    const event = object(raw);
    exactKeys(event, [
      "id",
      "calendarId",
      "revision",
      "title",
      "start",
      "end",
      "allDay",
    ]);
    const result = {
      id: identifier(event.id),
      calendarId: identifier(event.calendarId),
      revision: workflowDigest(event.revision),
      title: text(event.title, 1000, true),
      start: utc(event.start),
      end: utc(event.end),
      allDay: event.allDay,
    };
    if (
      typeof result.allDay !== "boolean" ||
      !operation.calendarIds.includes(result.calendarId) ||
      Date.parse(result.end) < Date.parse(result.start) ||
      Date.parse(result.start) >= Date.parse(operation.end) ||
      (Date.parse(result.end) <= Date.parse(operation.start) &&
        !(
          result.start === result.end &&
          Date.parse(result.start) >= Date.parse(operation.start)
        ))
    )
      return reject("Calendar event is outside selected scope");
    const revision = createHash("sha256")
      .update(
        JSON.stringify([
          result.id,
          result.calendarId,
          result.title,
          result.start,
          result.end,
          result.allDay,
        ]),
      )
      .digest("hex");
    if (revision !== result.revision)
      return reject("Calendar event revision mismatched");
    return { ...result, allDay: result.allDay };
  });
  if (
    new Set(
      events.map((event) =>
        JSON.stringify([event.calendarId, event.id, event.start]),
      ),
    ).size !== events.length
  )
    return reject("Duplicate calendar occurrence");
  return { kind: "calendar", events };
}
