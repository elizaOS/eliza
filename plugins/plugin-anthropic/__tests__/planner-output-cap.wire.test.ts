/**
 * The non-coding planner on the Anthropic wire, through the runtime's
 * per-attempt preparation, the real text handler and AI SDK, and a loopback
 * Messages API that enforces the extended-thinking rule (max_tokens must exceed
 * thinking.budget_tokens). The planner sets no default cap for Anthropic, so
 * every thinking configuration keeps the request it had before the default.
 */
import { createServer, type Server } from "node:http";
import { AgentRuntime, type IAgentRuntime, ModelType, type ToolDefinition } from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../../plugin-assistant/src/runtime/planner-loop.ts";
import { handleActionPlanner, resolveAnthropicMaxOutputTokens } from "../models/text";

const MODEL = "claude-sonnet-4-5-20250929";
const ANSWER = "Created qa dinner.";
const bodies: Array<{
  max_tokens?: number;
  thinking?: { type: string; budget_tokens?: number };
}> = [];
let baseUrl: string;
let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      bodies.push(body);
      const budget = body.thinking?.budget_tokens;
      if (typeof budget === "number" && !(body.max_tokens > budget)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "max_tokens must be greater than thinking.budget_tokens",
            },
          })
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: `msg-${bodies.length}`,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [
            {
              type: "tool_use",
              id: "toolu_reply",
              name: "REPLY",
              input: { text: ANSWER, eliza_turn_scope: "final" },
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
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
  bodies.length = 0;
  vi.stubEnv("ANTHROPIC_AUTH_MODE", "apikey");
  vi.stubEnv("ELIZA_MOCK_ANTHROPIC_BASE", undefined);
  vi.stubEnv("ELIZA_PLANNER_MAX_TOKENS", undefined);
  for (const key of [
    "ANTHROPIC_COT_BUDGET",
    "ANTHROPIC_COT_BUDGET_SMALL",
    "ANTHROPIC_COT_BUDGET_LARGE",
    "ANTHROPIC_EFFORT",
    "ANTHROPIC_EFFORT_SMALL",
    "ANTHROPIC_EFFORT_LARGE",
  ])
    vi.stubEnv(key, undefined);
  return () => vi.unstubAllEnvs();
});

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

/** Plan one turn with the anthropic registration; return the wire bodies. */
async function plan(thinking: Record<string, string>, model: string = MODEL) {
  const settings: Record<string, string> = {
    ANTHROPIC_API_KEY: "loopback-only-key",
    ANTHROPIC_AUTH_MODE: "apikey",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_ACTION_PLANNER_MODEL: model,
    ...thinking,
  };
  const host = {
    getSetting: (key: string) => settings[key] ?? null,
    character: { name: "Ada" },
    emitEvent: vi.fn(),
    getService: () => null,
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
  const runtime = new AgentRuntime({ character: { name: "Ada", bio: [] }, logLevel: "fatal" });
  runtime.registerDatabaseAdapter({ createLogs: async () => undefined } as never);
  runtime.registerModel(
    ModelType.ACTION_PLANNER,
    (_runtime, params) => handleActionPlanner(host, params as never) as never,
    "anthropic"
  );
  const result = await runPlannerLoop({
    runtime: {
      useModel: (type, params, provider) => runtime.useModel(type, params as never, provider),
      getSetting: (key) => settings[key] ?? null,
    },
    context: { id: "planner-output-cap-anthropic", events: [] },
    tools,
    executeToolCall: async () => ({ success: true, text: "Created." }),
    evaluate: async () => ({
      success: true,
      decision: "FINISH",
      thought: "The event exists.",
      messageToUser: ANSWER,
    }),
  }).finally(() => runtime.stop());
  expect(result.finalMessage).toBe(ANSWER);
  return bodies;
}

/** The plugin's own output limit for a model: what an omitted cap sends. */
const outputLimit = (model: string) =>
  resolveAnthropicMaxOutputTokens({ getSetting: () => null } as never, model as never);

it("sends the model output limit without thinking settings, as before the default", async () => {
  const sent = await plan({});
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ max_tokens: outputLimit(MODEL) });
  expect(sent[0]).not.toHaveProperty("thinking");
});

it("keeps max_tokens above a thinking budget", async () => {
  // The SDK adds the budget to the output limit and clamps to the model's.
  const sent = await plan({ ANTHROPIC_COT_BUDGET: "10000" });
  expect(sent).toEqual([
    expect.objectContaining({
      thinking: { type: "enabled", budget_tokens: 10000 },
      max_tokens: outputLimit(MODEL),
    }),
  ]);
});

it("leaves adaptive thinking the model output limit, as before the default", async () => {
  // Adaptive thinking spends max_tokens; a default would share it with the answer.
  const sent = await plan({ ANTHROPIC_EFFORT_LARGE: "high" });
  expect(sent).toEqual([
    expect.objectContaining({
      thinking: { type: "adaptive" },
      max_tokens: outputLimit(MODEL),
    }),
  ]);
});

it("leaves a model that always thinks adaptively its output limit", async () => {
  // claude-fable-5 turns a thinking budget into adaptive thinking.
  const sent = await plan({ ANTHROPIC_COT_BUDGET: "10000" }, "claude-fable-5");
  expect(sent).toEqual([
    expect.objectContaining({
      thinking: { type: "adaptive" },
      max_tokens: outputLimit("claude-fable-5"),
    }),
  ]);
});

it("sends the planner override above a thinking budget", async () => {
  vi.stubEnv("ELIZA_PLANNER_MAX_TOKENS", "8192");
  const sent = await plan({ ANTHROPIC_COT_BUDGET: "10000" });
  expect(sent).toEqual([
    expect.objectContaining({
      thinking: { type: "enabled", budget_tokens: 10000 },
      max_tokens: 8192 + 10000,
    }),
  ]);
});
