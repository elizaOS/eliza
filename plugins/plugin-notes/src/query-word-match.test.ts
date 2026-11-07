/**
 * Tests that query lookups prefer notes naming the query as a whole word over
 * notes that only contain it inside a longer word.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotesService } from "./service";
import type { StickyNote } from "./types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function seeded(
  notes: Array<Pick<StickyNote, "title" | "color">>,
): Promise<NotesService> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "notes-query-word-"));
  temporaryDirectories.push(stateDir);
  const service = new NotesService(undefined, { stateDir });
  await service.initialize();
  for (const note of notes) {
    await service.createNoteWithCommit({ ...note, body: "" });
  }
  return service;
}

async function updatedTitle(
  service: NotesService,
  query: string,
): Promise<string | undefined> {
  const before = service.snapshot().notes;
  const result = await service.updateNoteByLookupWithCommit(
    "query",
    query,
    { content: "Updated" },
    service.snapshot().revision,
  );
  return before.find((note) => note.id === result.value.id)?.title;
}

describe("query lookup whole-word tier", () => {
  it("prefers a whole-word title over a word that contains the query", async () => {
    const service = await seeded([
      { title: "Trip plan", color: "yellow" },
      { title: "Airplane snacks", color: "green" },
    ]);
    expect(await updatedTitle(service, "plan")).toBe("Trip plan");
  });

  it("does not treat a longer word starting with the query as a match", async () => {
    const service = await seeded([
      { title: "Tea to buy", color: "yellow" },
      { title: "Team offsite", color: "green" },
    ]);
    expect(await updatedTitle(service, "tea")).toBe("Tea to buy");
  });

  it("matches a color as a whole word ahead of a title substring", async () => {
    const service = await seeded([
      { title: "Groceries", color: "rose" },
      { title: "Prosecco brands", color: "yellow" },
    ]);
    expect(await updatedTitle(service, "rose")).toBe("Groceries");
  });

  it("still lets an exact title win", async () => {
    const service = await seeded([
      { title: "Plan", color: "yellow" },
      { title: "Trip plan", color: "green" },
    ]);
    expect(await updatedTitle(service, "plan")).toBe("Plan");
  });

  it("still resolves a Korean title by its leading word", async () => {
    const service = await seeded([
      { title: "장보기 목록", color: "yellow" },
      { title: "Weekly review", color: "green" },
    ]);
    expect(await updatedTitle(service, "장보기")).toBe("장보기 목록");
  });
});
