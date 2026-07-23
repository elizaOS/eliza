/**
 * Server-owned Notes and Simple Calendar domain service. It is the only layer
 * allowed to mutate the durable per-agent document; HTTP routes and view
 * capabilities call this API so validation, identity, timestamps, and restart
 * behavior remain identical across every entry point.
 */

import { randomUUID } from "node:crypto";
import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import { SimpleViewsStore } from "./store.js";
import type {
  SimpleCalendarEvent,
  SimpleViewsSnapshot,
  SimpleViewsStoreStatus,
  StickyNote,
} from "./types.js";
import {
  parseCreateCalendarEventInput,
  parseCreateNoteInput,
  parseDateKey,
  parseEntityId,
  parseUpdateCalendarEventInput,
  parseUpdateNoteInput,
} from "./validation.js";

export const SIMPLE_VIEWS_SERVICE_TYPE = "simple-views";
export const SIMPLE_VIEWS_STATE_UPDATED_EVENT = "simple-views:state-updated";

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

function notFound(kind: "note" | "calendar event", id: string): ElizaError {
  return new ElizaError(`Simple Views ${kind} "${id}" was not found.`, {
    code: "SIMPLE_VIEWS_NOT_FOUND",
    context: { kind, id },
    severity: "ephemeral",
  });
}

export class SimpleViewsService extends Service {
  static override readonly serviceType = SIMPLE_VIEWS_SERVICE_TYPE;

  override capabilityDescription =
    "Durable managed Cloud Notes and Calendar CRUD with view switching.";

  readonly store: SimpleViewsStore;

  private readonly now: () => Date;
  private readonly createId: (kind: "note" | "event") => string;
  private readonly eventRuntime: IAgentRuntime | undefined;

  constructor(
    runtime?: IAgentRuntime,
    options: {
      store?: SimpleViewsStore;
      stateDir?: string;
      now?: () => Date;
      createId?: (kind: "note" | "event") => string;
    } = {},
  ) {
    super(runtime);
    this.eventRuntime = runtime;
    this.store = options.store
      ? options.store
      : new SimpleViewsStore({
          stateDir: options.stateDir,
          agentId: runtime ? String(runtime.agentId) : undefined,
        });
    this.now = options.now ? options.now : () => new Date();
    this.createId = options.createId
      ? options.createId
      : (kind) => `${kind}-${randomUUID()}`;
  }

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<SimpleViewsService> {
    const service = new SimpleViewsService(runtime);
    await service.initialize();
    logger.info(
      {
        src: "plugin-simple-views",
        filePath: service.store.filePath,
      },
      "[SimpleViewsService] Ready",
    );
    return service;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  override async stop(): Promise<void> {
    await this.store.stop();
    logger.info({ src: "plugin-simple-views" }, "[SimpleViewsService] Stopped");
  }

  status(): SimpleViewsStoreStatus {
    return this.store.getStatus();
  }

  snapshot(): SimpleViewsSnapshot {
    return this.store.snapshot();
  }

  listNotes(): StickyNote[] {
    return this.snapshot().notes;
  }

  getNote(idValue: unknown): StickyNote {
    const id = parseEntityId(idValue);
    const note = this.snapshot().notes.find((candidate) => candidate.id === id);
    if (!note) throw notFound("note", id);
    return note;
  }

  async createNote(inputValue: unknown): Promise<StickyNote> {
    const input = parseCreateNoteInput(inputValue);
    const now = this.now().toISOString();
    const id = parseEntityId(this.createId("note"));
    const transaction = await this.store.transact((draft) => {
      if (draft.notes.some((note) => note.id === id)) {
        throw new ElizaError(
          `Simple Views generated duplicate note id "${id}".`,
          {
            code: "SIMPLE_VIEWS_DUPLICATE_ID",
            context: { kind: "note", id },
            severity: "fatal",
          },
        );
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
    return transaction.value;
  }

  async updateNote(idValue: unknown, patchValue: unknown): Promise<StickyNote> {
    const id = parseEntityId(idValue);
    const patch = parseUpdateNoteInput(patchValue);
    const updatedAt = this.now().toISOString();
    const transaction = await this.store.transact((draft) => {
      const index = draft.notes.findIndex((note) => note.id === id);
      const existing = draft.notes[index];
      if (index < 0 || !existing) throw notFound("note", id);
      const updated: StickyNote = {
        ...existing,
        updatedAt,
      };
      if (patch.title !== undefined) updated.title = patch.title;
      if (patch.body !== undefined) updated.body = patch.body;
      if (patch.color !== undefined) updated.color = patch.color;
      draft.notes[index] = updated;
      return updated;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:updated");
    return transaction.value;
  }

  async deleteNote(idValue: unknown): Promise<StickyNote> {
    const id = parseEntityId(idValue);
    const transaction = await this.store.transact((draft) => {
      const index = draft.notes.findIndex((note) => note.id === id);
      const existing = draft.notes[index];
      if (index < 0 || !existing) throw notFound("note", id);
      draft.notes.splice(index, 1);
      return existing;
    });
    await this.emitStateUpdated(transaction.snapshot, "note:deleted");
    return transaction.value;
  }

  async clearNotes(): Promise<number> {
    const transaction = await this.store.transact((draft) => {
      const count = draft.notes.length;
      draft.notes = [];
      return count;
    });
    await this.emitStateUpdated(transaction.snapshot, "notes:cleared");
    return transaction.value;
  }

  selectedDate(): string {
    return this.snapshot().selectedDate;
  }

  async selectDate(dateValue: unknown): Promise<string> {
    const date = parseDateKey(dateValue);
    const transaction = await this.store.transact((draft) => {
      draft.selectedDate = date;
      return date;
    });
    await this.emitStateUpdated(transaction.snapshot, "calendar:date-selected");
    return transaction.value;
  }

  listCalendarEvents(dateValue?: unknown): SimpleCalendarEvent[] {
    const events = this.snapshot().events;
    if (dateValue === undefined) return events;
    const date = parseDateKey(dateValue);
    return events.filter((event) => event.date === date);
  }

  getCalendarEvent(idValue: unknown): SimpleCalendarEvent {
    const id = parseEntityId(idValue);
    const event = this.snapshot().events.find(
      (candidate) => candidate.id === id,
    );
    if (!event) throw notFound("calendar event", id);
    return event;
  }

  async createCalendarEvent(inputValue: unknown): Promise<SimpleCalendarEvent> {
    const input = parseCreateCalendarEventInput(
      inputValue,
      this.selectedDate(),
    );
    const now = this.now().toISOString();
    const id = parseEntityId(this.createId("event"));
    const transaction = await this.store.transact((draft) => {
      if (draft.events.some((event) => event.id === id)) {
        throw new ElizaError(
          `Simple Views generated duplicate calendar event id "${id}".`,
          {
            code: "SIMPLE_VIEWS_DUPLICATE_ID",
            context: { kind: "calendar event", id },
            severity: "fatal",
          },
        );
      }
      const event: SimpleCalendarEvent = {
        id,
        title: input.title,
        date: input.date,
        time: input.time,
        notes: input.notes,
        color: input.color,
        createdAt: now,
        updatedAt: now,
      };
      draft.events.push(event);
      draft.selectedDate = event.date;
      return event;
    });
    await this.emitStateUpdated(transaction.snapshot, "calendar:event-created");
    return transaction.value;
  }

  async updateCalendarEvent(
    idValue: unknown,
    patchValue: unknown,
  ): Promise<SimpleCalendarEvent> {
    const id = parseEntityId(idValue);
    const patch = parseUpdateCalendarEventInput(patchValue);
    const updatedAt = this.now().toISOString();
    const transaction = await this.store.transact((draft) => {
      const index = draft.events.findIndex((event) => event.id === id);
      const existing = draft.events[index];
      if (index < 0 || !existing) throw notFound("calendar event", id);
      const updated: SimpleCalendarEvent = {
        ...existing,
        updatedAt,
      };
      if (patch.title !== undefined) updated.title = patch.title;
      if (patch.date !== undefined) updated.date = patch.date;
      if (patch.time !== undefined) updated.time = patch.time;
      if (patch.notes !== undefined) updated.notes = patch.notes;
      if (patch.color !== undefined) updated.color = patch.color;
      draft.events[index] = updated;
      if (patch.date !== undefined) draft.selectedDate = patch.date;
      return updated;
    });
    await this.emitStateUpdated(transaction.snapshot, "calendar:event-updated");
    return transaction.value;
  }

  async deleteCalendarEvent(idValue: unknown): Promise<SimpleCalendarEvent> {
    const id = parseEntityId(idValue);
    const transaction = await this.store.transact((draft) => {
      const index = draft.events.findIndex((event) => event.id === id);
      const existing = draft.events[index];
      if (index < 0 || !existing) throw notFound("calendar event", id);
      draft.events.splice(index, 1);
      return existing;
    });
    await this.emitStateUpdated(transaction.snapshot, "calendar:event-deleted");
    return transaction.value;
  }

  private async emitStateUpdated(
    snapshot: SimpleViewsSnapshot,
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
            code: "SIMPLE_VIEWS_BROADCAST_UNAVAILABLE",
            severity: "ephemeral",
          },
        );
      }
      service.broadcastWs({
        type: "view:event",
        viewEventType: SIMPLE_VIEWS_STATE_UPDATED_EVENT,
        payload: {
          revision: snapshot.revision,
          mutation,
        },
      });
    } catch (error) {
      // error-policy:J7 diagnostics-must-not-kill-the-loop — persistence already
      // committed atomically, so a transient shell fan-out failure is reported
      // rather than turning a successful write into a retryable duplicate.
      this.eventRuntime.reportError("SimpleViewsService.broadcast", error, {
        eventType: SIMPLE_VIEWS_STATE_UPDATED_EVENT,
        revision: snapshot.revision,
        mutation,
      });
    }
  }
}

export function getSimpleViewsService(
  runtime: IAgentRuntime,
): SimpleViewsService {
  const service = runtime.getService<SimpleViewsService>(
    SIMPLE_VIEWS_SERVICE_TYPE,
  );
  if (!service) {
    throw new ElizaError(
      "Simple Views service is not registered or has not finished loading.",
      {
        code: "SIMPLE_VIEWS_SERVICE_UNAVAILABLE",
        severity: "ephemeral",
      },
    );
  }
  return service;
}
