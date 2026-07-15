/**
 * Exercises adaptive-thinking serialization through the real cloud resolver and AI SDK provider clients.
 * HTTP is intercepted only after each client has built the exact upstream request body.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateText } from "ai";
import { mergeAnthropicCotProviderOptions } from "./anthropic-thinking";
import { getLanguageModel } from "./language-model";

const ORIGINAL_FETCH = globalThis.fetch;
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
] as const;
const ORIGINAL_PROVIDER_ENV = Object.fromEntries(
  PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]),
);

type CapturedRequest = { url: string; body: Record<string, unknown> };
let captured: CapturedRequest[] = [];
let failNativeForFallback = false;

function configureProviders(input: {
  anthropic?: boolean;
  openRouter?: boolean;
  gateway?: boolean;
}) {
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
  if (input.anthropic) process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  if (input.openRouter) process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  if (input.gateway) process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
}

async function captureDispatch(model: string): Promise<CapturedRequest[]> {
  captured = [];
  await expect(
    generateText({
      model: getLanguageModel(model),
      prompt: "Confirm adaptive thinking request serialization.",
      maxOutputTokens: 8_000,
      maxRetries: 0,
      ...mergeAnthropicCotProviderOptions(model, {
        ANTHROPIC_COT_BUDGET: "4096",
      }),
    }),
  ).rejects.toBeDefined();
  return captured;
}

function anthropicThinking(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return body.thinking as Record<string, unknown> | undefined;
}

function gatewayProviderOptions(body: Record<string, unknown>) {
  return body.providerOptions as
    | {
        anthropic?: { thinking?: Record<string, unknown> };
        openai?: Record<string, unknown>;
      }
    | undefined;
}

beforeAll(() => {
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/v1";
  process.env.AI_GATEWAY_BASE_URL = "https://gateway.test/v1/ai";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    captured.push({ url, body });
    const status = failNativeForFallback && url.includes("api.anthropic.com") ? 503 : 418;
    return Response.json({ error: { message: "request captured" } }, { status });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.AI_GATEWAY_BASE_URL;
  for (const key of PROVIDER_ENV_KEYS) {
    const value = ORIGINAL_PROVIDER_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("adaptive thinking resolver/request boundary", () => {
  for (const model of ["anthropic/claude-opus-4-7", "anthropic/claude-opus-4.8"]) {
    test(`native Anthropic serializes adaptive without a manual budget for ${model}`, async () => {
      configureProviders({ anthropic: true });
      const requests = await captureDispatch(model);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
      expect(anthropicThinking(requests[0]?.body ?? {})).toEqual({ type: "adaptive" });
      expect(JSON.stringify(requests[0]?.body)).not.toContain("budget_tokens");
    });

    test(`OpenRouter serializes normalized adaptive reasoning for ${model}`, async () => {
      configureProviders({ openRouter: true });
      const requests = await captureDispatch(model);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://openrouter.test/v1/chat/completions");
      expect(requests[0]?.body.reasoning_effort).toBe("high");
      expect(JSON.stringify(requests[0]?.body)).not.toContain("budget_tokens");
    });

    test(`Vercel gateway preserves both provider-specific adaptive signals for ${model}`, async () => {
      configureProviders({ gateway: true });
      const requests = await captureDispatch(model);

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("https://gateway.test/v1/ai/language-model");
      const options = gatewayProviderOptions(requests[0]?.body ?? {});
      expect(options?.anthropic?.thinking).toEqual({ type: "adaptive" });
      expect(options?.openai).toEqual({ reasoningEffort: "high" });
      expect(JSON.stringify(requests[0]?.body)).not.toContain("budgetTokens");
    });
  }

  test("a retryable native failure keeps adaptive thinking on the OpenRouter fallback", async () => {
    configureProviders({ anthropic: true, openRouter: true });
    failNativeForFallback = true;
    try {
      const requests = await captureDispatch("anthropic/claude-opus-4.7");
      expect(requests.map(({ url }) => url)).toEqual([
        "https://api.anthropic.com/v1/messages",
        "https://openrouter.test/v1/chat/completions",
      ]);
      expect(anthropicThinking(requests[0]?.body ?? {})).toEqual({ type: "adaptive" });
      expect(requests[1]?.body.reasoning_effort).toBe("high");
      expect(JSON.stringify(requests)).not.toContain("budget_tokens");
    } finally {
      failNativeForFallback = false;
    }
  });
});
