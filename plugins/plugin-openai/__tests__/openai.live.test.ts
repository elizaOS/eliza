import { ModelType } from "@elizaos/core";
import { expect, it } from "vitest";

import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";
import { openaiPlugin } from "../index";
import { getAuthHeader, getBaseURL } from "../utils/config";

describeLive(
  "OpenAI plugin live",
  { provider: "openai", requiredEnv: ["OPENAI_API_KEY"] },
  ({ harness }) => {
    it("connects to the live models endpoint", async () => {
      const { runtime } = harness();
      const response = await fetch(`${getBaseURL(runtime)}/models`, {
        headers: getAuthHeader(runtime),
      });

      expect(response.ok).toBe(true);
      const payload = (await response.json()) as { data?: unknown[] };
      expect(Array.isArray(payload.data)).toBe(true);
      expect(payload.data?.length ?? 0).toBeGreaterThan(0);
    }, 30_000);

    it("generates text with TEXT_SMALL", async () => {
      const { runtime } = harness();
      const handler = openaiPlugin.models?.[ModelType.TEXT_SMALL];
      expect(typeof handler).toBe("function");
      if (!handler) {
        throw new Error("TEXT_SMALL handler is unavailable");
      }

      const response = await handler(runtime, {
        prompt: "Reply with exactly two words: live ready",
      });

      expect(typeof response).toBe("string");
      expect((response as string).length).toBeGreaterThan(0);
    }, 30_000);

    it("generates embeddings with TEXT_EMBEDDING", async () => {
      const { runtime } = harness();
      const handler = openaiPlugin.models?.[ModelType.TEXT_EMBEDDING];
      expect(typeof handler).toBe("function");
      if (!handler) {
        throw new Error("TEXT_EMBEDDING handler is unavailable");
      }

      const response = (await handler(runtime, {
        text: "Eliza live embedding smoke test",
      })) as number[];

      expect(Array.isArray(response)).toBe(true);
      expect(response.length).toBeGreaterThan(0);
      expect(typeof response[0]).toBe("number");
    }, 30_000);
  }
);
