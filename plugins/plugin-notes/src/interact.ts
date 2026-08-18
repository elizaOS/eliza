/**
 * Server interaction broker for Notes view capabilities. The registry supplies
 * the owning runtime at dispatch time, and every successful mutation returns a
 * receipt bound to the exact durable revision that the user-facing reply cites.
 */

import {
  type EffectReceipt,
  ElizaError,
  type IAgentRuntime,
  isElizaError,
  toElizaError,
} from "@elizaos/core";
import { getNotesService, type NotesService } from "./service.js";
import type { NotesSnapshot, StickyNote } from "./types.js";
import { isRecord, parseNoteContent } from "./validation.js";

export interface NotesInteractResult {
  success: boolean;
  text: string;
  state?: NotesSnapshot;
  data?: unknown;
  effectReceipts?: readonly EffectReceipt[];
  userFacingEffectReceiptIds?: readonly string[];
  error?: {
    code: string;
    message: string;
  };
}

const EXPECTED_FAILURE_CODES = new Set([
  "NOTES_VALIDATION_FAILED",
  "NOTES_NOT_FOUND",
  "NOTES_AMBIGUOUS_NOTE",
  "NOTES_DELETE_NAME_MISMATCH",
  "NOTES_SERVICE_UNAVAILABLE",
  "NOTES_STORE_UNAVAILABLE",
]);

const PLANNER_SUMMARY_ITEM_LIMIT = 20;
const PLANNER_SUMMARY_EXCERPT_LENGTH = 160;

function quoted(value: string): string {
  return `“${value}”`;
}

function sentence(value: string): string {
  const text = value.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function humanDetails(value: string): string {
  const details = value.trim();
  return details.length > 0
    ? ` — ${details.slice(0, PLANNER_SUMMARY_EXCERPT_LENGTH)}`
    : "";
}

function noteSummary(note: StickyNote): string {
  return `${quoted(note.title)}${humanDetails(note.body)}`;
}

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

function summarizeNotes(notes: StickyNote[]): string {
  if (notes.length === 0) return "You don't have any notes yet.";
  const visible = notes
    .slice(0, PLANNER_SUMMARY_ITEM_LIMIT)
    .map((note) => noteSummary(note));
  if (notes.length > visible.length) {
    visible.push(`Plus ${notes.length - visible.length} more.`);
  }
  return notes.length === 1
    ? visible.join("")
    : `Here are your notes:\n${visible.map((note) => `• ${note}`).join("\n")}`;
}

type NoteSelector =
  | { selector: "id"; value: string }
  | { selector: "query"; value: string }
  | { selector: "title"; value: string };

function parseClearNotesConfirmation(
  params: Record<string, unknown>,
  currentRevision: number,
): number {
  assertOnlyParams(params, ["confirm", "expectedRevision"]);
  if (!Object.hasOwn(params, "confirm")) {
    throw new ElizaError("clear-notes requires confirm: true.", {
      code: "NOTES_VALIDATION_FAILED",
      context: { field: "confirm" },
      severity: "ephemeral",
    });
  }
  if (params.confirm !== true) {
    throw new ElizaError("clear-notes confirm must be the boolean true.", {
      code: "NOTES_VALIDATION_FAILED",
      context: { field: "confirm", value: params.confirm },
      severity: "ephemeral",
    });
  }
  if (!Object.hasOwn(params, "expectedRevision")) {
    throw new ElizaError(
      "clear-notes requires expectedRevision matching the current notes revision.",
      {
        code: "NOTES_VALIDATION_FAILED",
        context: { field: "expectedRevision" },
        severity: "ephemeral",
      },
    );
  }
  const expectedRevision = params.expectedRevision;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    throw new ElizaError(
      "clear-notes expectedRevision must be a non-negative integer.",
      {
        code: "NOTES_VALIDATION_FAILED",
        context: { field: "expectedRevision", value: expectedRevision },
        severity: "ephemeral",
      },
    );
  }
  if (expectedRevision !== currentRevision) {
    throw new ElizaError(
      "clear-notes expectedRevision is stale; refresh the notes snapshot and try again.",
      {
        code: "NOTES_VALIDATION_FAILED",
        context: {
          field: "expectedRevision",
          expectedRevision,
          currentRevision,
        },
        severity: "ephemeral",
      },
    );
  }
  return expectedRevision;
}

function parseLookupTarget(
  params: Record<string, unknown>,
  capability: string,
  selectorNames: readonly ("id" | "query" | "title")[],
): NoteSelector {
  const providedSelectors = selectorNames.filter((name) =>
    Object.hasOwn(params, name),
  );
  if (providedSelectors.length !== 1) {
    throw new ElizaError(
      `${capability} requires exactly one of ${selectorNames.join(", ")}.`,
      {
        code: "NOTES_VALIDATION_FAILED",
        context: {
          fields: selectorNames,
          providedFields: providedSelectors,
        },
        severity: "ephemeral",
      },
    );
  }
  const selector = providedSelectors[0];
  const selectorValue = selector ? params[selector] : undefined;
  if (
    !selector ||
    typeof selectorValue !== "string" ||
    selectorValue.trim().length === 0
  ) {
    throw new ElizaError(
      `${capability} ${selector ?? "selector"} must be a nonblank string.`,
      {
        code: "NOTES_VALIDATION_FAILED",
        context: { field: selector ?? "selector" },
        severity: "ephemeral",
      },
    );
  }
  const value = selectorValue.trim();
  return selector === "id" ? { selector, value } : { selector, value };
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

function mutationSuccess(
  state: NotesSnapshot,
  capability: string,
  resource: { kind: string; id: string },
  text: string,
  data?: unknown,
  replayed = false,
): NotesInteractResult {
  const observedAt = new Date().toISOString();
  const receiptId = `notes:${capability}:${resource.id}:${state.revision}`;
  const base = {
    receiptId,
    operation: `notes.${capability}`,
    resource: { ...resource, version: String(state.revision) },
    artifacts: [],
    idempotency: { key: replayed ? resource.id : null, replayed },
    observedAt,
  };
  const receipt: EffectReceipt = replayed
    ? {
        ...base,
        outcome: "noop",
        reason: "An identical note already exists.",
      }
    : {
        ...base,
        outcome: "applied",
        commit: {
          kind: "durable",
          id: `notes:revision:${state.revision}`,
          committedAt: observedAt,
        },
      };
  return {
    success: true,
    text,
    state,
    ...(data !== undefined ? { data } : {}),
    effectReceipts: [receipt],
    userFacingEffectReceiptIds: [receiptId],
  };
}

async function dispatchCapability(
  service: NotesService,
  capability: string,
  paramsValue?: Record<string, unknown>,
): Promise<NotesInteractResult> {
  const params = paramsRecord(paramsValue);
  if (capability === "get-notes") {
    assertOnlyParams(params, ["query"]);
    const target =
      Object.keys(params).length === 0
        ? null
        : parseLookupTarget(params, capability, ["query"]);
    const notes = target
      ? [service.getNoteByLookup("query", target.value)]
      : service.listNotes();
    return success(service, summarizeNotes(notes), { notes });
  }
  if (capability === "get-note") {
    assertOnlyParams(params, ["id", "title", "query"]);
    const target = parseLookupTarget(params, capability, [
      "id",
      "title",
      "query",
    ]);
    const note =
      target.selector === "id"
        ? service.getNote(target.value)
        : service.getNoteByLookup(target.selector, target.value);
    return success(service, sentence(noteSummary(note)), { note });
  }
  if (capability === "create-note") {
    assertOnlyParams(params, ["content", "color"]);
    const input = {
      ...parseNoteContent(params.content),
      ...(Object.hasOwn(params, "color") ? { color: params.color } : {}),
    };
    const {
      value: note,
      snapshot,
      replayed,
    } = await service.createNoteWithCommit(input);
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "notes.note", id: note.id },
      replayed
        ? `Note ${quoted(note.title)} already exists.`
        : `Created note ${quoted(note.title)}.`,
      { note, replayed },
      replayed,
    );
  }
  if (capability === "update-note") {
    assertOnlyParams(params, ["id", "title", "query", "content", "color"]);
    const target = parseLookupTarget(params, capability, [
      "id",
      "title",
      "query",
    ]);
    const patch: Record<string, unknown> = {
      ...(Object.hasOwn(params, "content")
        ? parseNoteContent(params.content)
        : {}),
      ...(Object.hasOwn(params, "color") ? { color: params.color } : {}),
    };
    const updated =
      target.selector === "id"
        ? await service.updateNoteWithCommit(target.value, patch)
        : await service.updateNoteByLookupWithCommit(
            target.selector,
            target.value,
            patch,
          );
    const { value: note, snapshot, consolidatedIds } = updated;
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "notes.note", id: note.id },
      consolidatedIds.length > 0
        ? `Updated note ${quoted(note.title)} and consolidated ${consolidatedIds.length + 1} identical copies.`
        : `Updated note ${quoted(note.title)}.`,
      { note, consolidatedCount: consolidatedIds.length, consolidatedIds },
    );
  }
  if (capability === "delete-note") {
    assertOnlyParams(params, ["id", "query", "title", "ownerText"]);
    const target = parseLookupTarget(params, capability, [
      "id",
      "query",
      "title",
    ]);
    // The user's original words, injected by the VIEWS dispatcher for
    // destructive capabilities. Id-selected deletes skip the fence (ids come
    // from structured contexts, not name translation).
    const ownerText =
      typeof params.ownerText === "string" ? params.ownerText : undefined;
    const removed =
      target.selector === "id"
        ? await service.deleteNoteWithCommit(target.value)
        : await service.deleteNoteByLookupWithCommit(
            target.selector,
            target.value,
            { requireTitleInText: ownerText },
          );
    const { value: note, snapshot, removedIds } = removed;
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "notes.note", id: note.id },
      removedIds.length > 1
        ? `Deleted note ${quoted(note.title)} and removed ${removedIds.length} identical copies.`
        : `Deleted note ${quoted(note.title)}.`,
      { note, removedCount: removedIds.length, removedIds },
    );
  }
  if (capability === "clear-notes") {
    // The synchronous check is a fast path against the current snapshot; the
    // authoritative guard runs atomically inside clearNotesWithCommit's write
    // barrier so a note committed in the dispatch/commit race window is not
    // silently wiped (issue #22122).
    const expectedRevision = parseClearNotesConfirmation(
      params,
      service.snapshot().revision,
    );
    const { value: cleared, snapshot } =
      await service.clearNotesWithCommit(expectedRevision);
    return mutationSuccess(
      snapshot,
      capability,
      { kind: "notes.note-collection", id: "notes" },
      cleared === 0
        ? "There were no notes to delete."
        : cleared === 1
          ? "Deleted your note."
          : `Deleted all ${cleared} notes.`,
      { cleared },
    );
  }
  throw new ElizaError(`Notes does not support capability "${capability}".`, {
    code: "NOTES_UNKNOWN_CAPABILITY",
    context: { capability },
    severity: "ephemeral",
  });
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
    // error-policy:J1 Expected capability input and lookup failures become
    // explicit false results; systemic failures reach the shared route boundary.
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
