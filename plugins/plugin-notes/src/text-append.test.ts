import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type IAgentRuntime,
  type Memory,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { notesAction } from "./action.js";
import { inferSelectedNotesUpdate } from "./native-note-update.js";
import { NotesService } from "./service.js";
import { NotesStore } from "./store.js";
import { noteTextEditSchema } from "./types.js";
import { parseUpdateNoteInput } from "./validation.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notes-append-"));
  dirs.push(dir);
  const runtime = {
    agentId: randomUUID(),
    getServiceLoadPromise: async () => ({ broadcastWs: () => {} }),
  } as unknown as IAgentRuntime;
  const service = new NotesService(runtime, {
    store: new NotesStore({ filePath: path.join(dir, "notes.json") }),
  });
  await service.initialize();
  return service;
}
const append = (text: string) => ({
  textEdit: { action: "append", field: "body", text },
});

describe("lossless Notes append", () => {
  it("appends only the suffix and preserves old punctuation, whitespace, Unicode and metadata", async () => {
    const service = await setup();
    const created = await service.createNoteWithCommit({
      content: "Alpha launch check\nPack a jacket.  \n雪",
      color: "slate",
      format: { kind: "text", data: { custom: { keep: true } } },
    });
    const before = created.value;
    const changed = await service.updateNoteWithCommit(
      before.id,
      append("\nBring water"),
      created.snapshot.revision,
    );
    expect(changed.value.body).toBe(before.body + "\nBring water");
    expect(changed.value).toMatchObject({
      id: before.id,
      title: before.title,
      color: before.color,
      createdAt: before.createdAt,
      format: before.format,
    });
    expect(changed.snapshot.revision).toBe(created.snapshot.revision + 1);
  });
  it("rejects stale and missing revisions without changing the note", async () => {
    const service = await setup();
    const created = await service.createNoteWithCommit({
      content: "Packing\nPack a jacket.",
    });
    const changed = await service.updateNoteWithCommit(
      created.value.id,
      append("\nBring water"),
      created.snapshot.revision,
    );
    await expect(
      service.updateNoteWithCommit(
        created.value.id,
        append("\nStale"),
        created.snapshot.revision,
      ),
    ).rejects.toThrow();
    await expect(
      service.updateNoteWithCommit(created.value.id, append("\nMissing")),
    ).rejects.toThrow();
    const after = await service.getNote(created.value.id);
    expect(after).toEqual(changed.value);
  });
  it("uses the same revision guard for lookup appends and preserves literal replace behavior", async () => {
    const service = await setup();
    const created = await service.createNoteWithCommit({
      content: "Packing\nPack a jacket.",
    });
    const changed = await service.updateNoteByLookupWithCommit(
      "title",
      "Packing",
      append("\nBring water"),
      created.snapshot.revision,
    );
    expect(changed.value.body).toBe("\nPack a jacket.\nBring water");
    await expect(
      service.updateNoteByLookupWithCommit(
        "title",
        "Packing",
        append("\nAgain"),
        created.snapshot.revision,
      ),
    ).rejects.toThrow();
    const replaced = await service.updateNoteWithCommit(created.value.id, {
      textEdit: { field: "body", oldText: "jacket.", newText: "coat." },
    });
    expect(replaced.value.body).toBe("\nPack a coat.\nBring water");
  });
  it("dispatches append through the public Notes action without rewriting the original", async () => {
    const service = await setup();
    const created = await service.createNoteWithCommit({
      content: "Packing\nPack a jacket.",
    });
    const runtime = { getService: () => service } as unknown as IAgentRuntime;
    const result = await notesAction.handler(
      runtime,
      { content: { text: "Add Bring water to that note." } } as Memory,
      undefined,
      {
        parameters: {
          action: "update",
          noteId: created.value.id,
          expectedRevision: created.snapshot.revision,
          ...append("\nBring water"),
        },
      } as never,
    );
    expect(result?.success).toBe(true);
    expect(service.getNote(created.value.id)?.body).toBe(
      "\nPack a jacket.\nBring water",
    );
  });
  it("does not invent separators for an empty body or inline suffix", async () => {
    const service = await setup();
    const created = await service.createNoteWithCommit({ content: "Packing" });
    const changed = await service.updateNoteWithCommit(
      created.value.id,
      append("\nBring water"),
      created.snapshot.revision,
    );
    const inline = await service.updateNoteWithCommit(
      created.value.id,
      append("!"),
      changed.snapshot.revision,
    );
    expect(inline.value.title).toBe("Packing");
    expect(inline.value.body).toBe("\nBring water!");
  });
  it("keeps checklist append on its authored path without modifying existing items", async () => {
    const service = await setup();
    const created = await service.createNoteWithCommit({
      title: "Packing",
      format: {
        kind: "list",
        data: {
          items: [{ t: "Pack a jacket.", done: true, custom: "keep" }],
          custom: { untouched: true },
        },
      },
    });
    await expect(
      service.updateNoteWithCommit(
        created.value.id,
        append("\nBring water"),
        created.snapshot.revision,
      ),
    ).rejects.toThrow();
    const changed = await service.updateNoteWithCommit(
      created.value.id,
      {
        authoredEdit: {
          field: "checklist",
          action: "append",
          text: "Bring water",
        },
      },
      created.snapshot.revision,
    );
    expect(changed.value.format?.data).toEqual({
      items: [
        { t: "Pack a jacket.", done: true, custom: "keep" },
        { t: "Bring water", done: false },
      ],
      custom: { untouched: true },
    });
  });
  it("keeps an empty checklist on the authored append route", async () => {
    const service = await setup();
    const created = await service.createNoteWithCommit({
      title: "Packing",
      format: { kind: "list", data: { items: [], custom: "preserve" } },
    });
    await expect(
      service.updateNoteWithCommit(
        created.value.id,
        append("\nBring water"),
        created.snapshot.revision,
      ),
    ).rejects.toThrow();
    expect(service.getNote(created.value.id)).toEqual(created.value);
    const changed = await service.updateNoteWithCommit(
      created.value.id,
      {
        authoredEdit: {
          field: "checklist",
          action: "append",
          text: "Bring water",
        },
      },
      created.snapshot.revision,
    );
    expect(changed.value.format?.data).toEqual({
      items: [{ t: "Bring water", done: false }],
      custom: "preserve",
    });
  });
  it("exposes one shared schema and rejects mixed or invalid append payloads", () => {
    expect(
      notesAction.parameters?.find((x) => x.name === "textEdit")?.schema,
    ).toBe(noteTextEditSchema);
    for (const textEdit of [
      { action: "append", field: "title", text: "x" },
      { action: "append", field: "body", text: "" },
      { action: "append", field: "body", text: "x", oldText: "old" },
      { action: "other", field: "body", oldText: "x", newText: "y" },
    ])
      expect(() => parseUpdateNoteInput({ textEdit })).toThrow();
  });
  it("uses canonical append in selected-native-note extraction without asking the model to rewrite the original", async () => {
    let calls = 0;
    const runtime = {
      useModel: async (
        _type: unknown,
        request: { responseSchema: unknown },
      ) => {
        calls++;
        expect(JSON.stringify(request.responseSchema)).toContain('"append"');
        return JSON.stringify({
          requiresInput: false,
          clarification: null,
          changes: [],
          textEdit: { action: "append", field: "body", text: "\nBring water" },
        });
      },
    } as unknown as IAgentRuntime;
    const result = await runWithTrajectoryContext(
      { trajectoryStepId: "notes-append-test" },
      () =>
        inferSelectedNotesUpdate({
          runtime,
          message: {
            content: { text: "Add Bring water to that note." },
          } as Memory,
          fields: { title: "Packing", body: "Pack a jacket." },
          signal: new AbortController().signal,
        }),
    );
    expect(result.fields).toEqual({
      title: "Packing",
      body: "Pack a jacket.\nBring water",
    });
    expect(calls).toBe(1);
  });
});
