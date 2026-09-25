/**
 * Exercises Notes dispatch, validation, ownership, and persistence against a
 * real NotesService over a temp-file store. Scripted model outputs drive the
 * real core planner to verify corrected-call recovery and unrelated failures.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ActionResult,
  actionToJsonSchema,
  executePlannedToolCall,
  type IAgentRuntime,
  type Memory,
  satisfiesRoleGate,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type JsonSchema,
  validateSchema,
} from "../../../packages/core/src/actions/validate-tool-args.ts";
import {
  type PlannerToolCall,
  runPlannerLoop,
} from "../../plugin-assistant/src/runtime/planner-loop.ts";
import { collectBudgetedStageOneCandidateActions } from "../../plugin-assistant/src/services/message/planned-tool.ts";
import { __INTERNAL_normalizeNativeToolsForCall } from "../../plugin-openai/models/text.ts";
import { notesAction } from "./action.js";
import { notesPlugin } from "./plugin.js";
import {
  getNotesService,
  NOTES_SERVICE_TYPE,
  NotesService,
} from "./service.js";
import { NotesStore } from "./store.js";
import { parseNoteContent } from "./validation.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function harness(now?: () => Date): Promise<IAgentRuntime> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notes-action-"));
  tmpDirs.push(dir);
  const runtime = {
    agentId: randomUUID() as UUID,
    getService: (type: string) =>
      type === NOTES_SERVICE_TYPE ? service : null,
    // No shell transport is installed in this file-backed domain harness.
    getServiceLoadPromise: async () => null,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  const service = new NotesService(runtime, {
    store: new NotesStore({ filePath: path.join(dir, "notes.json") }),
    ...(now ? { now } : {}),
  });
  await service.initialize();
  return runtime;
}

const message = { content: { text: "" } } as unknown as Memory;

async function run(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
  callback?: Parameters<typeof notesAction.handler>[4],
): Promise<ActionResult> {
  const result = await notesAction.handler(
    runtime,
    message,
    undefined,
    {
      parameters,
    } as never,
    callback,
  );
  if (!result) throw new Error("NOTES action returned no result.");
  return result;
}

async function executorHarness(now?: () => Date): Promise<IAgentRuntime> {
  const runtime = await harness(now);
  Object.assign(runtime, {
    actions: notesPlugin.actions,
    getRoom: vi.fn(async () => ({ worldId: "world-id" })),
    getWorld: vi.fn(async () => ({
      metadata: {
        roles: { "owner-id": "OWNER" },
        roleSources: { "owner-id": "manual" },
      },
    })),
    reportError: vi.fn(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
  return runtime;
}

function execute(
  runtime: IAgentRuntime,
  call: PlannerToolCall,
  userRoles: Parameters<typeof executePlannedToolCall>[1]["userRoles"] = [
    "OWNER",
  ],
  sourceText = "Create the requested note.",
) {
  return executePlannedToolCall(
    runtime,
    {
      message: {
        id: "message-id" as UUID,
        entityId: "owner-id" as UUID,
        roomId: "room-id" as UUID,
        content: { text: sourceText },
      } as Memory,
      activeContexts: ["notes"],
      userRoles,
    },
    call,
  );
}

describe("promoted Notes execution", () => {
  it("requires an update selector on the provider wire and preserves unrelated text through real admission", async () => {
    const runtime = await executorHarness();
    const action = notesPlugin.actions?.find(
      (entry) => entry.name === "NOTES_UPDATE",
    );
    if (!action)
      throw new Error("The promoted Notes update action is unavailable");
    const normalized = __INTERNAL_normalizeNativeToolsForCall(
      [
        {
          name: action.name,
          description: action.description,
          strict: true,
          parameters: actionToJsonSchema(action),
        },
      ],
      { cerebrasMode: true },
    );
    const tools = normalized.tools as Record<
      string,
      { inputSchema: { jsonSchema: JsonSchema } }
    >;
    const schema = tools.NOTES_UPDATE.inputSchema.jsonSchema;
    const missing = { replacementContent: "Packing\nBring spare cable." };
    const errors: string[] = [];
    validateSchema(schema, missing, "", errors);
    expect(errors).toEqual(
      expect.arrayContaining([expect.stringContaining("content")]),
    );
    const service = getNotesService(runtime);
    const original = await service.createNote({
      title: "Packing",
      body: "Bring lens. Bring cable.",
      color: "yellow",
    });
    expect(
      (await execute(runtime, { name: action.name, params: missing })).success,
    ).toBe(false);
    expect(service.getNote(original.id)).toEqual(original);
    const params = {
      content: "Packing",
      textEdit: {
        field: "body",
        oldText: "Bring cable.",
        newText: "Bring spare cable.",
      },
    };
    const validErrors: string[] = [];
    validateSchema(schema, params, "", validErrors);
    expect(validErrors).toEqual([]);
    expect(
      (await execute(runtime, { name: action.name, params })).success,
    ).toBe(true);
    expect(service.getNote(original.id).body).toBe(
      "Bring lens. Bring spare cable.",
    );
  });

  it.each([undefined, "", "  ", 7, ["Existing"], { title: "Existing" }])(
    "rejects invalid legacy update selector %j without writes",
    async (selector) => {
      const runtime = await executorHarness();
      const service = getNotesService(runtime);
      const original = await service.createNote({
        title: "Existing",
        body: "Keep all text.",
        color: "yellow",
      });
      const result = await execute(runtime, {
        name: "NOTES_UPDATE",
        params: { text: selector, replacementContent: "Existing\nChanged" },
      });
      expect(result.success).toBe(false);
      expect(service.getNote(original.id)).toEqual(original);
    },
  );
  it.each(["text", "note", "title", "query"])(
    "persists CRUD through the declared %s content alternative",
    async (name) => {
      const runtime = await executorHarness();
      const content = "Exact label\nComplete body with  two spaces.";
      expect(
        await execute(runtime, {
          name: "NOTES_CREATE",
          params: { [name]: content },
        }),
      ).toMatchObject({ success: true });
      const originalRead = await execute(runtime, {
        name: "NOTES_LIST",
        params: { [name]: "Exact label" },
      });
      expect(originalRead).toMatchObject({ success: true, data: { count: 1 } });
      expect(
        await execute(runtime, {
          name: "NOTES_UPDATE",
          params: {
            expectedRevision: originalRead.data?.notesRevision,
            [name]: "Exact label",
            replacementContent: "Exact label\nChanged body.",
          },
        }),
      ).toMatchObject({ success: true });
      expect(getNotesService(runtime).listNotes()).toMatchObject([
        { title: "Exact label", body: "\nChanged body." },
      ]);
      expect(
        await execute(runtime, {
          name: "NOTES_DELETE",
          params: { [name]: "Exact label" },
        }),
      ).toMatchObject({ success: true });
      expect(getNotesService(runtime).listNotes()).toEqual([]);
    },
  );

  it.each(["body", "newText"])(
    "accepts matching %s replacement and rejects conflicting replacements without writing",
    async (name) => {
      const runtime = await executorHarness();
      await execute(runtime, {
        name: "NOTES_CREATE",
        params: { content: "Record\nOriginal" },
      });
      const originalSnapshot = getNotesService(runtime).snapshot();
      const replacement = "Record\nChanged  exactly";
      expect(
        await execute(runtime, {
          name: "NOTES_UPDATE",
          params: {
            content: "Record",
            expectedRevision: originalSnapshot.revision,
            [name]: replacement,
            replacementContent: replacement,
          },
        }),
      ).toMatchObject({ success: true });
      const before = getNotesService(runtime).listNotes();
      expect(
        await execute(runtime, {
          name: "NOTES_UPDATE",
          params: {
            content: "Record",
            [name]: "Different",
            replacementContent: replacement,
          },
        }),
      ).toMatchObject({ success: false });
      expect(getNotesService(runtime).listNotes()).toEqual(before);
    },
  );

  it("accepts identical content alternatives without losing bytes", async () => {
    const runtime = await executorHarness();
    const content = "Exact label\nComplete  body";
    expect(
      await execute(runtime, {
        name: "NOTES_CREATE",
        params: {
          content,
          text: content,
          note: content,
          title: content,
          query: content,
        },
      }),
    ).toMatchObject({ success: true });
    expect(getNotesService(runtime).listNotes()).toMatchObject([
      { title: "Exact label", body: "\nComplete  body" },
    ]);
  });

  it.each([
    {},
    { text: "" },
    { text: "   " },
    { unexpected: "Content" },
    { content: "Record", query: "Different" },
    { content: "Record", text: "Record " },
  ])(
    "rejects missing, unknown, or conflicting input without writes: %j",
    async (params) => {
      const runtime = await executorHarness();
      expect(
        await execute(runtime, { name: "NOTES_CREATE", params }),
      ).toMatchObject({ success: false });
      expect(getNotesService(runtime).listNotes()).toEqual([]);
    },
  );

  it("accepts the planner alias spellings the handler documents (#31114)", async () => {
    // Before the aliases were declared, every one of these calls was rejected
    // by the core validator with "Unexpected argument" before the handler ran.
    const runtime = await executorHarness();
    const created = await execute(runtime, {
      name: "NOTES_CREATE",
      params: { text: "Alias check\noriginal body" },
    });
    expect(created).toMatchObject({
      success: true,
      data: {
        op: "create",
        note: { title: "Alias check", body: "\noriginal body" },
      },
    });

    const listed = await execute(runtime, {
      name: "NOTES_LIST",
      params: { query: "alias" },
    });
    expect(listed).toMatchObject({
      success: true,
      data: { count: 1, filterApplied: true, topic: "alias" },
    });

    const updated = await execute(runtime, {
      name: "NOTES_UPDATE",
      params: {
        title: "Alias check",
        newText: "Alias check\nupdated body",
        expectedRevision: listed.data?.notesRevision,
      },
    });
    expect(updated).toMatchObject({
      success: true,
      data: {
        op: "update",
        note: { title: "Alias check", body: "\nupdated body" },
      },
    });

    const umbrella = await execute(runtime, {
      name: "NOTES",
      params: { action: "create", note: "Second note" },
    });
    expect(umbrella).toMatchObject({
      success: true,
      data: { op: "create", note: { title: "Second note" } },
    });

    // Notes rejects conflicting alternatives before any store operation.
    const conflict = await execute(runtime, {
      name: "NOTES_LIST",
      params: { content: "second", query: "alias" },
    });
    expect(conflict).toMatchObject({
      success: false,
      data: { invalidParameterNames: ["query"] },
    });
  });

  it("filters creation/update dates at exact boundaries across a DST week without changing notes", async () => {
    let instant = "2026-03-02T07:59:59.999Z";
    const runtime = await executorHarness(() => new Date(instant));
    const service = getNotesService(runtime);
    const beforeWeek = await service.createNote({
      title: "Fern before",
      body: "keep",
      color: "yellow",
    });
    instant = "2026-03-02T08:00:00.000Z";
    const first = await service.createNote({
      title: "Fern first",
      body: "exact  body",
      color: "yellow",
    });
    await service.createNote({
      title: "Other topic",
      body: "untouched",
      color: "yellow",
    });
    instant = "2026-03-09T06:59:59.999Z";
    const last = await service.createNote({
      title: "Fern last",
      body: "last instant",
      color: "yellow",
    });
    const beforeEdit = service.snapshot();
    await service.updateNote(
      beforeWeek.id,
      { body: "edited in the week" },
      beforeEdit.revision,
    );
    instant = "2026-03-09T07:00:00.000Z";
    await service.createNote({
      title: "Fern after",
      body: "excluded end",
      color: "yellow",
    });
    const before = await fs.readFile(service.store.filePath, "utf8");
    const dateRange = {
      field: "createdAt",
      startAt: "2026-03-02T00:00:00-08:00",
      endAt: "2026-03-09T00:00:00-07:00",
    };
    const created = await execute(runtime, {
      name: "NOTES_LIST",
      params: { content: "Fern", dateRange },
    });
    expect(created).toMatchObject({
      success: true,
      data: {
        count: 2,
        total: 5,
        filterApplied: true,
        dateRange,
      },
    });
    expect(
      ((created.data?.notes ?? []) as Array<{ id: string }>)
        .map((note) => note.id)
        .sort(),
    ).toEqual([first.id, last.id].sort());
    expect(created.data?.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining(first),
        expect.objectContaining(last),
      ]),
    );
    const edited = await execute(runtime, {
      name: "NOTES_LIST",
      params: {
        content: "Fern",
        dateRange: { ...dateRange, field: "updatedAt" },
      },
    });
    expect(edited).toMatchObject({ success: true, data: { count: 3 } });
    const absent = await execute(runtime, {
      name: "NOTES_LIST",
      params: {
        dateRange: {
          field: "createdAt",
          startAt: "2026-02-01T00:00:00Z",
          endAt: "2026-03-01T00:00:00Z",
        },
      },
    });
    expect(absent).toMatchObject({
      success: true,
      data: { count: 0, total: 5, filterApplied: true, notes: [] },
    });
    expect(await fs.readFile(service.store.filePath, "utf8")).toBe(before);
  });

  it.each([
    {},
    {
      field: "title",
      startAt: "2026-03-01T00:00:00Z",
      endAt: "2026-04-01T00:00:00Z",
    },
    {
      field: "createdAt",
      startAt: "2026-03-01T00:00:00",
      endAt: "2026-04-01T00:00:00Z",
    },
    {
      field: "createdAt",
      startAt: "2026-02-30T00:00:00Z",
      endAt: "2026-04-01T00:00:00Z",
    },
    {
      field: "createdAt",
      startAt: "2026-04-01T00:00:00Z",
      endAt: "2026-03-01T00:00:00Z",
    },
    {
      field: "createdAt",
      startAt: "2026-03-01T00:00:00Z",
      endAt: "2026-03-01T00:00:00Z",
    },
  ])(
    "rejects an invalid date filter instead of silently listing all notes: %j",
    async (dateRange) => {
      const runtime = await executorHarness();
      const service = getNotesService(runtime);
      await service.createNote({
        title: "Keep me",
        body: "unchanged",
        color: "yellow",
      });
      const before = await fs.readFile(service.store.filePath, "utf8");
      const result = await execute(runtime, {
        name: "NOTES_LIST",
        params: { dateRange },
      });
      expect(result.success).toBe(false);
      expect(result.data).not.toHaveProperty("notes");
      expect(await fs.readFile(service.store.filePath, "utf8")).toBe(before);
    },
  );
  it.each(["literal", "replacement"])(
    "updates an exact ID with %s input despite duplicate titles and ID text decoys",
    async (kind) => {
      const runtime = await executorHarness();
      const service = getNotesService(runtime);
      const original = await service.createNote({
        title: "Same title",
        body: "Keep  both spaces and Mira’s violet backpack.",
      });
      const sibling = await service.createNote({
        title: "Same title",
        body: "Unchanged sibling.",
      });
      const decoy = await service.createNote({
        title: original.id,
        body: "ID text is not identity.",
      });
      const originalSnapshot = service.snapshot();
      const patch =
        kind === "literal"
          ? { textEdit: { field: "body", oldText: "violet", newText: "green" } }
          : {
              expectedRevision: originalSnapshot.revision,
              replacementContent:
                "Same title\nKeep  both spaces and Mira’s green backpack.",
            };
      const result = await execute(runtime, {
        name: "NOTES_UPDATE",
        params: { noteId: original.id, ...patch },
      });
      expect(result.success).toBe(true);
      expect(result.data?.note).toMatchObject({
        id: original.id,
        title: original.title,
        body: `${kind === "replacement" ? "\n" : ""}Keep  both spaces and Mira’s green backpack.`,
      });
      expect(result.effectReceipts?.[0]).toMatchObject({
        outcome: "applied",
        resource: { id: original.id },
      });
      expect(service.getNote(sibling.id)).toEqual(sibling);
      expect(service.getNote(decoy.id)).toEqual(decoy);
      const filePath = service.store.filePath;
      await service.stop();
      const reopened = new NotesService(undefined, {
        store: new NotesStore({ filePath }),
      });
      await reopened.initialize();
      expect(reopened.getNote(original.id).body).toBe(
        `${kind === "replacement" ? "\n" : ""}Keep  both spaces and Mira’s green backpack.`,
      );
      await reopened.stop();
    },
  );

  it("rejects missing, conflicting, case-mismatched and unauthorized ID updates without touching any record", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const original = await service.createNote({
      title: "Exact target",
      body: "Original.",
    });
    await service.createNote({
      title: "note_missing_qa",
      body: "Decoy for an absent ID.",
    });
    const originalSnapshot = service.snapshot();
    const before = originalSnapshot.notes;
    for (const selector of [
      { noteId: "note_missing_qa" },
      { noteId: original.id.toUpperCase() },
      { noteId: original.id, content: original.title },
      { noteId: "" },
      {},
    ]) {
      const result = await execute(runtime, {
        name: "NOTES_UPDATE",
        params: {
          ...selector,
          expectedRevision: originalSnapshot.revision,
          replacementContent: "Exact target\nChanged.",
        },
      });
      expect(result.success).toBe(false);
      expect(result.effectReceipts).toBeUndefined();
      expect(service.listNotes()).toEqual(before);
    }
    const denied = await execute(
      runtime,
      {
        name: "NOTES_UPDATE",
        params: {
          noteId: original.id,
          expectedRevision: originalSnapshot.revision,
          replacementContent: "Exact target\nChanged.",
        },
      },
      ["MEMBER"],
    );
    expect(denied.success).toBe(false);
    expect(service.listNotes()).toEqual(before);
  });
  it("reads exact IDs without substituting matching text or exposing other notes", async () => {
    const runtime = await executorHarness();
    const created = await run(runtime, {
      action: "create",
      content: "Exact read fixture\nComplete original body",
    });
    const id = created.data?.noteId;
    expect(typeof id).toBe("string");
    await run(runtime, {
      action: "create",
      content: `Decoy\n${id}\nnote_missing_qa`,
    });
    const before = getNotesService(runtime).listNotes();
    const selected = collectBudgetedStageOneCandidateActions({
      actions: runtime.actions,
      candidateActions: ["NOTES_GET", "NOTES_GET_NOTE"],
      contexts: ["notes"],
      deferUnselectedContexts: true,
      deferParentHints: true,
    });
    expect(selected.map((action) => action.name)).toEqual(["NOTES_GET"]);
    const found = await execute(runtime, {
      name: selected[0].name,
      params: { noteId: id },
    });
    expect(found).toMatchObject({
      success: true,
      data: {
        lookupMode: "exact_id",
        requestedNoteId: id,
        count: 1,
        notes: [created.data?.note],
      },
    });
    const missingId = await execute(runtime, {
      name: "NOTES_GET",
      params: {},
    });
    expect(missingId.success).toBe(false);
    expect(missingId.data).not.toHaveProperty("notes");
    const absent = await execute(runtime, {
      name: "NOTES_LIST",
      params: { noteId: "note_missing_qa" },
    });
    expect(absent).toMatchObject({
      success: true,
      data: { lookupMode: "exact_id", count: 0, notes: [] },
    });
    const text = await execute(runtime, {
      name: "NOTES_LIST",
      params: { content: "note_missing_qa" },
    });
    expect(text).toMatchObject({
      success: true,
      data: { lookupMode: "text", count: 1 },
    });
    const conflict = await execute(runtime, {
      name: "NOTES_LIST",
      params: { noteId: id, content: "Decoy" },
    });
    expect(conflict).toMatchObject({ success: false });
    const denied = await execute(
      runtime,
      { name: "NOTES_GET", params: { noteId: id } },
      ["NONE"],
    );
    expect(denied.success).toBe(false);
    expect(denied.data).not.toHaveProperty("notes");
    expect(getNotesService(runtime).listNotes()).toEqual(before);
  });

  it("updates the complete note through the declared replacement field", async () => {
    const runtime = await executorHarness();
    await execute(runtime, {
      name: "NOTES_CREATE",
      params: { content: "Packing list\nCharger" },
    });
    const originalRead = await execute(runtime, {
      name: "NOTES_LIST",
      params: { content: "Packing list" },
    });
    expect(originalRead.data?.notes).toMatchObject([{ body: "\nCharger" }]);
    const result = await execute(runtime, {
      name: "NOTES_UPDATE",
      params: {
        content: "Packing list",
        expectedRevision: originalRead.data?.notesRevision,
        replacementContent: "Packing list\nCharger and water",
      },
    });
    expect(result.success).toBe(true);
    expect(result.data?.note).toMatchObject({
      title: "Packing list",
      body: "\nCharger and water",
    });
  });

  it("creates, lists, updates, and deletes through the registered children", async () => {
    const runtime = await executorHarness();
    const created = await execute(runtime, {
      name: "NOTES_CREATE",
      params: {
        content:
          "Conversation context QA\nBring the blue notebook and charger; no water.",
      },
    });
    expect(created.success).toBe(true);
    expect(created.data?.note).toMatchObject({
      title: "Conversation context QA",
      body: "\nBring the blue notebook and charger; no water.",
    });
    const originalSnapshot = getNotesService(runtime).snapshot();
    const updated = await execute(runtime, {
      name: "NOTES_UPDATE",
      params: {
        content: "Conversation context QA",
        expectedRevision: originalSnapshot.revision,
        replacementContent:
          "Conversation context QA\nBring only the blue notebook.",
      },
    });
    expect(updated.success).toBe(true);
    expect(updated.data?.noteId).toBe(created.data?.noteId);
    const listed = await execute(runtime, {
      name: "NOTES_LIST",
      params: { content: "" },
    });
    expect(listed.data?.notes).toMatchObject([
      {
        title: "Conversation context QA",
        body: "\nBring only the blue notebook.",
      },
    ]);
    expect(listed.data?.filterApplied).toBe(false);
    const deleted = await execute(runtime, {
      name: "NOTES_DELETE",
      params: { content: "Conversation context QA" },
    });
    expect(deleted.success).toBe(true);
    expect(deleted.data?.note).toEqual(updated.data?.note);
    expect((await run(runtime, { action: "list" })).data?.notes).toEqual([]);

    for (const result of [created, listed, updated, deleted]) {
      expect(result).toMatchObject({
        success: true,
        transcriptVisibility: "internal",
        modelReplyRequired: true,
      });
      expect(result).not.toHaveProperty("userFacingText");
      expect(result).not.toHaveProperty("text");
      expect(result).not.toHaveProperty("verifiedUserFacing");
      expect(result).not.toHaveProperty("turnComplete");
    }
    expect(listed.effectReceipts).toBeUndefined();
    for (const result of [created, updated, deleted]) {
      expect(result.effectReceipts).toEqual([
        expect.objectContaining({
          outcome: "applied",
          resource: { kind: "notes.note", id: created.data?.noteId },
          commit: expect.objectContaining({ kind: "durable" }),
        }),
      ]);
    }
  });

  it("advances a committed Notes step to queued navigation but still evaluates the final reply", async () => {
    const runtime = await executorHarness();
    const useModel = vi.fn().mockResolvedValue({
      toolCalls: [
        {
          id: "create-note",
          name: "NOTES_CREATE",
          arguments: {
            content: "Queue contract QA\nBring the notebook.",
            eliza_turn_scope: "final",
          },
        },
        {
          id: "open-notes",
          name: "VIEWS",
          arguments: {
            action: "show",
            view: "notes",
            eliza_turn_scope: "final",
          },
        },
      ],
    });
    const executeToolCall = vi.fn(async (call: PlannerToolCall) =>
      call.name === "VIEWS"
        ? {
            success: true,
            text: "Navigation accepted: notes.",
            transcriptVisibility: "internal" as const,
            modelReplyRequired: true,
            turnComplete: false,
          }
        : execute(runtime, call),
    );
    const evaluate = vi.fn<
      NonNullable<Parameters<typeof runPlannerLoop>[0]["evaluate"]>
    >(async ({ trajectory }) =>
      trajectory.steps.at(-1)?.toolCall?.name === "VIEWS"
        ? {
            success: true,
            decision: "FINISH",
            thought: "The note is saved and navigation completed.",
            messageToUser: "Your notebook note is saved, and Notes is open.",
            effectReceiptIds: trajectory.steps.flatMap((step) =>
              (step.result?.effectReceipts ?? []).map(
                (receipt) => receipt.receiptId,
              ),
            ),
          }
        : {
            success: false,
            decision: "NEXT_RECOMMENDED",
            thought: "Opening Notes remains queued.",
            recommendedToolCallId: "open-notes",
          },
    );

    const result = await runPlannerLoop({
      runtime: { useModel },
      context: { id: "notes-navigation", events: [] },
      executeToolCall,
      evaluate,
    });

    expect(useModel).toHaveBeenCalledTimes(1);
    expect(executeToolCall.mock.calls.map(([call]) => call.name)).toEqual([
      "NOTES_CREATE",
      "VIEWS",
    ]);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.finalMessage).toBe(
      "Your notebook note is saved, and Notes is open.",
    );
    expect((await run(runtime, { action: "list" })).data?.notes).toMatchObject([
      { title: "Queue contract QA", body: "\nBring the notebook." },
    ]);
  });

  it.each([
    ["NOTES_CREATE", { body: "Bring the notebook." }, "content"],
    ["NOTES_CREATE", { content: "" }, "content"],
    ["NOTES_UPDATE", { body: "Replacement" }, "content"],
    ["NOTES_UPDATE", { content: "" }, "content"],
    ["NOTES_UPDATE", { content: "Existing note" }, "replacementContent"],
    [
      "NOTES_UPDATE",
      { content: "Existing note", body: "" },
      "replacementContent",
    ],
    ["NOTES_DELETE", {}, "content"],
    ["NOTES_DELETE", { content: "" }, "content"],
  ])(
    "rejects incomplete %s arguments before writing: %j",
    async (name, params, missing) => {
      const runtime = await executorHarness();
      await run(runtime, {
        action: "create",
        content: "Existing note\nKeep this body.",
      });
      const before = (await run(runtime, { action: "list" })).data?.notes;
      const rejected = await execute(runtime, { name, params });
      expect(rejected.success).toBe(false);
      expect(rejected.effectReceipts).toBeUndefined();
      expect(rejected.verifiedUserFacing).not.toBe(true);
      expect(rejected.turnComplete).not.toBe(true);
      expect(rejected.data?.parameterErrors).toEqual(
        expect.arrayContaining([expect.stringContaining(missing)]),
      );
      expect((await run(runtime, { action: "list" })).data?.notes).toEqual(
        before,
      );
    },
  );

  it("denies a non-owner promoted write without changing the store", async () => {
    const runtime = await executorHarness();
    const rejected = await execute(
      runtime,
      {
        name: "NOTES_CREATE",
        params: { content: "Unauthorized note" },
      },
      ["USER"],
    );
    expect(rejected.success).toBe(false);
    expect(rejected.effectReceipts).toBeUndefined();
    expect((await run(runtime, { action: "list" })).data?.notes).toEqual([]);
  });

  it.each([
    { name: "NOTES", related: true },
    { name: "NOTES", related: false },
    { name: "NOTES_CREATE", related: true },
    { name: "NOTES_CREATE", related: false },
  ])(
    "retains only unresolved $name failure authority after a related retry: $related",
    async ({ name, related }) => {
      const runtime = await executorHarness();
      const body = "Bring the blue notebook and charger; no water.";
      const content = related
        ? `Conversation context QA\n${body}`
        : "Dentist appointment\nTuesday afternoon.";
      const useModel = vi
        .fn()
        .mockResolvedValue(
          "The first note could not be saved; the second note was saved.",
        )
        .mockResolvedValueOnce({
          toolCalls: [
            {
              id: "missing-content",
              name,
              arguments: { action: "create", body },
            },
          ],
        })
        .mockResolvedValueOnce({
          toolCalls: [
            { id: "retry", name, arguments: { action: "create", content } },
          ],
        });
      const completion = "Hecho. La nota solicitada está guardada.";
      const result = await runPlannerLoop({
        runtime: { useModel },
        context: { id: "notes-recovery", events: [] },
        executeToolCall: (call) => execute(runtime, call),
        evaluate: ({ trajectory }) => {
          const lastResult = trajectory.steps.at(-1)?.result;
          return lastResult?.success
            ? {
                success: true,
                decision: "FINISH",
                thought: "The requested note was saved.",
                messageToUser: completion,
                effectReceiptIds: lastResult.effectReceipts?.map(
                  (receipt) => receipt.receiptId,
                ),
              }
            : {
                success: false,
                decision: "CONTINUE",
                thought: "Correct the missing content.",
              };
        },
      });
      expect((await run(runtime, { action: "list" })).data?.count).toBe(1);
      expect(
        result.trajectory.steps.filter(
          (step) => step.result?.success === false,
        ),
      ).toHaveLength(1);
      if (related) {
        expect(result.finalMessage).toBe(completion);
        expect(useModel).toHaveBeenCalledTimes(2);
      } else {
        expect(result.finalMessage).not.toBe(completion);
        expect(useModel.mock.calls.length).toBeGreaterThan(2);
      }
    },
  );
});

describe("NOTES operation parsing", () => {
  it.each(["text", "note", "title"])(
    "preserves the direct handler's legacy %s content alias",
    async (alias) => {
      const runtime = await harness();
      const created = await run(runtime, {
        action: "create",
        [alias]: "Legacy title",
        body: "Legacy body",
      });
      expect(created.success).toBe(true);
      expect(
        (await run(runtime, { action: "list" })).data?.notes,
      ).toMatchObject([{ title: "Legacy title", body: "\nLegacy body" }]);
    },
  );

  it("keeps canonical Notes aliases distinct from generic view navigation", () => {
    expect(notesAction.similes).toEqual(
      expect.arrayContaining(["NOTES_LIST", "NOTES_READ", "SEARCH_NOTES"]),
    );
    expect(notesAction.similes).not.toContain("LIST_NOTES");
    expect(notesAction.similes).not.toContain("SHOW_NOTES");
  });

  it("denies every non-owner role before the handler can access the store", () => {
    expect(notesAction.roleGate).toEqual({ minRole: "OWNER" });
    expect(satisfiesRoleGate(["GUEST"], notesAction.roleGate)).toBe(false);
    expect(satisfiesRoleGate(["USER"], notesAction.roleGate)).toBe(false);
    expect(satisfiesRoleGate(["ADMIN"], notesAction.roleGate)).toBe(false);
    expect(satisfiesRoleGate(["OWNER"], notesAction.roleGate)).toBe(true);
  });

  it("refuses an operation it does not implement instead of listing", async () => {
    const runtime = await harness();
    await run(runtime, {
      action: "create",
      content: "spare key under the mat",
    });

    // "remove" is plausible planner output: DELETE_NOTE is an advertised simile.
    const result = await run(runtime, {
      action: "remove",
      content: "spare key",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("NOTES_UNKNOWN_OP");
    // The failure names what it CAN do, and never renders the note list.
    expect(result.text).toContain("delete");
    expect(result.text).not.toContain("spare key under the mat");
  });

  it("still reads when no operation was named at all", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "wifi is on the fridge" });

    const result = await run(runtime, {});

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ count: 1, total: 1 });
    expect(result.data?.notes).toMatchObject([
      { title: "wifi is on the fridge", body: "", color: "yellow" },
    ]);
  });

  it("returns structured note facts for one natural model-authored reply", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "wifi is on the fridge" });
    const callback = vi.fn();

    const result = await run(runtime, { action: "list" }, callback);

    expect(callback).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      transcriptVisibility: "internal",
      modelReplyRequired: true,
      data: {
        count: 1,
        total: 1,
        notes: [{ title: "wifi is on the fridge", body: "" }],
      },
    });
    expect(result).not.toHaveProperty("userFacingText");
    expect(result).not.toHaveProperty("text");
    expect(result).not.toHaveProperty("modelReplyFallback");
    expect(result).not.toHaveProperty("verifiedUserFacing");
    expect(result).not.toHaveProperty("turnComplete");
  });

  it("treats a strict-provider empty content field as omission for an unfiltered count", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "first note" });
    await run(runtime, { action: "create", content: "second note" });
    Object.assign(runtime, {
      actions: [notesAction],
      getRoom: vi.fn(async () => ({ worldId: "world-id" })),
      getWorld: vi.fn(async () => ({
        metadata: {
          roles: { "owner-id": "OWNER" },
          roleSources: { "owner-id": "manual" },
        },
      })),
      reportError: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    const result = await executePlannedToolCall(
      runtime,
      {
        message: {
          id: "message-id" as UUID,
          entityId: "owner-id" as UUID,
          roomId: "room-id" as UUID,
          content: { text: "How many notes do I have?" },
        } as Memory,
        activeContexts: ["notes"],
        userRoles: ["OWNER"],
      },
      {
        name: "NOTES",
        params: { action: "list", content: "", body: "" },
      },
    );

    expect(result).toMatchObject({
      success: true,
      data: {
        count: 2,
        total: 2,
        filterApplied: false,
      },
    });
  });

  it("preserves stored identity and timestamps so the model can compare recency", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "Recency check\noriginal body",
    });
    const originalRead = await run(runtime, { action: "list" });
    const updated = await run(runtime, {
      action: "update",
      expectedRevision: originalRead.data?.notesRevision,
      content: "Recency check",
      body: "Recency check\nupdated body",
    });
    const result = await run(runtime, { action: "list" });

    expect(result.data?.notes).toMatchObject([updated.data?.note]);
    expect(result.data?.notes).toMatchObject([
      {
        id: created.data?.noteId,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        title: "Recency check",
        body: "\nupdated body",
      },
    ]);
    const filtered = await run(runtime, {
      action: "list",
      content: "Recency check",
    });
    expect(filtered.data?.notes).toEqual(result.data?.notes);
  });

  it("keeps a topic-scoped read from exposing unrelated notes", async () => {
    const runtime = await harness();
    await run(runtime, {
      action: "create",
      content: "the plumber comes thursday morning",
    });
    await run(runtime, {
      action: "create",
      content: "spare key under the mat",
    });

    const match = await run(runtime, { action: "list", content: "PLUMBER" });
    expect(match.data?.notes).toMatchObject([
      {
        title: "the plumber comes thursday morning",
        body: "",
        color: "yellow",
      },
    ]);
    expect(match.data).toMatchObject({
      count: 1,
      total: 2,
      filterApplied: true,
    });

    const absent = await run(runtime, { action: "list", query: "dentist" });
    expect(absent.data?.notes).toEqual([]);
    expect(absent.data).toMatchObject({
      count: 0,
      total: 2,
      filterApplied: true,
    });
  });

  it("preserves literal colon content through create and full replacement", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "Demo check 917: bring the green notebook.",
    });
    expect(created.success).toBe(true);
    expect(created.data?.note).toMatchObject({
      title: "Demo check 917: bring the green notebook.",
      body: "",
    });
    const originalRead = await run(runtime, { action: "list" });
    const updated = await run(runtime, {
      action: "update",
      expectedRevision: originalRead.data?.notesRevision,
      content: "Demo check 917",
      replacementContent: "Demo check 917: bring the blue notebook.",
    });
    expect(updated.success).toBe(true);
    const listed = await run(runtime, { action: "list" });
    expect(listed.data?.notes).toMatchObject([
      { title: "Demo check 917: bring the blue notebook.", body: "" },
    ]);
  });

  it.each(["Stable Local Notes QA", "QA: afternoon"])(
    "preserves a separate create body with title %s",
    async (title) => {
      const runtime = await harness();
      const created = await run(runtime, {
        action: "create",
        content: title,
        body: "Cerebras local note persistence",
      });

      expect(created.success).toBe(true);
      expect(created.data?.note).toMatchObject({
        title,
        body: "\nCerebras local note persistence",
      });
      const listed = await run(runtime, { action: "list" });
      expect(listed.data?.notes).toMatchObject([
        {
          title,
          body: "\nCerebras local note persistence",
          color: "yellow",
        },
      ]);
    },
  );

  it("stores a redundant create body once without removing intentional repeated lines", async () => {
    const runtime = await harness();
    const body = "Bring a charger and water.\nBring a charger and water.";
    const created = await run(runtime, {
      action: "create",
      content: `Checklist\n${body}`,
      body,
    });
    expect(created.success).toBe(true);
    const listed = await run(runtime, { action: "list", content: "Checklist" });
    expect(listed.data?.notes).toMatchObject([
      { title: "Checklist", body: `\n${body}` },
    ]);
    expect(listed.data?.count).toBe(1);
  });

  it("rejects conflicting create bodies without persisting either version", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "Checklist\nBring water.",
      body: "Bring a charger.",
    });
    expect(created).toMatchObject({
      success: false,
      error: "NOTES_CONFLICTING_BODY",
    });
    const listed = await run(runtime, { action: "list" });
    expect(listed.data?.notes).toEqual([]);
  });

  it("returns the persisted label and body as evidence after a content update", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "Demo checklist",
      body: "charger",
    });
    const originalRead = await run(runtime, { action: "list" });
    const updated = await run(runtime, {
      action: "update",
      expectedRevision: originalRead.data?.notesRevision,
      content: "Demo checklist",
      body: "Demo checklist\ncharger and water",
    });
    expect(updated.success).toBe(true);
    expect(updated.modelReplyRequired).toBe(true);
    expect(updated.data?.note).toMatchObject({
      id: created.data?.noteId,
      title: "Demo checklist",
      body: "\ncharger and water",
    });
    const listed = await run(runtime, {
      action: "list",
      content: "Demo checklist",
    });
    expect(listed.data?.notes).toMatchObject([
      { title: "Demo checklist", body: "\ncharger and water", color: "yellow" },
    ]);
  });

  it("lets the owner create, search/list, update, and delete in one store", async () => {
    const runtime = await harness();
    const created = await run(runtime, {
      action: "create",
      content: "bins go out tuesday",
    });
    expect(created.success).toBe(true);
    expect(created.data?.note).toMatchObject({ title: "bins go out tuesday" });

    const listed = await run(runtime, { action: "list" });
    expect(listed.success).toBe(true);
    expect(listed.data?.notes).toMatchObject([
      { title: "bins go out tuesday", body: "", color: "yellow" },
    ]);

    const updated = await run(runtime, {
      action: "update",
      expectedRevision: listed.data?.notesRevision,
      content: "bins",
      body: "bins go out wednesday",
    });
    expect(updated.success).toBe(true);
    expect(updated.data?.note).toMatchObject({
      title: "bins go out wednesday",
    });

    const deleted = await run(runtime, {
      action: "delete",
      content: "wednesday",
    });
    expect(deleted.success).toBe(true);
    expect(deleted.data?.note).toEqual(updated.data?.note);

    const after = await run(runtime, { action: "list" });
    expect(after.data).toMatchObject({ count: 0, total: 0, notes: [] });
  });
});

describe("identical-duplicate notes", () => {
  async function seedLegacyCopies(
    runtime: IAgentRuntime,
    content: string,
    copies: number,
  ): Promise<NotesService> {
    const service = runtime.getService<NotesService>(NOTES_SERVICE_TYPE);
    if (!service) throw new Error("NotesService missing from harness");
    const original = await service.createNote(parseNoteContent(content));
    await service.store.transact((draft) => {
      for (let index = 1; index < copies; index += 1) {
        draft.notes.push({ ...original, id: `legacy-copy-${index}` });
      }
    });
    return service;
  }

  it("makes concurrent identical creates one replayable logical note", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const before = service.snapshot();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        execute(runtime, {
          name: "NOTES_CREATE",
          params: { content: "i need to buy milk" },
        }),
      ),
    );

    expect(
      results.filter((result) => result.data?.replayed === false),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.data?.replayed === true),
    ).toHaveLength(3);
    for (const result of results) {
      expect(result.success).toBe(true);
      expect(result.effectReceipts).toHaveLength(1);
      const receipt = result.effectReceipts?.[0];
      expect(receipt?.resource.id).toBe(result.data?.noteId);
      if (result.data?.replayed) {
        expect(receipt).toMatchObject({
          outcome: "noop",
          idempotency: { key: result.data.noteId, replayed: true },
        });
        expect(receipt).not.toHaveProperty("commit");
      } else {
        expect(receipt).toMatchObject({
          outcome: "applied",
          idempotency: { key: null, replayed: false },
          commit: { kind: "durable", id: result.data?.noteId },
        });
      }
    }
    expect(service.snapshot().revision).toBe(before.revision + 1);
    const saved = await fs.readFile(service.store.filePath, "utf8");
    const snapshot = service.snapshot();
    await run(runtime, { action: "create", content: "i need to buy milk" });
    expect(service.snapshot()).toEqual(snapshot);
    expect(await fs.readFile(service.store.filePath, "utf8")).toBe(saved);
    const listed = await run(runtime, { action: "list" });
    expect(listed.data).toMatchObject({ count: 1, total: 1 });
  });

  it("deletes every byte-identical copy as one logical note", async () => {
    const runtime = await harness();
    await seedLegacyCopies(runtime, "i need to buy milk", 4);
    await run(runtime, {
      action: "create",
      content: "spare key under the mat",
    });

    const result = await run(runtime, { action: "delete", content: "milk" });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      removedCount: 4,
      note: { title: "i need to buy milk", body: "" },
    });

    const after = await run(runtime, { action: "list" });
    expect(after.data?.notes).toMatchObject([
      { title: "spare key under the mat", body: "", color: "yellow" },
    ]);
  });

  it("still refuses genuinely differing matches as ambiguous", async () => {
    const runtime = await harness();
    await run(runtime, { action: "create", content: "buy milk at aldi" });
    await run(runtime, { action: "create", content: "buy milk for the cat" });

    await expect(
      run(runtime, { action: "delete", content: "milk" }),
    ).rejects.toMatchObject({ code: "NOTES_AMBIGUOUS_NOTE" });
  });

  it("updates one logical note and consolidates its identical stored copies", async () => {
    const runtime = await harness();
    await seedLegacyCopies(runtime, "i need to buy milk", 4);

    const originalRead = await run(runtime, { action: "list" });
    const result = await run(runtime, {
      action: "update",
      expectedRevision: originalRead.data?.notesRevision,
      content: "milk",
      body: "i already bought milk",
    });

    expect(result.data).toMatchObject({ consolidatedCount: 3 });
    const after = await run(runtime, { action: "list" });
    expect(after.data).toMatchObject({ count: 1, total: 1 });
    expect(after.data?.notes).toMatchObject([
      { title: "i already bought milk", body: "", color: "yellow" },
    ]);
  });

  it("keeps same-text notes with different visible colors distinct", async () => {
    const runtime = await harness();
    const service = runtime.getService<NotesService>(NOTES_SERVICE_TYPE);
    if (!service) throw new Error("NotesService missing from harness");
    await service.createNote({ title: "buy milk", body: "", color: "yellow" });
    await service.createNote({ title: "buy milk", body: "", color: "green" });

    await expect(
      run(runtime, { action: "delete", content: "buy milk" }),
    ).rejects.toMatchObject({ code: "NOTES_AMBIGUOUS_NOTE" });

    const deleted = await run(runtime, {
      action: "delete",
      content: "buy milk green",
    });
    expect(deleted.success).toBe(true);
    expect(service.listNotes().map((note) => note.color)).toEqual(["yellow"]);
  });
});

describe("literal Notes edits", () => {
  it("updates through the promoted tool without a read and persists only the requested substring", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const original = await service.createNote({
      title: "Literal edit",
      body: "Bring a green folder and a charger.",
      color: "rose",
    });
    const other = await service.createNote({
      title: "Other note",
      body: "green",
      color: "slate",
    });
    const result = await execute(runtime, {
      name: "NOTES_UPDATE",
      params: {
        content: "Literal edit",
        textEdit: { field: "body", oldText: "green", newText: "orange" },
      },
    });
    expect(result.success).toBe(true);
    expect(result.effectReceipts).toEqual([
      expect.objectContaining({ outcome: "applied" }),
    ]);
    const updated = service.getNote(original.id);
    expect(updated).toEqual({
      ...original,
      body: "Bring a orange folder and a charger.",
      updatedAt: updated.updatedAt,
    });
    expect(service.getNote(other.id)).toEqual(other);
    const filePath = service.store.filePath;
    await service.stop();
    const reopened = new NotesService(undefined, {
      store: new NotesStore({ filePath }),
    });
    await reopened.initialize();
    expect(reopened.getNote(original.id)).toEqual(updated);
    await reopened.stop();
  });

  it.each([
    ["body", "green", "$& \n$1 🟠", "Use $& \n$1 🟠 here.", "Exact title"],
    ["body", "green ", "", "Use here.", "Exact title"],
    ["title", "Exact", "Precise", "Use green here.", "Precise title"],
  ] as const)(
    "preserves literal strings when editing %s",
    async (field, oldText, newText, body, title) => {
      const runtime = await executorHarness();
      await execute(runtime, {
        name: "NOTES_CREATE",
        params: { content: "Exact title\nUse green here." },
      });
      const result = await execute(runtime, {
        name: "NOTES_UPDATE",
        params: {
          content: "Exact title",
          textEdit: { field, oldText, newText },
        },
      });
      expect(result.success).toBe(true);
      expect(result.data?.note).toMatchObject({ title, body: `\n${body}` });
    },
  );

  it("preserves boundary whitespace in atomic literal edits", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const note = await service.createNote({
      title: "Exact title",
      body: "green",
    });
    const result = await execute(runtime, {
      name: "NOTES_UPDATE",
      params: {
        noteId: note.id,
        textEdit: { field: "body", oldText: "green", newText: " orange " },
      },
    });
    expect(result.success).toBe(true);
    expect(service.getNote(note.id).body).toBe(" orange ");
  });

  it("preserves all authored whitespace through action create and replacement", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const content = "  Title  \n\n  Body  \n";
    const created = await execute(runtime, {
      name: "NOTES_CREATE",
      params: { content },
    });
    expect(created.success).toBe(true);
    const note = service.listNotes()[0];
    expect(note.title + note.body).toBe(content);
    const replacementContent = "  Title  \n\n  Updated  \n";
    const updated = await execute(runtime, {
      name: "NOTES_UPDATE",
      params: {
        noteId: note.id,
        expectedRevision: service.snapshot().revision,
        replacementContent,
      },
    });
    expect(updated.success).toBe(true);
    const after = service.getNote(note.id);
    expect(after.title + after.body).toBe(replacementContent);
  });

  it.each([
    ["missing", "orange", "green", "NOTES_EDIT_TEXT_NOT_FOUND"],
    ["green", "orange", "green green", "NOTES_EDIT_TEXT_AMBIGUOUS"],
    ["aa", "b", "aaa", "NOTES_EDIT_TEXT_AMBIGUOUS"],
  ])(
    "rejects %s -> %s without any revision or record change",
    async (oldText, newText, body, code) => {
      const runtime = await executorHarness();
      const service = getNotesService(runtime);
      await service.createNote({ title: "Exact title", body });
      const before = service.snapshot();
      const result = await execute(runtime, {
        name: "NOTES_UPDATE",
        params: {
          content: "Exact title",
          textEdit: { field: "body", oldText, newText },
        },
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain(code);
      expect(result.data?.coachingFailure).toBe(true);
      expect(result.effectReceipts).toBeUndefined();
      expect(service.snapshot()).toEqual(before);
    },
  );

  it("finishes a corrected literal edit without reopening reply planning", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const note = await service.createNote({
      title: "Retry QA",
      body: '"Keep this."',
    });
    const originalSnapshot = service.snapshot();
    const useModel = vi
      .fn()
      .mockResolvedValueOnce({
        toolCalls: [
          {
            id: "notes-edit-first",
            name: "NOTES_PATCH",
            arguments: {
              target: { kind: "id", value: note.id },
              expectedRevision: originalSnapshot.revision,
              changes: [],
              textEdit: { field: "body", oldText: "absent", newText: "" },
              eliza_turn_scope: "final",
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        toolCalls: [
          {
            id: "notes-edit-corrected",
            name: "NOTES_PATCH",
            arguments: {
              target: { kind: "id", value: note.id },
              expectedRevision: originalSnapshot.revision,
              changes: [{ field: "body", value: "Keep this." }],
              eliza_turn_scope: "final",
            },
          },
        ],
      });
    const result = await runPlannerLoop({
      runtime: { useModel },
      context: { id: "literal-edit-retry", events: [] },
      executeToolCall: (call) => execute(runtime, call),
      evaluate: ({ trajectory }) => {
        const last = trajectory.steps.at(-1)?.result;
        return last?.success
          ? {
              success: true,
              decision: "FINISH",
              thought: "Verified corrected edit.",
              messageToUser: "The quotation marks are removed.",
              effectReceiptIds: last.effectReceipts?.map(
                (receipt) => receipt.receiptId,
              ),
            }
          : {
              success: false,
              decision: "CONTINUE",
              thought: "Correct the rejected edit.",
            };
      },
    });
    expect(useModel).toHaveBeenCalledTimes(2);
    expect(result.finalMessage).toBe("The quotation marks are removed.");
    expect(service.getNote(note.id).body).toBe("Keep this.");
  });

  it("does not label an unexpected update failure as prewrite coaching", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const note = await service.createNote({
      title: "Failure QA",
      body: "Keep this.",
    });
    const originalSnapshot = service.snapshot();
    vi.spyOn(service, "updateNoteWithCommit").mockRejectedValueOnce(
      new Error("Store unavailable"),
    );
    const result = await execute(runtime, {
      name: "NOTES_PATCH",
      params: {
        target: { kind: "id", value: note.id },
        expectedRevision: originalSnapshot.revision,
        changes: [{ field: "body", value: "Changed" }],
      },
    });
    expect(result.success).toBe(false);
    expect(result.data?.coachingFailure).not.toBe(true);
    expect(result.effectReceipts).toBeUndefined();
    expect(service.getNote(note.id).body).toBe("Keep this.");
  });

  it("checks the old text inside the write barrier when two edits race", async () => {
    const runtime = await harness();
    const service = getNotesService(runtime);
    const note = await service.createNote({
      title: "Exact title",
      body: "green",
    });
    const before = service.snapshot();
    const results = await Promise.allSettled(
      ["orange", "violet"].map((newText) =>
        service.updateNoteByLookupWithCommit("title", note.title, {
          textEdit: { field: "body", oldText: "green", newText },
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(service.getNote(note.id).body).toBe("orange");
    expect(service.snapshot().revision).toBe(before.revision + 1);
  });

  it("keeps owner admission and conflicting update forms from mutating records", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    await service.createNote({ title: "Exact title", body: "green" });
    const before = service.snapshot();
    const params = {
      content: "Exact title",
      textEdit: { field: "body", oldText: "green", newText: "orange" },
    };
    expect(
      (await execute(runtime, { name: "NOTES_UPDATE", params }, ["MEMBER"]))
        .success,
    ).toBe(false);
    expect(
      (
        await execute(runtime, {
          name: "NOTES_UPDATE",
          params: { ...params, replacementContent: "Wrong title\nred" },
        })
      ).success,
    ).toBe(false);
    expect(service.snapshot()).toEqual(before);
  });
});

describe("structured Notes field patches", () => {
  it.each([
    ["NOTES_GET", "NOTES_UPDATE"],
    ["NOTES_LIST", "NOTES_PATCH"],
  ])(
    "rejects a stale %s revision through %s without a receipt or durable write",
    async (readName, writeName) => {
      const runtime = await executorHarness();
      const service = getNotesService(runtime);
      const note = await service.createNote({
        title: "Shared draft",
        body: "Original body",
      });
      const read = await execute(runtime, {
        name: readName,
        params:
          readName === "NOTES_GET"
            ? { noteId: note.id }
            : { content: note.title },
      });
      expect(read.success).toBe(true);
      expect(read.data?.notes).toMatchObject([note]);
      expect(read.data?.notesRevision).toBe(service.snapshot().revision);
      await service.updateNote(
        note.id,
        { body: "Another writer's complete body" },
        read.data?.notesRevision,
      );
      const committed = service.snapshot();
      const bytes = await fs.readFile(service.store.filePath, "utf8");
      const replacement =
        writeName === "NOTES_UPDATE"
          ? {
              noteId: note.id,
              replacementContent: "Shared draft\nStale replacement",
            }
          : {
              target: { kind: "id", value: note.id },
              changes: [{ field: "body", value: "Stale replacement" }],
            };
      const result = await execute(runtime, {
        name: writeName,
        params: { ...replacement, expectedRevision: read.data?.notesRevision },
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain("NOTES_EDIT_CONFLICT");
      expect(result.effectReceipts).toBeUndefined();
      expect(service.snapshot()).toEqual(committed);
      expect(await fs.readFile(service.store.filePath, "utf8")).toBe(bytes);
    },
  );

  it("replaces fields without rewriting omitted content", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const original = await service.createNote({
      title: "Keep  My Title",
      body: "Old body",
      color: "rose",
    });
    const originalRead = await execute(runtime, {
      name: "NOTES_GET",
      params: { noteId: original.id },
    });
    expect(originalRead.data?.notes).toMatchObject([original]);
    const result = await execute(runtime, {
      name: "NOTES_PATCH",
      params: {
        target: { kind: "id", value: original.id },
        expectedRevision: originalRead.data?.notesRevision,
        changes: [
          { field: "body", value: "Mira’s notebook is violet.\nSecond line." },
        ],
      },
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(service.getNote(original.id)).toMatchObject({
      title: original.title,
      color: original.color,
      body: "Mira’s notebook is violet.\nSecond line.",
    });
    expect(result.effectReceipts).toEqual([
      expect.objectContaining({ outcome: "applied" }),
    ]);
  });
  it("supports text lookup and combined title/body replacement", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const note = await service.createNote({
      title: "Field patch target",
      body: "Old",
      color: "yellow",
    });
    const originalSnapshot = service.snapshot();
    const result = await execute(runtime, {
      name: "NOTES_PATCH",
      params: {
        target: { kind: "text", value: note.title },
        expectedRevision: originalSnapshot.revision,
        changes: [
          { field: "title", value: "New title" },
          { field: "body", value: "Exact’s body" },
        ],
      },
    });
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(service.getNote(note.id)).toMatchObject({
      title: "New title",
      body: "Exact’s body",
      color: "yellow",
    });
  });
  it.each(
    [
      [],
      [{ field: "body", value: " altered " }],
      [
        { field: "body", value: "x" },
        { field: "body", value: "y" },
      ],
      [{ field: "color", value: "rose" }],
      [{ field: "body" }],
    ].map((changes) => [changes]),
  )("rejects invalid patches without writing: %j", async (changes) => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const note = await service.createNote({
      title: "Guard",
      body: "Old",
      color: "yellow",
    });
    const result = await execute(runtime, {
      name: "NOTES_PATCH",
      params: { target: { kind: "id", value: note.id }, changes },
    });
    expect(result.success).toBe(false);
    expect(service.getNote(note.id)).toEqual(note);
  });
  it("rejects ambiguous targets and unauthorized callers", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    await service.createNote({
      title: "Duplicate",
      body: "One",
      color: "yellow",
    });
    await service.createNote({
      title: "Duplicate",
      body: "Two",
      color: "rose",
    });
    const originalSnapshot = service.snapshot();
    const before = originalSnapshot.notes;
    expect(
      (
        await execute(runtime, {
          name: "NOTES_PATCH",
          params: {
            expectedRevision: originalSnapshot.revision,
            target: { kind: "text", value: "Duplicate" },
            changes: [{ field: "body", value: "New" }],
          },
        })
      ).success,
    ).toBe(false);
    expect(
      (
        await execute(
          runtime,
          {
            name: "NOTES_PATCH",
            params: {
              expectedRevision: originalSnapshot.revision,
              target: { kind: "id", value: before[0].id },
              changes: [{ field: "body", value: "New" }],
            },
          },
          ["MEMBER"],
        )
      ).success,
    ).toBe(false);
    expect(service.listNotes()).toEqual(before);
  });

  it("returns an unanswered selection with both candidates and no edit receipt", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    await service.createNote({ title: "Same title", body: "Silver folder" });
    await service.createNote({
      title: "Same title",
      body: "Bring it tomorrow",
    });
    const before = service.snapshot();
    const result = await execute(runtime, {
      name: "NOTES_PATCH",
      params: {
        expectedRevision: before.revision,
        target: { kind: "text", value: "Same title" },
        changes: [{ field: "body", value: "Amber folder" }],
      },
    });
    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      awaitingUserInput: true,
      requiresInput: true,
      candidates: expect.arrayContaining([
        expect.objectContaining({ body: "Silver folder" }),
        expect.objectContaining({ body: "Bring it tomorrow" }),
      ]),
    });
    expect(result.effectReceipts).toBeUndefined();
    expect(service.snapshot()).toEqual(before);
  });

  it.each(["NOTES_PATCH", "NOTES_UPDATE"])(
    "%s cannot bypass a named duplicate title with a planner-selected ID",
    async (name) => {
      const runtime = await executorHarness();
      const service = getNotesService(runtime);
      const first = await service.createNote({
        title: "QA duplicate",
        body: "Silver",
      });
      await service.createNote({ title: "QA duplicate", body: "Tomorrow" });
      const before = service.snapshot();
      const params =
        name === "NOTES_PATCH"
          ? {
              target: { kind: "id", value: first.id },
              changes: [{ field: "body", value: "Amber" }],
            }
          : { noteId: first.id, replacementContent: "QA duplicate\nAmber" };
      const result = await execute(
        runtime,
        { name, params: { ...params, expectedRevision: before.revision } },
        ["OWNER"],
        'In QA duplicate, change the body to "Amber".',
      );
      expect(result.success).toBe(false);
      expect(result.data?.awaitingUserInput).toBe(true);
      expect(result.effectReceipts).toBeUndefined();
      expect(service.snapshot()).toEqual(before);
    },
  );

  it.each(["explicit ID", "body follow-up"])(
    "retains an identified duplicate selection through %s",
    async (selection) => {
      const runtime = await executorHarness();
      const service = getNotesService(runtime);
      const first = await service.createNote({
        title: "QA duplicate",
        body: "Silver",
      });
      const other = await service.createNote({
        title: "QA duplicate",
        body: "Tomorrow",
      });
      const originalSnapshot = service.snapshot();
      const text =
        selection === "explicit ID"
          ? `Set QA duplicate with ID ${first.id} to Amber.`
          : "The one that says Silver. Set its body to Amber.";
      const result = await execute(
        runtime,
        {
          name: "NOTES_PATCH",
          params: {
            expectedRevision: originalSnapshot.revision,
            target: { kind: "id", value: first.id },
            changes: [{ field: "body", value: "Amber" }],
          },
        },
        ["OWNER"],
        text,
      );
      expect(result.success).toBe(true);
      expect(service.getNote(first.id).body).toBe("Amber");
      expect(service.getNote(other.id)).toEqual(other);
    },
  );
});

describe("field patch literal alternative", () => {
  it("preserves all surrounding text and rejects conflicting forms", async () => {
    const runtime = await executorHarness();
    const service = getNotesService(runtime);
    const note = await service.createNote({
      title: "Literal target",
      body: "Mira’s notebook is violet.",
      color: "rose",
    });
    const params = {
      expectedRevision: service.snapshot().revision,
      target: { kind: "id", value: note.id },
      changes: [],
      textEdit: { field: "body", oldText: "violet", newText: "orange" },
    };
    expect(
      (await execute(runtime, { name: "NOTES_PATCH", params })).success,
    ).toBe(true);
    expect(service.getNote(note.id)).toMatchObject({
      title: note.title,
      body: "Mira’s notebook is orange.",
      color: "rose",
    });
    const before = service.getNote(note.id);
    expect(
      (
        await execute(runtime, {
          name: "NOTES_PATCH",
          params: {
            ...params,
            expectedRevision: service.snapshot().revision,
            changes: [{ field: "body", value: "" }],
          },
        })
      ).success,
    ).toBe(false);
    expect(
      (await execute(runtime, { name: "NOTES_PATCH", params })).success,
    ).toBe(false);
    expect(service.getNote(note.id)).toEqual(before);
  });
});
