/**
 * No call of a turn sends an output cap, through the runtime's model dispatch,
 * the real adapter and AI SDK against a loopback endpoint: a planner round,
 * Stage 1, the evaluator and a side call (the SMS reply draft). Every removed
 * cap variable and setting is set to a small value and must be ignored. A
 * planner round that stops at the model's own maximum is not re-sent.
 */
import { createServer, type Server } from "node:http";
import {
  AgentRuntime,
  ChannelType,
  type IAgentRuntime,
  ModelType,
  type ToolDefinition,
} from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  makeMessage,
  makeRuntime,
  runStage1,
} from "../../plugin-assistant/src/__tests__/stage1/fixtures.ts";
import { runEvaluator } from "../../plugin-assistant/src/runtime/evaluator.ts";
import { runPlannerLoop } from "../../plugin-assistant/src/runtime/planner-loop.ts";
import { handleReplyDraft } from "../../plugin-native-phone/src/routes/reply-draft-route.ts";
import { handleActionPlanner, handleResponseHandler, handleTextSmall } from "../models/text";

type WireTool = { function?: { name?: string; parameters?: { properties?: object } } };
type WireBody = Record<string, unknown> & {
  model?: string;
  stream?: boolean;
  tools?: WireTool[];
  response_format?: { json_schema?: { schema?: { properties?: Record<string, unknown> } } };
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
  TEXT_SMALL_MAX_TOKENS: "16",
  RESPONSE_HANDLER_MAX_TOKENS: "16",
  ACTION_PLANNER_MAX_TOKENS: "16",
};
/** Every cap setting the runtime once merged, set small. */
const REMOVED_CAP_SETTINGS = {
  ACTION_PLANNER_MAX_TOKENS: "16",
  RESPONSE_HANDLER_MAX_TOKENS: "16",
  TEXT_SMALL_MAX_TOKENS: "16",
  TEXT_LARGE_MAX_TOKENS: "16",
  DEFAULT_MAX_TOKENS: "16",
};

const requests: WireBody[] = [];
/** Finish reason of the next planner response; "length" cuts a tool call off. */
let plannerFinishes: Array<"length" | "tool_calls"> = [];
let baseUrl: string;
let server: Server;

/** A direct answer in each field the request's HANDLE_RESPONSE tool asks for. */
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

/** The response a call of this shape gets: a tool call or text, and its finish reason. */
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
  if (tools.some((tool) => tool.function?.name === "REPLY")) {
    const finish = plannerFinishes.shift() ?? "tool_calls";
    return finish === "length"
      ? {
          toolCall: {
            id: "call_create",
            type: "function",
            function: {
              name: "CALENDAR_CREATE_EVENT",
              arguments: '{"title":"qa dinner","attendees":[{"email":""},{"email":""',
            },
          },
          finish,
        }
      : {
          toolCall: {
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
  if (body.response_format) {
    const properties = body.response_format.json_schema?.schema?.properties;
    return {
      content: JSON.stringify(
        properties?.__eliza_response ? { __eliza_response: VERDICT } : VERDICT
      ),
      finish: "stop",
    };
  }
  return { content: DRAFT, finish: "stop" };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WireBody;
      requests.push(body);
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
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  requests.length = 0;
  plannerFinishes = [];
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  for (const [key, value] of Object.entries(REMOVED_CAP_ENV)) vi.stubEnv(key, value);
});

afterEach(() => vi.unstubAllEnvs());

const settings: Record<string, string> = {
  ...REMOVED_CAP_SETTINGS,
  CEREBRAS_MODEL: "qwen-3.8-27b",
  OPENAI_ACTION_PLANNER_MODEL: "qwen-3.8-27b",
  OPENAI_RESPONSE_HANDLER_MODEL: "qwen-3.8-27b",
  OPENAI_SMALL_MODEL: "qwen-3.8-27b",
};
const host = {
  getSetting: (key: string) => settings[key] ?? null,
  character: { name: "Ada", system: "Preserve the complete caller context." },
  emitEvent: vi.fn(),
  getService: () => null,
  getServicesByType: () => [],
} as unknown as IAgentRuntime;
const tools: ToolDefinition[] = [
  {
    name: "CALENDAR_CREATE_EVENT",
    description: "Create a calendar event.",
    parameters: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "REPLY",
    description: "Reply to the user.",
    parameters: { type: "object", properties: { text: { type: "string" } } },
  },
];

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.stop();
});

/** A runtime whose text models are this plugin's handlers, under the former cap settings. */
function dispatcher(errors: unknown[] = []): AgentRuntime {
  const runtime = new AgentRuntime({
    character: { name: "Ada", bio: [], settings: REMOVED_CAP_SETTINGS },
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
      "openai"
    );
  }
  return runtime;
}

function plan(runtime: AgentRuntime) {
  return runPlannerLoop({
    runtime: {
      useModel: (type, params, provider) => runtime.useModel(type, params as never, provider),
    },
    context: { id: "no-output-cap-wire", events: [] },
    tools,
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
};

it("sends no output cap from a planner round, Stage 1, the evaluator or a side call", async () => {
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

  const context = { id: "no-output-cap-evaluator", events: [] };
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
  expect(requests[3].reasoning_effort).toBe("none");

  expect(requests.map((body) => (body.tools ?? []).map((tool) => tool.function?.name))).toEqual([
    expect.arrayContaining(["REPLY"]),
    expect.arrayContaining(["HANDLE_RESPONSE"]),
    [],
    [],
  ]);
  expect(requests[2].response_format).toBeDefined();
  for (const body of requests) sentNoCap(body);
});

it("does not re-send a planner round stopped at the model's limit, and ends the turn", async () => {
  plannerFinishes = ["length", "tool_calls"];
  const errors: unknown[] = [];
  await expect(plan(dispatcher(errors))).rejects.toMatchObject({
    code: "MODEL_OUTPUT_INCOMPLETE",
  });

  expect(requests).toHaveLength(1);
  sentNoCap(requests[0]);
  // The adapter records the omitted cap as null, the evidence a caller reads
  // to tell the model's own limit from a cap it sent.
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    code: "MODEL_OUTPUT_INCOMPLETE",
    context: { finishReason: "length", maxTokens: null },
  });
});

it("reports a streamed cut-off tool call as incomplete output, not invalid arguments", async () => {
  plannerFinishes = ["length"];
  // An explicit cap still reaches the wire: the adapter forwards what it is given.
  const result = (await handleActionPlanner(host, {
    messages: [{ role: "user", content: "make event for tomorrow that says qa dinner at 5pm" }],
    tools,
    toolChoice: "required",
    maxTokens: 8192,
    stream: true,
    onStreamChunk: () => {},
  } as never)) as { toolCalls: Promise<unknown>; finishReason: Promise<unknown> };

  expect(requests[0]).toMatchObject({ stream: true, max_tokens: 8192 });
  await expect(result.toolCalls).resolves.toBeUndefined();
  await expect(result.finishReason).rejects.toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
});
