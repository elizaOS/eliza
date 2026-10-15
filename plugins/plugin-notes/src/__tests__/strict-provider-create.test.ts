// @vitest-environment node
/** Exercises strict-provider NOTES create arguments through real tool admission and the persisted Notes file. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  executePlannedToolCall,
  type IAgentRuntime,
  stringToUuid,
} from "@elizaos/core";
import { initializeTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, test } from "vitest";
import { notesPlugin } from "../plugin.js";
import { NotesService } from "../service.js";
import { NotesStore } from "../store.js";

const runtimes: AgentRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "notes-strict-create-"),
  );
  directories.push(directory);
  const filePath = path.join(directory, "notes.json");
  const runtime = new AgentRuntime({
    agentId: stringToUuid(directory),
    character: createCharacter({ name: "Notes strict create" }),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  await initializeTestRuntime(runtime, { skipMigrations: true });
  class PersistedNotes extends NotesService {
    static override async start(owner: IAgentRuntime) {
      const service = new NotesService(owner, {
        store: new NotesStore({ filePath }),
      });
      await service.initialize();
      return service;
    }
  }
  await runtime.registerPlugin({ ...notesPlugin, services: [PersistedNotes] });
  await runtime.getServiceLoadPromise(NotesService.serviceType);
  const service = runtime.getService<NotesService>(NotesService.serviceType);
  if (!service) throw new Error("Notes service did not start");
  const invoke = (name: string, params: Record<string, unknown>) =>
    executePlannedToolCall(
      runtime,
      {
        message: {
          id: stringToUuid(`strict-create-${name}`),
          entityId: runtime.agentId,
          roomId: stringToUuid("strict-create-room"),
          content: { text: "Make a note: Buy milk" },
        },
        userRoles: ["OWNER"],
        activeContexts: ["notes"],
      },
      { name, params },
    );
  const persisted = async () =>
    (
      JSON.parse(await readFile(filePath, "utf8")) as {
        notes: Array<{ title: string; body: string }>;
      }
    ).notes.map(({ title, body }) => ({ title, body }));
  return { service, invoke, persisted };
}

test.each([
  ["NOTES", { action: "create", content: "Buy milk", body: "" }],
  ["NOTES_CREATE", { content: "Buy milk", body: "" }],
])(
  "%s treats a strict-provider empty body as omission",
  async (name, params) => {
    const { service, invoke, persisted } = await setup();

    const created = await invoke(name, params);

    expect(created).toMatchObject({
      success: true,
      data: { note: { title: "Buy milk", body: "" }, replayed: false },
    });
    expect(await persisted()).toEqual([{ title: "Buy milk", body: "" }]);

    // The same note created without the placeholder is one logical note.
    const replay = await service.createNoteWithCommit({ content: "Buy milk" });
    expect(replay.replayed).toBe(true);
    expect(await persisted()).toEqual([{ title: "Buy milk", body: "" }]);

    const removed = await invoke("NOTES", {
      action: "delete",
      content: "Buy milk",
    });
    expect(removed).toMatchObject({ success: true, data: { removedCount: 1 } });
    expect(await persisted()).toEqual([]);
  },
);

test("a supplied create body still joins its title with one newline", async () => {
  const { invoke, persisted } = await setup();

  const created = await invoke("NOTES_CREATE", {
    content: "Groceries",
    body: "eggs\nbread",
  });

  expect(created).toMatchObject({
    success: true,
    data: { note: { title: "Groceries", body: "\neggs\nbread" } },
  });
  expect(await persisted()).toEqual([
    { title: "Groceries", body: "\neggs\nbread" },
  ]);
});
