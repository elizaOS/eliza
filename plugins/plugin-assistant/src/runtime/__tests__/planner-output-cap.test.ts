/**
 * Planner rounds send no output cap on any provider. A round that stops at the
 * model's own maximum is not re-sent: the identical request would stop there
 * again, so the turn ends after one call. A temporary rate limit still gets its
 * single re-send. The former cap settings are ignored.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
/** What an adapter throws when a call that sent no cap stops at the model's limit. */
const atModelLimit = () =>
  new ElizaError(
    "[cerebras] Model output did not complete successfully (length).",
    {
      code: "MODEL_OUTPUT_INCOMPLETE",
      context: { finishReason: "length", maxTokens: null },
    },
  );
const rateLimited = () =>
  Object.assign(new Error("Too Many Requests"), {
    status: 429,
    retryAfterMs: 1,
  });

/** Every planner cap setting that once applied, set small: each is ignored. */
const REMOVED_CAP_ENV = {
  ELIZA_PLANNER_MAX_TOKENS: "16",
  ELIZA_CODING_PLANNER_MAX_TOKENS: "16",
};
const REMOVED_CAP_SETTINGS = {
  ACTION_PLANNER_MAX_TOKENS: "16",
  TEXT_SMALL_MAX_TOKENS: "16",
  TEXT_LARGE_MAX_TOKENS: "16",
  DEFAULT_MAX_TOKENS: "16",
};

const REMOTE: ModelAttemptContext = {
  modelType: ModelType.ACTION_PLANNER,
  provider: "openai",
};

async function run(
  outputs: Array<ReturnType<typeof reply> | Error>,
  options: {
    codingMode?: boolean;
    replyOnly?: boolean;
    attempt?: ModelAttemptContext;
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
  const evaluate = vi.fn(async () => ({
    success: true,
    decision: "FINISH" as const,
    thought: "The event exists.",
    messageToUser: ANSWER,
  }));
  const result = runPlannerLoop({
    runtime: {
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        // Like the runtime: prepare a handler-owned copy for the resolved
        // registration, then drop the hook.
        const { prepareModelAttempt, ...rest } = params as {
          prepareModelAttempt?: GenerateTextParams["prepareModelAttempt"];
        } & Record<string, unknown>;
        const request: Record<string, unknown> = { ...rest };
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
      getSetting: (key: string) =>
        (REMOVED_CAP_SETTINGS as Record<string, string>)[key] ?? null,
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
    evaluate,
    recorder,
    trajectoryId: "planner-output-cap",
  });
  return { result, requests, inputs, stages, reportError, execute, evaluate };
}

beforeEach(() => {
  for (const [key, value] of Object.entries(REMOVED_CAP_ENV))
    vi.stubEnv(key, value);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const UNCAPPED = { maxTokens: undefined, omitted: true };

describe("planner rounds send no output cap", () => {
  it.each<[string, ModelAttemptContext]>([
    ["a remote registration", REMOTE],
    [
      "a remote registration that declares an output limit",
      { ...REMOTE, metadata: { maxOutputTokens: 4096 } },
    ],
    [
      "Anthropic",
      { modelType: ModelType.ACTION_PLANNER, provider: "anthropic" },
    ],
    [
      "AOSP reached through the TEXT_SMALL fallback",
      { modelType: ModelType.TEXT_SMALL, provider: "eliza-aosp-llama" },
    ],
    [
      "eliza-router",
      { modelType: ModelType.TEXT_SMALL, provider: "eliza-router" },
    ],
  ])("sends %s no cap", async (_lane, attempt) => {
    const { result, requests } = await run([reply()], { attempt });
    expect((await result).finalMessage).toBe(ANSWER);
    expect(requests).toEqual([UNCAPPED]);
  });

  it("sends a reply-only synthesis round no cap", async () => {
    const { result, requests } = await run([reply()], { replyOnly: true });
    await result;
    expect(requests).toEqual([UNCAPPED]);
  });

  it("leaves the Stage 1 request uncapped", async () => {
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

describe("a planning round that stops at the model's maximum", () => {
  it("is not re-sent and ends the turn", async () => {
    const failure = atModelLimit();
    const { result, requests, stages, execute, evaluate } = await run([
      failure,
      reply(),
    ]);
    await expect(result).rejects.toBe(failure);
    expect(requests).toEqual([UNCAPPED]);
    const planner = stages.filter((stage) => stage.kind === "planner");
    expect(planner.map((stage) => stage.retryIdx)).toEqual([undefined]);
    expect(planner.map((stage) => stage.model?.finishReason)).toEqual([
      "error",
    ]);
    expect(execute).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("is not re-sent in coding mode either, which sends no cap", async () => {
    const { result, requests } = await run([atModelLimit(), reply()], {
      codingMode: true,
    });
    expect((await result).terminalFailure?.code).toBe(
      "MODEL_OUTPUT_INCOMPLETE",
    );
    expect(requests).toEqual([UNCAPPED]);
  });
});

describe("rate-limit re-send", () => {
  it("re-sends the identical request once and completes the step", async () => {
    const { result, requests, inputs, stages, reportError } = await run([
      rateLimited(),
      reply(),
    ]);
    expect((await result).finalMessage).toBe(ANSWER);
    expect(requests).toEqual([UNCAPPED, UNCAPPED]);
    expect(inputs[1]).toBe(inputs[0]);
    expect(
      stages
        .filter((stage) => stage.kind === "planner")
        .map((stage) => stage.retryIdx),
    ).toEqual([undefined, 1]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("fails through the existing error path after a second refusal", async () => {
    const second = rateLimited();
    const { result, requests } = await run([rateLimited(), second, reply()]);
    await expect(result).rejects.toBe(second);
    expect(requests).toHaveLength(2);
  });

  it("does not re-send a model-maximum stop that follows a re-send", async () => {
    const stopped = atModelLimit();
    const { result, requests } = await run([rateLimited(), stopped, reply()]);
    await expect(result).rejects.toBe(stopped);
    expect(requests).toHaveLength(2);
  });
});

describe("through AgentRuntime model dispatch", () => {
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
      character: {
        name: "planner-output-cap",
        bio: [],
        settings: REMOVED_CAP_SETTINGS,
      },
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

  it("sends a remote ACTION_PLANNER registration no cap under the former cap settings", async () => {
    await expect(
      plan([{ modelType: ModelType.ACTION_PLANNER, provider: "openai" }]),
    ).resolves.toEqual([
      { provider: "openai", maxTokens: undefined, omitted: true },
    ]);
  });

  it("sends every failover attempt no cap", async () => {
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
        { modelType: ModelType.TEXT_SMALL, provider: "elizaOSCloud" },
      ]),
    ).resolves.toEqual([
      { provider: "openai", maxTokens: undefined, omitted: true },
      { provider: "elizaOSCloud", maxTokens: undefined, omitted: true },
    ]);
  });
});
