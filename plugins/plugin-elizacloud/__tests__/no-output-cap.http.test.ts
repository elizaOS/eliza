/**
 * No call of a turn sends the Cloud gateway an output cap, through the
 * runtime's model dispatch, the real Cloud handlers and HTTP client against a
 * loopback gateway: a planner round, Stage 1, the evaluator and side calls (the
 * SMS reply draft and an image description). The gateway forwards a cap only
 * when the request carries one, so an omitted cap leaves the model's own
 * maximum in place. Every removed cap variable and setting is set to a small
 * value and must be ignored. A planner round that stops at the model's own
 * maximum is not re-sent.
 */
import { createServer, type Server } from "node:http";
import { AgentRuntime, ChannelType, type IAgentRuntime, ModelType } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
} from "../../plugin-assistant/src/__tests__/stage1/fixtures.ts";
import { runEvaluator } from "../../plugin-assistant/src/runtime/evaluator.ts";
import { runPlannerLoop } from "../../plugin-assistant/src/runtime/planner-loop.ts";
import { handleReplyDraft } from "../../plugin-native-phone/src/routes/reply-draft-route.ts";
import { handleImageDescription } from "../src/models/image";
import { handleActionPlanner, handleResponseHandler, handleTextSmall } from "../src/models/text";

type WireTool = { function?: { name?: string; parameters?: { properties?: object } } };
type WireBody = Record<string, unknown> & {
  model?: string;
  stream?: boolean;
  tools?: WireTool[];
  messages?: Array<{ content?: unknown }>;
  input?: unknown;
  response_format?: {
    type?: string;
    json_schema?: { schema?: { properties?: Record<string, unknown> } };
  };
};

const ANSWER = "Created qa dinner.";
const DIRECT_REPLY = "Hello there.";
const DRAFT = "Thursday works for me.";
const VERDICT = { thought: "The event exists.", success: true, decision: "FINISH" };

/** Every cap variable that once applied, set small. */
const REMOVED_CAP_ENV = {
  ELIZA_PLANNER_MAX_TOKENS: "16",
  ELIZA_CODING_PLANNER_MAX_TOKENS: "16",
  ELIZA_STAGE1_MAX_TOKENS: "16",
  ELIZA_EVALUATOR_MAX_TOKENS: "16",
  ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS: "16",
  TEXT_SMALL_MAX_TOKENS: "16",
  RESPONSE_HANDLER_MAX_TOKENS: "16",
  ACTION_PLANNER_MAX_TOKENS: "16",
};
/** Every cap setting the runtime or this plugin once read, set small. */
const REMOVED_CAP_SETTINGS = {
  ACTION_PLANNER_MAX_TOKENS: "16",
  RESPONSE_HANDLER_MAX_TOKENS: "16",
  TEXT_SMALL_MAX_TOKENS: "16",
  TEXT_LARGE_MAX_TOKENS: "16",
  IMAGE_DESCRIPTION_MAX_TOKENS: "16",
  DEFAULT_MAX_TOKENS: "16",
  ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MAX_TOKENS: "16",
};

const requests: Array<{ path: string; body: WireBody }> = [];
let plannerFinishes: Array<"length" | "tool_calls"> = [];
let baseUrl: string;
let server: Server;

function stage1Decision(tool: WireTool): Record<string, unknown> {
  const direct: Record<string, unknown> = {
    shouldRespond: "RESPOND",
    contexts: ["simple"],
    replyEffectStatus: "none",
    replyText: DIRECT_REPLY,
    emotion: "none",
  };
  return Object.fromEntries(
    Object.keys(tool.function?.parameters?.properties ?? {}).map((field) => [
      field,
      direct[field] ?? [],
    ])
  );
}

const isImageRequest = (body: WireBody) =>
  JSON.stringify(body.messages ?? []).includes('"image_url"');

function respond(body: WireBody): {
  toolCall?: { id: string; type: "function"; function: { name: string; arguments: string } };
  content?: string;
  finish: string;
} {
  const tools = body.tools ?? [];
  const handleResponse = tools.find((tool) => tool.function?.name === "HANDLE_RESPONSE");
  if (handleResponse)
    return {
      toolCall: {
        id: "call_handle_response",
        type: "function",
        function: {
          name: "HANDLE_RESPONSE",
          arguments: JSON.stringify(stage1Decision(handleResponse)),
        },
      },
      finish: "tool_calls",
    };
  if (tools.some((tool) => tool.function?.name === "CALENDAR_CREATE_EVENT")) {
    const finish = plannerFinishes.shift() ?? "tool_calls";
    return {
      toolCall:
        finish === "length"
          ? {
              id: "call_create",
              type: "function",
              function: {
                name: "CALENDAR_CREATE_EVENT",
                arguments: '{"title":"qa dinner","attendees":[{"email":""},{"email":""',
              },
            }
          : {
              id: "call_reply",
              type: "function",
              function: {
                name: "REPLY",
                arguments: JSON.stringify({ text: ANSWER, eliza_turn_scope: "final" }),
              },
            },
      finish,
    };
  }
  if (isImageRequest(body))
    return {
      content: JSON.stringify({ title: "Square", description: "A green square." }),
      finish: "stop",
    };
  if (JSON.stringify(body.messages ?? []).includes("<thread>"))
    return { content: DRAFT, finish: "stop" };
  // The evaluator: its schema travels as a response format or in the prompt.
  const properties = body.response_format?.json_schema?.schema?.properties;
  return {
    content: JSON.stringify(properties?.__eliza_response ? { __eliza_response: VERDICT } : VERDICT),
    finish: "stop",
  };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      requests.push({ path, body });
      if (path.endsWith("/responses")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ output_text: DRAFT }));
        return;
      }
      const { toolCall, content, finish } = respond(body);
      const base = { id: `chatcmpl-${requests.length}`, created: 0, model: body.model };
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const choice of [
          {
            delta: toolCall
              ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }
              : { role: "assistant", content },
          },
          { delta: {}, finish_reason: finish },
        ]) {
          response.write(
            `data: ${JSON.stringify({
              ...base,
              object: "chat.completion.chunk",
              choices: [{ index: 0, finish_reason: null, ...choice }],
              ...("finish_reason" in choice ? { usage } : {}),
            })}\n\n`
          );
        }
        response.end("data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: content ?? null,
                ...(toolCall ? { tool_calls: [toolCall] } : {}),
              },
              finish_reason: finish,
            },
          ],
          usage,
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

const settings: Record<string, string> = {};
const host = {
  character: { name: "Cloud cap test", bio: [] },
  getSetting: (key: string) => settings[key],
  emitEvent: vi.fn(async () => {}),
} as unknown as IAgentRuntime;

beforeEach(() => {
  requests.length = 0;
  plannerFinishes = [];
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(settings, REMOVED_CAP_SETTINGS, {
    ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
    ELIZAOS_CLOUD_BASE_URL: baseUrl,
    ELIZAOS_CLOUD_ACTION_PLANNER_MODEL: "qwen-3.8-27b",
    ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "qwen-3.8-27b",
    ELIZAOS_CLOUD_SMALL_MODEL: "qwen-3.8-27b",
    ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL: "qwen-3.8-27b",
  });
  for (const [key, value] of Object.entries(REMOVED_CAP_ENV)) vi.stubEnv(key, value);
});

afterEach(() => vi.unstubAllEnvs());

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

/** A runtime whose text models are the Cloud handlers, under the former cap settings. */
function dispatcher(errors: unknown[] = []): AgentRuntime {
  const runtime = new AgentRuntime({
    character: { name: "Cloud cap test", bio: [], settings: REMOVED_CAP_SETTINGS },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter({ createLogs: async () => undefined } as never);
  runtimes.push(runtime);
  for (const [modelType, handler] of [
    [ModelType.ACTION_PLANNER, handleActionPlanner],
    [ModelType.RESPONSE_HANDLER, handleResponseHandler],
    [ModelType.TEXT_SMALL, handleTextSmall],
  ] as const) {
    runtime.registerModel(
      modelType,
      async (_runtime, params) => {
        try {
          return (await handler(host, params as never)) as never;
        } catch (error) {
          errors.push(error);
          throw error;
        }
      },
      "elizaOSCloud"
    );
  }
  return runtime;
}

function plan(runtime: AgentRuntime) {
  return runPlannerLoop({
    runtime: {
      useModel: (type, params, provider) => runtime.useModel(type, params as never, provider),
    },
    context: { id: "no-output-cap-cloud", events: [] },
    tools: [
      {
        name: "CALENDAR_CREATE_EVENT",
        description: "Create a calendar event.",
        parameters: { type: "object", properties: { title: { type: "string" } } },
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
}

const sentNoCap = (body: WireBody) => {
  expect(body).not.toHaveProperty("max_tokens");
  expect(body).not.toHaveProperty("max_completion_tokens");
  expect(body).not.toHaveProperty("max_output_tokens");
};

it("sends the gateway no output cap from a planner round, Stage 1, the evaluator or a side call", async () => {
  const runtime = dispatcher();

  expect((await plan(runtime)).finalMessage).toBe(ANSWER);
  expect(requests).toHaveLength(1);

  const stage1Host = makeRuntime([]);
  stage1Host.useModel = runtime.useModel.bind(runtime);
  const stage1 = await runStage1({
    runtime: stage1Host,
    message: makeMessage({ text: "hi", channelType: ChannelType.DM }),
  });
  expect(stage1.kind).toBe("direct_reply");
  if (stage1.kind === "direct_reply")
    expect(stage1.result.responseContent?.text).toBe(DIRECT_REPLY);
  expect(requests).toHaveLength(2);

  const context = { id: "no-output-cap-cloud-evaluator", events: [] };
  const verdict = await runEvaluator({
    runtime: {
      getSetting: (key: string) => settings[key] ?? null,
      useModel: (type, params, provider) => runtime.useModel(type, params as never, provider),
    },
    context,
    trajectory: { context, steps: [], archivedSteps: [], plannedQueue: [], evaluatorOutputs: [] },
  });
  expect(verdict.decision).toBe("FINISH");
  expect(requests).toHaveLength(3);
  expect(requests[2].path).toMatch(/\/chat\/completions$/);

  const draft = await handleReplyDraft({
    body: {
      participant: "Ada",
      messages: [{ direction: "in", date: 1, body: "Are you free on Thursday?" }],
      truncated: false,
    },
    signal: new AbortController().signal,
    runtime,
  });
  expect(draft).toEqual({ status: 200, body: { draft: DRAFT } });
  expect(requests).toHaveLength(4);
  // The draft runs with thinking off: qwen-3.8-27b reasons at "none".
  expect(requests[3].body.reasoning_effort).toBe("none");

  await handleImageDescription(host, {
    imageUrl: "data:image/png;base64,AA==",
    prompt: "Describe the synthetic image",
  });
  expect(requests).toHaveLength(5);
  expect(isImageRequest(requests[4].body)).toBe(true);

  expect(
    requests.slice(0, 2).map(({ body }) => (body.tools ?? []).map((tool) => tool.function?.name))
  ).toEqual([
    expect.arrayContaining(["CALENDAR_CREATE_EVENT"]),
    expect.arrayContaining(["HANDLE_RESPONSE"]),
  ]);
  for (const { body } of requests) sentNoCap(body);
});

it("does not re-send a planner round stopped at the model's limit, and ends the turn", async () => {
  plannerFinishes = ["length", "tool_calls"];
  const errors: unknown[] = [];
  await expect(plan(dispatcher(errors))).rejects.toMatchObject({
    code: "MODEL_OUTPUT_INCOMPLETE",
  });
  expect(requests).toHaveLength(1);
  sentNoCap(requests[0].body);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    code: "MODEL_OUTPUT_INCOMPLETE",
    context: { finishReason: "length", maxTokens: null },
  });
});
