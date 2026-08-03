/**
 * Real-filesystem coverage for the Simple Views backend. Tests restart the
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
  type SimpleViewsInteractResult,
  serverInteract,
} from "../interact.js";
import { simpleViewsRoutes } from "../routes.js";
import { SIMPLE_VIEWS_SERVICE_TYPE, SimpleViewsService } from "../service.js";
import { SimpleViewsStore, simpleViewsStateFilePath } from "../store.js";
import { todayDateKey } from "../validation.js";

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
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "simple-views-backend-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function temporaryStateFile(): Promise<string> {
  return path.join(
    await temporaryStateDirectory(),
    "simple-views",
    "state.json",
  );
}

function clock(start = "2026-07-16T12:00:00.000Z"): () => Date {
  let tick = 0;
  const epoch = Date.parse(start);
  return () => new Date(epoch + tick++ * 1_000);
}

function idFactory(): (kind: "note" | "event") => string {
  let next = 1;
  return (kind) => `${kind}-test-${next++}`;
}

function expectAppliedMutationReceipt(
  result: SimpleViewsInteractResult,
  capability: string,
  resource: { kind: string; id: string },
): void {
  if (!result.state) throw new Error("Mutation result state is required.");
  expect(result.effectReceipts).toHaveLength(1);
  const receipt = result.effectReceipts?.[0];
  if (!receipt) throw new Error("Mutation effect receipt is required.");
  expect(receipt).toMatchObject({
    operation: `simple-views.${capability}`,
    resource: { ...resource, version: String(result.state.revision) },
    artifacts: [],
    idempotency: { key: null, replayed: false },
    outcome: "applied",
    commit: {
      kind: "durable",
      id: `simple-views:revision:${result.state.revision}`,
    },
  });
  expect(Number.isNaN(Date.parse(receipt.observedAt))).toBe(false);
  expect(receipt.commit.committedAt).toBe(receipt.observedAt);
  expect(result.userFacingEffectReceiptIds).toEqual([receipt.receiptId]);
}

class ConnectorSetupTestService extends Service {
  static override readonly serviceType = "connector-setup";

  override capabilityDescription =
    "Captures Simple Views websocket broadcasts in the backend harness.";

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
    character: createCharacter({ name: `Simple Views ${agentId}` }),
    disableBasicCapabilities: true,
    enableAutonomy: false,
    logLevel: "fatal",
  });
  testRuntimes.push(runtime);
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  return runtime;
}

async function serviceFor(filePath: string): Promise<SimpleViewsService> {
  const now = clock();
  const service = new SimpleViewsService(undefined, {
    store: new SimpleViewsStore({ filePath, now }),
    now,
    createId: idFactory(),
  });
  await service.initialize();
  return service;
}

async function runtimeFor(service: SimpleViewsService): Promise<AgentRuntime> {
  const runtime = await createTestRuntime(`route-runtime-${runtimeSequence++}`);
  class BoundSimpleViewsService extends SimpleViewsService {
    static override async start(
      _runtime: IAgentRuntime,
    ): Promise<SimpleViewsService> {
      return service;
    }
  }
  await runtime.registerService(BoundSimpleViewsService);
  await runtime.getServiceLoadPromise(SIMPLE_VIEWS_SERVICE_TYPE);
  return runtime;
}

async function defaultStoreRuntime(agentId: string): Promise<AgentRuntime> {
  const runtime = await createTestRuntime(agentId);
  await runtime.registerService(ConnectorSetupTestService);
  return runtime;
}

function route(type: Route["type"], pathValue: string): Route {
  const match = simpleViewsRoutes.find(
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

describe("SimpleViewsStore", () => {
  it("uses the runtime's local calendar day instead of the UTC day", () => {
    expect(todayDateKey(new Date(2026, 6, 16, 23, 30))).toBe("2026-07-16");
  });

  it("persists one document and restores notes, events, and selected date after restart", async () => {
    const filePath = await temporaryStateFile();
    const first = await serviceFor(filePath);
    const note = await first.createNote({
      title: "Split-pane QA",
      body: "Keep notes beside the calendar",
      color: "green",
    });
    const event = await first.createCalendarEvent({
      title: "View switching review",
      date: "2026-07-20",
      time: "14:30",
      notes: "Open both Cloud views",
      color: "rose",
    });
    await first.selectDate("2026-07-21");
    const beforeRestart = first.snapshot();
    await first.stop();

    const second = await serviceFor(filePath);
    const afterRestart = second.snapshot();
    expect(afterRestart).toEqual(beforeRestart);
    expect(second.getNote(note.id)).toMatchObject({ title: "Split-pane QA" });
    expect(second.getCalendarEvent(event.id)).toMatchObject({
      title: "View switching review",
    });
    expect(afterRestart.selectedDate).toBe("2026-07-21");

    const persisted = JSON.parse(await fs.readFile(filePath, "utf8"));
    expect(persisted).toMatchObject({
      schemaVersion: 1,
      revision: 3,
      selectedDate: "2026-07-21",
    });
    expect(Object.keys(persisted).sort()).toEqual(
      [
        "events",
        "notes",
        "persistedAt",
        "revision",
        "schemaVersion",
        "selectedDate",
      ].sort(),
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
    const first = new SimpleViewsService(await defaultStoreRuntime("agent-a"), {
      stateDir,
    });
    const duplicate = new SimpleViewsService(
      await defaultStoreRuntime("agent-a"),
      { stateDir },
    );
    const isolated = new SimpleViewsService(
      await defaultStoreRuntime("agent-b"),
      { stateDir },
    );
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
      simpleViewsStateFilePath(stateDir, testAgentId("agent-a")),
    );
    expect(isolated.store.filePath).toBe(
      simpleViewsStateFilePath(stateDir, testAgentId("agent-b")),
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

    const restarted = new SimpleViewsService(
      await defaultStoreRuntime("agent-a"),
      { stateDir },
    );
    await restarted.initialize();
    expect(restarted.snapshot()).toMatchObject({ revision: 24 });
    expect(restarted.listNotes()).toHaveLength(24);
    await restarted.stop();
  });

  it("keeps unscoped workbench state outside the agent-scoped durable store", async () => {
    const stateDir = await temporaryStateDirectory();
    const legacyPath = simpleViewsStateFilePath(stateDir);
    const scopedPath = simpleViewsStateFilePath(
      stateDir,
      testAgentId("agent-a"),
    );
    const legacy = await serviceFor(legacyPath);
    await legacy.createNote({ title: "Legacy note", body: "Keep this" });
    await legacy.createCalendarEvent({
      title: "Legacy event",
      date: "2026-07-22",
      time: "15:00",
    });
    await legacy.selectDate("2026-07-22");
    await legacy.stop();
    const legacyBytes = await fs.readFile(legacyPath, "utf8");

    const first = new SimpleViewsService(await defaultStoreRuntime("agent-a"), {
      stateDir,
    });
    const duplicate = new SimpleViewsService(
      await defaultStoreRuntime("agent-a"),
      { stateDir },
    );
    await Promise.all([first.initialize(), duplicate.initialize()]);

    expect(first.snapshot()).toMatchObject({
      revision: 0,
      notes: [],
      events: [],
    });
    expect(duplicate.snapshot()).toMatchObject({
      revision: 0,
      notes: [],
      events: [],
    });
    expect(await fs.readFile(scopedPath, "utf8")).not.toBe(legacyBytes);
    expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyBytes);

    await first.createNote({ title: "Scoped note" });
    await first.stop();
    await duplicate.stop();

    const restarted = new SimpleViewsService(
      await defaultStoreRuntime("agent-a"),
      { stateDir },
    );
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
    const legacyPath = simpleViewsStateFilePath(stateDir);
    const scopedPath = simpleViewsStateFilePath(
      stateDir,
      testAgentId("agent-a"),
    );
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ schemaVersion: 1, revision: "not-a-number" }),
      "utf8",
    );

    const service = new SimpleViewsService(
      await defaultStoreRuntime("agent-a"),
      { stateDir },
    );
    await expect(service.initialize()).resolves.toBeUndefined();
    expect(service.snapshot()).toMatchObject({
      revision: 0,
      notes: [],
      events: [],
    });
    await fs.access(scopedPath);
    await service.stop();
  });

  it("surfaces corrupt persisted bytes as an error instead of healthy empty state", async () => {
    const filePath = await temporaryStateFile();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ definitely not json", "utf8");
    const store = new SimpleViewsStore({ filePath });

    await expect(store.initialize()).rejects.toMatchObject({
      code: "SIMPLE_VIEWS_STORE_INVALID_JSON",
    });
    expect(store.getStatus()).toMatchObject({
      phase: "error",
      error: { code: "SIMPLE_VIEWS_STORE_INVALID_JSON" },
    });
    expect(() => store.snapshot()).toThrow("not valid JSON");
  });
});

describe("Simple Views capabilities", () => {
  it("dispatches server capabilities to the owning runtime service", async () => {
    const first = await serviceFor(await temporaryStateFile());
    const second = await serviceFor(await temporaryStateFile());
    const firstRuntime = await runtimeFor(first);
    const secondRuntime = await runtimeFor(second);

    await expect(
      serverInteract(
        "create-note",
        { title: "First runtime", body: "A" },
        { runtime: firstRuntime },
      ),
    ).resolves.toMatchObject({ success: true });
    await expect(
      serverInteract(
        "create-note",
        { title: "Second runtime", body: "B" },
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
      error: { code: "SIMPLE_VIEWS_SERVICE_UNAVAILABLE" },
    });
  });

  it("drives full note and calendar CRUD against the durable service", async () => {
    const service = await serviceFor(await temporaryStateFile());

    const createdNote = await interact(
      "create-note",
      { title: "Workbench", body: "First draft", color: "yellow" },
      service,
    );
    expect(createdNote).toMatchObject({ success: true });
    const noteId = service.listNotes()[0]?.id;
    if (!noteId) throw new Error("Created note id is required.");
    expectAppliedMutationReceipt(createdNote, "create-note", {
      kind: "simple-views.note",
      id: noteId,
    });
    await expect(interact("get-notes", {}, service)).resolves.toMatchObject({
      success: true,
      data: { notes: [{ id: noteId, title: "Workbench" }] },
    });
    await expect(
      interact("get-notes", { title: "Workbench" }, service),
    ).resolves.toMatchObject({
      success: true,
      data: { notes: [{ id: noteId, title: "Workbench" }] },
    });

    const updatedNote = await interact(
      "update-note",
      { query: "Workbench", body: "Polished draft", color: "green" },
      service,
    );
    expect(updatedNote).toMatchObject({ success: true });
    expectAppliedMutationReceipt(updatedNote, "update-note", {
      kind: "simple-views.note",
      id: noteId,
    });
    expect(service.getNote(noteId)).toMatchObject({
      body: "Polished draft",
      color: "green",
    });
    await expect(
      interact(
        "update-note",
        { oldTitle: "Workbench", title: "Workbench ready" },
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
      data: { note: { title: "Workbench ready" } },
    });
    expect(readNote.effectReceipts).toBeUndefined();
    expect(readNote.userFacingEffectReceiptIds).toBeUndefined();
    const deletedNote = await interact(
      "delete-note",
      { query: "polished" },
      service,
    );
    expect(deletedNote).toMatchObject({ success: true });
    expectAppliedMutationReceipt(deletedNote, "delete-note", {
      kind: "simple-views.note",
      id: noteId,
    });
    expect(service.listNotes()).toEqual([]);

    await interact(
      "create-note",
      { title: "One", body: "", color: "slate" },
      service,
    );
    await interact(
      "create-note",
      { title: "Two", body: "", color: "rose" },
      service,
    );
    const clearedNotes = await interact("clear-notes", {}, service);
    expect(clearedNotes).toMatchObject({
      success: true,
      data: { cleared: 2 },
    });
    expectAppliedMutationReceipt(clearedNotes, "clear-notes", {
      kind: "simple-views.note-collection",
      id: "notes",
    });

    const selectedDate = await interact(
      "select-calendar-date",
      { date: "2026-08-03" },
      service,
    );
    expect(selectedDate).toMatchObject({ success: true });
    expectAppliedMutationReceipt(selectedDate, "select-calendar-date", {
      kind: "simple-views.calendar-selection",
      id: "selected-date",
    });
    const createdEvent = await interact(
      "create-calendar-event",
      {
        title: "Calendar demo",
        time: "10:15",
        details: "Created on the selected date",
        color: "rose",
      },
      service,
    );
    expect(createdEvent).toMatchObject({ success: true });
    const eventId = service.listCalendarEvents()[0]?.id;
    if (!eventId) throw new Error("Created calendar event id is required.");
    expectAppliedMutationReceipt(createdEvent, "create-calendar-event", {
      kind: "simple-views.calendar-event",
      id: eventId,
    });
    expect(service.getCalendarEvent(eventId)).toMatchObject({
      date: "2026-08-03",
      notes: "Created on the selected date",
    });
    await expect(
      interact("get-calendar-state", { date: "2026-08-03" }, service),
    ).resolves.toMatchObject({
      success: true,
      data: {
        selectedDate: "2026-08-03",
        events: [{ id: eventId, title: "Calendar demo" }],
      },
    });
    await expect(
      interact("get-calendar-state", { title: "Calendar demo" }, service),
    ).resolves.toMatchObject({
      success: true,
      data: { events: [{ id: eventId, title: "Calendar demo" }] },
    });

    const updatedEvent = await interact(
      "update-calendar-event",
      {
        oldTitle: "Calendar demo",
        title: "Updated demo",
        date: "2026-08-04",
        time: "11:45",
        details: "Updated capability details",
      },
      service,
    );
    expect(updatedEvent).toMatchObject({ success: true });
    expectAppliedMutationReceipt(updatedEvent, "update-calendar-event", {
      kind: "simple-views.calendar-event",
      id: eventId,
    });
    expect(service.selectedDate()).toBe("2026-08-03");
    expect(service.getCalendarEvent(eventId)).toMatchObject({
      title: "Updated demo",
      notes: "Updated capability details",
    });
    await expect(
      interact("get-calendar-event", { query: "capability details" }, service),
    ).resolves.toMatchObject({
      success: true,
      data: { event: { id: eventId, title: "Updated demo" } },
    });
    const deletedEvent = await interact(
      "delete-calendar-event",
      { id: eventId },
      service,
    );
    expect(deletedEvent).toMatchObject({ success: true });
    expectAppliedMutationReceipt(deletedEvent, "delete-calendar-event", {
      kind: "simple-views.calendar-event",
      id: eventId,
    });
    expect(service.listCalendarEvents()).toEqual([]);

    await interact(
      "create-calendar-event",
      {
        title: "Afternoon review",
        date: "2026-08-05",
        time: "15:30",
        notes: "Review the roadmap",
      },
      service,
    );
    await expect(
      interact("delete-calendar-event", { title: "Afternoon review" }, service),
    ).resolves.toMatchObject({ success: true });
    expect(service.listCalendarEvents()).toEqual([]);

    await interact(
      "create-calendar-event",
      {
        title: "Morning review",
        date: "2026-08-05",
        time: "08:30",
        notes: "Review launch notes",
      },
      service,
    );
    await expect(
      interact("delete-calendar-event", { query: "launch notes" }, service),
    ).resolves.toMatchObject({ success: true });
    expect(service.listCalendarEvents()).toEqual([]);
  });

  it("keeps the viewed date stable when events are created or moved", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await service.selectDate("2026-08-03");

    const event = await service.createCalendarEvent({
      title: "Tomorrow's demo",
      date: "2026-08-04",
      time: "15:00",
    });
    expect(service.selectedDate()).toBe("2026-08-03");

    await service.updateCalendarEvent(event.id, { date: "2026-08-05" });
    expect(service.selectedDate()).toBe("2026-08-03");
  });

  it("fails closed when a note update lookup is missing or ambiguous", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-note",
      { title: "Daily plan", body: "Morning", color: "yellow" },
      service,
    );
    await interact(
      "create-note",
      { title: "Daily plan", body: "Evening", color: "rose" },
      service,
    );

    await expect(
      interact(
        "update-note",
        { query: "Daily plan", body: "Changed" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_AMBIGUOUS_NOTE" },
    });
    await expect(
      interact(
        "update-note",
        { query: "does not exist", body: "Changed" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_NOT_FOUND" },
    });
    expect(service.listNotes().map((note) => note.body)).toEqual([
      "Evening",
      "Morning",
    ]);
  });

  it("fails closed when a calendar delete lookup is missing or ambiguous", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-calendar-event",
      {
        title: "Daily review",
        date: "2026-08-05",
        time: "08:30",
        notes: "Morning",
      },
      service,
    );
    await interact(
      "create-calendar-event",
      {
        title: "Daily review",
        date: "2026-08-06",
        time: "17:30",
        notes: "Evening",
      },
      service,
    );

    await expect(
      interact("delete-calendar-event", { title: "Daily review" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_AMBIGUOUS_EVENT" },
    });
    await expect(
      interact("delete-calendar-event", { query: "does not exist" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_NOT_FOUND" },
    });
    const [firstEvent] = service.listCalendarEvents();
    expect(firstEvent).toBeDefined();
    await expect(
      interact(
        "delete-calendar-event",
        { id: firstEvent?.id, title: "Daily review" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_VALIDATION_FAILED" },
    });
    await expect(
      interact(
        "delete-calendar-event",
        { id: 123, title: "Daily review" },
        service,
      ),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_VALIDATION_FAILED" },
    });
    await expect(
      interact("delete-calendar-event", { query: "   " }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_VALIDATION_FAILED" },
    });
    expect(service.listCalendarEvents()).toHaveLength(2);
  });

  it("serializes calendar lookup deletion with concurrent event mutations", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await interact(
      "create-calendar-event",
      {
        title: "Rename race",
        date: "2026-08-05",
        time: "08:30",
        notes: "Preserve after rename",
      },
      service,
    );
    const renameTarget = service.listCalendarEvents()[0];
    expect(renameTarget).toBeDefined();
    const rename = service.updateCalendarEvent(renameTarget?.id, {
      title: "Renamed before delete",
    });
    const deleteRenamed = interact(
      "delete-calendar-event",
      { title: "Rename race" },
      service,
    );
    await expect(rename).resolves.toMatchObject({
      title: "Renamed before delete",
    });
    await expect(deleteRenamed).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_NOT_FOUND" },
    });
    expect(service.listCalendarEvents()).toEqual([
      expect.objectContaining({ title: "Renamed before delete" }),
    ]);

    await interact(
      "create-calendar-event",
      {
        title: "Unique before create",
        date: "2026-08-06",
        time: "09:00",
        notes: "Existing",
      },
      service,
    );
    const createDuplicate = service.createCalendarEvent({
      title: "Unique before create",
      date: "2026-08-07",
      time: "10:00",
      notes: "Concurrent duplicate",
    });
    const deleteDuplicated = interact(
      "delete-calendar-event",
      { title: "Unique before create" },
      service,
    );
    await expect(createDuplicate).resolves.toMatchObject({
      title: "Unique before create",
    });
    await expect(deleteDuplicated).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_AMBIGUOUS_EVENT" },
    });
    expect(
      service
        .listCalendarEvents()
        .filter((event) => event.title === "Unique before create"),
    ).toHaveLength(2);
  });

  it("returns explicit failures for invalid input and rejects undeclared capabilities", async () => {
    const service = await serviceFor(await temporaryStateFile());
    await expect(
      interact("select-calendar-date", { date: "2026-02-31" }, service),
    ).resolves.toMatchObject({
      success: false,
      error: { code: "SIMPLE_VIEWS_VALIDATION_FAILED" },
    });
    expect(service.selectedDate()).toBe("2026-07-16");
    await expect(
      interact("launch-confetti", {}, service),
    ).rejects.toMatchObject({
      code: "SIMPLE_VIEWS_UNKNOWN_CAPABILITY",
    });
  });
});

describe("Simple Views authenticated routes", () => {
  it("keeps every state route behind the central auth gate", () => {
    expect(simpleViewsRoutes.length).toBeGreaterThan(0);
    for (const routeValue of simpleViewsRoutes) {
      expect(routeValue.public).not.toBe(true);
      expect(routeValue.rawPath).toBe(true);
      expect(routeValue.modes).toEqual(["cloud"]);
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
    await service.selectDate("2026-09-05");
    await service.createCalendarEvent({ title: "Route event", time: "08:30" });

    const state = await invokeRoute(
      route("GET", "/api/simple-views/state"),
      runtime,
    );
    expect(state).toMatchObject({
      status: 200,
      body: {
        success: true,
        data: {
          revision: 3,
          selectedDate: "2026-09-05",
          notes: [{ title: "Route note" }],
          events: [{ title: "Route event", date: "2026-09-05" }],
        },
      },
    });
  });

  it("returns unavailable instead of fabricating an empty snapshot", async () => {
    const service = await serviceFor(await temporaryStateFile());
    const runtime = await runtimeFor(service);
    await service.stop();
    const unavailable = await invokeRoute(
      route("GET", "/api/simple-views/state"),
      runtime,
    );
    expect(unavailable).toMatchObject({
      status: 503,
      body: {
        success: false,
        error: { code: "SIMPLE_VIEWS_STORE_UNAVAILABLE" },
      },
    });
  });
});
