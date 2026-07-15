/**
 * Live test hitting a real Cerebras endpoint through the plugin to verify
 * provider-mode detection, the Cerebras reasoning_effort wire default, and GLM
 * thinking-off suppression. Runs only in the post-merge lane with
 * CEREBRAS_API_KEY; skips with a named reason keyless.
 *
 * Uses the harness's dedicated `provider: "cerebras"` rather than the
 * OPENAI_API_KEY alias: CI runners carry a real OpenAI key, which disables the
 * alias and silently reroutes requests to api.openai.com — run 29295263144
 * sent zai-glm-4.7 there and got a 404 model_not_found. The cerebras provider
 * pins OPENAI_BASE_URL and the key unconditionally.
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

/**
 * True only for the provider's "model does not exist or you do not have
 * access" 404 — the one condition allowed to downgrade the GLM leg to a
 * visible skip. Any other error (auth, network, 5xx, bad request) rethrows.
 */
function isModelAccessError(error: unknown, modelId: string): boolean {
  if (!(error instanceof Error) || error.name !== "AI_APICallError") {
    return false;
  }
  const apiError = error as Error & {
    statusCode?: number;
    data?: { error?: { code?: string } };
  };
  return (
    apiError.statusCode === 404 &&
    apiError.data?.error?.code === "model_not_found" &&
    error.message.includes(modelId)
  );
}

/**
 * Asserts the model returned actual visible text. A null/undefined `text`
 * must fail with a truthful type assertion, not a vitest arguments-shape
 * error (`toContain` on null throws "invalid combination of arguments").
 * The full response rides along in the failure message so an empty-content
 * regression (e.g. everything spent in the reasoning channel) stays
 * diagnosable from CI logs alone.
 */
function expectRealText(text: string | undefined, response?: unknown): string {
  const receipt = response === undefined ? "" : ` — full response: ${JSON.stringify(response)}`;
  expect(typeof text, `expected visible text, got ${typeof text}${receipt}`).toBe("string");
  const value = text as string;
  expect(value.trim().length, `expected non-empty visible text${receipt}`).toBeGreaterThan(0);
  return value;
}

describeLive(
  "plugin-openai Cerebras live",
  { provider: "cerebras", requiredEnv: ["CEREBRAS_API_KEY"] },
  ({ harness }) => {
    it("uses TEXT_LARGE against Cerebras and returns real text + usage", async () => {
      const { runtime } = harness();
      const baseURL = runtime.getSetting("OPENAI_BASE_URL");
      expect(typeof baseURL).toBe("string");
      expect(baseURL).toContain("cerebras.ai");

      const result = (await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Reply with the single word: ready",
      })) as string | UseModelResult;

      const text = typeof result === "string" ? result : result.text;
      expectRealText(text, typeof result === "string" ? undefined : result);
      if (typeof result !== "string") {
        expect(result.usage?.promptTokens ?? 0).toBeGreaterThan(0);
        expect(result.usage?.completionTokens ?? 0).toBeGreaterThan(0);
      }
    }, 120_000);

    it("applies the Cerebras reasoning floor to gpt-oss-120b and returns visible text", async () => {
      const { runtime } = harness();
      runtime.setSetting("OPENAI_LARGE_MODEL", "gpt-oss-120b");

      // No explicit OPENAI_REASONING_EFFORT: the plugin's Cerebras-mode
      // default ("low") must bound hidden reasoning so visible content
      // survives the capped response — the wire behavior this PR bounds,
      // proven on a model every Cerebras key can reach.
      //
      // `messages` is load-bearing: prompt-only calls return a plain string
      // (usesNativeTextResult — no usage to assert), and reading `.text` off
      // that string is exactly how run 29297039074 failed here. The forceful
      // phrasing keeps gpt-oss from spending the entire budget in the
      // reasoning channel on a trivial ask.
      const result = (await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt: "Respond with exactly the word READY and nothing else.",
        messages: [
          {
            role: "user",
            content: "Respond with exactly the word READY and nothing else.",
          },
        ],
        maxTokens: 160,
      })) as UseModelResult;

      const text = expectRealText(result.text, result);
      expect(text.toUpperCase()).toContain("READY");
      expect(result.usage?.promptTokens ?? 0).toBeGreaterThan(0);
      expect(result.usage?.completionTokens ?? 0).toBeGreaterThan(0);

      logger.info("[OpenAICerebrasLive] gpt-oss-120b reasoning-floor receipt", {
        model: "gpt-oss-120b",
        request: {
          maxTokens: 160,
          resolvedReasoningEffort: "low (Cerebras-mode default)",
        },
        response: {
          text: result.text,
          finishReason: result.finishReason,
          usage: result.usage,
        },
      });
    }, 120_000);

    it("suppresses hidden thinking for the exact GLM model and returns visible text", async (ctx) => {
      const { runtime } = harness();
      runtime.setSetting("OPENAI_LARGE_MODEL", "zai-glm-4.7");

      let result: UseModelResult;
      try {
        result = (await runtime.useModel(ModelType.TEXT_LARGE, {
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
      } catch (error) {
        // error-policy:J4 explicit user-facing degrade — only the exact
        // model-access 404 downgrades to a VISIBLE skip (never a pass); the
        // thinking-off mapping stays covered by reasoning-effort.shape.test.ts.
        if (isModelAccessError(error, "zai-glm-4.7")) {
          logger.warn(
            "[OpenAICerebrasLive] CI key lacks zai-glm-4.7 access; skipping the GLM live leg.",
            { error: String(error) }
          );
          ctx.skip(
            "CI key lacks zai-glm-4.7 access (404 model_not_found); mapping covered by shape tests"
          );
        }
        throw error;
      }

      // A live model may wrap PONG in whitespace/punctuation despite the
      // instruction — assert containment, not exact equality.
      const text = expectRealText(result.text, result);
      expect(text.trim().toUpperCase()).toContain("PONG");
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
