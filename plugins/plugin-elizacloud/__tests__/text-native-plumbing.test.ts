/**
 * Live e2e for elizacloud's text + native-tool plumbing. Drives the real
 * `handleResponseHandler` and `handleActionPlanner` against the live Eliza
 * Cloud endpoint and asserts both:
 *   - the request body the SDK sends has the right shape (model, messages,
 *     native tools, prompt cache keys, OpenRouter provider blocks)
 *   - the live response is sane (text returned for the responses path,
 *     a native tool call returned for the planner path)
 *
 * The fetch interceptor is read-only — it captures the request, then lets
 * the call through to the real Cloud endpoint.
 *
 * Skips with a yellow warning when `ELIZAOS_CLOUD_API_KEY` is not set.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_ELIZA_CLOUD_TEXT_MODEL } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleActionPlanner, handleResponseHandler } from "../src/models/text";

const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const REQUIRED = ["ELIZAOS_CLOUD_API_KEY"] as const;

const missing = REQUIRED.filter((k) => !process.env[k]?.trim());

type RuntimeFixture = Pick<IAgentRuntime, "character" | "emitEvent" | "getSetting"> &
  Partial<IAgentRuntime>;

function runtime(settings: Record<string, string | undefined> = {}): IAgentRuntime {
  const merged: Record<string, string | undefined> = {
    ELIZAOS_CLOUD_API_KEY: process.env.ELIZAOS_CLOUD_API_KEY,
    ...settings,
  };
  const fixture: RuntimeFixture = {
    character: {
      name: "Milady",
      bio: [],
    },
    getSetting: (key: string) => merged[key],
    emitEvent: vi.fn(),
  };
  return fixture as IAgentRuntime;
}

interface CapturedRequest {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

if (missing.length > 0) {
  const reason = `missing required env: ${missing.join(", ")}`;
  process.env.SKIP_REASON ||= reason;
  console.warn(
    `${YELLOW}[plugin-elizacloud live] skipped — ${reason} (set ${missing.join(
      ", "
    )} to enable)${RESET}`
  );
  describe("Eliza Cloud native planner plumbing (live)", () => {
    it.skip(`[live] suite skipped — set ${missing.join(", ")} to enable`, () => {});
  });
} else {
  describe("Eliza Cloud native planner plumbing (live)", () => {
    const captured: CapturedRequest[] = [];
    const realFetch = globalThis.fetch;

    beforeEach(() => {
      captured.length = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const method = init?.method ?? "GET";
          let body: Record<string, unknown> | null = null;
          if (typeof init?.body === "string") {
            try {
              body = JSON.parse(init.body) as Record<string, unknown>;
            } catch {
              body = null;
            }
          }
          captured.push({ url, method, body });
          return realFetch(input, init);
        }
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("sends a real /responses call and returns generated text", async () => {
      const text = await handleResponseHandler(runtime(), {
        prompt: "Reply with exactly the single word: pong. No punctuation, no other words.",
        system: "You are a strict echo bot.",
      } as never);

      expect(typeof text).toBe("string");
      expect((text as string).length).toBeGreaterThan(0);

      const responsesCall = captured.find((c) => c.url.includes("/responses"));
      expect(responsesCall).toBeDefined();
      expect(responsesCall?.method).toBe("POST");
      const body = responsesCall?.body ?? {};
      expect(typeof body.model).toBe("string");
      expect(body.model).toBe(DEFAULT_ELIZA_CLOUD_TEXT_MODEL);
      expect(Array.isArray(body.input)).toBe(true);
    }, 120_000);

    it("sends native tools, schemas, and prompt cache keys to /chat/completions and gets a tool call back", async () => {
      const result = await handleActionPlanner(runtime(), {
        prompt: "fallback prompt",
        system: "You are a planner. You MUST call the PLAN_ACTIONS tool. Always.",
        messages: [
          {
            role: "user",
            content:
              "Plan one action by calling the PLAN_ACTIONS tool with an empty actions array.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "PLAN_ACTIONS",
              description: "Plan actions",
              parameters: {
                type: "object",
                properties: { actions: { type: "array" } },
                required: ["actions"],
              },
            },
          },
        ],
        toolChoice: { type: "tool", toolName: "PLAN_ACTIONS" },
        providerOptions: {
          eliza: { promptCacheKey: "agent:milady:planner-live" },
          openrouter: { provider: { order: ["deepinfra"] } },
          gateway: { caching: "auto" },
        },
      } as never);

      const chatCall = captured.find((c) => c.url.includes("/chat/completions"));
      expect(chatCall).toBeDefined();
      expect(chatCall?.method).toBe("POST");

      const body = chatCall?.body ?? {};
      expect(typeof body.model).toBe("string");
      expect(body.prompt_cache_key).toBe("agent:milady:planner-live");
      expect(body.promptCacheKey).toBe("agent:milady:planner-live");
      expect(body.provider).toEqual({ order: ["deepinfra"] });
      expect(body.gateway).toEqual({ caching: "auto" });
      expect(Array.isArray(body.messages)).toBe(true);
      expect(Array.isArray(body.tools)).toBe(true);
      expect(body.tool_choice).toEqual({
        type: "function",
        function: { name: "PLAN_ACTIONS" },
      });
      expect(body.providerOptions).toMatchObject({
        gateway: { caching: "auto" },
        openrouter: {
          provider: { order: ["deepinfra"] },
          promptCacheKey: "agent:milady:planner-live",
          prompt_cache_key: "agent:milady:planner-live",
        },
        openai: {
          promptCacheKey: "agent:milady:planner-live",
          prompt_cache_key: "agent:milady:planner-live",
        },
      });
      expect(body.provider_options).toEqual(body.providerOptions);

      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
      if (
        result &&
        typeof result === "object" &&
        "toolCalls" in result &&
        Array.isArray((result as { toolCalls: unknown }).toolCalls)
      ) {
        const toolCalls = (
          result as {
            toolCalls: Array<{ toolName?: string }>;
          }
        ).toolCalls;
        expect(toolCalls.length).toBeGreaterThan(0);
        expect(toolCalls[0]?.toolName).toBe("PLAN_ACTIONS");
      }
    }, 120_000);
  });
}
