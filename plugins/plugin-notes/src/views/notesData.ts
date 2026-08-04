/**
 * Browser-side transport and validation for the Notes bundle. The server owns
 * all state; this module accepts only the authenticated route envelopes and
 * domain shapes shared with the plugin before exposing them to React or the
 * mounted-view interaction broker.
 */

import { fetchWithCsrf } from "@elizaos/ui/api/csrf-client";
import { NOTES_CAPABILITIES } from "../capabilities.js";
import type { NotesSnapshot, StickyColor, StickyNote } from "../types.js";

export const NOTES_STATE_UPDATED_EVENT = "notes:state-updated";
export const NOTES_UPDATED_EVENT = "view:notes:updated";

export interface NotesInteractResult {
  success: true;
  text: string;
  state: NotesSnapshot;
}

const NOTES_CAPABILITY_IDS = new Set(NOTES_CAPABILITIES.map(({ id }) => id));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Notes response field "${key}" must be a string.`);
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
    throw new Error(`Notes response field "${key}" has an invalid color.`);
  }
  return value;
}

function parseNote(value: unknown): StickyNote {
  if (!isRecord(value)) {
    throw new Error("Notes returned an invalid note.");
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

function parseSnapshot(value: unknown): NotesSnapshot {
  if (!isRecord(value)) {
    throw new Error("Notes returned an invalid state snapshot.");
  }
  if (!Array.isArray(value.notes)) {
    throw new Error("Notes state must contain a notes array.");
  }
  if (
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0
  ) {
    throw new Error("Notes state revision is invalid.");
  }
  return {
    notes: value.notes.map(parseNote),
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
  return new Error(`Notes request failed with HTTP ${status}.`);
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
  return new Error("Notes returned an invalid broker failure result.");
}

function parseBrokerResult(value: unknown): NotesInteractResult {
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    value.requestId.trim().length === 0 ||
    typeof value.success !== "boolean"
  ) {
    throw new Error("Notes returned an invalid broker envelope.");
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
    throw new Error("Notes returned an invalid broker result.");
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
    throw new Error("Notes returned malformed JSON.", { cause });
  }
}

export async function fetchNotesState(): Promise<NotesSnapshot> {
  const response = await fetchWithCsrf("/api/notes/state", {
    headers: { Accept: "application/json" },
  });
  const value = await readJson(response);
  if (!response.ok) {
    throw parseErrorEnvelope(value, response.status);
  }
  if (!isRecord(value) || value.success !== true || !("data" in value)) {
    throw new Error("Notes returned an invalid success envelope.");
  }
  return parseSnapshot(value.data);
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<NotesInteractResult> {
  if (!NOTES_CAPABILITY_IDS.has(capability)) {
    throw new Error(`Notes does not support capability "${capability}".`);
  }
  const response = await fetchWithCsrf("/api/views/notes/interact", {
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
