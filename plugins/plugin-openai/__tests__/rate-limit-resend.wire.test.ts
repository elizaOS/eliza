/**
 * The runtime's one re-send of a rate-limited planner round reaches the
 * provider. Cerebras refuses with Retry-After 59 while its per-minute
 * allowance refills all the time; the planner waits at most 5 s and re-sends,
 * and the adapter's local hold on the model ends after 4 s, before that
 * re-send. A hold for the stated minute failed the re-send locally. Drives the
 * runtime's model dispatch, the real adapter and AI SDK against a loopback
 * provider, in real time (about 5 s).
 */
import { createServer, type Server } from "node:http";
import { AgentRuntime, type IAgentRuntime, ModelType, type ToolDefinition } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { RATE_LIMIT_RETRY_MAX_WAIT_MS } from "../../plugin-assistant/src/runtime/evaluator.ts";
import { runPlannerLoop } from "../../plugin-assistant/src/runtime/planner-loop.ts";
import { handleActionPlanner } from "../models/text";

const ANSWER = "Created qa dinner.";
const requests: Array<{ at: number; messages: unknown }> = [];
let refusals = 0;
let baseUrl: string;
let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ at: Date.now(), messages: body.messages });
      if (requests.length <= refusals) {
        response.writeHead(429, { "content-type": "application/json", "retry-after": "59" });
        response.end(JSON.stringify({ error: { message: "Tokens per minute limit exceeded" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_reply",
                    type: "function",
                    function: {
                      name: "REPLY",
                      arguments: JSON.stringify({ text: ANSWER, eliza_turn_scope: "final" }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
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
  refusals = 0;
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_API_KEY", "loopback-only-key");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
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

function plan() {
  const runtime = new AgentRuntime({ character: { name: "Ada", bio: [] }, logLevel: "fatal" });
  runtime.registerDatabaseAdapter({ createLogs: async () => undefined } as never);
  runtime.registerModel(
    ModelType.ACTION_PLANNER,
    async (_runtime, params) => (await handleActionPlanner(host, params as never)) as never,
    "openai"
  );
  return runPlannerLoop({
    runtime: {
      useModel: (type, params, provider) => runtime.useModel(type, params as never, provider),
    },
    context: { id: "rate-limit-resend-wire", events: [] },
    tools,
    executeToolCall: async () => ({ success: true, text: "Created." }),
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "The event exists.",
      messageToUser: ANSWER,
    }),
  }).finally(() => runtime.stop());
}

it("re-sends a planner round refused with Retry-After 59 to the provider after the runtime's wait", async () => {
  refusals = 1;
  const result = await plan();

  expect(result.finalMessage).toBe(ANSWER);
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1].messages)).toBe(JSON.stringify(requests[0].messages));
  const waitedMs = requests[1].at - requests[0].at;
  expect(waitedMs).toBeGreaterThanOrEqual(RATE_LIMIT_RETRY_MAX_WAIT_MS - 50);
  expect(waitedMs).toBeLessThan(RATE_LIMIT_RETRY_MAX_WAIT_MS + 3_000);
}, 20_000);

it("fails the turn after the one re-send is refused too", async () => {
  refusals = 2;
  await expect(plan()).rejects.toMatchObject({ statusCode: 429 });
  expect(requests).toHaveLength(2);
}, 20_000);
