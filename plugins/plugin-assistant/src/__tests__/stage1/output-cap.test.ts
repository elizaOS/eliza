/**
 * Stage 1 sends no output cap. The former host caps, the
 * ELIZA_STAGE1_MAX_TOKENS environment variable and the merged
 * RESPONSE_HANDLER_MAX_TOKENS / DEFAULT_MAX_TOKENS settings, are ignored. A
 * generation that stops at the model's own maximum gets the cut-off reply.
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

/** Every Stage 1 cap setting that once applied, set small. */
const REMOVED_CAP_SETTINGS = {
  RESPONSE_HANDLER_MAX_TOKENS: "16",
  DEFAULT_MAX_TOKENS: "16",
};

describe("Stage 1 output cap", () => {
  it("sends no cap when the host configures none", async () => {
    const { requests } = await runStage1OnHost({});
    expect(requests).toEqual([{ maxTokens: undefined, omitMaxTokens: true }]);
  });

  it("ignores the former cap settings and environment variable", async () => {
    vi.stubEnv("ELIZA_STAGE1_MAX_TOKENS", "16");
    const { requests, result } = await runStage1OnHost(REMOVED_CAP_SETTINGS);
    expect(requests).toEqual([{ maxTokens: undefined, omitMaxTokens: true }]);
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply")
      expect(result.result.responseContent?.text).toBe("Hello there.");
  });

  it("answers that the reply was cut off when generation stops at the model's limit", async () => {
    const { requests, result } = await runStage1OnHost(REMOVED_CAP_SETTINGS, {
      text: CUT_OFF_TEXT,
      finishReason: "length",
    });
    // No cap was sent: the model's own maximum ended it, so a retry would too.
    expect(requests).toEqual([{ maxTokens: undefined, omitMaxTokens: true }]);
    expect(result.kind).toBe("direct_reply");
    if (result.kind === "direct_reply")
      expect(result.result.responseContent?.text).toBe(
        STAGE1_COMPLETION_LIMIT_REPLY,
      );
  });
});
