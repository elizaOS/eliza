/**
 * A provider 400 reaches core through the Cloud as it does on a direct route:
 * status 400 and a provider-shaped `responseBody`. Stage 1 then re-sends a
 * request once after Cerebras could not parse the model's own tool call
 * (`parser_error` on `tool_calls`), on this route as on the direct one. Before,
 * the gateway sent only "Bad Request" and this provider kept no body, so the
 * turn ended instead. The gateway's shapes below are the ones
 * packages/cloud/api/v1/chat/completions/route.ts writes, as an HTTP body or
 * as an error frame inside a 200 stream.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AgentRuntime,
  ChannelType,
  isInsufficientCreditsError,
  isModelProviderFallbackError,
  isPermanentQuotaError,
  isProviderContextOverflowError,
  isRateLimitError,
  ModelType,
  modelProviderErrorDetail,
  type TextStreamResult,
} from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
  stage1Response,
} from "../../plugin-assistant/src/__tests__/stage1/fixtures";
import { rateLimitRetryWaitMs } from "../../plugin-assistant/src/runtime/evaluator";
import { isProviderToolCallParseFailure } from "../../plugin-assistant/src/runtime/tool-call-parse-failure";
import {
  handleActionPlanner,
  handleResponseHandler,
  handleTextLarge,
  handleTextMedium,
  handleTextMega,
  handleTextNano,
  handleTextSmall,
} from "../src/models/text";

/** One gateway answer: an HTTP error body, an error frame in a 200 stream, or a completion. */
type Answer =
  | { status: number; body: Record<string, unknown> }
  | { frame: Record<string, unknown> }
  | { completion: Record<string, unknown> };

let server: Server;
let baseUrl: string;
/** The model type header and body of each upload, in order. */
let uploads: Array<{ modelType: string; body: string }> = [];
let answers: Answer[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      uploads.push({
        modelType: String(req.headers["x-eliza-model-type"]),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const answer = answers.shift();
      if (!answer) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Unexpected upload" } }));
      } else if ("frame" in answer) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(answer.frame)}\n\n`);
        res.end("data: [DONE]\n\n");
      } else if ("completion" in answer) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.completion));
      } else {
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  uploads = [];
  answers = [];
});

/** Cerebras's message for a tool call it could not parse (resident log, November 2026). */
const PARSER_MESSAGE =
  "Failed to generate tool_calls. Exception: Failed to generate tool call but tool_choice = 'required'.";

/** The gateway's 400 for a flat provider body: the provider's fields, its own message. */
function gatewayBody(fields: Record<string, unknown>): Answer {
  const { code, param, message, ...rest } = fields;
  return {
    status: 400,
    body: {
      error: {
        code,
        param,
        message: "Bad Request",
        type: "invalid_request_error",
        provider_message: message,
        ...rest,
      },
    },
  };
}
/** The same 400 as the terminal frame of a stream that already answered 200. */
function gatewayFrame(fields: Record<string, unknown>): Answer {
  const { code, param, message, ...rest } = fields;
  return {
    frame: {
      error: {
        provider_code: code,
        param,
        message: "Bad Request",
        type: "invalid_request_error",
        code: 400,
        provider_message: message,
        ...rest,
      },
    },
  };
}
const PARSER_ERROR = { code: "parser_error", param: "tool_calls", message: PARSER_MESSAGE };

/** The seven text registrations of this provider, as its plugin registers them. */
const CLOUD_TEXT_HANDLERS = [
  [ModelType.TEXT_NANO, handleTextNano],
  [ModelType.TEXT_SMALL, handleTextSmall],
  [ModelType.TEXT_MEDIUM, handleTextMedium],
  [ModelType.TEXT_LARGE, handleTextLarge],
  [ModelType.TEXT_MEGA, handleTextMega],
  [ModelType.RESPONSE_HANDLER, handleResponseHandler],
  [ModelType.ACTION_PLANNER, handleActionPlanner],
] as const;

/** A runtime with every Cloud text slot on the plugin's one default model, as on a phone. */
function agent(): AgentRuntime {
  const runtime = new AgentRuntime({
    character: {
      name: "Cloud 400 test",
      bio: [],
      settings: {
        secrets: { ELIZAOS_CLOUD_API_KEY: "synthetic-test-key" },
        ELIZAOS_CLOUD_BASE_URL: baseUrl,
      },
    },
    logLevel: "fatal",
    adapter: { createLogs: async () => undefined },
  } as never);
  for (const [type, handler] of CLOUD_TEXT_HANDLERS)
    runtime.registerModel(type, handler as never, "elizaOSCloud", 50);
  return runtime;
}

/**
 * A parser error whose long message comes first on the wire, as another
 * gateway or an enveloped provider body may send it.
 */
const LONG_MESSAGE = "Failed to generate tool_calls. ".repeat(80);
const LONG_BODY: Answer = {
  status: 400,
  body: {
    error: {
      message: LONG_MESSAGE,
      type: "invalid_request_error",
      code: "parser_error",
      param: "tool_calls",
    },
  },
};
const LONG_FRAME: Answer = {
  frame: {
    error: {
      message: LONG_MESSAGE,
      type: "invalid_request_error",
      code: 400,
      provider_code: "parser_error",
      param: "tool_calls",
    },
  },
};

const STAGE1 = { prompt: "Say hi", messages: [{ role: "user" as const, content: "Say hi" }] };
const STREAMED = { stream: true, streamStructured: true, onStreamChunk: () => undefined };
const PATHS = [
  ["an HTTP body", gatewayBody, LONG_BODY, STAGE1],
  ["a stream frame", gatewayFrame, LONG_FRAME, { ...STAGE1, ...STREAMED }],
] as const;

async function failed(run: () => Promise<unknown>): Promise<unknown> {
  try {
    const result = await run();
    if (result && typeof result === "object" && "textStream" in result) {
      for await (const _chunk of (result as TextStreamResult).textStream) {
        // drain
      }
    }
  } catch (error) {
    return error;
  }
  throw new Error("Cloud call completed without the provider error");
}

describe.each(PATHS)("a provider 400 through the Cloud as %s", (_label, shape, long, call) => {
  const stage1Error = (answer: Answer) => {
    answers = [answer];
    return failed(() => agent().useModel(ModelType.RESPONSE_HANDLER, call as never));
  };

  it("is a tool call the provider could not parse, uploaded once", async () => {
    const error = await stage1Error(shape(PARSER_ERROR));
    expect(uploads.map((upload) => upload.modelType)).toEqual(["RESPONSE_HANDLER"]);
    expect((error as { status?: number }).status).toBe(400);
    // Still the gateway's own: classifiers that read only the message see
    // what they saw before.
    expect((error as Error).message).toBe("Bad Request");
    expect(isProviderToolCallParseFailure(error)).toBe(true);
    const detail = modelProviderErrorDetail(error);
    expect(detail).toMatchObject({ status: 400, providerMessage: PARSER_MESSAGE });
    expect(detail?.responseBodyExcerpt).toMatch(
      /^\{"error":\{"code":"parser_error","param":"tool_calls","message":/
    );
  });

  it("keeps the fields inside core's excerpt when a long message comes first", async () => {
    const error = await stage1Error(long);
    expect(modelProviderErrorDetail(error)?.responseBodyExcerpt).toHaveLength(400);
    expect(isProviderToolCallParseFailure(error)).toBe(true);
  });

  it.each([
    ["today's gateway message alone", { message: undefined }],
    ["a parser error on another field", { ...PARSER_ERROR, param: "response_format" }],
    ["a parser error with no param", { ...PARSER_ERROR, param: undefined }],
  ])("is not a parse failure for %s", async (_case, fields) => {
    const error = await stage1Error(shape(fields));
    expect((error as { status?: number }).status).toBe(400);
    expect(isProviderToolCallParseFailure(error)).toBe(false);
  });

  it("is a context overflow when the provider says the request is too long", async () => {
    const error = await stage1Error(
      shape({
        code: "context_length_exceeded",
        param: "messages",
        message:
          "Please reduce the length of the messages or completion. Current length is 140000 while limit is 131072",
      })
    );
    expect(isProviderToolCallParseFailure(error)).toBe(false);
    expect(isProviderContextOverflowError(error)).toBe(true);
  });

  it("leaves a provider message about load or credit to the classifiers that read the message", async () => {
    const error = await stage1Error(
      shape({ message: "Model overloaded: insufficient_quota, quota exceeded, out of credits" })
    );
    // Not fallback-class: not sent again through the sibling slots.
    expect(uploads.map((upload) => upload.modelType)).toEqual(["RESPONSE_HANDLER"]);
    expect(isModelProviderFallbackError(error, ModelType.RESPONSE_HANDLER)).toBe(false);
    expect(isRateLimitError(error)).toBe(false);
    expect(isInsufficientCreditsError(error)).toBe(false);
    expect(isPermanentQuotaError(error)).toBe(false);
    expect(rateLimitRetryWaitMs(error)).toBeUndefined();
  });
});

describe.each(PATHS)("Stage 1 on the Cloud route, the 400 as %s", (_label, shape, long, call) => {
  const REPLY = "Hello there.";
  const { arguments: handleResponse } = stage1Response({
    contexts: ["simple"],
    replyText: REPLY,
  }).toolCalls[0];
  const completion: Answer = {
    completion: {
      id: "chatcmpl-cloud-400",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-handle-response",
                type: "function",
                function: { name: "HANDLE_RESPONSE", arguments: JSON.stringify(handleResponse) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    },
  };

  /** One direct-message turn whose Stage 1 requests go through the Cloud runtime. */
  async function turn() {
    const cloud = agent();
    const runtime = makeRuntime([]);
    runtime.useModel = ((type: never, params: Record<string, unknown>) =>
      cloud.useModel(type, { ...params, ...("stream" in call ? STREAMED : {}) } as never)) as never;
    return runStage1({
      runtime,
      message: makeMessage({ text: "hi", channelType: ChannelType.DM }),
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
  }

  it("re-sends the same request once and answers the turn", async () => {
    answers = [shape(PARSER_ERROR), completion];
    expect(await turn()).toMatchObject({
      value: { kind: "direct_reply", result: { responseContent: { text: REPLY } } },
    });
    expect(uploads.map((upload) => upload.modelType)).toEqual([
      "RESPONSE_HANDLER",
      "RESPONSE_HANDLER",
    ]);
    expect(uploads[1]?.body).toBe(uploads[0]?.body);
  });

  it.each([
    ["a long provider message", shape({ ...PARSER_ERROR, message: "x".repeat(2_000) })],
    ["a long message ahead of the fields", long],
  ])("re-sends after %s too", async (_case, failure) => {
    answers = [failure, completion];
    expect(await turn()).toMatchObject({ value: { kind: "direct_reply" } });
    expect(uploads).toHaveLength(2);
  });

  it("ends the turn without a re-send on today's gateway message alone", async () => {
    answers = [shape({ message: undefined }), completion];
    const outcome = await turn();
    expect(outcome).toHaveProperty("error");
    expect(uploads).toHaveLength(1);
  });

  it("ends the turn when the re-sent request fails the same way", async () => {
    answers = [shape(PARSER_ERROR), shape(PARSER_ERROR), completion];
    const outcome = await turn();
    expect(isProviderToolCallParseFailure((outcome as { error?: unknown }).error)).toBe(true);
    expect(uploads).toHaveLength(2);
  });
});
