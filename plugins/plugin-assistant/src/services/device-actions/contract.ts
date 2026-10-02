import {
  type CalendarOperation,
  validateCalendarOperation,
} from "./calendar-contract.ts";
import { type MapsOperation, validateMapsOperation } from "./maps-contract.ts";
import {
  type NotesOperation,
  validateNotesOperation,
} from "./notes-contract.ts";
import {
  type ReminderOperation,
  validateReminderOperation,
} from "./reminder-contract.ts";
import {
  validateWorkflowBinding,
  validateWorkflowReadOperation,
  type WorkflowDeviceBinding,
  type WorkflowPresentationOperation,
  type WorkflowReadOperation,
} from "./workflow-contract.ts";
export class DeviceActionError extends Error {
  override readonly name = "DeviceActionError";
  constructor(
    message: string,
    readonly code:
      | "DEVICE_REQUEST_REJECTED"
      | "DEVICE_STORE_UNAVAILABLE" = "DEVICE_REQUEST_REJECTED",
  ) {
    super(message);
  }
}
/** Closed, versioned phone operations. Validation rejects rather than truncates. */
export const DEVICE_VIEWS = [
  "home",
  "notes",
  "reminders",
  "browser",
  "calendar",
  "files",
  "photos",
  "camera",
  "maps",
  "inbox",
  "settings",
  "workflows",
] as const;
export type DeviceOperation =
  | MapsOperation
  | ReminderOperation
  | NotesOperation
  | CalendarOperation
  | WorkflowReadOperation
  | WorkflowPresentationOperation
  | { type: "create_note"; title: string; body: string }
  | { type: "create_reminder"; title: string; dueAt: string }
  | { type: "open_view"; view: (typeof DEVICE_VIEWS)[number] }
  | { type: "browser_navigate"; url: string };
export type DeviceActionPayload = {
  action: "device_action";
  version: 1;
  installationId: string;
  enrollmentId: string;
  operation: DeviceOperation;
  workflow?: WorkflowDeviceBinding;
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DeviceActionError("Expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, max: number, empty = false): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max ||
    value.includes("\0")
  )
    throw new DeviceActionError("Invalid text");
  return value;
}
export function identifier(value: unknown): string {
  const id = text(value, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
    throw new DeviceActionError("Invalid identifier");
  return id;
}
export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new DeviceActionError("Unexpected field");
}
export function validateDeviceOperation(value: unknown): DeviceOperation {
  const p = object(value);
  switch (p.type) {
    case "maps_read_selected":
      try {
        return validateMapsOperation(p);
      } catch {
        throw new DeviceActionError("Invalid Maps operation");
      }
    case "reminder_read_selected":
    case "reminder_update":
    case "reminder_complete":
    case "reminder_snooze":
    case "reminder_cancel":
      try {
        return validateReminderOperation(p);
      } catch {
        throw new DeviceActionError("Invalid reminder operation");
      }
    case "notes_read_selected":
    case "notes_update":
    case "notes_delete":
      try {
        return validateNotesOperation(p);
      } catch {
        throw new DeviceActionError("Invalid Notes operation");
      }
    case "calendar_create":
    case "calendar_read_selected":
    case "calendar_update":
    case "calendar_delete":
      try {
        return validateCalendarOperation(p);
      } catch {
        throw new DeviceActionError("Invalid Calendar operation");
      }
    case "post_notification":
      exactKeys(p, ["type", "title", "body"]);
      return {
        type: p.type,
        title: text(p.title, 200),
        body: text(p.body, 2000),
      };
    case "speak_text":
      exactKeys(p, ["type", "text"]);
      return { type: p.type, text: text(p.text, 5000) };
    case "read_selected_notes":
    case "read_calendar_range":
      return validateWorkflowReadOperation(p);
    case "create_note":
      exactKeys(p, ["type", "title", "body"]);
      return {
        type: p.type,
        title: text(p.title, 256),
        body: text(p.body, 32000, true),
      };
    case "create_reminder": {
      exactKeys(p, ["type", "title", "dueAt"]);
      const dueAt = text(p.dueAt, 40);
      if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(dueAt) ||
        !Number.isFinite(Date.parse(dueAt)) ||
        new Date(dueAt).toISOString().replace(".000Z", "Z") !==
          dueAt.replace(".000Z", "Z")
      )
        throw new DeviceActionError("Reminder requires an absolute UTC time");
      return { type: p.type, title: text(p.title, 200), dueAt };
    }
    case "open_view":
      exactKeys(p, ["type", "view"]);
      if (!(DEVICE_VIEWS as readonly unknown[]).includes(p.view))
        throw new DeviceActionError("Unsupported view");
      return { type: p.type, view: p.view as (typeof DEVICE_VIEWS)[number] };
    case "browser_navigate": {
      exactKeys(p, ["type", "url"]);
      let url: URL;
      try {
        url = new URL(text(p.url, 4096));
      } catch {
        throw new DeviceActionError("Invalid browser destination");
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new DeviceActionError(
          "Only HTTPS browser destinations are supported",
        );
      return { type: p.type, url: url.href };
    }
    default:
      throw new DeviceActionError("Unsupported device operation");
  }
}
export function validateDevicePayload(value: unknown): DeviceActionPayload {
  const p = object(value);
  exactKeys(p, [
    "action",
    "version",
    "installationId",
    "enrollmentId",
    "operation",
    "workflow",
  ]);
  if (p.action !== "device_action" || p.version !== 1)
    throw new DeviceActionError("Unsupported device protocol");
  const operation = validateDeviceOperation(p.operation);
  if (
    [
      "read_selected_notes",
      "read_calendar_range",
      "post_notification",
      "speak_text",
    ].includes(operation.type) &&
    !p.workflow
  )
    throw new DeviceActionError("Workflow read binding required");
  return {
    action: p.action,
    version: 1,
    installationId: identifier(p.installationId),
    enrollmentId: identifier(p.enrollmentId),
    operation,
    ...(p.workflow === undefined
      ? {}
      : { workflow: validateWorkflowBinding(p.workflow) }),
  };
}
