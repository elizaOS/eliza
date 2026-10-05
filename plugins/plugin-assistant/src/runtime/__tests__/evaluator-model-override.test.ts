import {
  type ContextObject,
  completionContextSources,
  type EvaluatorRuntime,
  type ModelAttemptContext,
  ModelType,
  type PlannerTrajectory,
  type RecordedStage,
  type RunEvaluatorParams,
} from "@elizaos/core";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "@elizaos/core/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runEvaluator } from "../evaluator";

beforeEach(() => vi.stubEnv("ELIZA_EVALUATOR_MODEL", undefined));
afterEach(() => vi.unstubAllEnvs());

function trajectory(
  context: ContextObject = { id: "model-selection" },
): PlannerTrajectory {
  return { context, steps: [], plannedQueue: [], evaluatorOutputs: [] };
}
const answer = {
  thought: "",
  success: true,
  decision: "FINISH",
  messageToUser: "Answer from complete evidence.",
};

it("leaves unset and blank model selection requests unchanged", async () => {
  const requests: unknown[] = [];
  for (const setting of [undefined, "", "  "]) {
    const t = trajectory();
    await runEvaluator({
      context: t.context,
      trajectory: t,
      runtime: {
        getSetting: () => setting ?? null,
        useModel: async (_type, params) => {
          expect(params).not.toHaveProperty("model");
          const { prepareModelAttempt: _prepare, ...wireParams } = params;
          requests.push(wireParams);
          return JSON.stringify(answer);
        },
      },
    });
  }
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[2]).toEqual(requests[0]);
});

it.each(["", "  ", false, 17])(
  "does not let environment replace explicit runtime value %j",
  async (setting) => {
    vi.stubEnv("ELIZA_EVALUATOR_MODEL", "environment-model");
    const t = trajectory();
    await runEvaluator({
      context: t.context,
      trajectory: t,
      runtime: {
        getSetting: () => setting,
        useModel: async (_type, params) => {
          expect(params).not.toHaveProperty("model");
          return JSON.stringify(answer);
        },
      },
    });
  },
);

it.each([" explicit-model ", "", "  "])(
  "resolves explicit evaluator selection %j without changing blank semantics",
  async (model) => {
    const t = trajectory();
    await runEvaluator({
      context: t.context,
      trajectory: t,
      model,
      runtime: {
        getSetting: () => "configured-model",
        useModel: async (type, params) => {
          expect(type).toBe(ModelType.RESPONSE_HANDLER);
          expect(params.model).toBe(model.trim() || "configured-model");
          return JSON.stringify(answer);
        },
      },
    });
  },
);

it.each(
  [undefined, "", "  ", "gpt-oss-120b"].flatMap((initial) =>
    ["runtime", "environment"].map((source) => ({ initial, source })),
  ),
)(
  "pins initial evaluator selection $initial from $source through restoration but resolves a reused caller afresh",
  async ({ initial, source }) => {
    const context: ContextObject = {
      id: "restore-model",
      events: [1, 2].map((id) => ({
        id: `history:${id}`,
        type: "segment",
        source: "prior-dialogue",
        createdAt: id,
        segment: {
          id: `history:${id}`,
          label: "prior_message:user",
          content: `Original ${id}`,
          stable: false,
        },
      })),
    };
    context.metadata = {
      completionContext: {
        mode: "selected",
        complete: true,
        sourceSetId: completionContextSources(context).sourceSetId,
        relevantSourceIds: ["h1"],
        constraintSourceIds: [],
        referentSourceIds: [],
        pendingIntentSourceIds: [],
      },
    };
    const t = trajectory(context);
    t.modelBaseContext = context;
    let setting = initial ?? null;
    if (source === "environment") vi.stubEnv("ELIZA_EVALUATOR_MODEL", initial);
    const initialModel = initial?.trim() || undefined;
    let calls = 0;
    const params: RunEvaluatorParams = {
      context,
      trajectory: t,
      runtime: {
        getSetting: () => (source === "runtime" ? setting : null),
        useModel: async (_type, params) => {
          const expected = calls < 2 ? initialModel : "changed-during-turn";
          if (expected) expect(params.model).toBe(expected);
          else expect(params).not.toHaveProperty("model");
          calls++;
          setting = "changed-during-turn";
          if (source === "environment")
            vi.stubEnv("ELIZA_EVALUATOR_MODEL", setting);
          if (calls === 1) {
            expect(JSON.stringify(params.messages)).not.toContain("Original 2");
            return JSON.stringify({
              thought: "Need original.",
              success: false,
              // This independent PR uses develop's restoration envelope.
              // Exclusive RESTORE_* decisions are reviewed separately.
              decision: "CONTINUE",
              contextRequest: "history",
            });
          }
          expect(JSON.stringify(params.messages)).toContain("Original 2");
          return JSON.stringify(answer);
        },
      },
    };
    await runEvaluator(params);
    expect(calls).toBe(2);
    expect(params).not.toHaveProperty("model");
    await runEvaluator(params);
    expect(calls).toBe(3);
  },
);

it("prepares each attempt without borrowing another model's capacity and records the served model", async () => {
  const t = trajectory();
  const stages: RecordedStage[] = [];
  const attempts: ModelAttemptContext[] = [
    {
      modelType: ModelType.RESPONSE_HANDLER,
      provider: "primary",
      metadata: { displayModel: "slot-model", contextWindowTokens: 64_000 },
    },
    {
      modelType: ModelType.RESPONSE_HANDLER,
      provider: "backup",
      metadata: { displayModel: "gpt-oss-120b", contextWindowTokens: 131_072 },
    },
  ];
  const runtime: EvaluatorRuntime = {
    supportsModelAttemptPreparation: true,
    getSetting: () => "gpt-oss-120b",
    getModelRegistrations: () =>
      attempts.map((attempt, i) => ({
        ...attempt,
        priority: 100 - i,
        registrationOrder: i,
      })),
    useModel: async (_type, params) => {
      const originalMessages = structuredClone(params.messages);
      for (const [i, attempt] of attempts.entries()) {
        const prepared = { ...params };
        await params.prepareModelAttempt?.(attempt, prepared);
        expect(prepared.model).toBe("gpt-oss-120b");
        expect(prepared.messages).toEqual(originalMessages);
        expect(prepared.providerOptions).toHaveProperty(
          "eliza.modelInputBudget.contextWindowTokens",
          i === 0 ? DEFAULT_CONTEXT_WINDOW_TOKENS : 131_072,
        );
      }
      // An adapter may ignore per-call selection or serve a concrete fallback.
      return {
        text: JSON.stringify(answer),
        providerMetadata: {
          modelName: "actually-served-model",
          provider: "backup",
        },
      };
    },
  };
  await runEvaluator({
    context: t.context,
    trajectory: t,
    runtime,
    trajectoryId: "served-model",
    recorder: {
      startTrajectory: () => "served-model",
      recordStage: async (_id, stage) => {
        stages.push(stage);
      },
      endTrajectory: async () => {},
      load: async () => null,
      list: async () => [],
    },
  });
  expect(stages).toHaveLength(1);
  expect(stages[0].model).toMatchObject({
    modelName: "actually-served-model",
    provider: "backup",
  });
});
