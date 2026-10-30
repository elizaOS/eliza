/**
 * Runs one reasoning-model planner turn on a PGlite-backed runtime through the
 * trajectory sinks the message pipeline composes: the JSON file recorder wrapped
 * by the database semantic-stage fan-out. A configured secret that the model
 * echoes in its reasoning and visible text must not reach either store.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type GenerateTextParams,
  type GenerateTextResult,
  ModelType,
  type PlannerRuntime,
  runWithTrajectoryContext,
  withSemanticStageFanOut,
} from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, expect, it } from "vitest";
import { trajectoriesPlugin } from "../features/trajectories/index.ts";
import type { TrajectoriesService } from "../features/trajectories/TrajectoriesService.ts";
import { runPlannerLoop } from "./planner-loop.ts";
import { createJsonFileTrajectoryRecorder } from "./trajectory-recorder.ts";

const SECRET = "synthetic-trajectory-credential-7f3c9a21d4e8";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("keeps configured secrets out of persisted planner stages", async () => {
  const rootDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "trajectory-stage-redaction-"),
  );
  cleanups.push(() => fs.rm(rootDir, { recursive: true, force: true }));
  const { runtime, cleanup } = await createTestRuntime({
    settings: { EXAMPLE_SERVICE_API_KEY: SECRET },
    plugins: [trajectoriesPlugin],
  });
  cleanups.push(cleanup);
  expect(runtime.redactSecrets(`key ${SECRET}`)).not.toContain(SECRET);

  // Same shape plugin-openai returns for the Cerebras reasoning model: private
  // reasoning parts followed by the visible text part.
  const visible = JSON.stringify({
    thought: "Answer directly",
    toolCalls: [],
    messageToUser: `Your service key is ${SECRET}.`,
    completed: true,
  });
  runtime.registerModel(
    ModelType.ACTION_PLANNER,
    async (): Promise<GenerateTextResult> => ({
      text: visible,
      content: [
        {
          type: "reasoning",
          text: `The user asked for the key; it is ${SECRET}.`,
          providerOptions: { cerebras: { model: "qwen-3.8-27b" } },
        },
        { type: "text", text: visible },
      ],
    }),
    "cerebras",
  );

  const service = (await runtime.getServiceLoadPromise(
    "trajectories",
  )) as TrajectoriesService;
  const dbTrajectoryId = await service.startTrajectory(runtime.agentId, {
    source: "chat",
  });
  const stepId = service.startStep(dbTrajectoryId, { timestamp: Date.now() });
  await service.flushWriteQueue(dbTrajectoryId);

  const recorder = withSemanticStageFanOut(
    createJsonFileTrajectoryRecorder({
      rootDir,
      enabled: true,
      redactSecrets: runtime.redactSecrets.bind(runtime),
    }),
    runtime,
  );
  const fileTrajectoryId = recorder.startTrajectory({
    agentId: runtime.agentId,
    rootMessage: { id: "root-message", text: "What is my service key?" },
  });

  // Same adapter shape the message pipeline hands the planner.
  const plannerRuntime: PlannerRuntime = {
    getModelRegistrations: () => runtime.getModelRegistrations(),
    useModel: (modelType, params, provider) =>
      runtime.useModel(modelType, params as GenerateTextParams, provider),
    logger: runtime.logger as PlannerRuntime["logger"],
  };
  await runWithTrajectoryContext({ trajectoryStepId: stepId }, () =>
    runPlannerLoop({
      runtime: plannerRuntime,
      context: {
        id: "turn-context",
        metadata: {},
        events: [
          {
            id: "user-message",
            type: "message",
            message: {
              role: "user",
              content: `My service key is ${SECRET}. What is it?`,
            },
          },
        ],
      },
      executeToolCall: async () => {
        throw new Error("No tool call expected");
      },
      recorder,
      trajectoryId: fileTrajectoryId,
    }),
  );
  await recorder.endTrajectory(fileTrajectoryId, "finished");
  await service.flushWriteQueue(dbTrajectoryId);

  const fileText = await fs.readFile(
    path.join(rootDir, runtime.agentId, `${fileTrajectoryId}.json`),
    "utf8",
  );
  const filePlanner = JSON.parse(fileText).stages.find(
    (stage: { kind: string }) => stage.kind === "planner",
  );
  expect(filePlanner.model.responseContent[0]).toEqual({
    type: "reasoning",
    text: "The user asked for the key; it is [REDACTED:EXAMPLE_SERVICE_API_KEY].",
    providerOptions: { cerebras: { model: "qwen-3.8-27b" } },
  });
  expect(filePlanner.model.providerOptions.eliza.prefixHash).toBe(
    filePlanner.cache.prefixHash,
  );
  expect(fileText).not.toContain(SECRET);

  const detail = await service.getTrajectoryDetail(dbTrajectoryId);
  const semanticStages = detail?.steps.flatMap(
    (step) => step.semanticStages ?? [],
  );
  expect(semanticStages?.map((stage) => stage.kind)).toContain("planner");
  expect(JSON.stringify(semanticStages)).not.toContain(SECRET);
});
