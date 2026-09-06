/** Exercises owner-authorized Notes reads against real filesystem state, trusted dispatch and the production reply-egress guard; live model selection is outside this harness. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  evaluatePlannedReplyEgress,
  executePlannedToolCall,
  type IAgentRuntime,
  plannedReplyHasClaimGroundingReceipt,
  stringToUuid,
} from "@elizaos/core";
import { afterEach, expect, test } from "vitest";
import { notesAction } from "../action.js";
import { notesPlugin } from "../plugin.js";
import { NotesService } from "../service.js";
import { NotesStore } from "../store.js";

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

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "notes-read-proof-"));
  directories.push(directory);
  const filePath = path.join(directory, "notes.json");
  const runtime = new AgentRuntime({
    agentId: stringToUuid(directory),
    character: createCharacter({ name: "Notes read proof" }),
    disableBasicCapabilities: true,
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtimes.push(runtime);
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
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
  const invoke = (params: Record<string, unknown>, owner = true) =>
    executePlannedToolCall(
      runtime,
      {
        message: {
          id: stringToUuid("read-proof-message"),
          entityId: runtime.agentId,
          roomId: stringToUuid("read-proof-room"),
          content: { text: "List my saved notes; do not change anything." },
        },
        userRoles: owner ? ["OWNER"] : ["GUEST"],
        activeContexts: ["notes"],
      },
      { name: "NOTES", params },
    );
  return { runtime, service, filePath, invoke };
}

test("an actual empty owner read grounds its exact answer without licensing an invented broader claim", async () => {
  const { invoke, service } = await setup();
  const before = service.snapshot();
  const result = await invoke({ action: "list" });
  if (typeof result.text !== "string")
    throw new Error("Read produced no answer");
  expect(
    plannedReplyHasClaimGroundingReceipt({
      kind: "empty_tracked_state",
      reply: result.text,
      results: [result],
      actions: [notesAction],
    }),
  ).toBe(true);
  expect(
    evaluatePlannedReplyEgress({
      reply: result.text,
      actionResults: [result],
      actions: [notesAction],
    }),
  ).toEqual({ verdict: "allow" });
  expect(
    evaluatePlannedReplyEgress({
      reply: "Your list is empty. You have no tasks or notes today.",
      actionResults: [result],
      actions: [notesAction],
    }).verdict,
  ).toBe("reject");
  expect(service.snapshot()).toEqual(before);
});

test("a filtered miss proves only the exact scoped answer and preserves existing persisted notes", async () => {
  const { invoke, service, filePath } = await setup();
  await service.createNote({
    title: "Shopping",
    body: "Buy oats",
    color: "yellow",
  });
  const before = await readFile(filePath, "utf8");
  const result = await invoke({ action: "list", content: "Passport" });
  if (typeof result.text !== "string")
    throw new Error("Read produced no answer");
  expect(
    plannedReplyHasClaimGroundingReceipt({
      kind: "empty_tracked_state",
      reply: result.text,
      results: [result],
      actions: [notesAction],
    }),
  ).toBe(true);
  expect(
    evaluatePlannedReplyEgress({
      reply: "Your list is empty. Zero notes saved, nothing there yet.",
      actionResults: [result],
      actions: [notesAction],
    }).verdict,
  ).toBe("reject");
  expect(await readFile(filePath, "utf8")).toBe(before);
});

test("denied reads and mutations cannot supply empty-read authority", async () => {
  const { invoke } = await setup();
  for (const result of [
    await invoke({ action: "list" }, false),
    await invoke({ action: "create", content: "Keep this note" }),
  ]) {
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
