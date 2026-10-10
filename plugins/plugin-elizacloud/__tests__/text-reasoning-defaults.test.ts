import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleResponseHandler } from "../src/models/text";

afterEach(() => vi.restoreAllMocks());

describe("Cerebras Cloud reasoning controls", () => {
  it.each([
    [undefined, undefined, "high"],
    ["low", undefined, "low"],
    ["none", undefined, "none"],
    ["high", "off", "none"],
  ] as const)(
    "preserves effort %s and thinking %s on the wire",
    async (effort, thinking, expected) => {
      const settings: Record<string, string | undefined> = {
        ELIZAOS_CLOUD_API_KEY: "synthetic-test-key",
        ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: "qwen-3.8-27b",
        ELIZAOS_CLOUD_REASONING_EFFORT: effort,
      };
      const runtime = {
        character: { name: "Reasoning test", bio: [] },
        getSetting: (key: string) => settings[key],
        emitEvent: vi.fn(),
      } as unknown as IAgentRuntime;
      const requests: Record<string, unknown>[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          id: "synthetic-response",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        });
      });
      await handleResponseHandler(runtime, {
        messages: [{ role: "user", content: "Reply ok" }],
        providerOptions: { eliza: thinking ? { thinking } : {} },
        stream: false,
      } as never);
      expect(requests).toHaveLength(1);
      expect(requests[0].reasoning_effort).toBe(expected);
      expect(requests[0]).not.toHaveProperty("max_tokens");
      expect(requests[0]).not.toHaveProperty("max_completion_tokens");
    }
  );
});
