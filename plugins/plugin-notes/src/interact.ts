/**
 * Server interaction broker for Notes view capabilities.
 * The view registry supplies the owning runtime at dispatch time so each agent
 * reaches its own service instance. This boundary converts expected
 * validation/not-found failures into explicit capability results.
 */

import {
  ElizaError,
  type IAgentRuntime,
  isElizaError,
  toElizaError,
} from "@elizaos/core";
import { getNotesService, type NotesService } from "./service.js";
import type { NotesSnapshot, StickyNote } from "./types.js";
import { isRecord } from "./validation.js";

export interface NotesInteractResult {
  success: boolean;
  text: string;
  state?: NotesSnapshot;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

const EXPECTED_FAILURE_CODES = new Set([
  "NOTES_VALIDATION_FAILED",
  "NOTES_NOT_FOUND",
  "NOTES_AMBIGUOUS_NOTE",
  "NOTES_SERVICE_UNAVAILABLE",
  "NOTES_STORE_UNAVAILABLE",
]);

const PLANNER_SUMMARY_ITEM_LIMIT = 20;
const PLANNER_SUMMARY_EXCERPT_LENGTH = 160;

function paramsRecord(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new ElizaError("Capability params must be a JSON object.", {
      code: "NOTES_VALIDATION_FAILED",
      context: { field: "params" },
      severity: "ephemeral",
    });
  }
  return value;
}

function requiredParam(params: Record<string, unknown>, key: string): unknown {
  if (!(key in params)) {
    throw new ElizaError(`Capability param "${key}" is required.`, {
      code: "NOTES_VALIDATION_FAILED",
      context: { field: key },
      severity: "ephemeral",
    });
  }
  return params[key];
}

function assertOnlyParams(
  params: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unknownKey = Object.keys(params).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    throw new ElizaError(
      `Capability params contain unsupported field "${unknownKey}".`,
      {
        code: "NOTES_VALIDATION_FAILED",
        context: { field: unknownKey },
        severity: "ephemeral",
      },
    );
  }
}

function withoutId(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => key !== "id"),
  );
}

function summarizeNotes(notes: StickyNote[]): string {
  if (notes.length === 0) return "No sticky notes yet.";
  const visible = notes
    .slice(0, PLANNER_SUMMARY_ITEM_LIMIT)
    .map(
      (note) =>
        `${note.title}: ${note.body.slice(0, PLANNER_SUMMARY_EXCERPT_LENGTH)}`,
    );
  if (notes.length > visible.length) {
    visible.push(`${notes.length - visible.length} more notes not shown.`);
  }
  return visible.join("\n");
}


function normalizedLookup(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function resolveNoteTarget(
  notes: StickyNote[],
  params: Record<string, unknown>,
): string {
  if (typeof params.id === "string" && params.id.trim().length > 0) {
    return params.id;
  }
  const targetValue =
    typeof params.title === "string"
      ? params.title
      : typeof params.query === "string"
        ? params.query
        : "";
  const target = normalizedLookup(targetValue);
  if (target.length === 0) {
    throw new ElizaError("delete-note requires id, title, or query.", {
      code: "NOTES_VALIDATION_FAILED",
      context: { field: "id" },
      severity: "ephemeral",
    });
  }

  const exact = notes.filter((note) => normalizedLookup(note.title) === target);
  const candidates =
    exact.length > 0
      ? exact
      : notes.filter((note) =>
          normalizedLookup(`${note.title} ${note.body}`).includes(target),
        );
  if (candidates.length === 0) {
    throw new ElizaError(`No sticky note matches "${targetValue}".`, {
      code: "NOTES_NOT_FOUND",
      context: { kind: "note", target: targetValue },
      severity: "ephemeral",
    });
  }
  if (candidates.length > 1) {
    throw new ElizaError(
      `"${targetValue}" matches multiple sticky notes: ${candidates
        .map((note) => note.title)
        .join(", ")}.`,
      {
        code: "NOTES_AMBIGUOUS_NOTE",
        context: {
          target: targetValue,
          candidateIds: candidates.map((note) => note.id),
        },
        severity: "ephemeral",
      },
    );
  }
  const candidate = candidates[0];
  if (!candidate) {
    throw new ElizaError("Resolved sticky note was missing.", {
      code: "NOTES_NOTE_RESOLUTION_FAILED",
      severity: "fatal",
    });
  }
  return candidate.id;
}

function success(
  service: NotesService,
  text: string,
  data?: unknown,
): NotesInteractResult {
  const result: NotesInteractResult = {
    success: true,
    text,
    state: service.snapshot(),
  };
  if (data !== undefined) result.data = data;
  return result;
}

async function dispatchCapability(
  service: NotesService,
  capability: string,
  paramsValue?: Record<string, unknown>,
): Promise<NotesInteractResult> {
  const params = paramsRecord(paramsValue);
  if (capability === "get-notes") {
    assertOnlyParams(params, []);
    const notes = service.listNotes();
    return success(service, summarizeNotes(notes), { notes });
  }
  if (capability === "get-note") {
    assertOnlyParams(params, ["id"]);
    const note = service.getNote(requiredParam(params, "id"));
    return success(service, `Read sticky note "${note.title}".`, { note });
  }
  if (capability === "create-note") {
    const note = await service.createNote(params);
    return success(service, `Created sticky note "${note.title}".`, { note });
  }
  if (capability === "update-note") {
    const note = await service.updateNote(
      requiredParam(params, "id"),
      withoutId(params),
    );
    return success(service, `Updated sticky note "${note.title}".`, { note });
  }
  if (capability === "delete-note") {
    assertOnlyParams(params, ["id", "title", "query"]);
    const id = resolveNoteTarget(service.listNotes(), params);
    const note = await service.deleteNote(id);
    return success(service, `Deleted sticky note "${note.title}".`, { note });
  }
  if (capability === "clear-notes") {
    assertOnlyParams(params, []);
    const cleared = await service.clearNotes();
    return success(service, `Cleared ${cleared} sticky note(s).`, { cleared });
  }
  throw new ElizaError(
    `Notes does not support capability "${capability}".`,
    {
      code: "NOTES_UNKNOWN_CAPABILITY",
      context: { capability },
      severity: "ephemeral",
    },
  );
}

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
  service?: NotesService,
): Promise<NotesInteractResult> {
  try {
    if (!service) {
      throw new ElizaError(
        "Notes interaction requires an owning runtime service.",
        {
          code: "NOTES_SERVICE_UNAVAILABLE",
          severity: "ephemeral",
        },
      );
    }
    return await dispatchCapability(service, capability, params);
  } catch (error) {
    // error-policy:J1 boundary translation — expected capability input and
    // lookup failures become explicit false results; systemic store failures
    // continue upward to the shared view-route error boundary and diagnostics.
    const normalized = isElizaError(error)
      ? error
      : toElizaError(error, "NOTES_INTERACT_FAILED");
    if (!EXPECTED_FAILURE_CODES.has(normalized.code)) throw normalized;
    return {
      success: false,
      text: normalized.message,
      error: { code: normalized.code, message: normalized.message },
    };
  }
}

export async function serverInteract(
  capability: string,
  params?: Record<string, unknown>,
  context?: { runtime?: IAgentRuntime },
): Promise<NotesInteractResult> {
  if (!context?.runtime) {
    return interact(capability, params);
  }
  return interact(capability, params, getNotesService(context.runtime));
}
