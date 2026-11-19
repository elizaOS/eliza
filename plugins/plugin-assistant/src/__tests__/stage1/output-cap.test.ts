/**
 * Stage 1 sends no output cap unless the host configures one. Its request used
 * to override the model settings every other call honours, so a host could not
 * bound it for a provider that reserves the cap, or an upper bound when none is
 * sent, against a rate limit at admission.
 */
import { AgentRuntime, ChannelType, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STAGE1_COMPLETION_LIMIT_REPLY } from "../../services/message/stage1-completion.js";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
} from "./fixtures.js";

const dispatchers: AgentRuntime[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispatcher of dispatchers.splice(0)) await dispatcher.stop();
});

/**
 * Run one Stage 1 turn through real model dispatch on a host with `settings`
 * and return what the provider handler received.
 */
async function runStage1OnHost(
  settings: Record<string, string>,
  response: unknown = stage1Response({
    contexts: ["simple"],
    replyText: "Hello there.",
  }),
) {
  const dispatcher = new AgentRuntime({
    character: { name: "stage1-output-cap", bio: [], settings },
    logLevel: "fatal",
  });
  dispatcher.registerDatabaseAdapter({
    createLogs: async () => undefined,
  } as never);
  dispatchers.push(dispatcher);
  const requests: Array<{ maxTokens?: number; omitMaxTokens?: boolean }> = [];
  dispatcher.registerModel(
    ModelType.RESPONSE_HANDLER,
    async (_runtime, params) => {
      requests.push({
        maxTokens: params.maxTokens as number | undefined,
        omitMaxTokens: params.omitMaxTokens as boolean | undefined,
      });
      return response as never;
    },
    "openai",
    100,
  );
  // Stage 1 never reads the cap setting itself: only the dispatcher has it.
  const runtime = makeRuntime([]);
  runtime.useModel = dispatcher.useModel.bind(dispatcher);
  const result = await runStage1({
    runtime,
    message: makeMessage({ text: "hi", channelType: ChannelType.DM }),
  });
  return { requests, result };
}

/** An envelope that stops inside replyText. */
const CUT_OFF_TEXT =
  '{"shouldRespond":"RESPOND","contexts":["simple"],"replyText":"Day 1: Asakusa and';

describe("Stage 1 output cap", () => {
  it("sends no cap when the host configures none", async () => {
    const { requests } = await runStage1OnHost({});
    expect(requests).toEqual([{ maxTokens: undefined, omitMaxTokens: true }]);
  });

  it.each(["RESPONSE_HANDLER_MAX_TOKENS", "DEFAULT_MAX_TOKENS"])(
    "sends the host's %s as the cap",
    async (setting) => {
      const { requests } = await runStage1OnHost({ [setting]: "2048" });
      expect(requests).toEqual([{ maxTokens: 2048, omitMaxTokens: false }]);
    },
  );

  // A phone's host can set an environment variable but not a runtime setting.
  it("sends the cap the host's environment sets, over a setting", async () => {
    vi.stubEnv("ELIZA_STAGE1_MAX_TOKENS", "4096");
    expect((await runStage1OnHost({})).requests).toEqual([
      { maxTokens: 4096, omitMaxTokens: false },
    ]);
    expect(
      (await runStage1OnHost({ RESPONSE_HANDLER_MAX_TOKENS: "2048" })).requests,
    ).toEqual([{ maxTokens: 4096, omitMaxTokens: false }]);
    const { result } = await runStage1OnHost(
      {},
      { text: CUT_OFF_TEXT, finishReason: "length" },
    );
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply")
      expect(result.result.responseContent?.text).toBe(
        STAGE1_COMPLETION_LIMIT_REPLY,
      );
    vi.stubEnv("ELIZA_STAGE1_MAX_TOKENS", " ");
    expect((await runStage1OnHost({})).requests).toEqual([
      { maxTokens: undefined, omitMaxTokens: true },
    ]);
    vi.stubEnv("ELIZA_STAGE1_MAX_TOKENS", "lots");
    await expect(runStage1OnHost({})).rejects.toThrow(
      'ELIZA_STAGE1_MAX_TOKENS must be a positive integer, got "lots"',
    );
  });

  it.each([
    [
      "reports using the whole cap",
      {
        text: CUT_OFF_TEXT,
        usage: { promptTokens: 100, completionTokens: 2048, totalTokens: 2148 },
      },
    ],
    // The runtime rejects this result instead of returning it to Stage 1.
    [
      "reports stopping at its length limit",
      { text: CUT_OFF_TEXT, finishReason: "length" },
    ],
  ])(
    "answers that the reply was cut off when a capped generation %s",
    async (_label, response) => {
      const { requests, result } = await runStage1OnHost(
        { RESPONSE_HANDLER_MAX_TOKENS: "2048" },
        response,
      );
      // One call: the same cap would cut a retry off at the same place.
      expect(requests).toHaveLength(1);
      expect(result.kind).toBe("direct_reply");
      if (result.kind === "direct_reply")
        expect(result.result.responseContent?.text).toBe(
          STAGE1_COMPLETION_LIMIT_REPLY,
        );
    },
  );

  it("keeps failing the turn when an uncapped generation stops at the provider's limit", async () => {
    await expect(
      runStage1OnHost({}, { text: CUT_OFF_TEXT, finishReason: "length" }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
  });
});
