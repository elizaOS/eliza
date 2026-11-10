// @vitest-environment node
/** Exercises owner-authorized Notes reads against real filesystem state, trusted dispatch, the planner loop and reply-egress guard with bounded scripted models. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  type IAgentRuntime,
  type NotesRequestOperation,
  stringToUuid,
} from "@elizaos/core";
import { initializeTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, test, vi } from "vitest";
import { runPlannerLoop } from "../../../plugin-assistant/src/runtime/planner-loop.ts";
import {
  evaluatePlannedReplyEgress,
  plannedReplyHasClaimGroundingReceipt,
} from "../../../plugin-assistant/src/services/message/egress-policy.ts";
import { notesAction } from "../action.js";
import { notesPlugin } from "../plugin.js";
import { NotesService } from "../service.js";
import { NotesStore } from "../store.js";
import {
  boundNotesRequest,
  notesFixturePlannerRuntime,
} from "./helpers/bound-notes-request.ts";

const runtimes: AgentRuntime[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup(
  requested: { text: string; operations: readonly NotesRequestOperation[] } = {
    text: "List my saved notes; do not change anything.",
    operations: ["list", "get"],
  },
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notes-read-proof-"));
  directories.push(directory);
  const filePath = path.join(directory, "notes.json");
  const runtime = new AgentRuntime({
    agentId: stringToUuid(directory),
    character: createCharacter({ name: "Notes read proof" }),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  await initializeTestRuntime(runtime, { skipMigrations: true });
  class PersistedNotes extends NotesService {
    static override async start(owner: IAgentRuntime) {
      const service = new NotesService(owner, {
        store: new NotesStore({ filePath }),
      });
      await service.initialize();
      return service;
    }
  }
  await runtime.registerPlugin({ ...notesPlugin, services: [PersistedNotes] });
  await runtime.getServiceLoadPromise(NotesService.serviceType);
  const service = runtime.getService<NotesService>(NotesService.serviceType);
  if (!service) throw new Error("Notes service did not start");
  const request = await boundNotesRequest(runtime, {
    ...requested,
    message: {
      entityId: runtime.agentId,
      roomId: stringToUuid("read-proof-room"),
    },
  });
  const invoke = (params: Record<string, unknown>, owner = true) =>
    request.execute({ name: "NOTES", params }, owner ? ["OWNER"] : ["GUEST"]);
  return { runtime, service, filePath, invoke, request };
}

test("an empty owner read remains structured and does not license an invented broader claim", async () => {
  const { invoke, service } = await setup();
  const before = service.snapshot();
  const result = await invoke({ action: "list" });
  expect(result).toMatchObject({
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    data: { count: 0, total: 0, notes: [], filterApplied: false },
  });
  expect(result.text).toBeUndefined();
  expect(result.userFacingText).toBeUndefined();
  expect(result.verifiedUserFacing).toBeUndefined();
  for (const reply of [
    "You have no saved notes.",
    "You have no notes saved at the moment.",
  ]) {
    expect(
      evaluatePlannedReplyEgress({
        reply,
        actionResults: [result],
        actions: [notesAction],
      }),
    ).toEqual({ verdict: "allow" });
  }
  for (const reply of [
    "You have no tasks.",
    "You have no notes or tasks.",
    "You have no notes from last week.",
  ]) {
    expect(
      evaluatePlannedReplyEgress({
        reply,
        actionResults: [result],
        actions: [notesAction],
      }).verdict,
    ).toBe("reject");
  }
  expect(result.turnComplete).toBeUndefined();
  expect(
    evaluatePlannedReplyEgress({
      reply: "Your list is empty. You have no tasks or notes today.",
      actionResults: [result],
      actions: [notesAction],
    }).verdict,
  ).toBe("reject");
  expect(service.snapshot()).toEqual(before);
});

test("a filtered miss preserves its scope and persisted notes without granting global absence authority", async () => {
  const { invoke, service, filePath } = await setup();
  await service.createNote({
    title: "Shopping",
    body: "Buy oats",
    color: "yellow",
  });
  const before = await readFile(filePath, "utf8");
  const result = await invoke({ action: "list", content: "Passport" });
  expect(result).toMatchObject({
    success: true,
    transcriptVisibility: "internal",
    modelReplyRequired: true,
    data: {
      count: 0,
      total: 1,
      notes: [],
      filterApplied: true,
      topic: "Passport",
    },
  });
  expect(
    plannedReplyHasClaimGroundingReceipt({
      kind: "empty_tracked_state",
      reply: "You have no notes.",
      results: [result],
      actions: [notesAction],
    }),
  ).toBe(false);
  expect(
    evaluatePlannedReplyEgress({
      reply: "Your list is empty. Zero notes saved, nothing there yet.",
      actionResults: [result],
      actions: [notesAction],
    }).verdict,
  ).toBe("reject");
  expect(await readFile(filePath, "utf8")).toBe(before);
});

test("the real planner re-reads Notes after a mutation with identical list arguments", async () => {
  const { runtime, invoke, request } = await setup({
    text: "Read my notes, create Freshness proof with Complete note body., then read all notes again to verify it is present.",
    operations: ["list", "create"],
  });
  const plans: Record<string, string>[] = [
    { action: "list" },
    { action: "create", content: "Freshness proof\nComplete note body." },
    { action: "list" },
  ];
  const counts: number[] = [];
  let planningRounds = 0;
  let evaluations = 0;
  const finalReply = "The new note is present.";
  const model = vi.spyOn(runtime, "useModel").mockImplementation(async () => {
    const params = plans[planningRounds++];
    if (!params) throw new Error("Unexpected extra planner round");
    return {
      text: "",
      toolCalls: [
        {
          id: `notes-freshness-${planningRounds}`,
          name: "NOTES",
          arguments: {
            ...params,
            eliza_turn_scope:
              planningRounds === plans.length ? "final" : "more_work_pending",
          },
        },
      ],
    } as never;
  });
  const result = await runPlannerLoop({
    runtime: notesFixturePlannerRuntime(runtime),
    requestOperationIssuer: request.issuer,
    context: request.context,
    tools: [{ name: "NOTES", description: "Read and create owner notes." }],
    executeToolCall: async (call) => {
      const result = await invoke(call.params ?? {});
      if (call.params?.action === "list") {
        counts.push(Number(result.data?.count));
      }
      return result;
    },
    evaluate: async () => {
      evaluations++;
      if (evaluations > plans.length)
        throw new Error("Unexpected extra evaluation");
      // Intermediate successful internal reads may continue without a model
      // evaluation. Finish only after the actual post-write read is recorded.
      return counts.length === 2 && counts[1] === 1
        ? {
            success: true,
            decision: "FINISH",
            thought: "The repeated read observed the newly created note.",
            messageToUser: finalReply,
          }
        : {
            success: false,
            decision: "CONTINUE",
            thought:
              "The requested create and verification are not both complete.",
          };
    },
  });
  expect(counts).toEqual([0, 1]);
  expect(planningRounds).toBe(3);
  expect(evaluations).toBeGreaterThan(0);
  expect(evaluations).toBeLessThanOrEqual(3);
  expect(result.finalMessage).toBe(finalReply);
  model.mockRestore();
});

test("denied reads and mutations cannot supply empty-read authority", async () => {
  const { invoke, service } = await setup();
  const before = service.snapshot();
  const forced = await invoke({ action: "create", content: "Keep this note" });
  expect(forced).toMatchObject({
    success: false,
    data: {
      code: "REQUEST_OPERATION_RESTRICTED",
      executionStatus: "not_started",
      executed: false,
    },
  });
  expect(service.snapshot()).toEqual(before);
  for (const result of [await invoke({ action: "list" }, false), forced]) {
    expect(
      plannedReplyHasClaimGroundingReceipt({
        kind: "empty_tracked_state",
        reply: result.text ?? "You have no notes.",
        results: [result],
        actions: [notesAction],
      }),
    ).toBe(false);
  }
});

test("a later write invalidates earlier empty inventory authority", async () => {
  const { invoke, runtime } = await setup();
  const empty = await invoke({ action: "list" });
  const write = await boundNotesRequest(runtime, {
    text: "Create a new note.",
    operations: ["create"],
    message: {
      entityId: runtime.agentId,
      roomId: stringToUuid("read-proof-room"),
    },
  });
  const created = await write.execute({
    name: "NOTES",
    params: { action: "create", content: "A real note" },
  });
  expect(created.success).toBe(true);
  expect(
    evaluatePlannedReplyEgress({
      reply: "You have no saved notes.",
      actionResults: [empty, created],
      actions: [notesAction],
    }).verdict,
  ).toBe("reject");
});
