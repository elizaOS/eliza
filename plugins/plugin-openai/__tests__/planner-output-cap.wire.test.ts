/**
 * A planner generation cut off at its token cap, through the real AI SDK and
 * adapter against a loopback endpoint. Live 2026-10-30, the cut-off tool call
 * surfaced as "invalid tool arguments", so the planner could not retry it.
 */
import { createServer, type Server } from "node:http";
import type { IAgentRuntime, ToolDefinition } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../../plugin-assistant/src/runtime/planner-loop.ts";
import { handleActionPlanner } from "../models/text";

const requests: Array<{ stream?: boolean; max_tokens?: number; messages: unknown }> = [];
let finishes: Array<"length" | "tool_calls"> = [];
let baseUrl: string;
let server: Server;

const call = (finish: "length" | "tool_calls") =>
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
          arguments: JSON.stringify({ text: "Created qa dinner.", eliza_turn_scope: "final" }),
        },
      };

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      const finish = finishes.shift() ?? "tool_calls";
      const base = { id: `chatcmpl-${requests.length}`, created: 0, model: body.model };
      const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const choice of [
          { delta: { role: "assistant", tool_calls: [{ index: 0, ...call(finish) }] } },
          { delta: {}, finish_reason: finish },
        ]) {
          response.write(
            `data: ${JSON.stringify({
              ...base,
              object: "chat.completion.chunk",
              choices: [{ index: 0, finish_reason: null, ...choice }],
              ...(choice.finish_reason ? { usage } : {}),
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
              message: { role: "assistant", content: null, tool_calls: [call(finish)] },
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
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  vi.stubEnv("ELIZA_MOCK_OPENAI_BASE", undefined);
  vi.stubEnv("ELIZA_PLANNER_MAX_TOKENS", undefined);
});

afterEach(() => vi.unstubAllEnvs());

const settings: Record<string, string> = {
  CEREBRAS_MODEL: "qwen-3.8-27b",
  OPENAI_ACTION_PLANNER_MODEL: "qwen-3.8-27b",
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

it("retries a planner call cut off at the default cap and completes the turn", async () => {
  finishes = ["length", "tool_calls"];
  const errors: unknown[] = [];
  const result = await runPlannerLoop({
    runtime: {
      useModel: async (_type, params) => {
        try {
          return (await handleActionPlanner(host, params as never)) as never;
        } catch (error) {
          errors.push(error);
          throw error;
        }
      },
    },
    context: { id: "planner-output-cap-wire", events: [] },
    tools,
    executeToolCall: async () => ({ success: true, text: "Created." }),
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "The event exists.",
      messageToUser: "Created qa dinner.",
    }),
  });

  expect(result.finalMessage).toBe("Created qa dinner.");
  expect(requests.map((body) => body.max_tokens)).toEqual([8192, 8192]);
  expect(JSON.stringify(requests[1].messages)).toBe(JSON.stringify(requests[0].messages));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({
    code: "MODEL_OUTPUT_INCOMPLETE",
    context: { finishReason: "length", maxTokens: 8192 },
  });
});

it("reports a streamed cut-off tool call as incomplete output, not invalid arguments", async () => {
  finishes = ["length"];
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
