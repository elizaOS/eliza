/**
 * The non-coding planner output cap stops a degenerate tool call early and
 * gets one fresh generation. Live 2026-10-30: an uncapped calendar create
 * streamed 40,960 tokens in 29s, then failed the turn.
 */
import {
  ChannelType,
  ElizaError,
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

async function run(
  outputs: Array<ReturnType<typeof reply> | Error>,
  options: { codingMode?: boolean; replyOnly?: boolean } = {},
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
        requests.push({
          maxTokens: params.maxTokens as number | undefined,
          omitted: !("maxTokens" in params),
        });
        inputs.push(
          JSON.stringify({ messages: params.messages, tools: params.tools }),
        );
        const output = outputs.shift();
        if (!output) throw new Error("Unexpected planner call");
        if (output instanceof Error) throw output;
        return output;
      },
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
