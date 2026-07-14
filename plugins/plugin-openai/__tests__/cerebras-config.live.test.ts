/**
 * Live test hitting a real Cerebras endpoint through the plugin to verify
 * provider-mode detection and text generation. Runs only in the post-merge lane
 * with credentials.
 */
import { logger, ModelType } from "@elizaos/core";
import { expect, it } from "vitest";

import { describeLive } from "../../../packages/app-core/test/helpers/live-agent-test";

interface UseModelResult {
  text?: string;
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
  };
  providerMetadata?: unknown;
}

describeLive(
  "plugin-openai Cerebras live",
  { requiredEnv: ["CEREBRAS_API_KEY"] },
  ({ harness }) => {
    it("uses TEXT_LARGE against Cerebras and returns real text + usage", async () => {
      const { runtime } = harness();
      expect(runtime.getSetting("OPENAI_BASE_URL")).toContain("cerebras.ai");

      const result = (await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Reply with the single word: ready",
      })) as string | UseModelResult;

      const text = typeof result === "string" ? result : (result.text ?? "");
      expect(text.length).toBeGreaterThan(0);
      if (typeof result !== "string") {
        expect(result.usage?.promptTokens ?? 0).toBeGreaterThan(0);
        expect(result.usage?.completionTokens ?? 0).toBeGreaterThan(0);
      }
    }, 120_000);

    it("suppresses hidden thinking for the exact GLM model and returns visible text", async () => {
      const { runtime } = harness();
      runtime.setSetting("OPENAI_LARGE_MODEL", "zai-glm-4.7");

      const result = (await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Reply with exactly PONG and no punctuation.",
        messages: [
          {
            role: "user",
            content: "Reply with exactly PONG and no punctuation.",
          },
        ],
        maxTokens: 160,
        providerOptions: { eliza: { thinking: "off" } },
      })) as UseModelResult;

      // A live model may wrap PONG in whitespace/punctuation despite the
      // instruction — assert containment, not exact equality.
      expect(result.text?.trim().toUpperCase()).toContain("PONG");
      expect(result.finishReason).toBe("stop");
      expect(result.usage?.promptTokens ?? 0).toBeGreaterThan(0);
      expect(result.usage?.completionTokens ?? 0).toBeGreaterThan(0);
      // Under reasoning_effort "none" the provider may omit
      // completion_tokens_details entirely — undefined and 0 both prove no
      // hidden reasoning was billed.
      expect(result.usage?.reasoningTokens ?? 0).toBe(0);

      logger.info("[OpenAICerebrasLive] exact GLM thinking-off receipt", {
        model: "zai-glm-4.7",
        request: {
          maxTokens: 160,
          thinking: "off",
          resolvedReasoningEffort: "none",
        },
        response: {
          text: result.text,
          finishReason: result.finishReason,
          usage: result.usage,
          providerMetadata: result.providerMetadata,
        },
      });
    }, 120_000);
  }
);
