/** Real provider, scheduler, journal and database proof for deferred evidence. */
import {
  type AgentRuntime,
  ChannelType,
  modelOutputIncompleteEvidence,
  type RegisteredEvaluator,
  stringToUuid,
  TaskService,
} from "@elizaos/core";
import { buildLiveHarness, type LiveAgentHarness } from "@elizaos/testing/live";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testOutputPath } from "../../../../packages/scripts/lib/test-output.ts";
import {
  type CerebrasWireCapture,
  startCerebrasWireCapture,
  writeCerebrasEvidenceArtifacts,
} from "../../../plugin-openai/__tests__/helpers/cerebras-wire-capture.ts";
import { EvaluatorService } from "./evaluator.ts";
import { prepareEvaluatorProgress } from "./evaluator-progress.ts";

const enabled =
  process.env.ELIZA_RUN_LIVE_TESTS === "1" &&
  Boolean(process.env.CEREBRAS_API_KEY?.trim());
const priorBase = process.env.OPENAI_BASE_URL;
const priorProvider = process.env.ELIZA_PROVIDER;
const receipts: Array<Record<string, unknown>> = [];

describe.skipIf(!enabled)("deferred evidence with live Cerebras", () => {
  let harness: LiveAgentHarness;
  let capture: CerebrasWireCapture;

  beforeAll(async () => {
    capture = await startCerebrasWireCapture();
    process.env.OPENAI_BASE_URL = capture.baseUrl;
    process.env.ELIZA_PROVIDER = "cerebras";
    harness = await buildLiveHarness({
      provider: "cerebras",
      requiredEnv: ["CEREBRAS_API_KEY"],
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await harness?.close();
    } finally {
      await capture?.close();
      if (capture)
        await writeCerebrasEvidenceArtifacts({
          artifactDirectory:
            process.env.ELIZA_LIVE_TEST_ARTIFACT_DIR?.trim() ||
            testOutputPath("evaluator-deferred-page-live"),
          calls: capture.calls,
          trajectories: [],
          receipts,
          secrets: [process.env.CEREBRAS_API_KEY ?? ""].filter(Boolean),
          metadata: {
            provider: "cerebras",
            model: harness?.runtime.getSetting("OPENAI_SMALL_MODEL"),
            purpose: "issue-39202",
          },
        });
      if (priorBase === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = priorBase;
      if (priorProvider === undefined) delete process.env.ELIZA_PROVIDER;
      else process.env.ELIZA_PROVIDER = priorProvider;
    }
  }, 120_000);

  it("processes the deferred page after a real provider output limit without rebuying the failed page", async () => {
    const runtime = harness.runtime;
    const observed: Record<string, string[]> = { lead: [], lag: [] };
    const makeLane = (name: string): RegisteredEvaluator => ({
      name,
      description: "Validate the supplied complete source records.",
      background: true,
      incremental: true,
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
      shouldRun: async () => true,
      prompt: () =>
        'Read the complete supplied source records and return {"ok":true}.',
      processors: [
        {
          process: async ({ options }) => {
            observed[name].push(
              ...(options.extraction?.messages ?? []).map((row) =>
                String(row.id),
              ),
            );
            return undefined;
          },
        },
      ],
    });
    runtime.evaluators.length = 0;
    runtime.registerEvaluator(makeLane("lead"));
    const roomId = stringToUuid("live-deferred-room");
    const entityId = stringToUuid("live-deferred-owner");
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        type: ChannelType.DM,
        source: "test",
      },
    ]);
    await runtime.createEntities([
      { id: entityId, agentId: runtime.agentId, names: ["Owner"] },
    ]);
    await runtime.createRoomParticipants([entityId], roomId);
    const message = {
      id: stringToUuid("live-deferred-original"),
      agentId: runtime.agentId,
      roomId,
      entityId,
      createdAt: 10,
      content: { text: "My preferred meeting city is Berlin." },
    };
    await runtime.upsertMemory(message, "messages");
    const service = (await EvaluatorService.start(runtime)) as EvaluatorService;
    let now = Date.now() + 10_000;
    const scheduler = new TaskService(runtime, {
      now: () => now,
      setTimeout: () => {
        throw new Error("Manual scheduler ticks only");
      },
      clearTimeout: () => undefined,
    });
    const originalUseModel = runtime.useModel.bind(runtime);
    let cap = 4096;
    let semanticCalls = 0;
    runtime.useModel = (async (type, params, provider) => {
      semanticCalls++;
      try {
        const result = await originalUseModel(
          type,
          { ...params, maxTokens: cap },
          provider,
        );
        receipts.push({ call: semanticCalls, cap, outcome: "success" });
        return result;
      } catch (error) {
        receipts.push({
          call: semanticCalls,
          cap,
          outcome: "failure",
          incomplete: modelOutputIncompleteEvidence(error),
        });
        throw error;
      }
    }) as AgentRuntime["useModel"];
    const runOnlyTask = async () => {
      const tasks = await runtime.getTasksByName("POST_TURN_MEMORY");
      expect(tasks).toHaveLength(1);
      const id = tasks[0].id;
      if (!id) throw new Error("Missing task id");
      now += 2_000;
      await scheduler.executeTaskById(id);
      return { ...tasks[0], id };
    };
    await service.enqueue(message, undefined, { phase: "post_turn" });
    await runOnlyTask();
    expect(observed.lead).toEqual([message.id]);
    const next = {
      ...message,
      id: stringToUuid("live-deferred-next"),
      createdAt: 20,
      content: { text: "My preferred weekday for meetings is Friday." },
    };
    await runtime.upsertMemory(next, "messages");
    const stored = await runtime.getMemories({
      tableName: "messages",
      roomId,
      unique: false,
      includeEmbedding: false,
    });
    runtime.setSetting(
      "MEMORY_EVIDENCE_BATCH_BYTES",
      String(
        Math.max(
          ...stored.map(
            (row) => new TextEncoder().encode(JSON.stringify(row)).byteLength,
          ),
        ) + 1,
      ),
    );
    runtime.registerEvaluator(makeLane("lag"));
    await service.enqueue(next, undefined, { phase: "post_turn" });
    cap = 1; // A real provider request limit, never a fabricated model response.
    const failedTask = await runOnlyTask();
    const retained = await runtime.getTask(failedTask.id);
    expect(retained?.metadata?.nonRetryableEvidenceIds).toHaveLength(1);
    expect(receipts.at(-1)).toMatchObject({
      outcome: "failure",
      incomplete: { finishReason: "length" },
    });
    cap = 4096;
    await runOnlyTask();
    expect(await runtime.getTasksByName("POST_TURN_MEMORY")).toEqual([]);
    expect(semanticCalls).toBe(3);
    expect(observed).toEqual({ lead: [message.id, next.id], lag: [] });
    const room = await runtime.getMemories({
      tableName: "messages",
      roomId,
      unique: false,
      includeEmbedding: false,
    });
    const progress = await prepareEvaluatorProgress(
      runtime,
      next,
      ["lead", "lag"],
      room,
    );
    expect(progress.get("lead")?.messages).toEqual([]);
    expect(
      progress
        .get("lag")
        ?.messages.map((row) => row.id)
        .sort(),
    ).toEqual([message.id, next.id].sort());
    receipts.push({
      outcome: "passed",
      semanticCalls,
      observed,
      blockedEvidenceIds: retained?.metadata?.nonRetryableEvidenceIds,
    });
  }, 180_000);
});
