/**
 * Real-filesystem coverage for the Notes backend. Tests restart the
 * durable store, exercise concurrent serialized writes, drive every domain
 * capability, and invoke the authenticated state route against the real service.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
  type Route,
  type RouteHandlerContext,
  type RouteHandlerResult,
  Service,
  stringToUuid,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  interact,
  type NotesInteractResult,
  serverInteract,
} from "../interact.js";
import { notesRoutes } from "../routes.js";
import { NOTES_SERVICE_TYPE, NotesService } from "../service.js";
import { NotesStore, notesStateFilePath } from "../store.js";
import type { StickyNote } from "../types.js";

const temporaryDirectories: string[] = [];
const testRuntimes: AgentRuntime[] = [];
let runtimeSequence = 0;

function testAgentId(seed: string): ReturnType<typeof stringToUuid> {
  return stringToUuid(seed);
}

afterEach(async () => {
  await Promise.all(testRuntimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryStateDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "notes-backend-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function temporaryStateFile(): Promise<string> {
  return path.join(await temporaryStateDirectory(), "notes", "state.json");
}

function clock(start = "2026-07-16T12:00:00.000Z"): () => Date {
  let tick = 0;
  const epoch = Date.parse(start);
  return () => new Date(epoch + tick++ * 1_000);
}

function idFactory(): () => string {
  let next = 1;
  return () => `note-test-${next++}`;
}

function expectAppliedMutationReceipt(
  result: NotesInteractResult,
  capability: string,
  resource: { kind: string; id: string },
): void {
  if (!result.state) throw new Error("Mutation result state is required.");
  expect(result.effectReceipts).toHaveLength(1);
  const receipt = result.effectReceipts?.[0];
  if (!receipt) throw new Error("Mutation effect receipt is required.");
  expect(receipt).toMatchObject({
    operation: `notes.${capability}`,
    resource: { ...resource, version: String(result.state.revision) },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    outcome: "applied",
    commit: {
      kind: "durable",
      id: `notes:revision:${result.state.revision}`,
    },
  });
  expect(Number.isNaN(Date.parse(receipt.observedAt))).toBe(false);
  if (receipt.outcome !== "applied") {
    throw new Error("Expected an applied mutation receipt.");
  }
  expect(receipt.commit.committedAt).toBe(receipt.observedAt);
  expect(result.userFacingEffectReceiptIds).toEqual([receipt.receiptId]);
}

class ConnectorSetupTestService extends Service {
  static override readonly serviceType = "connector-setup";

  override capabilityDescription =
    "Captures Notes websocket broadcasts in the backend harness.";

  readonly broadcasts: object[] = [];

  static override async start(
    runtime: IAgentRuntime,
  ): Promise<ConnectorSetupTestService> {
    return new ConnectorSetupTestService(runtime);
  }

  broadcastWs(data: object): void {
    this.broadcasts.push(data);
  }

  override async stop(): Promise<void> {}
}

async function createTestRuntime(agentId: string): Promise<AgentRuntime> {
  const runtime = new AgentRuntime({
    agentId: testAgentId(agentId),
    character: createCharacter({ name: `Notes ${agentId}` }),
    disableBasicCapabilities: true,
    enableAutonomy: false,
    logLevel: "fatal",
  });
  testRuntimes.push(runtime);
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  return runtime;
}

async function serviceFor(filePath: string): Promise<NotesService> {
  const now = clock();
  const service = new NotesService(undefined, {
    store: new NotesStore({ filePath, now }),
    now,
    createId: idFactory(),
  });
  await service.initialize();
  return service;
}

async function runtimeFor(service: NotesService): Promise<AgentRuntime> {
  const runtime = await createTestRuntime(`route-runtime-${runtimeSequence++}`);
  class BoundNotesService extends NotesService {
    static override async start(
      _runtime: IAgentRuntime,
    ): Promise<NotesService> {
      return service;
    }
  }
  await runtime.registerService(BoundNotesService);
  await runtime.getServiceLoadPromise(NOTES_SERVICE_TYPE);
  return runtime;
}

async function defaultStoreRuntime(agentId: string): Promise<AgentRuntime> {
  const runtime = await createTestRuntime(agentId);
  await runtime.registerService(ConnectorSetupTestService);
  return runtime;
}

function route(type: Route["type"], pathValue: string): Route {
  const match = notesRoutes.find(
    (candidate) => candidate.type === type && candidate.path === pathValue,
  );
  if (!match?.routeHandler) {
    throw new Error(`Missing ${type} ${pathValue} route handler.`);
  }
  return match;
}

async function invokeRoute(
  routeValue: Route,
  runtime: IAgentRuntime,
  options: {
    body?: unknown;
    params?: Record<string, string>;
    query?: Record<string, string | string[]>;
  } = {},
): Promise<RouteHandlerResult> {
  if (!routeValue.routeHandler) throw new Error("Route handler is required.");
  const context = {
    body: options.body,
    params: options.params ? options.params : {},
    query: options.query ? options.query : {},
    headers: {},
    method: routeValue.type,
    path: routeValue.path,
    runtime,
    inProcess: false,
    isTrustedLocal: true,
  } satisfies RouteHandlerContext;
  return routeValue.routeHandler(context);
}

describe("NotesStore", () => {
  it("persists one document and restores notes after restart", async () => {
    const filePath = await temporaryStateFile();
    const first = await serviceFor(filePath);
    const note = await first.createNote({
      title: "Split-pane QA",
      body: "Keep notes durable",
      color: "green",
    });
    await first.createNote({
      title: "Second note",
      body: "Also durable",
      color: "rose",
    });
    const beforeRestart = first.snapshot();
    await first.stop();

    const second = await serviceFor(filePath);
    const afterRestart = second.snapshot();
    expect(afterRestart).toEqual(beforeRestart);
    expect(second.getNote(note.id)).toMatchObject({ title: "Split-pane QA" });

    const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      revision: 2,
    });
    expect(Object.keys(persisted).sort()).toEqual(
      ["notes", "persistedAt", "revision", "schemaVersion"].sort(),
    );
  });

  it("serializes concurrent writes without losing a mutation", async () => {
    const filePath = await temporaryStateFile();
    const service = await serviceFor(filePath);
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        service.createNote({
          title: `Concurrent note ${index}`,
          body: `Body ${index}`,
          color: "slate",
        }),
      ),
    );
    expect(service.snapshot()).toMatchObject({ revision: 24 });
    expect(service.listNotes()).toHaveLength(24);
    await service.stop();

    const restarted = await serviceFor(filePath);
    expect(restarted.listNotes()).toHaveLength(24);
    expect(new Set(restarted.listNotes().map((note) => note.id)).size).toBe(24);
  });

  it("scopes default stores per agent and shares serialization for duplicate runtime construction", async () => {
    const stateDir = await temporaryStateDirectory();
    const first = new NotesService(await defaultStoreRuntime("agent-a"), {
      stateDir,
    });
    const duplicate = new NotesService(await defaultStoreRuntime("agent-a"), {
      stateDir,
    });
    const isolated = new NotesService(await defaultStoreRuntime("agent-b"), {
      stateDir,
    });
    await Promise.all([
      first.initialize(),
      duplicate.initialize(),
      isolated.initialize(),
    ]);

    await Promise.all([
      ...Array.from({ length: 12 }, (_, index) =>
        first.createNote({ title: `First ${index}` }),
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        duplicate.createNote({ title: `Duplicate ${index}` }),
      ),
      isolated.createNote({ title: "Other agent" }),
    ]);

    expect(first.store.filePath).toBe(duplicate.store.filePath);
    expect(first.store.filePath).toBe(
      notesStateFilePath(stateDir, testAgentId("agent-a")),
    );
    expect(isolated.store.filePath).toBe(
      notesStateFilePath(stateDir, testAgentId("agent-b")),
    );
    expect(first.snapshot()).toMatchObject({ revision: 24 });
    expect(duplicate.listNotes()).toHaveLength(24);
    expect(isolated.snapshot()).toMatchObject({ revision: 1 });
    expect(isolated.listNotes().map((note) => note.title)).toEqual([
      "Other agent",
    ]);

    await first.stop();
    expect(duplicate.listNotes()).toHaveLength(24);
    await duplicate.stop();
    await isolated.stop();

    const restarted = new NotesService(await defaultStoreRuntime("agent-a"), {
      stateDir,
    });
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({ revision: 24 });
    expect(restarted.listNotes()).toHaveLength(24);
    await restarted.stop();
  });

  it("keeps unscoped workbench state outside the agent-scoped durable store", async () => {
    const stateDir = await temporaryStateDirectory();
    const legacyPath = notesStateFilePath(stateDir);
    const scopedPath = notesStateFilePath(stateDir, testAgentId("agent-a"));
    const legacy = await serviceFor(legacyPath);
    await legacy.createNote({ title: "Legacy note", body: "Keep this" });
    await legacy.stop();
    const legacyBytes = await fs.readFile(legacyPath, "utf8");

    const first = new NotesService(await defaultStoreRuntime("agent-a"), {
      stateDir,
    });
    const duplicate = new NotesService(await defaultStoreRuntime("agent-a"), {
      stateDir,
    });
    await Promise.all([first.initialize(), duplicate.initialize()]);

    expect(first.snapshot()).toMatchObject({ revision: 0, notes: [] });
    expect(duplicate.snapshot()).toMatchObject({ revision: 0, notes: [] });
    expect(await fs.readFile(scopedPath, "utf8")).not.toBe(legacyBytes);
    expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyBytes);

    await first.createNote({ title: "Scoped note" });
    await first.stop();
    await duplicate.stop();

    const restarted = new NotesService(await defaultStoreRuntime("agent-a"), {
      stateDir,
    });
    await restarted.initialize();
    expect(restarted.listNotes().map((note) => note.title)).toEqual([
      "Scoped note",
    ]);
    expect(restarted.snapshot()).toMatchObject({ revision: 1 });
    expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyBytes);
    await restarted.stop();
  });

  it("ignores malformed unscoped workbench state instead of importing it", async () => {
    const stateDir = await temporaryStateDirectory();
    const legacyPath = notesStateFilePath(stateDir);
    const scopedPath = notesStateFilePath(stateDir, testAgentId("agent-a"));
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ schemaVersion: 1, revision: "not-a-number" }),
      "utf8",
    );

    const service = new NotesService(await defaultStoreRuntime("agent-a"), {
      stateDir,
    });
    await expect(service.initialize()).resolves.toBeUndefined();
    expect(service.snapshot()).toMatchObject({ revision: 0, notes: [] });
    await fs.access(scopedPath);
    await service.stop();
  });

  it("surfaces corrupt persisted bytes as an error instead of healthy empty state", async () => {
    const filePath = await temporaryStateFile();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ definitely not json", "utf8");
    const store = new NotesStore({ filePath });

    await expect(store.initialize()).rejects.toMatchObject({
      code: "NOTES_STORE_INVALID_JSON",
    });
    expect(store.getStatus()).toMatchObject({
      phase: "error",
      error: { code: "NOTES_STORE_INVALID_JSON" },
    });
    expect(() => store.snapshot()).toThrow("not valid JSON");
  });
});

describe("Notes capabilities", () => {
  it("dispatches server capabilities to the owning runtime service", async () => {
    const first = await serviceFor(await temporaryStateFile());
    const second = await serviceFor(await temporaryStateFile());
    const firstRuntime = await runtimeFor(first);
    const secondRuntime = await runtimeFor(second);

    await expect(
      serverInteract(
        "create-note",
        { content: "First runtime\nA" },
        { runtime: firstRuntime },
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      serverInteract(
        "create-note",
        { content: "Second runtime\nB" },
        { runtime: secondRuntime },
      ),
    ).resolves.toMatchObject({ success: true });

    expect(first.listNotes().map((note) => note.title)).toEqual([
      "First runtime",
    ]);
    expect(second.listNotes().map((note) => note.title)).toEqual([
      "Second runtime",
    ]);
    await expect(serverInteract("get-notes")).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_SERVICE_UNAVAILABLE" },
    });
  });

  it("drives full note CRUD against the durable service", async () => {
    const service = await serviceFor(await temporaryStateFile());

    const createdNote = await interact(
      "create-note",
      { content: "Workbench\nFirst draft", color: "yellow" },
      service,
    );
    expect(createdNote).toMatchObject({ success: true });
    const noteId = service.listNotes()[0]?.id;
    if (!noteId) throw new Error("Created note id is required.");
    expectAppliedMutationReceipt(createdNote, "create-note", {
      kind: "notes.note",
      id: noteId,
    });

    await expect(
      interact("get-notes", { query: "Workbench" }, service),
    ).resolves.toMatchObject({
      success: true,
      data: { notes: [{ id: noteId, title: "Workbench" }] },
    });

    const updatedNote = await interact(
      "update-note",
      {
        query: "Workbench",
        content: "Workbench\nPolished draft",
        color: "green",
      },
      service,
    );
    expect(updatedNote).toMatchObject({ success: true });
    expectAppliedMutationReceipt(updatedNote, "update-note", {
      kind: "notes.note",
      id: noteId,
    });
    expect(service.getNote(noteId)).toMatchObject({
      body: "Polished draft",
      color: "green",
    });
    await expect(
      interact(
        "update-note",
        { query: "Workbench", content: "Workbench ready\nPolished draft" },
        service,
      ),
    ).resolves.toMatchObject({ success: true });
    const readNote = await interact(
      "get-note",
      { query: "Workbench ready" },
      service,
    );
    expect(readNote).toMatchObject({
      success: true,
      data: { note: { id: noteId, title: "Workbench ready" } },
    });
    expect(readNote.effectReceipts).toBeUndefined();
    const deletedNote = await interact(
      "delete-note",
      { query: "polished" },
      service,
    );
    expect(deletedNote).toMatchObject({ success: true });
    expectAppliedMutationReceipt(deletedNote, "delete-note", {
      kind: "notes.note",
      id: noteId,
    });
    expect(service.listNotes()).toEqual([]);

    await interact("create-note", { content: "One", color: "slate" }, service);
    await interact("create-note", { content: "Two", color: "rose" }, service);
    const clearedNotes = await interact(
      "clear-notes",
      { confirm: true, expectedRevision: service.snapshot().revision },
      service,
    );
    expect(clearedNotes).toMatchObject({
      success: true,
      data: { cleared: 2 },
    });
    expectAppliedMutationReceipt(clearedNotes, "clear-notes", {
      kind: "notes.note-collection",
      id: "notes",
    });
  });

  it("returns replay and multi-record outcomes for one logical note", async () => {
    const service = await serviceFor(await temporaryStateFile());
    const first = await interact(
      "create-note",
      { content: "Milk\nBuy oat milk", color: "green" },
      service,
    );
    const note = (first.data as { note: StickyNote }).note;

    const replay = await interact(
      "create-note",
      { content: "Milk\nBuy oat milk", color: "green" },
      service,
    );
    expect(replay).toMatchObject({
      success: true,
      data: { note: { id: note.id }, replayed: true },
      effectReceipts: [
        {
          outcome: "noop",
          idempotency: { key: note.id, replayed: true },
        },
      ],
    });
    expect(service.listNotes()).toHaveLength(1);

    await service.store.transact((draft) => {
      draft.notes.push(
        { ...note, id: "legacy-milk-2" },
        { ...note, id: "legacy-milk-3" },
      );
    });
    expect(service.snapshot().notes).toHaveLength(1);

    const updated = await interact(
      "update-note",
      { query: "Milk", content: "Milk\nAlready bought" },
      service,
    );
    expect(updated).toMatchObject({
      success: true,
      data: {
        consolidatedCount: 2,
        consolidatedIds: ["legacy-milk-2", "legacy-milk-3"],
      },
    });
    expect(updated.text).toContain("consolidated 3 identical copies");

    await service.store.transact((draft) => {
      const current = draft.notes[0];
      if (!current) throw new Error("Updated note is required");
      draft.notes.push({ ...current, id: "legacy-updated-copy" });
    });
    const deleted = await interact(
      "delete-note",
      { query: "Already bought" },
      service,
    );
    expect(deleted).toMatchObject({
      success: true,
      data: {
        removedCount: 2,
        removedIds: [note.id, "legacy-updated-copy"],
      },
    });
    expect(deleted.text).toContain("removed 2 identical copies");
    expect(service.listNotes()).toEqual([]);
  });

  it("requires structural confirmation before clear-notes mutates the collection", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Keep me", color: "yellow" },
      service,
    );
    const revision = service.snapshot().revision;

    await expect(interact("clear-notes", {}, service)).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    await expect(
      interact(
        "clear-notes",
        { confirm: false, expectedRevision: revision },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    await expect(
      interact(
        "clear-notes",
        { confirm: "true", expectedRevision: revision },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    await expect(
      interact("clear-notes", { confirm: true }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    await expect(
      interact(
        "clear-notes",
        { confirm: true, expectedRevision: revision - 1 },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    await expect(
      interact(
        "clear-notes",
        { confirm: true, expectedRevision: revision, query: "Keep" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    expect(service.listNotes()).toHaveLength(1);

    const cleared = await interact(
      "clear-notes",
      { confirm: true, expectedRevision: revision },
      service,
    );
    expect(cleared).toMatchObject({
      success: true,
      data: { cleared: 1 },
    });
    expectAppliedMutationReceipt(cleared, "clear-notes", {
      kind: "notes.note-collection",
      id: "notes",
    });
    expect(service.listNotes()).toEqual([]);
  });

  it("rejects stale clear-notes confirmation after another mutation", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "First", color: "yellow" },
      service,
    );
    const staleRevision = service.snapshot().revision;
    await interact(
      "create-note",
      { content: "Second", color: "green" },
      service,
    );

    await expect(
      interact(
        "clear-notes",
        { confirm: true, expectedRevision: staleRevision },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    expect(service.listNotes()).toHaveLength(2);

    const cleared = await interact(
      "clear-notes",
      { confirm: true, expectedRevision: service.snapshot().revision },
      service,
    );
    expect(cleared).toMatchObject({
      success: true,
      data: { cleared: 2 },
    });
    expect(service.listNotes()).toEqual([]);
  });

  it("rejects a clear confirmed against a revision a concurrent create advances (issue #22122)", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact("create-note", { content: "A", color: "yellow" }, service);
    // The user confirmed against this snapshot; a note created before the clear
    // actually commits must not be wiped without a fresh confirmation.
    const confirmedRevision = service.snapshot().revision;

    // Dispatch both in the same tick. create-note acquires the store write
    // barrier first and commits at confirmedRevision + 1 before the clear's
    // transaction body runs, so the dispatch-time check alone would be defeated.
    const createB = service.createNote({ title: "B", body: "racing insert" });
    const clear = interact(
      "clear-notes",
      { confirm: true, expectedRevision: confirmedRevision },
      service,
    );
    const [, clearResult] = await Promise.all([createB, clear]);

    expect(clearResult).toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    const remaining = service.listNotes();
    const titles = remaining.map((note) => note.title);
    expect(titles).toContain("A");
    expect(titles).toContain("B");
    expect(remaining).toHaveLength(2);

    // A clear confirmed against the now-current revision still succeeds.
    const cleared = await interact(
      "clear-notes",
      { confirm: true, expectedRevision: service.snapshot().revision },
      service,
    );
    expect(cleared).toMatchObject({ success: true, data: { cleared: 2 } });
    expect(service.listNotes()).toEqual([]);
  });

  it("rejects a clear confirmed against a revision a concurrent update advances (issue #22122)", async () => {
    const service = await serviceFor(await temporaryStateFile());
    const seed = await service.createNote({ title: "Keep", body: "original" });
    const confirmedRevision = service.snapshot().revision;

    const updateSeed = service.updateNote(seed.id, {
      title: "Keep",
      body: "edited in the race window",
    });
    const clear = interact(
      "clear-notes",
      { confirm: true, expectedRevision: confirmedRevision },
      service,
    );
    const [, clearResult] = await Promise.all([updateSeed, clear]);

    expect(clearResult).toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    const remaining = service.listNotes();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      title: "Keep",
      body: "edited in the race window",
    });
  });

  it("persists intentional clear-notes across service restart", async () => {
    const filePath = await temporaryStateFile();
    const first = await serviceFor(filePath);
    await interact(
      "create-note",
      { content: "Persisted", color: "slate" },
      first,
    );
    const revision = first.snapshot().revision;
    await interact(
      "clear-notes",
      { confirm: true, expectedRevision: revision },
      first,
    );
    await first.stop();

    const restarted = await serviceFor(filePath);
    expect(restarted.snapshot()).toMatchObject({ revision: revision + 1 });
    expect(restarted.listNotes()).toEqual([]);
    await restarted.stop();
  });

  it("fails closed when a title lookup is missing or ambiguous", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Daily plan\nMorning", color: "yellow" },
      service,
    );
    await interact(
      "create-note",
      { content: "Daily plan\nEvening", color: "rose" },
      service,
    );

    await expect(
      interact(
        "update-note",
        { query: "Daily plan", content: "Daily plan\nChanged" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_AMBIGUOUS_NOTE" },
    });
    await expect(
      interact(
        "update-note",
        { query: "does not exist", content: "Changed" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_NOT_FOUND" },
    });
    expect(service.listNotes().map((note) => note.body)).toEqual([
      "Evening",
      "Morning",
    ]);
  });

  it("delete-note with title selector deletes by exact first-line label", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Shopping list\nMilk and eggs", color: "yellow" },
      service,
    );
    await interact(
      "create-note",
      { content: "Todo\nFix the bug", color: "rose" },
      service,
    );

    // Exact title match deletes the right note.
    const deleted = await interact(
      "delete-note",
      { title: "Shopping list" },
      service,
    );
    expect(deleted).toMatchObject({
      success: true,
      data: { note: { title: "Shopping list" } },
    });
    // Only "Todo" remains.
    expect(service.listNotes().map((n) => n.title)).toEqual(["Todo"]);
  });

  it("delete-note with title selector fails on ambiguous or unknown label", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Meeting notes\nMorning sync", color: "yellow" },
      service,
    );
    await interact(
      "create-note",
      { content: "Meeting notes\nAfternoon review", color: "rose" },
      service,
    );

    // Two notes share the same first-line label -> ambiguous.
    await expect(
      interact("delete-note", { title: "Meeting notes" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_AMBIGUOUS_NOTE" },
    });

    // No note has this label -> not found.
    await expect(
      interact("delete-note", { title: "Nonexistent" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_NOT_FOUND" },
    });

    // Nothing was deleted.
    expect(service.listNotes()).toHaveLength(2);
  });

  it("returns the destructive name-mismatch fence as a structured failure", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "wifi password\nhunter2-not-really", color: "yellow" },
      service,
    );

    await expect(
      interact(
        "delete-note",
        {
          title: "wifi password",
          ownerText: "delete the wifi credentials note",
        },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      text: expect.stringContaining("nothing was deleted"),
      error: { code: "NOTES_DELETE_NAME_MISMATCH" },
    });
    expect(service.listNotes().map((note) => note.title)).toEqual([
      "wifi password",
    ]);
  });

  it("delete-note rejects content parameter (fail-closed for payload contract)", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Test note\nBody", color: "yellow" },
      service,
    );

    // content is not a declared delete selector — the boundary rejects
    // it with NOTES_VALIDATION_FAILED (fail-closed).
    await expect(
      interact("delete-note", { content: "Test note" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });

    expect(service.listNotes()).toHaveLength(1);
  });

  it("get-note with title selector reads by exact first-line label", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Shopping list\nMilk and eggs", color: "yellow" },
      service,
    );
    await interact(
      "create-note",
      { content: "Todo\nFix the bug", color: "rose" },
      service,
    );

    // Exact title match reads the right note.
    const read = await interact(
      "get-note",
      { title: "Shopping list" },
      service,
    );
    expect(read).toMatchObject({
      success: true,
      data: { note: { title: "Shopping list" } },
    });
  });

  it("get-note with title selector fails on ambiguous or unknown label", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Meeting notes\nMorning sync", color: "yellow" },
      service,
    );
    await interact(
      "create-note",
      { content: "Meeting notes\nAfternoon review", color: "rose" },
      service,
    );

    // Two notes share the same first-line label -> ambiguous.
    await expect(
      interact("get-note", { title: "Meeting notes" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_AMBIGUOUS_NOTE" },
    });

    // No note has this label -> not found.
    await expect(
      interact("get-note", { title: "Nonexistent" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_NOT_FOUND" },
    });
  });

  it("get-note enforces exactly-one-of id/title/query", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Test\nBody", color: "yellow" },
      service,
    );

    // Providing both title and query must fail validation.
    await expect(
      interact("get-note", { title: "Test", query: "Body" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });

    // Providing zero selectors must fail validation.
    await expect(interact("get-note", {}, service)).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
  });

  it("update-note with title selector updates by exact first-line label", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Shopping list\nMilk and eggs", color: "yellow" },
      service,
    );
    await interact(
      "create-note",
      { content: "Todo\nFix the bug", color: "rose" },
      service,
    );

    // Exact title match updates the right note.
    const updated = await interact(
      "update-note",
      { title: "Shopping list", content: "Shopping list\nDone shopping" },
      service,
    );
    expect(updated).toMatchObject({
      success: true,
      data: { note: { title: "Shopping list", body: "Done shopping" } },
    });
    // "Todo" remains unchanged; order may shift after update.
    expect(
      service.listNotes().map((n) => ({ title: n.title, body: n.body })),
    ).toEqual(
      expect.arrayContaining([
        { title: "Shopping list", body: "Done shopping" },
        { title: "Todo", body: "Fix the bug" },
      ]),
    );
  });

  it("update-note with title selector fails on ambiguous or unknown label", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Meeting notes\nMorning sync", color: "yellow" },
      service,
    );
    await interact(
      "create-note",
      { content: "Meeting notes\nAfternoon review", color: "rose" },
      service,
    );

    // Two notes share the same first-line label -> ambiguous.
    await expect(
      interact(
        "update-note",
        { title: "Meeting notes", content: "Changed" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_AMBIGUOUS_NOTE" },
    });

    // No note has this label -> not found.
    await expect(
      interact(
        "update-note",
        { title: "Nonexistent", content: "Changed" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_NOT_FOUND" },
    });

    // Nothing was mutated.
    expect(service.listNotes().map((n) => n.body)).toEqual(
      expect.arrayContaining(["Morning sync", "Afternoon review"]),
    );
  });

  it("update-note enforces exactly-one-of id/title/query for selector", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { content: "Test\nBody", color: "yellow" },
      service,
    );

    // Providing both title and query must fail validation.
    await expect(
      interact(
        "update-note",
        { title: "Test", query: "Body", content: "Changed" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });

    // No selector with content must fail validation.
    await expect(
      interact("update-note", { content: "Changed" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
  });

  it("returns explicit failures for invalid input and rejects undeclared capabilities", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await expect(
      interact("create-note", { content: "   " }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "NOTES_VALIDATION_FAILED" },
    });
    expect(service.listNotes()).toEqual([]);
    await expect(
      interact("launch-confetti", {}, service),
    ).rejects.toMatchObject({
      code: "NOTES_UNKNOWN_CAPABILITY",
    });
  });
});

describe("Notes authenticated routes", () => {
  it("keeps every state route behind the central auth gate", () => {
    expect(notesRoutes.length).toBeGreaterThan(0);
    for (const routeValue of notesRoutes) {
      expect(routeValue.public).not.toBe(true);
      expect(routeValue.rawPath).toBe(true);
      expect(routeValue.modes).toEqual([
        "local",
        "local-only",
        "cloud",
        "remote",
      ]);
    }
  });

  it("returns the authoritative durable snapshot", async () => {
    const service = await serviceFor(await temporaryStateFile());
    const runtime = await runtimeFor(service);
    await service.createNote({
      title: "Route note",
      body: "Read over HTTP",
      color: "green",
    });

    const state = await invokeRoute(route("GET", "/api/notes/state"), runtime);
    expect(state).toMatchObject({
      status: 200,
      body: {
        success: true,
        data: {
          revision: 1,
          notes: [{ title: "Route note" }],
        },
      },
    });
  });

  it("returns unavailable instead of fabricating an empty snapshot", async () => {
    const service = await serviceFor(await temporaryStateFile());
    const runtime = await runtimeFor(service);
    await service.stop();
    const unavailable = await invokeRoute(
      route("GET", "/api/notes/state"),
      runtime,
    );
    expect(unavailable).toMatchObject({
      status: 503,
      body: {
        success: false,
        error: { code: "NOTES_STORE_UNAVAILABLE" },
      },
    });
  });
});
