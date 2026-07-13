/**
 * Sends one real Opus 4.7 request through the cloud resolver and records the serialized adaptive-thinking request with the live response.
 */

import { describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { mergeAnthropicCotProviderOptions } from "./anthropic-thinking";
import { getLanguageModel } from "./language-model";

const LIVE_MODEL = "anthropic/claude-opus-4-7";
const liveEnabled =
  process.env.ELIZA_LIVE_TEST === "1" && Boolean(process.env.ANTHROPIC_API_KEY?.trim());

describe.skipIf(!liveEnabled)("adaptive thinking live Anthropic trajectory", () => {
  test("sends adaptive thinking without a manual budget and returns a live response", async () => {
    const result = await generateText({
      model: getLanguageModel(LIVE_MODEL),
      prompt:
        "Reply with ADAPTIVE_OK followed by one short sentence explaining why two even integers sum to an even integer.",
      maxOutputTokens: 4_096,
      maxRetries: 0,
      ...mergeAnthropicCotProviderOptions(LIVE_MODEL, {
        ANTHROPIC_COT_BUDGET: "2048",
      }),
    });

    const requestBody = result.request.body as Record<string, unknown>;
    expect(requestBody.thinking).toEqual({ type: "adaptive" });
    expect(JSON.stringify(requestBody)).not.toContain("budget_tokens");
    expect(result.text).toContain("ADAPTIVE_OK");

    process.stdout.write(
      `${JSON.stringify(
        {
          evidence: "live-anthropic-adaptive-thinking-trajectory",
          model: LIVE_MODEL,
          request: requestBody,
          response: {
            text: result.text,
            finishReason: result.finishReason,
            usage: result.usage,
            providerMetadata: result.providerMetadata,
          },
        },
        null,
        2,
      )}\n`,
    );
  }, 120_000);
});
