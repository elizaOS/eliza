/** A move by name moves the one logical note, identical stored copies included. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, createCharacter } from "@elizaos/core";
import { initializeTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import { notesAction } from "../action.js";
import { NOTES_SERVICE_TYPE, NotesService } from "../service.js";
import { NotesStore } from "../store.js";
import {
  boundNotesRequest,
  notesFixtureText,
} from "./helpers/bound-notes-request.ts";

const directories: string[] = [];
const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});

it("moving a note by name takes its identical stored copies along", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "notes-move-"));
  directories.push(directory);
  const runtime = new AgentRuntime({
    character: createCharacter({ name: "Notes move" }),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  await initializeTestRuntime(runtime, { skipMigrations: true });
  const service = new NotesService(runtime, {
    store: new NotesStore({ filePath: path.join(directory, "notes.json") }),
  });
  await service.initialize();
  class FileNotesService extends NotesService {
    static override async start(): Promise<NotesService> {
      return service;
    }
  }
  await runtime.registerService(FileNotesService);
  await runtime.getServiceLoadPromise(NOTES_SERVICE_TYPE);
  // The Notes editor creates each new plain draft with forceNew, so an
  // owner who writes the same note twice stores two identical copies, shown
  // as one note.
  for (let copy = 0; copy < 2; copy += 1)
    await service.createNote({ content: "Groceries\nMilk", forceNew: true });
  expect(service.snapshot().notes).toHaveLength(1);

  const request = await boundNotesRequest(runtime, {
    text: notesFixtureText.move,
    operations: ["move"],
    message: {
      content: {
        text: "",
        metadata: { notesFolders: [{ id: "f-travel", name: "Travel" }] },
      },
    },
  });
  const moved = await request.handler(notesAction, {
    action: "move",
    content: "groceries",
    folder: "Travel",
  });

  expect(moved.success).toBe(true);
  expect(
    service.snapshot().notes.map((note) => ({
      title: note.title,
      folderId: note.format?.data.folderId ?? null,
    })),
  ).toEqual([{ title: "Groceries", folderId: "f-travel" }]);
});
