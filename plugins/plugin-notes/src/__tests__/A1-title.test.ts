import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTES_CAPABILITIES } from "../capabilities.js";
import { interact } from "../interact.js";
import { NotesService } from "../service.js";
import { NotesStore } from "../store.js";

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "a1-"));
  return join(dir, "notes.json");
}

async function serviceFor(file: string): Promise<NotesService> {
  const store = new NotesStore({
    stateDir: file.replace(/\/[^/]+$/, ""),
    agentId: "test",
  });
  // @ts-expect-error
  store.filePath = file;
  const svc = new NotesService(undefined, {
    store,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    createId: (() => {
      let i = 0;
      return () => `note-${++i}`;
    })(),
  });
  await svc.initialize();
  return svc;
}

describe("A1 title selector (real NOTES_CAPABILITIES)", () => {
  it("declares title for get/update/delete and not for create", () => {
    const get = NOTES_CAPABILITIES.find((c) => c.id === "get-note");
    const del = NOTES_CAPABILITIES.find((c) => c.id === "delete-note");
    const upd = NOTES_CAPABILITIES.find((c) => c.id === "update-note");
    const cre = NOTES_CAPABILITIES.find((c) => c.id === "create-note");
    expect(get).toBeDefined();
    expect(del).toBeDefined();
    expect(upd).toBeDefined();
    expect(cre).toBeDefined();
    if (!get || !del || !upd || !cre) return;
    expect(get.params).toHaveProperty("title");
    expect(del.params).toHaveProperty("title");
    expect(upd.params).toHaveProperty("title");
    expect(cre.params).not.toHaveProperty("title");
    expect(del.params).not.toHaveProperty("content");
  });

  it("delete-note with exact title deletes, content fails closed, query still works", async () => {
    const svc = await serviceFor(tempFile());
    await interact("create-note", { content: "Exact Title\nBody1" }, svc);
    await interact("create-note", { content: "Other\nBody2" }, svc);
    // exact title
    const del = await interact("delete-note", { title: "Exact Title" }, svc);
    expect(del.success).toBe(true);
    expect(svc.listNotes()).toHaveLength(1);
    // content must fail
    await interact("create-note", { content: "Exact Title\nBody3" }, svc);
    const bad = await interact(
      "delete-note",
      { content: "Exact Title" } as never,
      svc,
    );
    expect(bad.success).toBe(false);
    expect(bad.error?.code).toBe("NOTES_VALIDATION_FAILED");
    expect(svc.listNotes()).toHaveLength(2);
    // query (unique contained text)
    const del2 = await interact("delete-note", { query: "Body3" }, svc);
    expect(del2.success).toBe(true);
    expect(svc.listNotes()).toHaveLength(1);
  });

  it("get-note with title reads exact, missing/duplicate fails without mutation", async () => {
    const svc = await serviceFor(tempFile());
    await interact("create-note", { content: "Dup Title\nA" }, svc);
    await interact("create-note", { content: "Dup Title\nB" }, svc);
    const miss = await interact("get-note", { title: "No Such" }, svc);
    expect(miss.success).toBe(false);
    const dup = await interact("get-note", { title: "Dup Title" }, svc);
    expect(dup.success).toBe(false);
    expect(svc.listNotes()).toHaveLength(2);
    // exact with body disambiguation via full title still duplicate, but unique title works
    await interact("create-note", { content: "Unique Title\nC" }, svc);
    const ok = await interact("get-note", { title: "Unique Title" }, svc);
    expect(ok.success).toBe(true);
  });
});
