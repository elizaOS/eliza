/**
 * Regression: Notes owner-text checks read the owner's words, not the
 * contextual-documents envelope the chat route substitutes for content.text,
 * and a planner-substituted ID for a named title does not choose between
 * distinct same-title notes on delete.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ActionResult,
  bindIncomingMessagePersistence,
  type IAgentRuntime,
  promoteSubactionsToActions,
  stringToUuid,
} from "@elizaos/core";
import { expect, test } from "vitest";
import { maybeAugmentChatMessageWithDocuments } from "../../../../packages/agent/src/api/chat-augmentation.ts";
import { HELP_DOCUMENTS } from "../../../../packages/agent/src/runtime/default-help-documents.ts";
import { notesAction } from "../action.js";
import { namedNotesProvider, namedNotesRoutingProvider } from "../provider.js";
import { namedNoteReadEvaluator } from "../request-effect.js";
import { NotesService } from "../service.js";
import { boundNotesRequest } from "./helpers/bound-notes-request.ts";

const children = promoteSubactionsToActions(notesAction);
const child = (name: string) => {
  const action = children.find((candidate) => candidate.name === name);
  if (!action) throw Error(`missing ${name}`);
  return action;
};
const fragments = HELP_DOCUMENTS.flatMap((doc) =>
  (doc.fragments ?? []).map((fragment) => ({ doc, text: fragment.text })),
);

async function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "notes-owner-text-"));
  let service: NotesService | undefined;
  // Keyword-search stand-in returning every bundled FAQ fragment; the route's
  // own coverage gate selects what enters the envelope.
  const documents = {
    countMemories: async () => fragments.length,
    searchDocuments: async () =>
      fragments.map((fragment, index) => ({
        id: stringToUuid(`fragment-${index}`),
        content: { text: fragment.text },
        similarity: 1,
        metadata: { filename: fragment.doc.filename },
      })),
  };
  const logger = { warn() {}, debug() {}, info() {}, error() {} };
  const runtime = {
    agentId: stringToUuid(directory),
    actions: children,
    logger,
    getCurrentRunId: () => undefined,
    getService: (name: string) =>
      name === "notes" ? service : name === "documents" ? documents : null,
    getServiceLoadPromise: async (name: string) =>
      name === "documents"
        ? documents
        : name === "connector-setup"
          ? { broadcastWs() {} }
          : null,
    reportError: (...args: unknown[]) => {
      throw args[1];
    },
  } as unknown as IAgentRuntime;
  const notes = new NotesService(runtime, { stateDir: directory });
  service = notes;
  await notes.initialize();
  const augment = async (text: string) => {
    const routed = await maybeAugmentChatMessageWithDocuments(
      runtime as never,
      // No message id: the detached per-turn recall-embed warm is out of scope.
      {
        entityId: runtime.agentId,
        roomId: runtime.agentId,
        content: { text },
      } as never,
    );
    return routed.content.text as string;
  };
  return {
    runtime,
    service: notes,
    augment,
    done: async () => {
      await notes.stop();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("the delete name fence reads the owner's words inside the document envelope", async () => {
  const f = await fixture();
  try {
    const owner = "delete the note with my Slack token";
    await f.service.createNoteWithCommit({
      content: "Settings\nslack token xoxb-1",
    });
    const routed = await f.augment(owner);
    // The route really rewrites this request, and the FAQ names "Settings".
    expect(routed).not.toBe(owner);
    expect(routed).toContain("Settings");
    for (const text of [owner, routed]) {
      const request = await boundNotesRequest(f.runtime, {
        text,
        operations: ["delete"],
      });
      const result = (await request.handler(child("NOTES_DELETE"), {
        content: "slack token",
      })) as ActionResult;
      expect(result.success).toBe(false);
      expect(result.error).toBe("NOTES_DELETE_NAME_MISMATCH");
      expect(f.service.snapshot().notes).toHaveLength(1);
    }
  } finally {
    await f.done();
  }
});

test("named-note routing and evidence ignore titles that only the envelope names", async () => {
  const f = await fixture();
  try {
    const owner = "read my note on voice models";
    await f.service.createNoteWithCommit({
      content: "Settings\nprivate door code 4411",
    });
    await f.service.createNoteWithCommit({
      content: "Voice models comparison\nkokoro vs piper",
    });
    const routed = await f.augment(owner);
    expect(routed).not.toBe(owner);
    expect(routed).toContain("Settings");
    for (const text of [owner, routed]) {
      const message = { content: { text } } as never;
      expect(
        (
          namedNoteReadEvaluator as unknown as {
            evaluate: (input: unknown) => unknown;
          }
        ).evaluate({ runtime: f.runtime, message }),
      ).toBeUndefined();
      const named = await namedNotesProvider.get(
        f.runtime,
        message,
        {} as never,
      );
      expect(JSON.stringify(named)).not.toContain("4411");
      const routing = await namedNotesRoutingProvider.get(
        f.runtime,
        message,
        {} as never,
      );
      expect(routing.text).toBe("");
    }
  } finally {
    await f.done();
  }
});

test("a note the owner names inside the envelope still routes to that note", async () => {
  const f = await fixture();
  try {
    const owner = "read my Settings note";
    const settings = (
      await f.service.createNoteWithCommit({ content: "Settings\nbody" })
    ).value;
    const routed = await f.augment(owner);
    const request = await boundNotesRequest(f.runtime, {
      text: "The current view is Notes.",
      operations: ["get"],
    });
    bindIncomingMessagePersistence(request.message, {
      ...request.message,
      content: { ...request.message.content, text: owner },
    });
    for (const message of [
      { content: { text: owner } },
      { content: { text: routed } },
      request.message,
    ]) {
      expect(
        (
          namedNoteReadEvaluator as unknown as {
            evaluate: (input: unknown) => unknown;
          }
        ).evaluate({ runtime: f.runtime, message }),
      ).toMatchObject({
        deterministicToolCall: {
          name: "NOTES_GET",
          params: { noteId: settings.id },
        },
      });
    }
  } finally {
    await f.done();
  }
});

test("delete with a planner-substituted ID asks between distinct same-title notes", async () => {
  const f = await fixture();
  try {
    await f.service.createNoteWithCommit({ content: "Groceries\nmilk" });
    const two = (
      await f.service.createNoteWithCommit({
        content: "Groceries\nparty snacks for Saturday",
      })
    ).value;
    const request = await boundNotesRequest(f.runtime, {
      text: "delete my Groceries note",
      operations: ["delete"],
    });
    const result = (await request.handler(child("NOTES_DELETE"), {
      noteId: two.id,
    })) as ActionResult;
    expect(result.success).toBe(false);
    expect(result.error).toBe("NOTES_AMBIGUOUS_NOTE");
    expect(f.service.snapshot().notes).toHaveLength(2);
  } finally {
    await f.done();
  }
});

test("delete by ID proceeds for a selection or an ID the owner gave", async () => {
  const f = await fixture();
  try {
    const one = (
      await f.service.createNoteWithCommit({ content: "Groceries\nmilk" })
    ).value;
    const two = (
      await f.service.createNoteWithCommit({
        content: "Groceries\nparty snacks for Saturday",
      })
    ).value;
    const selection = await boundNotesRequest(f.runtime, {
      text: "the second one",
      operations: ["delete"],
    });
    const selected = (await selection.handler(child("NOTES_DELETE"), {
      noteId: two.id,
    })) as ActionResult;
    expect(selected.success).toBe(true);
    await f.service.createNoteWithCommit({
      content: "Groceries\nparty snacks for Saturday",
    });
    const byId = await boundNotesRequest(f.runtime, {
      text: `delete my Groceries note ${one.id}`,
      operations: ["delete"],
    });
    const explicit = (await byId.handler(child("NOTES_DELETE"), {
      noteId: one.id,
    })) as ActionResult;
    expect(explicit.success).toBe(true);
    const left = f.service.snapshot().notes;
    expect(left).toHaveLength(1);
    expect(left[0].id).not.toBe(one.id);
    expect(left[0].body).toContain("party snacks for Saturday");
  } finally {
    await f.done();
  }
});

test("a unique named title still deletes when the planner supplies its ID", async () => {
  const f = await fixture();
  try {
    const only = (
      await f.service.createNoteWithCommit({ content: "Groceries\nmilk" })
    ).value;
    const request = await boundNotesRequest(f.runtime, {
      text: "delete my Groceries note",
      operations: ["delete"],
    });
    const result = (await request.handler(child("NOTES_DELETE"), {
      noteId: only.id,
    })) as ActionResult;
    expect(result.success).toBe(true);
    expect(f.service.snapshot().notes).toHaveLength(0);
  } finally {
    await f.done();
  }
});
