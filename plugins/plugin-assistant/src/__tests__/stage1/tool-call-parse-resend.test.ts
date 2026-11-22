/**
 * A provider that cannot parse the model's own tool call answers Stage 1 with
 * a 400 (Cerebras: generation_error / tool_calls / parser_error). The request
 * was accepted, so the turn sends it once more instead of ending with "I hit a
 * snag" (live 2026-11-20: "Take a picture and text mom that I'm here." failed
 * on the Stage 1 call after a history read). Other 400s stay terminal.
 */
import { ChannelType, type State } from "@elizaos/core";
import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";
import { isProviderToolCallParseFailure } from "../../runtime/tool-call-parse-failure.ts";
import {
  makeMessage,
  makeRuntime,
  makeState,
  runStage1,
  stage1Response,
} from "./fixtures.js";

const REPLY = "Hello there.";
const answer = () => stage1Response({ contexts: ["simple"], replyText: REPLY });
const directReply = {
  kind: "direct_reply",
  result: { responseContent: { text: REPLY } },
};

/** The error the AI SDK throws for a 400 with a flat provider body. */
const badRequest = (body: Record<string, unknown> | string) =>
  new APICallError({
    message: "Bad Request",
    url: "https://api.cerebras.ai/v1/chat/completions",
    requestBodyValues: {},
    statusCode: 400,
    responseBody: typeof body === "string" ? body : JSON.stringify(body),
    isRetryable: false,
  });

/** Cerebras's body, as logged on the resident. */
const PARSER_ERROR = {
  message:
    "Failed to generate tool_calls. Exception: Failed to generate tool call but tool_choice = 'required'.",
  type: "generation_error",
  param: "tool_calls",
  code: "parser_error",
  id: "",
  failed_generation: null,
};
const parserError = () => badRequest(PARSER_ERROR);

/** 400s that are the request's own fault: sending it again cannot help. */
const NOT_RESENT: Array<[string, Error]> = [
  [
    "a rejected tool schema",
    badRequest({
      message: "Failed to compile the JSON schema grammar.",
      type: "invalid_request_error",
      param: "tools",
      code: "wrong_api_format",
    }),
  ],
  [
    "a context that is too long",
    badRequest({
      message:
        "Please reduce the length of the messages or completion. Current length is 140000 while limit is 131072",
      type: "invalid_request_error",
      param: "messages",
      code: "context_length_exceeded",
    }),
  ],
  [
    "a parser error on another field",
    badRequest({ ...PARSER_ERROR, param: "response_format" }),
  ],
  ["a 400 without a body", badRequest("")],
  [
    "a 500 with the same body",
    new APICallError({
      message: "Internal Server Error",
      url: "https://api.cerebras.ai/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 500,
      responseBody: JSON.stringify(PARSER_ERROR),
      isRetryable: true,
    }),
  ],
  [
    "the provider message alone",
    Object.assign(new Error(PARSER_ERROR.message), { status: 400 }),
  ],
];

/** What the provider is sent: the parts that make two requests the same. */
const sentRequest = (params: Record<string, unknown>) =>
  JSON.stringify({
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
    maxTokens: params.maxTokens,
    omitMaxTokens: params.omitMaxTokens,
    providerOptions: params.providerOptions,
  });

/** One direct-message turn whose Stage 1 calls take `outputs` in order. */
function turn(
  outputs: unknown[],
  options: {
    state?: State;
    prepare?: (runtime: ReturnType<typeof makeRuntime>) => void;
  } = {},
) {
  const runtime = makeRuntime([]);
  options.prepare?.(runtime);
  const requests: string[] = [];
  runtime.useModel = vi.fn(
    async (_type: unknown, params: Record<string, unknown>) => {
      requests.push(sentRequest(params));
      const output = outputs.shift();
      if (output === undefined) throw new Error("Unexpected Stage 1 call");
      if (output instanceof Error) throw output;
      return output;
    },
  ) as never;
  const outcome = runStage1({
    runtime,
    message: makeMessage({ text: "hi", channelType: ChannelType.DM }),
    ...(options.state ? { state: options.state } : {}),
  }).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { outcome, requests };
}

describe("Stage 1 re-send after a tool call the provider could not parse", () => {
  it("re-sends the same request once and answers the turn", async () => {
    const { outcome, requests } = turn([parserError(), answer()]);
    expect(await outcome).toMatchObject({ value: directReply });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe(requests[0]);
  });

  it("fails as before when the re-sent request fails the same way", async () => {
    const second = parserError();
    const { outcome, requests } = turn([parserError(), second, answer()]);
    expect(await outcome).toEqual({ error: second });
    expect(requests).toHaveLength(2);
  });

  it.each(NOT_RESENT)(
    "fails without a re-send on %s",
    async (_label, failure) => {
      const { outcome, requests } = turn([failure, answer()]);
      expect(await outcome).toEqual({ error: failure });
      expect(requests).toHaveLength(1);
    },
  );

  it("allows one re-send for the whole Stage 1 run, not one for each request", async () => {
    const REFERENCE = "userPersonalityPreferences";
    const state = makeState();
    state.data.providers = {
      [REFERENCE]: {
        text: "Complete character preferences: address the user as Sam.",
        discoveryText: `context_discovery: ${REFERENCE}`,
      },
    };
    const second = parserError();
    const { outcome, requests } = turn(
      [
        parserError(),
        stage1Response({ contextRequests: [REFERENCE], contexts: ["simple"] }),
        second,
        answer(),
      ],
      {
        state,
        prepare: (runtime) => {
          runtime.providers = [
            { name: REFERENCE, cacheStable: true, get: vi.fn() },
          ];
          runtime.composeState = vi.fn(async () => structuredClone(state));
        },
      },
    );
    expect(await outcome).toEqual({ error: second });
    expect(requests).toHaveLength(3);
    expect(requests[1]).toBe(requests[0]);
    expect(requests[2]).not.toBe(requests[1]);
  });
});

describe("isProviderToolCallParseFailure", () => {
  it("reads the provider's fields when the body excerpt is cut short", () => {
    const long = badRequest({
      ...PARSER_ERROR,
      failed_generation: "x".repeat(2_000),
    });
    expect(isProviderToolCallParseFailure(long)).toBe(true);
  });

  it("reads the fields inside an OpenAI error envelope", () => {
    expect(
      isProviderToolCallParseFailure(badRequest({ error: PARSER_ERROR })),
    ).toBe(true);
  });
});
