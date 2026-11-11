import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NotesService } from "../service.js";
import { NotesStore } from "../store.js";

async function editOlderNoteToMatchNewer(clockMovesBack: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notes-lookup-"));
  const epoch = Date.parse("2026-07-16T12:00:00.000Z");
  let tick = 0;
  const now = () => new Date(epoch + tick++ * 1_000);
  let next = 1;
  const service = new NotesService(undefined, {
    store: new NotesStore({
      filePath: path.join(dir, "notes", "state.json"),
      now,
    }),
    now,
    createId: () => `note-test-${next++}`,
  });
  await service.initialize();
  // The owner edits the older note until it matches a newer one.
  const typed = await service.createNote({
    title: "Mil",
    body: "",
    color: "yellow",
  });
  const newer = await service.createNote({
    title: "Milk",
    body: "",
    color: "yellow",
  });
  if (clockMovesBack) tick -= 60;
  await service.updateNoteWithCommit(
    typed.id,
    { title: "Milk" },
    service.snapshot().revision,
  );
  return { service, typed, newer };
}

describe("lookup over identical copies", () => {
  for (const [name, clockMovesBack] of [
    ["the copy edited last", false],
    ["the copy with the newer revision when its clock time is older", true],
  ] as const) {
    it(`resolves to the copy the list shows: ${name}`, async () => {
      const { service, typed, newer } =
        await editOlderNoteToMatchNewer(clockMovesBack);
      expect(service.snapshot().notes.map((note) => note.id)).toEqual([
        typed.id,
      ]);
      expect(service.getNoteByLookup("title", "Milk").id).toBe(typed.id);

      // An edit by title must keep the note the owner sees, not the hidden copy.
      const result = await service.updateNoteByLookupWithCommit(
        "title",
        "Milk",
        { color: "green" },
        service.snapshot().revision,
      );
      expect(result.value.id).toBe(typed.id);
      expect(result.consolidatedIds).toEqual([newer.id]);
      expect(service.getNote(typed.id)).toMatchObject({
        title: "Milk",
        color: "green",
      });
    });
  }
});
