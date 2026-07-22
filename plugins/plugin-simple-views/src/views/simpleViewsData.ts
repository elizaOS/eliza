/**
 * Browser-side transport and validation for the Simple Views bundle. The
 * server owns all state; this module accepts only the authenticated route
 * envelopes and domain shapes shared with the plugin before exposing them to
 * React or the mounted-view interaction broker.
 */

import { fetchWithCsrf } from "@elizaos/ui/api/csrf-client";
import { CALENDAR_CAPABILITIES, NOTES_CAPABILITIES } from "../capabilities.js";
import type {
  SimpleCalendarEvent,
  SimpleViewsSnapshot,
  StickyColor,
  StickyNote,
} from "../types.js";

export const SIMPLE_VIEWS_UPDATED_EVENT = "simple-views:state-updated";
export const NOTES_UPDATED_EVENT = "view:notes:updated";
export const SIMPLE_CALENDAR_UPDATED_EVENT = "view:simple-calendar:updated";

export interface SimpleViewsInteractResult {
  success: true;
  text: string;
  state: SimpleViewsSnapshot;
}

const VIEW_ID_BY_CAPABILITY = new Map<string, "notes" | "simple-calendar">([
  ...NOTES_CAPABILITIES.map(({ id }) => [id, "notes"] as const),
  ...CALENDAR_CAPABILITIES.map(({ id }) => [id, "simple-calendar"] as const),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Simple Views response field "${key}" must be a string.`);
  }
  return value;
}

function readStickyColor(
  record: Record<string, unknown>,
  key: string,
): StickyColor {
  const value = record[key];
  if (
    value !== "yellow" &&
    value !== "green" &&
    value !== "rose" &&
    value !== "slate"
  ) {
    throw new Error(
      `Simple Views response field "${key}" has an invalid color.`,
    );
  }
  return value;
}

function parseNote(value: unknown): StickyNote {
  if (!isRecord(value)) {
    throw new Error("Simple Views returned an invalid note.");
  }
  return {
    id: readString(value, "id"),
    title: readString(value, "title"),
    body: readString(value, "body"),
    color: readStickyColor(value, "color"),
    createdAt: readString(value, "createdAt"),
    updatedAt: readString(value, "updatedAt"),
  };
}

function parseCalendarEvent(value: unknown): SimpleCalendarEvent {
  if (!isRecord(value)) {
    throw new Error("Simple Views returned an invalid calendar event.");
  }
  return {
    id: readString(value, "id"),
    title: readString(value, "title"),
    date: readString(value, "date"),
    time: readString(value, "time"),
    notes: readString(value, "notes"),
    color: readStickyColor(value, "color"),
    createdAt: readString(value, "createdAt"),
    updatedAt: readString(value, "updatedAt"),
  };
}

function parseSnapshot(value: unknown): SimpleViewsSnapshot {
  if (!isRecord(value)) {
    throw new Error("Simple Views returned an invalid state snapshot.");
  }
  if (!Array.isArray(value.notes) || !Array.isArray(value.events)) {
    throw new Error("Simple Views state must contain notes and events arrays.");
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    throw new Error("Simple Views state revision is invalid.");
  }
  return {
    notes: value.notes.map(parseNote),
    events: value.events.map(parseCalendarEvent),
    selectedDate: readString(value, "selectedDate"),
    revision: value.revision,
  };
}

function parseErrorEnvelope(value: unknown, status: number): Error {
  if (isRecord(value) && typeof value.error === "string") {
    return new Error(value.error);
  }
  if (
    isRecord(value) &&
    value.success === false &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  ) {
    return new Error(value.error.message, { cause: value.error.code });
  }
  return new Error(`Simple Views request failed with HTTP ${status}.`);
}

function parseBrokerFailure(value: Record<string, unknown>): Error {
  if (typeof value.error === "string" && value.error.trim()) {
    return new Error(value.error);
  }
  if (
    isRecord(value.result) &&
    value.result.success === false &&
    typeof value.result.text === "string" &&
    value.result.text.trim()
  ) {
    return new Error(value.result.text);
  }
  return new Error("Simple Views returned an invalid broker failure result.");
}

function parseBrokerResult(value: unknown): SimpleViewsInteractResult {
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    value.requestId.trim().length === 0 ||
    typeof value.success !== "boolean"
  ) {
    throw new Error("Simple Views returned an invalid broker envelope.");
  }
  if (!value.success) {
    throw parseBrokerFailure(value);
  }
  if (
    !isRecord(value.result) ||
    value.result.success !== true ||
    typeof value.result.text !== "string" ||
    !("state" in value.result)
  ) {
    throw new Error("Simple Views returned an invalid broker result.");
  }
  return {
    success: true,
    text: value.result.text,
    state: parseSnapshot(value.result.state),
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (cause) {
    // error-policy:J2 retain the parser cause at the authenticated API boundary.
    throw new Error("Simple Views returned malformed JSON.", { cause });
  }
}

export async function fetchSimpleViewsState(): Promise<SimpleViewsSnapshot> {
  const response = await fetchWithCsrf("/api/simple-views/state", {
    headers: { Accept: "application/json" },
  });
  const value = await readJson(response);
  if (!response.ok) {
    throw parseErrorEnvelope(value, response.status);
  }
  if (!isRecord(value) || value.success !== true || !("data" in value)) {
    throw new Error("Simple Views returned an invalid success envelope.");
  }
  return parseSnapshot(value.data);
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<SimpleViewsInteractResult> {
  const viewId = VIEW_ID_BY_CAPABILITY.get(capability);
  if (!viewId) {
    throw new Error(
      `Simple Views does not support capability "${capability}".`,
    );
  }
  const response = await fetchWithCsrf(`/api/views/${viewId}/interact`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ capability, ...(params ? { params } : {}) }),
  });
  const value = await readJson(response);
  if (!response.ok) {
    throw parseErrorEnvelope(value, response.status);
  }
  return parseBrokerResult(value);
}
