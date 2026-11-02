// @vitest-environment node
/**
 * The title fallback in updateNoteFromChatReference must read the user's
 * own words, not the rendered message text. On a document-augmented turn
 * the rendered text also holds the retrieved documents, so a title named
 * only inside a document rerouted an exact-id edit through the title
 * lookup — where duplicate titles turned it into an ambiguity failure
 * instead of the edit the planner already targeted.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  IAgentRuntime,
  Memory,
  NotesRequestOperation,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { boundNotesRequest } from "./__tests__/helpers/bound-notes-request.ts";
import { notesAction } from "./action.js";
import { notesPlugin } from "./plugin.js";
import { getNotesService, NOTES_SERVICE_TYPE, NotesService } from "./service.js";
import { NotesStore } from "./store.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

async function harness(): Promise<IAgentRuntime> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notes-user-words-"));
  dirs.push(dir);
  let service: NotesService;
  const runtime = {
    agentId: randomUUID(),
    actions: notesPlugin.actions,
    getService: (type: string) =>
      type === NOTES_SERVICE_TYPE ? service : null,
    getServiceLoadPromise: async () => ({}),
    reportError: () => {},
  } as unknown as IAgentRuntime;
  service = new NotesService(runtime, {
    store: new NotesStore({ filePath: path.join(dir, "notes.json") }),
  });
  await service.initialize();
  return runtime;
}

async function directNotesHandler(
  runtime: IAgentRuntime,
  operation: NotesRequestOperation,
  original: Memory,
  options?: Parameters<typeof notesAction.handler>[3],
) {
  const request = await boundNotesRequest(runtime, {
    text: original.content?.text || "Edit the requested saved note.",
    operations: [operation],
    message: original,
  });
  return request.handler(
    notesAction,
    (options?.parameters ?? {}) as Record<string, unknown>,
  );
}

const ENVELOPE =
  "Answer the user request using the contextual documents\n" +
  "<user_request>update that note</user_request>\n" +
  "Retrieved document: the Secret project plan covers next quarter.";

describe("update note from user words, not the document envelope", () => {
  it("edits the exact id when only a retrieved document names the title", async () => {
    const runtime = await harness();
    const service = getNotesService(runtime);
    await service.createNote({ title: "Secret project plan", body: "Alpha body" });
    const target = await service.createNote({
      title: "Secret project plan",
      body: "Beta body",
    });
    const revision = service.snapshot().revision;
    const message = { content: { text: ENVELOPE } } as unknown as Memory;
    const result = await directNotesHandler(runtime, "update", message, {
      parameters: {
        action: "update",
        noteId: target.id,
        textEdit: { action: "append", field: "body", text: "\nGamma" },
        expectedRevision: revision,
      },
    });
    expect(result.success).toBe(true);
    const notes = service.listNotes();
    expect(notes).toHaveLength(2);
    expect(
      notes.find((note) => note.id === target.id)?.body,
    ).toContain("Beta body\nGamma");
    expect(
      notes.find((note) => note.id !== target.id)?.body,
    ).toContain("Alpha body");
  });

  it("still asks which note when the user words name a duplicated title", async () => {
    const runtime = await harness();
    const service = getNotesService(runtime);
    await service.createNote({ title: "Secret project plan", body: "Alpha body" });
    const target = await service.createNote({
      title: "Secret project plan",
      body: "Beta body",
    });
    const revision = service.snapshot().revision;
    const message = {
      content: { text: "update the Secret project plan note" },
    } as unknown as Memory;
    const result = await directNotesHandler(runtime, "update", message, {
      parameters: {
        action: "update",
        noteId: target.id,
        textEdit: { action: "append", field: "body", text: "\nGamma" },
        expectedRevision: revision,
      },
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({ awaitingUserInput: true });
    expect(service.listNotes()).toHaveLength(2);
    expect(
      service.listNotes().find((note) => note.id === target.id)?.body,
    ).not.toContain("Gamma");
  });
});
