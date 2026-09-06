/** Exercises real Notes persistence when the filesystem denies hard links, including competing publication and interrupted initialization. */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { NotesStore } from "../store.js";
import type { StickyNote } from "../types.js";

const directories: string[] = [];
const stores: NotesStore[] = [];
const note: StickyNote = {
  id: "saved-note",
  title: "Remember the meeting",
  body: "Bring the design notes",
  color: "yellow",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stores.splice(0).map((store) => store.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
async function location(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notes-publication-"));
  directories.push(dir);
  return path.join(dir, "state.json");
}
function open(filePath: string): NotesStore {
  const store = new NotesStore({ filePath });
  stores.push(store);
  return store;
}
function denyHardLinks(): void {
  vi.spyOn(fs, "link").mockRejectedValue(
    Object.assign(new Error("Android denies hard links"), { code: "EACCES" }),
  );
}
it("persists edits and deletes across restarts after atomic directory publication", async () => {
  denyHardLinks();
  const file = await location();
  const first = open(file);
  await first.initialize();
  await first.transact((draft) => draft.notes.push(note));
  await first.stop();
  const second = open(file);
  await second.initialize();
  expect(second.snapshot().notes).toEqual([note]);
  await second.transact((draft) => {
    draft.notes[0].body = "Updated meeting notes";
  });
  await second.stop();
  const third = open(file);
  await third.initialize();
  expect(third.snapshot().notes[0].body).toBe("Updated meeting notes");
  await third.transact((draft) => {
    draft.notes = [];
  });
  await third.stop();
  const fourth = open(file);
  await fourth.initialize();
  expect(fourth.snapshot()).toEqual({ notes: [], revision: 3 });
});
it("reads a complete rival publication without replacing its notes", async () => {
  denyHardLinks();
  const file = await location();
  const rename = fs.rename.bind(fs);
  const winner = JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    persistedAt: note.createdAt,
    notes: [note],
  });
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (destination === `${file}.store`) {
      await fs.mkdir(destination);
      await fs.writeFile(path.join(destination, "state.json"), winner);
    }
    return rename(source, destination);
  });
  const store = open(file);
  await store.initialize();
  expect(store.snapshot()).toEqual({ revision: 7, notes: [note] });
  expect(await fs.readFile(`${file}.store/state.json`, "utf8")).toBe(winner);
});
it("rejects an incomplete published directory and preserves an abandoned candidate", async () => {
  const file = await location();
  await fs.mkdir(`${file}.store`);
  const candidate = `${file}.store.abandoned.tmp`;
  await fs.mkdir(candidate);
  await fs.writeFile(path.join(candidate, "state.json"), "unfinished");
  await expect(open(file).initialize()).rejects.toMatchObject({
    code: "NOTES_STORE_INVALID_PUBLICATION",
  });
  expect(await fs.readFile(path.join(candidate, "state.json"), "utf8")).toBe(
    "unfinished",
  );
});
it("keeps existing flat documents authoritative when hard links are unavailable", async () => {
  const file = await location();
  const first = open(file);
  await first.initialize();
  await first.transact((draft) => draft.notes.push(note));
  await first.stop();
  denyHardLinks();
  const second = open(file);
  await second.initialize();
  await second.transact((draft) => {
    draft.notes[0].body = "Legacy edit";
  });
  expect(JSON.parse(await fs.readFile(file, "utf8")).notes[0].body).toBe(
    "Legacy edit",
  );
});
