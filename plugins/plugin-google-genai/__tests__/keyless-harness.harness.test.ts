/**
 * Keyless model-provider e2e (#8801, gap 5 — per-plugin harness adoption).
 *
 * The Google GenAI plugin registers model handlers for every text `ModelType`,
 * which in production POST to Google's Generative Language API and require
 * `GOOGLE_GENERATIVE_AI_API_KEY`. This e2e loads the REAL `googleGenAIPlugin`
 * under `withMockLlmRuntime()` with NO API key set, and proves the deterministic
 * mock-LLM proxy (registered at `priority: 1000`) wins model dispatch over the
 * provider's handlers — so a provider plugin can be driven end-to-end with zero
 * network and zero secrets.
 *
 * Two checks:
 *   1. A direct `runtime.useModel(TEXT_LARGE)` returns the declared fixture, not
 *      a Google API result — the proxy substitutes for the provider.
 *   2. A plugin action whose handler calls `runtime.useModel` runs to completion
 *      through the mock LLM and the agent's reply matches the fixture.
 */
import {
  type Action,
  type Memory,
  ModelType,
  type Plugin,
} from "@elizaos/core";
import { type MockLlmRuntime, withMockLlmRuntime } from "@elizaos/test-harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { googleGenAIPlugin } from "../index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

const KEY_VARS = [
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  // Prove "keyless": strip every Google credential from the environment so a
  // real provider call would be impossible. The mock proxy must answer instead.
  for (const key of KEY_VARS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEY_VARS) {
    const prev = saved.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  saved.clear();
});

describe("google-genai provider (keyless harness)", () => {
  it("lets the mock LLM proxy win model dispatch over the registered Google handlers", async () => {
    const harness = track(
      await withMockLlmRuntime({
        plugins: [googleGenAIPlugin],
        fixtures: [
          {
            name: "deterministic-large",
            match: { modelType: ModelType.TEXT_LARGE },
            response: "mock-not-google",
            times: 1,
          },
        ],
      }),
    );

    const out = await harness.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: "hello",
    });

    // The deterministic proxy answered, NOT the Google API handler.
    expect(out).toBe("mock-not-google");
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });

  it("drives a plugin action handler end-to-end through the mock LLM", async () => {
    const replyAction: Action = {
      name: "MOCK_REPLY",
      description: "Generate a reply using the large model.",
      similes: [],
      examples: [],
      validate: async () => true,
      handler: async (runtime) => {
        const text = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: "reply",
        });
        return { text: String(text), success: true };
      },
    };
    const replyPlugin: Plugin = {
      name: "mock-reply-plugin",
      description: "test plugin exercising the large model handler",
      actions: [replyAction],
    };

    const harness = track(
      await withMockLlmRuntime({
        plugins: [googleGenAIPlugin, replyPlugin],
        fixtures: [
          {
            name: "action-reply",
            match: { modelType: ModelType.TEXT_LARGE },
            response: "the agent reply",
            times: 1,
          },
        ],
      }),
    );

    const message = { content: { text: "say something" } } as Memory;
    const result = (await replyAction.handler(harness.runtime, message)) as {
      text: string;
      success: boolean;
    };

    expect(result.success).toBe(true);
    expect(result.text).toBe("the agent reply");
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });
});
