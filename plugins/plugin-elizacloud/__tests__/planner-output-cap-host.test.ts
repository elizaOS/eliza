/**
 * The planner's output cap on the Cloud route, dispatched through the runtime
 * as the registered Cloud provider. The gateway forwards max_tokens only when
 * the request carries it, so a host that sets ELIZA_PLANNER_MAX_TOKENS=model
 * must send none for the gateway to leave the model's own limit in place.
 */
import { AgentRuntime, type IAgentRuntime, ModelType } from "@elizaos/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../../plugin-assistant/src/runtime/planner-loop.ts";
import { handleActionPlanner } from "../src/models/text";

const ANSWER = "Created qa dinner.";
const settings: Record<string, string> = {
  ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
  ELIZAOS_CLOUD_BASE_URL: "https://custom.example/api/v1",
  ELIZAOS_CLOUD_ACTION_PLANNER_MODEL: "qwen-3.8-27b",
};
const host = {
  character: { name: "Planner cap test", bio: [] },
  getSetting: (key: string) => settings[key],
  emitEvent: vi.fn(),
} as unknown as IAgentRuntime;

let bodies: Record<string, unknown>[] = [];

beforeEach(() => {
  bodies = [];
  vi.stubEnv("ELIZA_PLANNER_MAX_TOKENS", undefined);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({
      choices: [
        {
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
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function plan() {
  const runtime = new AgentRuntime({
    character: { name: "Planner cap test", bio: [] },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter({ createLogs: async () => undefined } as never);
  runtime.registerModel(
    ModelType.ACTION_PLANNER,
    async (_runtime, params) => (await handleActionPlanner(host, params as never)) as never,
    "elizaOSCloud"
  );
  const result = await runPlannerLoop({
    runtime: {
      useModel: (type, params, provider) => runtime.useModel(type, params as never, provider),
    },
    context: { id: "planner-output-cap-host", events: [] },
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
  }).finally(() => runtime.stop());
  expect(result.finalMessage).toBe(ANSWER);
}

it("sends the gateway the planner's default 8192 cap when the host sets none", async () => {
  await plan();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ max_tokens: 8192 });
});

it("sends the gateway no max_tokens under ELIZA_PLANNER_MAX_TOKENS=model", async () => {
  vi.stubEnv("ELIZA_PLANNER_MAX_TOKENS", "model");
  await plan();
  expect(bodies).toHaveLength(1);
  expect(bodies[0]).not.toHaveProperty("max_tokens");
  expect(bodies[0]).not.toHaveProperty("max_output_tokens");
});
