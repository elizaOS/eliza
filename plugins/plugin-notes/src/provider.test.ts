/**
 * Real-runtime coverage for the SAVED_NOTES provider: a note written through
 * the durable service must come back out through `composeState`, which is the
 * only path that puts it in front of the planner. The harness is
 * integration-backed — a real `AgentRuntime`, a real `NotesService`, and a real
 * temp-file store — because the bug was precisely that two real subsystems
 * never met.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  ElizaError,
  filterProvidersByContextGate,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  stringToUuid,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { notesPlugin } from "./plugin.js";
import { notesProvider, renderSavedNotesText } from "./provider.js";
import { NOTES_SERVICE_TYPE, NotesService } from "./service.js";
import { NotesStore } from "./store.js";
import type { StickyNote } from "./types.js";
import { parseNoteContent } from "./validation.js";

const temporaryDirectories: string[] = [];
const testRuntimes: AgentRuntime[] = [];
let runtimeSequence = 0;

afterEach(async () => {
  await Promise.all(testRuntimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function clock(start = "2026-08-14T12:00:00.000Z"): () => Date {
  let tick = 0;
  const epoch = Date.parse(start);
  return () => new Date(epoch + tick++ * 1_000);
}

function idFactory(): () => string {
  let next = 1;
  return () => `note-provider-${next++}`;
}

async function temporaryStateFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "notes-provider-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "notes", "state.json");
}

async function serviceWithNotes(contents: string[]): Promise<NotesService> {
  const now = clock();
  const service = new NotesService(undefined, {
    store: new NotesStore({ filePath: await temporaryStateFile(), now }),
    now,
    createId: idFactory(),
  });
  await service.initialize();
  for (const content of contents) {
    await service.createNote(parseNoteContent(content));
  }
  return service;
}

async function bareRuntime(): Promise<AgentRuntime> {
  const runtime = new AgentRuntime({
    agentId: stringToUuid(`notes-provider-runtime-${runtimeSequence++}`),
    character: createCharacter({ name: "Notes provider" }),
    disableBasicCapabilities: true,
    enableAutonomy: false,
    logLevel: "fatal",
  });
  testRuntimes.push(runtime);
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  return runtime;
}

async function runtimeWith(service: NotesService): Promise<AgentRuntime> {
  const runtime = await bareRuntime();
  class BoundNotesService extends NotesService {
    static override async start(
      _runtime: IAgentRuntime,
    ): Promise<NotesService> {
      return service;
    }
  }
  await runtime.registerService(BoundNotesService);
  await runtime.getServiceLoadPromise(NOTES_SERVICE_TYPE);
  return runtime;
}

function recallMessage(runtime: AgentRuntime, text: string): Memory {
  return {
    id: stringToUuid(`notes-provider-message-${text}`),
    entityId: stringToUuid("notes-provider-owner"),
    agentId: runtime.agentId,
    roomId: stringToUuid("notes-provider-room"),
    content: { text, source: "test" },
    createdAt: Date.parse("2026-08-14T12:05:00.000Z"),
  };
}

function registeredNotesProvider(): Provider {
  const provider = notesPlugin.providers?.find(
    (candidate) => candidate.name === "SAVED_NOTES",
  );
  if (!provider) {
    throw new Error("notesPlugin must register the SAVED_NOTES provider.");
  }
  return provider;
}

const EMPTY_STATE = { values: {}, data: {}, text: "" } satisfies State;

describe("SAVED_NOTES provider", () => {
  it("is absent from non-owner context and available to the owner", () => {
    expect(notesProvider.roleGate).toEqual({ minRole: "OWNER" });
    expect(
      filterProvidersByContextGate([notesProvider], ["general"], ["USER"]),
    ).toEqual([]);
    expect(
      filterProvidersByContextGate([notesProvider], ["memory"], ["ADMIN"]),
    ).toEqual([]);
    expect(
      filterProvidersByContextGate([notesProvider], ["general"], ["OWNER"]),
    ).toEqual([notesProvider]);
  });

  it("surfaces a saved note through composeState so recall does not depend on memory search", async () => {
    // The live failure (2026-08-14): this note existed while "who is alex
    // again" answered "Found 0 memory item(s)" twice.
    const service = await serviceWithNotes([
      "alex is my cofounder and we met at ethdenver",
    ]);
    const runtime = await runtimeWith(service);
    runtime.registerProvider(registeredNotesProvider());

    const state = await runtime.composeState(
      recallMessage(runtime, "who is alex again"),
      ["SAVED_NOTES"],
      true,
    );

    expect(state.text).toContain(
      "alex is my cofounder and we met at ethdenver",
    );
    expect(state.values.savedNotesAvailable).toBe(true);
    expect(state.values.savedNoteCount).toBe(1);
  });

  it("is routed to the contexts a recall turn actually selects", () => {
    // "make a note …" routes general and "who is alex again" routes memory;
    // a notes-only gate would have reproduced the bug on the recall turn.
    expect(registeredNotesProvider().contexts).toEqual(["general", "memory"]);
  });

  it("renders designed-empty distinctly from unavailable", async () => {
    const service = await serviceWithNotes([]);
    const runtime = await runtimeWith(service);

    const result = await notesProvider.get(
      runtime,
      recallMessage(runtime, "what notes do i have"),
      EMPTY_STATE,
    );

    expect(result.text).toBe("");
    expect(result.values?.savedNotesAvailable).toBe(true);
    expect(result.values?.savedNoteCount).toBe(0);
    expect(result.data?.savedNotes).toEqual([]);
  });

  it("reports an unreadable store as unavailable instead of an empty note list", async () => {
    const service = await serviceWithNotes([
      "alex is my cofounder and we met at ethdenver",
    ]);
    const runtime = await runtimeWith(service);
    const reported: unknown[] = [];
    runtime.reportError = (_scope: string, error: unknown) => {
      reported.push(error);
    };
    service.listNotes = () => {
      throw new ElizaError("Notes state is not loaded.", {
        code: "NOTES_STORE_UNAVAILABLE",
        severity: "ephemeral",
      });
    };

    const result = await notesProvider.get(
      runtime,
      recallMessage(runtime, "who is alex again"),
      EMPTY_STATE,
    );

    expect(result.text).toContain("SAVED NOTES: unavailable");
    expect(result.values?.savedNotesAvailable).toBe(false);
    expect(result.data?.savedNotes).toBeNull();
    expect(reported).toHaveLength(1);
  });

  it("reports an unregistered notes service as unavailable, not as zero notes", async () => {
    const runtime = await bareRuntime();
    const reported: unknown[] = [];
    runtime.reportError = (_scope: string, error: unknown) => {
      reported.push(error);
    };

    const result = await notesProvider.get(
      runtime,
      recallMessage(runtime, "who is alex again"),
      EMPTY_STATE,
    );

    expect(result.text).toContain("SAVED NOTES: unavailable");
    expect(result.values?.savedNotesAvailable).toBe(false);
    expect(reported).toHaveLength(1);
  });

  it("declares the notes it withheld so a truncated list never reads as complete", () => {
    const notes: StickyNote[] = Array.from({ length: 23 }, (_, index) => ({
      id: `note-${index}`,
      title: `note ${index}`,
      body: "",
      color: "yellow",
      createdAt: "2026-08-14T12:00:00.000Z",
      updatedAt: "2026-08-14T12:00:00.000Z",
    }));

    const text = renderSavedNotesText(notes);

    expect(text).toContain("- note 0");
    expect(text).toContain("- note 19");
    expect(text).not.toContain("- note 20");
    expect(text).toContain("3 older note(s) not shown");
  });

  it("truncates an oversized note body without dropping the note", () => {
    const text = renderSavedNotesText([
      {
        id: "note-long",
        title: "launch checklist",
        body: "x".repeat(5_000),
        color: "slate",
        createdAt: "2026-08-14T12:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    ]);

    expect(text).toContain("launch checklist");
    expect(text).toContain("(truncated)");
    expect(text.length).toBeLessThan(1_000);
  });

  it("keeps UTF-16 surrogate pairs intact when truncating a note line to 400", () => {
    const body = `${"a".repeat(382)}🦊${"b".repeat(100)}`;
    const text = renderSavedNotesText([
      {
        id: "note-emoji-boundary",
        title: "x",
        body,
        color: "yellow",
        createdAt: "2026-08-14T12:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    ]);
    const noteLine = text.split("\n").find((line) => line.startsWith("- x"));
    expect(noteLine).toBeDefined();
    if (noteLine) {
      expect(noteLine.isWellFormed()).toBe(true);
      expect(noteLine.length).toBeLessThanOrEqual(402);
    }
    expect(noteLine).not.toContain("🦊");
    expect(noteLine).toContain("(truncated)");
  });

  it("sanitizes lone surrogates in a note before truncation", () => {
    const text = renderSavedNotesText([
      {
        id: "note-lone",
        title: "a\ud800bc",
        body: "",
        color: "yellow",
        createdAt: "2026-08-14T12:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    ]);
    expect(text).toContain("a\ufffdbc");
    expect(text.isWellFormed()).toBe(true);
  });

  it("preserves an emoji that fits entirely under the 400 cap", () => {
    const body = `${"a".repeat(10)}🦊`;
    const text = renderSavedNotesText([
      {
        id: "note-fitting",
        title: "t",
        body,
        color: "yellow",
        createdAt: "2026-08-14T12:00:00.000Z",
        updatedAt: "2026-08-14T12:00:00.000Z",
      },
    ]);
    expect(text).toContain("🦊");
    expect(text.isWellFormed()).toBe(true);
    const noteLine = text.split("\n").find((line) => line.startsWith("- t"));
    expect(noteLine).toBeDefined();
    if (noteLine) {
      expect(noteLine.isWellFormed()).toBe(true);
    }
  });
});
