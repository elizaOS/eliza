/**
 * The non-coding planner output cap stops a degenerate tool call early and
 * gets one fresh generation. Live 2026-10-30: an uncapped calendar create
 * streamed 40,960 tokens in 29s, then failed the turn.
 */
import {
  AgentRuntime,
  ChannelType,
  ElizaError,
  type GenerateTextParams,
  type ModelAttemptContext,
  ModelType,
  type RecordedStage,
  type TrajectoryRecorder,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
  useModelCalls,
} from "../../__tests__/stage1/fixtures.js";
import { runPlannerLoop } from "../planner-loop";

const ANSWER = "Created qa dinner for tomorrow at 5pm.";
const reply = () => ({
  text: "",
  toolCalls: [
    {
      id: "reply",
      name: "REPLY",
      arguments: { text: ANSWER, eliza_turn_scope: "final" },
    },
  ],
});
/** What an adapter throws when generation stops at the requested cap. */
const capped = () =>
  new ElizaError(
    "[openai] Model output did not complete successfully (length).",
    {
      code: "MODEL_OUTPUT_INCOMPLETE",
      context: { finishReason: "length", maxTokens: 8192 },
    },
  );

/** A remote registration with no declared output limit (live: Cerebras). */
const REMOTE: ModelAttemptContext = {
  modelType: ModelType.ACTION_PLANNER,
  provider: "openai",
};

async function run(
  outputs: Array<ReturnType<typeof reply> | Error>,
  options: {
    codingMode?: boolean;
    replyOnly?: boolean;
    /** Resolved registration; null models a runtime that never prepares attempts. */
    attempt?: ModelAttemptContext | null;
    settings?: Record<string, string>;
    /** A cap the runtime merged from model settings before preparation. */
    modelSettingsMaxTokens?: number;
  } = {},
) {
  const requests: Array<{ maxTokens?: number; omitted: boolean }> = [];
  const inputs: string[] = [];
  const stages: RecordedStage[] = [];
  const recorder: TrajectoryRecorder = {
    startTrajectory: () => "planner-output-cap",
    recordStage: async (_id, stage) => {
      stages.push(stage);
    },
    endTrajectory: async () => {},
    load: async () => null,
    list: async () => [],
  };
  const reportError = vi.fn();
  const execute = vi.fn(async () => ({ success: true, text: "Created." }));
  const result = runPlannerLoop({
    runtime: {
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        // Like the runtime: merge model settings into a handler-owned copy,
        // prepare it for the resolved registration, then drop the hook.
        const { prepareModelAttempt, ...rest } = params as {
          prepareModelAttempt?: GenerateTextParams["prepareModelAttempt"];
        } & Record<string, unknown>;
        const request: Record<string, unknown> = {
          ...(options.modelSettingsMaxTokens === undefined
            ? {}
            : { maxTokens: options.modelSettingsMaxTokens }),
          ...rest,
        };
        if (options.attempt !== null)
          await prepareModelAttempt?.(options.attempt ?? REMOTE, request);
        requests.push({
          maxTokens: request.maxTokens as number | undefined,
          omitted: !("maxTokens" in request),
        });
        inputs.push(
          JSON.stringify({ messages: request.messages, tools: request.tools }),
        );
        const output = outputs.shift();
        if (!output) throw new Error("Unexpected planner call");
        if (output instanceof Error) throw output;
        return output;
      },
      getSetting: (key: string) => options.settings?.[key] ?? null,
      reportError,
    },
    context: { id: "planner-output-cap", events: [] },
    ...(options.codingMode ? { codingMode: true } : {}),
    ...(options.replyOnly
      ? {
          postToolReplySeed: {
            toolCall: { name: "CALENDAR_CREATE_EVENT" },
            result: {
              success: true,
              modelReplyRequired: true,
              text: "The event was created.",
            },
          },
        }
      : {
          tools: [
            {
              name: "CALENDAR_CREATE_EVENT",
              description: "Create a calendar event.",
              parameters: { type: "object", properties: {} },
            },
          ],
        }),
    executeToolCall: execute,
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "The event exists.",
      messageToUser: ANSWER,
    }),
    recorder,
    trajectoryId: "planner-output-cap",
  });
  return { result, requests, inputs, stages, reportError };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("non-coding planner output cap", () => {
  it("sends 8192 max tokens by default and lets the env override win", async () => {
    const byDefault = await run([reply()]);
    await byDefault.result;
    expect(byDefault.requests).toEqual([{ maxTokens: 8192, omitted: false }]);

    vi.stubEnv("ELIZA_PLANNER_MAX_TOKENS", "2048");
    const overridden = await run([reply()]);
    await overridden.result;
    expect(overridden.requests).toEqual([{ maxTokens: 2048, omitted: false }]);
  });

  it("retries a capped generation once with the same request and completes the step", async () => {
    const { result, requests, inputs, stages, reportError } = await run([
      capped(),
      reply(),
    ]);
    expect((await result).finalMessage).toBe(ANSWER);
    expect(requests).toHaveLength(2);
    expect(inputs[1]).toBe(inputs[0]);
    const planner = stages.filter((stage) => stage.kind === "planner");
    expect(planner.map((stage) => stage.retryIdx)).toEqual([undefined, 1]);
    expect(planner.map((stage) => stage.model?.finishReason)).toEqual([
      "error",
      undefined,
    ]);
    expect(new Set(planner.map((stage) => stage.stageId)).size).toBe(2);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("fails closed through the existing error path after a second capped generation", async () => {
    const second = capped();
    const { result, requests, stages } = await run([capped(), second, reply()]);
    await expect(result).rejects.toBe(second);
    expect(requests).toHaveLength(2);
    expect(
      stages
        .filter((stage) => stage.kind === "planner")
        .map((stage) => stage.retryIdx),
    ).toEqual([undefined, 1]);
  });
});

describe("default cap by resolved registration", () => {
  it("lowers the default to a registered output limit and still retries at it", async () => {
    const { result, requests } = await run([capped(), reply()], {
      attempt: { ...REMOTE, metadata: { maxOutputTokens: 4096 } },
    });
    expect((await result).finalMessage).toBe(ANSWER);
    expect(requests).toEqual([
      { maxTokens: 4096, omitted: false },
      { maxTokens: 4096, omitted: false },
    ]);
  });

  it.each<[string, ModelAttemptContext]>([
    [
      "AOSP reached through the TEXT_SMALL fallback",
      { modelType: ModelType.TEXT_SMALL, provider: "eliza-aosp-llama" },
    ],
    [
      "AOSP local-first cloud fallback",
      {
        modelType: ModelType.TEXT_SMALL,
        provider: "eliza-aosp-llama-cloud-fallback",
      },
    ],
    [
      "capacitor bridge and iOS on-device",
      { modelType: ModelType.TEXT_SMALL, provider: "capacitor-llama" },
    ],
    [
      "local inference loader",
      { modelType: ModelType.TEXT_SMALL, provider: "eliza-local-inference" },
    ],
    [
      "eliza-router, which can front local inference",
      { modelType: ModelType.TEXT_SMALL, provider: "eliza-router" },
    ],
    [
      "a registration that declares local inference",
      {
        modelType: ModelType.ACTION_PLANNER,
        provider: "custom",
        metadata: { local: true, maxOutputTokens: 4096 },
      },
    ],
  ])(
    "sends %s the previous omitted-cap request and never retries it",
    async (_lane, attempt) => {
      const ok = await run([reply()], { attempt });
      await ok.result;
      expect(ok.requests).toEqual([{ maxTokens: undefined, omitted: true }]);

      const failure = capped();
      const stopped = await run([failure, reply()], { attempt });
      await expect(stopped.result).rejects.toBe(failure);
      expect(stopped.requests).toHaveLength(1);
    },
  );

  it("sends the env override to on-device registrations too", async () => {
    vi.stubEnv("ELIZA_PLANNER_MAX_TOKENS", "2048");
    const { result, requests } = await run([reply()], {
      attempt: {
        modelType: ModelType.TEXT_SMALL,
        provider: "eliza-aosp-llama",
      },
    });
    await result;
    expect(requests).toEqual([{ maxTokens: 2048, omitted: false }]);
  });

  it("leaves a cap merged from model settings alone and does not retry it", async () => {
    const failure = capped();
    const { result, requests } = await run([failure, reply()], {
      modelSettingsMaxTokens: 3000,
    });
    await expect(result).rejects.toBe(failure);
    expect(requests).toEqual([{ maxTokens: 3000, omitted: false }]);
  });

  it("sends the previous uncapped request when the runtime does not prepare attempts", async () => {
    const { result, requests } = await run([reply()], { attempt: null });
    await result;
    expect(requests).toEqual([{ maxTokens: undefined, omitted: true }]);
  });
});

describe("default cap with Anthropic extended thinking", () => {
  const anthropic: ModelAttemptContext = {
    modelType: ModelType.ACTION_PLANNER,
    provider: "anthropic",
  };

  // The AI SDK adds a fixed thinking budget on top of max_tokens on the wire
  // (plugin-anthropic planner-output-cap.wire.test.ts), so it keeps the default.
  it.each<[string, Record<string, string>]>([
    ["no thinking", {}],
    ["a shared thinking budget", { ANTHROPIC_COT_BUDGET: "10000" }],
    ["a large-model thinking budget", { ANTHROPIC_COT_BUDGET_LARGE: "16000" }],
  ])("sends 8192 with %s", async (_label, settings) => {
    const { result, requests } = await run([reply()], {
      attempt: anthropic,
      settings,
    });
    await result;
    expect(requests).toEqual([{ maxTokens: 8192, omitted: false }]);
  });

  it.each<[string, Record<string, string>]>([
    ["a shared effort", { ANTHROPIC_EFFORT: "medium" }],
    ["a large-model effort", { ANTHROPIC_EFFORT_LARGE: "high" }],
  ])(
    "omits the default with adaptive thinking from %s",
    async (_label, settings) => {
      const { result, requests } = await run([reply()], {
        attempt: anthropic,
        settings,
      });
      await result;
      expect(requests).toEqual([{ maxTokens: undefined, omitted: true }]);
    },
  );

  it("reads the effort from the process environment", async () => {
    vi.stubEnv("ANTHROPIC_EFFORT_SMALL", "low");
    const { result, requests } = await run([reply()], { attempt: anthropic });
    await result;
    expect(requests).toEqual([{ maxTokens: undefined, omitted: true }]);
  });

  it("still sends the env override with adaptive thinking", async () => {
    vi.stubEnv("ELIZA_PLANNER_MAX_TOKENS", "20000");
    const { result, requests } = await run([reply()], {
      attempt: anthropic,
      settings: { ANTHROPIC_EFFORT: "high" },
    });
    await result;
    expect(requests).toEqual([{ maxTokens: 20000, omitted: false }]);
  });
});

describe("default cap through AgentRuntime model dispatch", () => {
  const runtimes: AgentRuntime[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.stop();
  });

  /** Plan one turn on a real runtime and return what each handler received. */
  async function plan(
    registrations: Array<{
      modelType: string;
      provider: string;
      fail?: Error;
    }>,
  ) {
    const runtime = new AgentRuntime({
      character: { name: "planner-output-cap", bio: [] },
      logLevel: "fatal",
    });
    runtime.registerDatabaseAdapter({
      createLogs: async () => undefined,
    } as never);
    runtimes.push(runtime);
    const seen: Array<{
      provider: string;
      maxTokens?: number;
      omitted: boolean;
    }> = [];
    for (const registration of registrations) {
      runtime.registerModel(
        registration.modelType,
        async (_runtime, params) => {
          seen.push({
            provider: registration.provider,
            maxTokens: params.maxTokens as number | undefined,
            omitted: !("maxTokens" in params),
          });
          if (registration.fail) throw registration.fail;
          return reply();
        },
        registration.provider,
        100,
      );
    }
    const result = await runPlannerLoop({
      runtime: {
        useModel: (type, params, provider) =>
          runtime.useModel(type, params as GenerateTextParams, provider),
      },
      context: { id: "planner-output-cap-runtime", events: [] },
      tools: [
        {
          name: "CALENDAR_CREATE_EVENT",
          description: "Create a calendar event.",
          parameters: { type: "object", properties: {} },
        },
      ],
      executeToolCall: async () => ({ success: true, text: "Created." }),
      evaluate: async () => ({
        success: true,
        decision: "FINISH",
        thought: "The event exists.",
        messageToUser: ANSWER,
      }),
    });
    expect(result.finalMessage).toBe(ANSWER);
    return seen;
  }

  it("sends 8192 to a remote ACTION_PLANNER registration", async () => {
    await expect(
      plan([{ modelType: ModelType.ACTION_PLANNER, provider: "openai" }]),
    ).resolves.toEqual([
      { provider: "openai", maxTokens: 8192, omitted: false },
    ]);
  });

  it.each(["eliza-aosp-llama", "capacitor-llama"])(
    "sends the %s TEXT_SMALL fallback the omitted-cap request",
    async (provider) => {
      await expect(
        plan([{ modelType: ModelType.TEXT_SMALL, provider }]),
      ).resolves.toEqual([{ provider, maxTokens: undefined, omitted: true }]);
    },
  );

  it("prepares each failover attempt for its own registration", async () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    await expect(
      plan([
        {
          modelType: ModelType.ACTION_PLANNER,
          provider: "openai",
          fail: refused,
        },
        { modelType: ModelType.TEXT_SMALL, provider: "eliza-aosp-llama" },
      ]),
    ).resolves.toEqual([
      { provider: "openai", maxTokens: 8192, omitted: false },
      { provider: "eliza-aosp-llama", maxTokens: undefined, omitted: true },
    ]);
  });
});

describe("requests outside the non-coding planning cap", () => {
  it("leaves the coding planner uncapped and never retries it", async () => {
    const uncapped = await run([capped(), reply()], { codingMode: true });
    expect((await uncapped.result).terminalFailure?.code).toBe(
      "MODEL_OUTPUT_INCOMPLETE",
    );
    expect(uncapped.requests).toEqual([
      { maxTokens: undefined, omitted: true },
    ]);

    vi.stubEnv("ELIZA_CODING_PLANNER_MAX_TOKENS", "4096");
    const overridden = await run([capped(), reply()], { codingMode: true });
    expect((await overridden.result).terminalFailure?.code).toBe(
      "MODEL_OUTPUT_INCOMPLETE",
    );
    expect(overridden.requests).toEqual([{ maxTokens: 4096, omitted: false }]);
  });

  it("leaves a reply-only synthesis round uncapped", async () => {
    const { result, requests } = await run([reply()], { replyOnly: true });
    await result;
    expect(requests).toEqual([{ maxTokens: undefined, omitted: true }]);
  });

  it("leaves the Stage 1 request uncapped even with the planner override set", async () => {
    vi.stubEnv("ELIZA_PLANNER_MAX_TOKENS", "2048");
    const runtime = makeRuntime([
      stage1Response({
        contexts: ["simple"],
        replyText: "Day 1: Asakusa and Ueno. Day 2: Shibuya. Day 3: Kamakura.",
      }),
    ]);
    await runStage1({
      runtime,
      message: makeMessage({
        text: "plan a 3-day trip to Tokyo",
        channelType: ChannelType.DM,
      }),
    });
    const params = useModelCalls(runtime)[0]?.[1] as {
      maxTokens?: number;
      omitMaxTokens?: boolean;
    };
    expect(params.maxTokens).toBeUndefined();
    expect(params.omitMaxTokens).toBe(true);
  });
});
