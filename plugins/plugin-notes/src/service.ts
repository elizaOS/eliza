/**
 * Server-owned Notes domain service. It is the only layer allowed to mutate
 * the durable per-agent document; HTTP routes and view capabilities call this
 * API so validation, identity, timestamps, and restart behavior remain
 * identical across every entry point.
 */

import { randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import { NotesStore } from "./store.js";
import type {
  NotesSnapshot,
  NotesStoreStatus,
  StickyNote,
  UpdateNoteInput,
} from "./types.js";
import {
  parseCreateNoteInput,
  parseEntityId,
  parseUpdateNoteInput,
} from "./validation.js";

export const NOTES_SERVICE_TYPE = "notes";
export const NOTES_STATE_UPDATED_EVENT = "notes:state-updated";

function isBroadcastService(
  value: unknown,
): value is { broadcastWs(data: object): void } {
  return (
    value !== null &&
    typeof value === "object" &&
    "broadcastWs" in value &&
    typeof value.broadcastWs === "function"
  );
}

function notFound(id: string): ElizaError {
  return new ElizaError(`Note "${id}" was not found.`, {
    code: "NOTES_NOT_FOUND",
    context: { kind: "note", id },
    severity: "ephemeral",
  });
}

type NoteLookupSelector = "title" | "query";

function normalizedLookup(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function lookupError(
  code: "NOTES_NOT_FOUND" | "NOTES_AMBIGUOUS_NOTE",
  selector: NoteLookupSelector,
  value: string,
  candidates: StickyNote[],
): ElizaError {
  const target = value.trim();
  return new ElizaError(
    code === "NOTES_NOT_FOUND"
      ? `No sticky note matches "${target}".`
      : `"${target}" matches multiple sticky notes: ${candidates
          .map((note) => note.title)
          .join(", ")}.`,
    {
      code,
      context: {
        kind: "note",
        selector,
        target,
        candidateIds: candidates.map((note) => note.id),
      },
      severity: "ephemeral",
    },
  );
}

/** Identity key for copies with exactly the same user-visible content. */
function noteContentKey(note: StickyNote): string {
  return `${note.title}\0${note.body}`;
}

function resolveNoteIndex(
  notes: StickyNote[],
  selector: NoteLookupSelector,
  value: string,
): number {
  const target = normalizedLookup(value);
  const exact = notes
    .map((note, index) => ({ index, note }))
    .filter(({ note }) => normalizedLookup(note.title) === target);
  const candidates =
    selector === "title" || exact.length > 0
      ? exact
      : notes
          .map((note, index) => ({ index, note }))
          .filter(({ note }) =>
            normalizedLookup(`${note.title} ${note.body}`).includes(target),
          );
  if (candidates.length === 0) {
    throw lookupError("NOTES_NOT_FOUND", selector, value, []);
  }
  // Ambiguity exists only between notes a user could tell apart. Multiple
  // byte-identical copies (the duplicate-create case) are one logical note:
  // asking "which one?" has no answerable form, and refusing made identical
  // duplicates permanently unaddressable through chat. Differing matches keep
  // the explicit ambiguity error.
  if (
    candidates.length > 1 &&
    new Set(candidates.map(({ note }) => noteContentKey(note))).size > 1
  ) {
    throw lookupError(
      "NOTES_AMBIGUOUS_NOTE",
      selector,
      value,
      candidates.map(({ note }) => note),
    );
  }
  const candidate = candidates[0];
  if (!candidate) {
    throw new ElizaError("Resolved sticky note was missing.", {
      code: "NOTES_NOTE_RESOLUTION_FAILED",
      severity: "fatal",
    });
  }
  return candidate.index;
}

function applyNotePatch(
  existing: StickyNote,
  patch: UpdateNoteInput,
  updatedAt: string,
): StickyNote {
  const updated: StickyNote = { ...existing, updatedAt };
  if (patch.title !== undefined) updated.title = patch.title;
  if (patch.body !== undefined) updated.body = patch.body;
  if (patch.color !== undefined) updated.color = patch.color;
  return updated;
}

export class NotesService extends Service {
  static override readonly serviceType = NOTES_SERVICE_TYPE;

  override capabilityDescription =
    "Durable managed Cloud Notes CRUD with view switching.";

  readonly store: NotesStore;

  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly eventRuntime: IAgentRuntime | undefined;

  constructor(
    runtime?: IAgentRuntime,
    options: {
      store?: NotesStore;
      stateDir?: string;
      now?: () => Date;
      createId?: () => string;
    } = {},
  ) {
    super(runtime);
    this.eventRuntime = runtime;
    this.store = options.store
      ? options.store
      : new NotesStore({
          stateDir: options.stateDir,
          agentId: runtime ? String(runtime.agentId) : undefined,
        });
    this.now = options.now ? options.now : () => new Date();
    this.createId = options.createId
      ? options.createId
      : () => `note-${randomUUID()}`;
  }

  static override async start(runtime: IAgentRuntime): Promise<NotesService> {
    const service = new NotesService(runtime);
    await service.initialize();
    logger.info(
      {
        src: "plugin-notes",
        filePath: service.store.filePath,
      },
      "[NotesService] Ready",
    );
    return service;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  override async stop(): Promise<void> {
    await this.store.stop();
    logger.info({ src: "plugin-notes" }, "[NotesService] Stopped");
  }

  status(): NotesStoreStatus {
    return this.store.getStatus();
  }

  snapshot(): NotesSnapshot {
    return this.store.snapshot();
  }

  listNotes(): StickyNote[] {
    return this.snapshot().notes;
  }

  getNote(idValue: unknown): StickyNote {
    const id = parseEntityId(idValue);
    const note = this.snapshot().notes.find((candidate) => candidate.id === id);
    if (!note) throw notFound(id);
    return note;
  }

  getNoteByLookup(selector: NoteLookupSelector, value: string): StickyNote {
    const notes = this.snapshot().notes;
    const note = notes[resolveNoteIndex(notes, selector, value)];
    if (!note) {
      throw new ElizaError("Resolved sticky note was missing.", {
        code: "NOTES_NOTE_RESOLUTION_FAILED",
        severity: "fatal",
      });
    }
    return note;
  }

  async createNoteWithCommit(
    inputValue: unknown,
  ): Promise<{ value: StickyNote; snapshot: NotesSnapshot }> {
    const input = parseCreateNoteInput(inputValue);
    const now = this.now().toISOString();
    const id = parseEntityId(this.createId());
    const transaction = await this.store.transact((draft) => {
      if (draft.notes.some((note) => note.id === id)) {
        throw new ElizaError(`Notes generated duplicate note id "${id}".`, {
          code: "NOTES_DUPLICATE_ID",
          context: { kind: "note", id },
          severity: "fatal",
        });
      }
      const note: StickyNote = {
        id,
        title: input.title,
        body: input.body,
        color: input.color,
        createdAt: now,
        updatedAt: now,
      };
      draft.notes.unshift(note);
      return note;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:created");
    return transaction;
  }

  async createNote(inputValue: unknown): Promise<StickyNote> {
    return (await this.createNoteWithCommit(inputValue)).value;
  }

  async updateNoteWithCommit(
    idValue: unknown,
    patchValue: unknown,
  ): Promise<{ value: StickyNote; snapshot: NotesSnapshot }> {
    const id = parseEntityId(idValue);
    const patch = parseUpdateNoteInput(patchValue);
    const updatedAt = this.now().toISOString();
    const transaction = await this.store.transact((draft) => {
      const index = draft.notes.findIndex((note) => note.id === id);
      const existing = draft.notes[index];
      if (index < 0 || !existing) throw notFound(id);
      const updated = applyNotePatch(existing, patch, updatedAt);
      draft.notes[index] = updated;
      return updated;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:updated");
    return transaction;
  }

  async updateNote(idValue: unknown, patchValue: unknown): Promise<StickyNote> {
    return (await this.updateNoteWithCommit(idValue, patchValue)).value;
  }

  async updateNoteByLookupWithCommit(
    selector: NoteLookupSelector,
    value: string,
    patchValue: unknown,
  ): Promise<{ value: StickyNote; snapshot: NotesSnapshot }> {
    const patch = parseUpdateNoteInput(patchValue);
    const updatedAt = this.now().toISOString();
    const transaction = await this.store.transact((draft) => {
      const index = resolveNoteIndex(draft.notes, selector, value);
      const existing = draft.notes[index];
      if (!existing) {
        throw new ElizaError("Resolved sticky note was missing.", {
          code: "NOTES_NOTE_RESOLUTION_FAILED",
          severity: "fatal",
        });
      }
      const updated = applyNotePatch(existing, patch, updatedAt);
      draft.notes[index] = updated;
      return updated;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:updated");
    return transaction;
  }

  async deleteNoteWithCommit(
    idValue: unknown,
  ): Promise<{ value: StickyNote; snapshot: NotesSnapshot }> {
    const id = parseEntityId(idValue);
    const transaction = await this.store.transact((draft) => {
      const index = draft.notes.findIndex((note) => note.id === id);
      const existing = draft.notes[index];
      if (index < 0 || !existing) throw notFound(id);
      draft.notes.splice(index, 1);
      return existing;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:deleted");
    return transaction;
  }

  async deleteNote(idValue: unknown): Promise<StickyNote> {
    return (await this.deleteNoteWithCommit(idValue)).value;
  }

  async deleteNoteByLookupWithCommit(
    selector: NoteLookupSelector,
    value: string,
  ): Promise<{
    value: StickyNote;
    snapshot: NotesSnapshot;
    removedCount: number;
  }> {
    let removedCount = 0;
    const transaction = await this.store.transact((draft) => {
      const index = resolveNoteIndex(draft.notes, selector, value);
      const existing = draft.notes[index];
      if (!existing) {
        throw new ElizaError("Resolved sticky note was missing.", {
          code: "NOTES_NOTE_RESOLUTION_FAILED",
          severity: "fatal",
        });
      }
      // Deleting "the note" deletes every byte-identical copy: duplicates are
      // one logical note, and leaving three identical survivors after "delete
      // the milk note" contradicts what the deletion just confirmed.
      const key = noteContentKey(existing);
      const kept = draft.notes.filter((note) => noteContentKey(note) !== key);
      removedCount = draft.notes.length - kept.length;
      draft.notes = kept;
      return existing;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:deleted");
    return { ...transaction, removedCount };
  }

  async clearNotesWithCommit(): Promise<{
    value: number;
    snapshot: NotesSnapshot;
  }> {
    const transaction = await this.store.transact((draft) => {
      const count = draft.notes.length;
      draft.notes = [];
      return count;
    });
    await this.emitStateUpdated(transaction.snapshot, "notes:cleared");
    return transaction;
  }

  async clearNotes(): Promise<number> {
    return (await this.clearNotesWithCommit()).value;
  }

  private async emitStateUpdated(
    snapshot: NotesSnapshot,
    mutation: string,
  ): Promise<void> {
    if (!this.eventRuntime) return;
    try {
      const service =
        await this.eventRuntime.getServiceLoadPromise("connector-setup");
      if (!isBroadcastService(service)) {
        throw new ElizaError(
          "connector-setup service does not expose broadcastWs.",
          {
            code: "NOTES_BROADCAST_UNAVAILABLE",
            severity: "ephemeral",
          },
        );
      }
      service.broadcastWs({
        type: "view:event",
        viewEventType: NOTES_STATE_UPDATED_EVENT,
        payload: {
          revision: snapshot.revision,
          mutation,
        },
      });
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop — persistence already
      // committed atomically, so a transient shell fan-out failure is reported
      // rather than turning a successful write into a retryable duplicate.
      this.eventRuntime.reportError("NotesService.broadcast", error, {
        eventType: NOTES_STATE_UPDATED_EVENT,
        revision: snapshot.revision,
        mutation,
      });
    }
  }
}

export function getNotesService(runtime: IAgentRuntime): NotesService {
  const service = runtime.getService<NotesService>(NOTES_SERVICE_TYPE);
  if (!service) {
    throw new ElizaError(
      "Notes service is not registered or has not finished loading.",
      {
        code: "NOTES_SERVICE_UNAVAILABLE",
        severity: "ephemeral",
      },
    );
  }
  return service;
}
