import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTES_CAPABILITIES } from "../capabilities.js";
import { interact } from "../interact.js";
import { NotesService } from "../service.js";
import { NotesStore } from "../store.js";

function tempStateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "notes-reviewer-"));
  return join(dir, "notes.json");
}

async function serviceFor(file: string): Promise<NotesService> {
  const store = new NotesStore({
    stateDir: file.replace(/\/[^/]+$/, ""),
    agentId: "test",
  });
  // @ts-expect-error
  store.filePath = file;
  const service = new NotesService(undefined, {
    store,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    createId: (() => {
      let i = 0;
      return () => `note-${++i}`;
    })(),
  });
  await service.initialize();
  return service;
}

describe("notes reviewer coverage", () => {
  it("declares title selector for get/update/delete", () => {
    const getNote = NOTES_CAPABILITIES.find((c) => c.id === "get-note")!;
    const deleteNote = NOTES_CAPABILITIES.find((c) => c.id === "delete-note")!;
    const updateNote = NOTES_CAPABILITIES.find((c) => c.id === "update-note")!;
    const clearNotes = NOTES_CAPABILITIES.find((c) => c.id === "clear-notes")!;
    expect(getNote.params).toHaveProperty("title");
    expect(deleteNote.params).toHaveProperty("title");
    expect(updateNote.params).toHaveProperty("title");
    expect(clearNotes.params).toHaveProperty("confirm");
    expect(clearNotes.params).toHaveProperty("revision");
    // content should not be in delete-note
    expect(deleteNote.params).not.toHaveProperty("content");
    expect(getNote.params).not.toHaveProperty("content");
  });

  it("delete-note with content fails closed", async () => {
    const service = await serviceFor(tempStateFile());
    await interact("create-note", { content: "QA marker\nBody" }, service);
    const result = await interact(
      "delete-note",
      { content: "QA marker" } as never,
      service,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("NOTES_VALIDATION_FAILED");
    expect(service.listNotes()).toHaveLength(1);
  });

  it("delete-note with exact title succeeds, query still works", async () => {
    const service = await serviceFor(tempStateFile());
    await interact("create-note", { content: "Exact Title\nBody1" }, service);
    await interact("create-note", { content: "Other\nBody2" }, service);
    const del = await interact(
      "delete-note",
      { title: "Exact Title" },
      service,
    );
    expect(del.success).toBe(true);
    expect(service.listNotes()).toHaveLength(1);
    expect(service.listNotes()[0]?.title).toBe("Other");
    // query
    await interact("create-note", { content: "Exact Title\nBody3" }, service);
    const del2 = await interact("delete-note", { query: "Body3" }, service);
    expect(del2.success).toBe(true);
  });

  it("clear-notes requires revision binding", async () => {
    const service = await serviceFor(tempStateFile());
    await interact("create-note", { content: "One" }, service);
    await interact("create-note", { content: "Two" }, service);
    const rev = service.snapshot().revision;
    // missing revision fails
    const miss = await interact(
      "clear-notes",
      { confirm: true } as never,
      service,
    );
    expect(miss.success).toBe(false);
    // false fails
    const fals = await interact(
      "clear-notes",
      { confirm: false, revision: rev } as never,
      service,
    );
    expect(fals.success).toBe(false);
    // stale fails
    const stale = await interact(
      "clear-notes",
      { confirm: true, revision: rev - 1 } as never,
      service,
    );
    expect(stale.success).toBe(false);
    expect(service.listNotes()).toHaveLength(2);
    // correct succeeds
    const ok = await interact(
      "clear-notes",
      { confirm: true, revision: rev },
      service,
    );
    expect(ok.success).toBe(true);
    expect(service.listNotes()).toHaveLength(0);
    expect(ok.data).toMatchObject({ cleared: 2 });
    // replay with same stale revision fails (already cleared, revision advanced)
    const replay = await interact(
      "clear-notes",
      { confirm: true, revision: rev } as never,
      service,
    );
    expect(replay.success).toBe(false);
  });

  it("clear-notes with single-note misselection cannot clear via boolean alone without revision", async () => {
    const service = await serviceFor(tempStateFile());
    await interact(
      "create-note",
      { content: "Single Note For Deletion" },
      service,
    );
    const rev = service.snapshot().revision;
    // planner mis-selects clear-notes for single-note request but provides only confirm:true without revision -> fails
    const mis = await interact(
      "clear-notes",
      { confirm: true } as never,
      service,
    );
    expect(mis.success).toBe(false);
    expect(service.listNotes()).toHaveLength(1);
    // even with correct revision, it would clear all, which is the structural risk the reviewer notes
    // but our binding at least requires revision, not just boolean
    const withRev = await interact(
      "clear-notes",
      { confirm: true, revision: rev },
      service,
    );
    expect(withRev.success).toBe(true);
  });
});
