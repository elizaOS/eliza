/** A non-retryable page must not erase a deferred evidence page or be bought again. */

import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Memory,
  type RegisteredEvaluator,
  type State,
  stringToUuid as sqliteTestAgentId,
  stringToUuid,
  type Task,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { describe, expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../index.ts";
import { EvaluatorService } from "./evaluator.ts";
import { prepareEvaluatorProgress } from "./evaluator-progress.ts";

const state: State = { values: {}, data: {}, text: "" };
const turn: Memory = {
  id: "00000000-0000-4000-8000-000000000001",
  roomId: "00000000-0000-4000-8000-000000000002",
  entityId: "00000000-0000-4000-8000-000000000003",
  content: { text: "I live in Berlin." },
  createdAt: 10,
};

async function setup() {
  const adapter = SQLiteDatabaseAdapter.create(
    ":memory:",
    sqliteTestAgentId("DeferredEvidencePage"),
  );
  const runtime = new AgentRuntime({
    plugins: [createAssistantPlugin()],
    character: {
      name: "DeferredEvidencePage",
      bio: "test",
      settings: {},
    } as Character,
    adapter,
    logLevel: "fatal",
  });
  await adapter.initialize();
  await adapter.ensureEmbeddingDimension(3);
  runtime.evaluators.length = 0;
  runtime.composeState = vi.fn(async () => state);
  runtime.emitEvent = vi.fn(async () => {});
  await runtime.createRooms([
    {
      id: turn.roomId,
      agentId: runtime.agentId,
      type: ChannelType.DM,
      source: "test",
    },
  ]);
  await runtime.createEntities([
    { id: turn.entityId, agentId: runtime.agentId, names: ["User"] },
  ]);
  await runtime.createRoomParticipants([turn.entityId], turn.roomId);
  const message = { ...turn, agentId: runtime.agentId };
  await runtime.upsertMemory(message, "messages");
  const service = (await EvaluatorService.start(runtime)) as EvaluatorService;
  return { runtime, service, message };
}

function lane(name: string, seen: string[]): RegisteredEvaluator {
  return {
    name,
    description: "test",
    background: true,
    incremental: true,
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    },
    shouldRun: async () => true,
    prepare: async () => ({ candidate: "original" }),
    prompt: ({ prepared }) => JSON.stringify(prepared),
    processors: [
      {
        process: async ({ options }) => {
          seen.push(
            ...(options.extraction?.messages ?? []).map((row) =>
              String(row.id),
            ),
          );
          return undefined;
        },
      },
    ],
  };
}

async function job(runtime: AgentRuntime) {
  const rows = await runtime.getTasksByName("POST_TURN_MEMORY");
  expect(rows).toHaveLength(1);
  const task = rows[0];
  if (!task?.id) throw new Error("Missing persisted task identity");
  return task as Task & { id: NonNullable<Task["id"]> };
}

async function execute(runtime: AgentRuntime, task: Task) {
  const worker = runtime.getTaskWorker("POST_TURN_MEMORY");
  if (!worker) throw new Error("Memory worker not registered");
  return worker.execute(runtime, {}, task);
}

async function setupDeferredPages() {
  const { runtime, service, message } = await setup();
  const observed: Record<string, string[]> = { lead: [], lag: [] };
  runtime.registerEvaluator(lane("lead", observed.lead));
  runtime.useModel = vi.fn(async () =>
    JSON.stringify({ lead: { ok: true } }),
  ) as AgentRuntime["useModel"];
  await service.enqueue(message, state, { phase: "post_turn" });
  await execute(runtime, await job(runtime));
  expect(runtime.useModel).toHaveBeenCalledTimes(1);
  const next = {
    ...message,
    id: stringToUuid("deferred-page-after-output-limit"),
    createdAt: 20,
    content: {
      text: "The complete next source, with its detail intact.",
    },
  };
  await runtime.upsertMemory(next, "messages");
  const stored = await runtime.getMemories({
    tableName: "messages",
    roomId: message.roomId,
    unique: false,
    includeEmbedding: false,
  });
  const budget =
    Math.max(
      ...stored.map(
        (row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
      ),
    ) + 1;
  vi.spyOn(runtime, "getSetting").mockImplementation((key) =>
    key === "MEMORY_EVIDENCE_BATCH_BYTES" ? String(budget) : null,
  );
  runtime.registerEvaluator(lane("lag", observed.lag));
  await service.enqueue(next, state, { phase: "post_turn" });
  return { runtime, service, message, next, observed };
}

function outputLimit() {
  return { text: "", finishReason: "length", toolCalls: [], usage: {} };
}

function heldOutput() {
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  return {
    entered,
    release,
    run: async () => {
      started();
      await pending;
      return outputLimit();
    },
  };
}

describe("deferred evidence after an output limit", () => {
  it("continues a deferred evidence page after a persistent output-limit stop", async () => {
    const { runtime, message, next, observed } = await setupDeferredPages();
    const prompts: string[] = [];
    runtime.useModel = vi.fn(async (_type, params) => {
      const input = params as { messages?: Array<{ content: string }> };
      prompts.push((input.messages ?? []).map((row) => row.content).join("\n"));
      return {
        text: "",
        finishReason: "length",
        toolCalls: [],
        usage: {},
      };
    }) as AgentRuntime["useModel"];
    const first = await job(runtime);
    expect(await execute(runtime, first)).toBeUndefined();
    const retained = await job(runtime);
    expect(retained.id).toBe(first.id);
    expect(retained.metadata?.nonRetryableEvidenceIds).toEqual([
      expect.any(String),
    ]);
    const outcomes: unknown[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const rows = await runtime.getTasksByName("POST_TURN_MEMORY");
      if (rows.length === 0) break;
      outcomes.push(await execute(runtime, rows[0]));
    }
    expect(outcomes).toEqual([{ preserveTask: true }]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(String(message.content.text));
    expect(prompts[0]).not.toContain(String(next.content.text));
    expect(prompts[1]).toContain(String(next.content.text));
    expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toEqual([]);
    expect(observed).toEqual({ lead: [message.id], lag: [] });
    const room = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      unique: false,
      includeEmbedding: false,
    });
    const lag = (
      await prepareEvaluatorProgress(runtime, next, ["lag"], room)
    ).get("lag");
    const lead = (
      await prepareEvaluatorProgress(runtime, next, ["lead"], room)
    ).get("lead");
    expect(lag?.messages.map((row) => row.id).sort()).toEqual(
      [message.id, next.id].sort(),
    );
    expect(lead?.messages.map((row) => row.id)).toEqual([next.id]);
    expect(lag?.pendingOutput).toBeUndefined();
    expect(lead?.pendingOutput).toBeUndefined();
  });

  it("retains blocked evidence across a retryable failure and then completes the deferred page", async () => {
    const { runtime, observed, next } = await setupDeferredPages();
    runtime.useModel = vi.fn(async () =>
      outputLimit(),
    ) as AgentRuntime["useModel"];
    await execute(runtime, await job(runtime));
    const retained = await job(runtime);
    const blocked = retained.metadata?.nonRetryableEvidenceIds;
    runtime.useModel = vi.fn(async () => {
      throw new Error("Temporary provider outage");
    }) as AgentRuntime["useModel"];
    await expect(execute(runtime, retained)).rejects.toMatchObject({
      code: "EVALUATOR_JOB_PENDING",
    });
    expect((await job(runtime)).metadata?.nonRetryableEvidenceIds).toEqual(
      blocked,
    );
    runtime.useModel = vi.fn(async () =>
      JSON.stringify({ lead: { ok: true } }),
    ) as AgentRuntime["useModel"];
    expect(await execute(runtime, await job(runtime))).toEqual({
      preserveTask: true,
    });
    expect(observed.lead).toContain(next.id);
    expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toEqual([]);
  });

  it("blocks a non-retryable page when an independent evaluator also has a retryable failure", async () => {
    const { runtime, observed, next } = await setupDeferredPages();
    const transient = {
      ...lane("transient", []),
      shouldRun: async () => {
        throw new Error("Temporary evaluator dependency failure");
      },
    };
    runtime.registerEvaluator(transient);
    runtime.useModel = vi.fn(async () =>
      outputLimit(),
    ) as AgentRuntime["useModel"];
    await expect(execute(runtime, await job(runtime))).rejects.toMatchObject({
      code: "EVALUATOR_JOB_PENDING",
    });
    expect((await job(runtime)).metadata?.nonRetryableEvidenceIds).toHaveLength(
      1,
    );
    runtime.evaluators.splice(runtime.evaluators.indexOf(transient), 1);
    runtime.useModel = vi.fn(async () =>
      JSON.stringify({ lead: { ok: true } }),
    ) as AgentRuntime["useModel"];
    expect(await execute(runtime, await job(runtime))).toEqual({
      preserveTask: true,
    });
    expect(observed.lead).toContain(next.id);
    expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toEqual([]);
  });

  it("does not retain stale blocked evidence after the task revision changes during inference", async () => {
    const { runtime } = await setupDeferredPages();
    const held = heldOutput();
    runtime.useModel = vi.fn(held.run) as AgentRuntime["useModel"];
    const first = await job(runtime);
    const running = execute(runtime, first);
    await held.entered;
    if (!first.roomId) throw new Error("Missing task room");
    await runtime.roomHandlerQueue.withLease(first.roomId, () =>
      runtime.updateTask(first.id, {
        metadata: {
          ...first.metadata,
          reconciliationRevision: "revised-during-inference",
        },
      }),
    );
    held.release();
    expect(await running).toEqual({ preserveTask: true });
    const current = await job(runtime);
    expect(current.metadata?.reconciliationRevision).toBe(
      "revised-during-inference",
    );
    expect(current.metadata?.nonRetryableEvidenceIds).toBeUndefined();
    runtime.useModel = vi.fn(async () =>
      outputLimit(),
    ) as AgentRuntime["useModel"];
    expect(await execute(runtime, current)).toBeUndefined();
    expect((await job(runtime)).metadata?.nonRetryableEvidenceIds).toHaveLength(
      1,
    );
  });

  it("does not resurrect a task cancelled during inference", async () => {
    const { runtime } = await setupDeferredPages();
    const held = heldOutput();
    runtime.useModel = vi.fn(held.run) as AgentRuntime["useModel"];
    const first = await job(runtime);
    const running = execute(runtime, first);
    await held.entered;
    await runtime.deleteTask(first.id);
    held.release();
    expect(await running).toEqual({ preserveTask: true });
    expect(await runtime.getTask(first.id)).toBeNull();
  });

  it("preserves a replacement task when an earlier cancelled attempt completes", async () => {
    const { runtime, service, next } = await setupDeferredPages();
    const held = heldOutput();
    runtime.useModel = vi.fn(held.run) as AgentRuntime["useModel"];
    const first = await job(runtime);
    const running = execute(runtime, first);
    await held.entered;
    await runtime.deleteTask(first.id);
    await service.enqueue(next, state, { phase: "post_turn" });
    const replacement = await job(runtime);
    held.release();
    expect(await running).toEqual({ preserveTask: true });
    const current = await job(runtime);
    expect(current.metadata?.reconciliationRevision).not.toBe(
      first.metadata?.reconciliationRevision,
    );
    expect(current.metadata).toEqual(replacement.metadata);
    expect(current.metadata?.nonRetryableEvidenceIds).toBeUndefined();
  });

  it("leaves task evidence pending when shutdown closes admission during inference", async () => {
    const { runtime } = await setupDeferredPages();
    const held = heldOutput();
    runtime.useModel = vi.fn(held.run) as AgentRuntime["useModel"];
    const first = await job(runtime);
    const running = execute(runtime, first);
    await held.entered;
    runtime.roomHandlerQueue.closeAdmissions("runtime-stop");
    held.release();
    await expect(running).rejects.toMatchObject({
      code: "ROOM_HANDLER_QUEUE_CLOSED",
    });
    expect(
      (await job(runtime)).metadata?.nonRetryableEvidenceIds,
    ).toBeUndefined();
  });
});
