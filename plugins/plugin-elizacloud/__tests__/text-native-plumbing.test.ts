import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleActionPlanner, handleResponseHandler } from "../models/text";
import {
  DEFAULT_ELIZA_CLOUD_LARGE_MODEL,
  getActionPlannerModel,
  getResponseHandlerModel,
} from "../utils/config";

const mocks = vi.hoisted(() => ({
  requestRaw: vi.fn(),
}));

vi.mock("../utils/sdk-client", () => ({
  createCloudApiClient: () => ({
    requestRaw: mocks.requestRaw,
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  return {
    character: {
      name: "Milady",
      bio: [],
    },
    getSetting: (key: string) => settings[key],
  } as unknown as IAgentRuntime;
}

type PlannerNativeResult = {
  text: string;
  toolCalls: Array<{
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    input: { actions: never[] };
  }>;
  usage?: {
    cacheReadInputTokens?: number;
    cachedPromptTokens?: number;
  };
};

function assertPlannerNativeResult(
  value: Awaited<ReturnType<typeof handleActionPlanner>>
): asserts value is Awaited<ReturnType<typeof handleActionPlanner>> & PlannerNativeResult {
  if (typeof value !== "object" || value === null || !("toolCalls" in value)) {
    throw new Error("Expected native planner result with tool calls");
  }
}

describe("Eliza Cloud native planner plumbing", () => {
  beforeEach(() => {
    mocks.requestRaw.mockReset();
  });

  it("uses current OpenRouter defaults while preserving explicit overrides", () => {
    const defaultRuntime = runtime();
    expect(getResponseHandlerModel(defaultRuntime)).toBe(DEFAULT_ELIZA_CLOUD_TEXT_MODEL);
    expect(getActionPlannerModel(defaultRuntime)).toBe(DEFAULT_ELIZA_CLOUD_LARGE_MODEL);
    expect(DEFAULT_ELIZA_CLOUD_LARGE_MODEL).toBe("deepseek/deepseek-v4-pro");

    const routedRuntime = runtime({
      ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "openai/custom-small",
      ELIZAOS_CLOUD_ACTION_PLANNER_MODEL: "deepseek/custom-planner",
    });
    expect(getResponseHandlerModel(routedRuntime)).toBe("openai/custom-small");
    expect(getActionPlannerModel(routedRuntime)).toBe("deepseek/custom-planner");
  });

  it("preserves messages, tools, schemas, OpenRouter provider blocks, and prompt cache keys", async () => {
    mocks.requestRaw.mockResolvedValueOnce(
      jsonResponse({
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_plan",
                  type: "function",
                  function: {
                    name: "PLAN_ACTIONS",
                    arguments: '{"actions":[]}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 4096,
          completion_tokens: 32,
          prompt_tokens_details: {
            cached_tokens: 3072,
          },
        },
      })
    );

    const result = await handleActionPlanner(runtime(), {
      prompt: "fallback prompt",
      system: "planner system",
      messages: [{ role: "user", content: "plan the next action" }],
      tools: [
        {
          type: "function",
          function: {
            name: "PLAN_ACTIONS",
            description: "Plan actions",
            parameters: { type: "object", properties: { actions: { type: "array" } } },
          },
        },
      ],
      toolChoice: { type: "tool", toolName: "PLAN_ACTIONS" },
      responseSchema: {
        name: "PlannerResponse",
        schema: { type: "object", properties: { actions: { type: "array" } } },
      },
      providerOptions: {
        eliza: { promptCacheKey: "agent:milady:planner" },
        openrouter: { provider: { order: ["deepinfra"] } },
        gateway: { caching: "auto" },
      },
    } as never);
    assertPlannerNativeResult(result);

    expect(mocks.requestRaw).toHaveBeenCalledTimes(1);
    const [method, path, request] = mocks.requestRaw.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/chat/completions");

    const body = request.json as Record<string, unknown>;
    expect(body.model).toBe("deepseek/deepseek-v4-pro");
    expect(body.prompt_cache_key).toBe("agent:milady:planner");
    expect(body.promptCacheKey).toBe("agent:milady:planner");
    expect(body.provider).toEqual({ order: ["deepinfra"] });
    expect(body.gateway).toEqual({ caching: "auto" });
    expect(body.messages).toEqual([
      { role: "system", content: "planner system" },
      { role: "user", content: "plan the next action" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "PLAN_ACTIONS",
          description: "Plan actions",
          parameters: { type: "object", properties: { actions: { type: "array" } } },
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "PLAN_ACTIONS" } });
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "PlannerResponse",
        schema: { type: "object", properties: { actions: { type: "array" } } },
      },
    });
    expect(body.providerOptions).toMatchObject({
      gateway: { caching: "auto" },
      openrouter: {
        provider: { order: ["deepinfra"] },
        promptCacheKey: "agent:milady:planner",
        prompt_cache_key: "agent:milady:planner",
      },
      openai: {
        promptCacheKey: "agent:milady:planner",
        prompt_cache_key: "agent:milady:planner",
      },
    });
    expect(body.provider_options).toEqual(body.providerOptions);

    expect(result.toolCalls).toEqual([
      {
        type: "tool-call",
        toolCallId: "call_plan",
        toolName: "PLAN_ACTIONS",
        input: { actions: [] },
      },
    ]);
    expect(result.usage?.cacheReadInputTokens).toBe(3072);
    expect(result.usage?.cachedPromptTokens).toBe(3072);
  });

  it("keeps plain text calls on the responses endpoint", async () => {
    mocks.requestRaw.mockResolvedValueOnce(
      jsonResponse({
        output_text: "hello",
        usage: {
          input_tokens: 12,
          output_tokens: 2,
          total_tokens: 14,
        },
      })
    );

    const text = await handleResponseHandler(runtime(), {
      prompt: "say hello",
      system: "short system",
    } as never);

    expect(text).toBe("hello");
    const [method, path, request] = mocks.requestRaw.mock.calls[0];
    expect(method).toBe("POST");
    expect(path).toBe("/responses");
    expect(request.json).toMatchObject({
      model: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
      input: [
        { role: "system", content: [{ type: "input_text", text: "short system" }] },
        { role: "user", content: [{ type: "input_text", text: "say hello" }] },
      ],
    });
  });
});
