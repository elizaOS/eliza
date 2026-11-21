/**
 * The Cloud names the Cerebras Qwen model with a provider prefix
 * (`cerebras/qwen-3.8-27b`). A prefixed id must still send the conversation's
 * `prompt_cache_key`: comparing the raw id sent a prompt-derived key shared by
 * every device with the same prompt.
 */
import { createHash } from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProviderCachePlan } from "../../plugin-assistant/src/runtime/provider-cache-plan";
import { handleActionPlanner } from "../src/models/text";

afterEach(() => vi.restoreAllMocks());

const ENDPOINTS = ["https://api.eliza.app/api/v1", "https://custom.example/api/v1"];

async function send(
  baseUrl: string,
  cache: { conversationId: string; prefixHash: string },
  eliza: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const settings: Record<string, string> = {
    ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
    ELIZAOS_CLOUD_BASE_URL: baseUrl,
    ELIZAOS_CLOUD_ACTION_PLANNER_MODEL: "cerebras/qwen-3.8-27b",
  };
  const runtime = {
    character: { name: "Cache key test", bio: [] },
    getSetting: (key: string) => settings[key],
    getModel: (type: string) => (type === "ACTION_PLANNER" ? handleActionPlanner : undefined),
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
  const requests: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "LOOKUP", arguments: "{}" } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  const promptSegments = [{ content: `segment ${cache.prefixHash}`, stable: true }];
  const plan = buildProviderCachePlan({ ...cache, promptSegments, hasTools: true });
  await handleActionPlanner(runtime, {
    messages: [{ role: "user", content: "Look it up" }],
    tools: [
      {
        name: "LOOKUP",
        description: "Look something up.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ],
    toolChoice: "required",
    providerOptions: {
      ...plan.providerOptions,
      eliza: { ...(plan.providerOptions.eliza as object), thinking: "off", ...eliza },
    },
  } as never);
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe("cerebras/qwen-3.8-27b");
  vi.restoreAllMocks();
  return requests[0];
}

const workflowKey = (conversationId: string) =>
  `eliza-workflow-v1:${createHash("sha256").update(conversationId).digest("hex")}`;

describe.each(ENDPOINTS)("Cloud qwen request for a prefixed model id (%s)", (baseUrl) => {
  it("keeps one prompt_cache_key for a conversation while its prompt changes", async () => {
    const first = await send(baseUrl, {
      conversationId: "room-a:planner",
      prefixHash: "a".repeat(64),
    });
    const second = await send(baseUrl, {
      conversationId: "room-a:planner",
      prefixHash: "b".repeat(64),
    });

    expect(first.prompt_cache_key).toBe(workflowKey("room-a:planner"));
    expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(first.promptCacheKey).toBe(first.prompt_cache_key);
    expect(second.promptCacheKey).toBe(first.prompt_cache_key);
  });

  it("gives two conversations with the same prompt different keys", async () => {
    const prefixHash = "c".repeat(64);
    const one = await send(baseUrl, { conversationId: "room-a:planner", prefixHash });
    const other = await send(baseUrl, { conversationId: "room-b:planner", prefixHash });

    expect(one.prompt_cache_key).toBe(workflowKey("room-a:planner"));
    expect(other.prompt_cache_key).toBe(workflowKey("room-b:planner"));
    expect(other.prompt_cache_key).not.toBe(one.prompt_cache_key);
  });

  it("keeps internal hints off the wire when the flag is not set", async () => {
    const sent = await send(baseUrl, {
      conversationId: "room-a:planner",
      prefixHash: "e".repeat(64),
    });

    expect(sent).not.toHaveProperty("providerOptions.eliza");
    expect(sent).not.toHaveProperty("provider_options.eliza");
  });
});
