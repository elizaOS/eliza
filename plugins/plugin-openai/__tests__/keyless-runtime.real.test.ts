/**
 * Keyless model-provider e2e (#8801, gap 5 — per-plugin provider adoption).
 *
 * The OpenAI plugin registers model handlers for every text `ModelType`, which
 * in production POST to `api.openai.com` and require `OPENAI_API_KEY`. This e2e
 * loads the REAL `openaiPlugin` under `createTestRuntimeWithModelProvider()` with NO API key
 * set, and proves the deterministic deterministic-model-provider proxy (registered at
 * `priority: 1000`) wins model dispatch over the provider's handlers — so a
 * provider plugin can be driven end-to-end with zero network and zero secrets.
 *
 * Two checks:
 *   1. A direct `runtime.useModel(TEXT_LARGE)` returns the declared fixture, not
 *      an OpenAI API result — the proxy substitutes for the provider.
 *   2. A plugin action whose handler calls `runtime.useModel` runs to completion
 *      through the deterministic model provider and the agent's reply matches the fixture.
 */
import { type Action, type Memory, ModelType, type Plugin } from "@elizaos/core";
import { type ModelProviderTestRuntime, createTestRuntimeWithModelProvider } from "@elizaos/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openaiPlugin } from "../index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: ModelProviderTestRuntime): ModelProviderTestRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

let savedApiKey: string | undefined;

beforeEach(() => {
  // Prove "keyless": strip the OpenAI credential from the environment so a real
  // provider call would be impossible. The mock proxy must answer instead.
  savedApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedApiKey;
});

describe("openai provider (deterministic model-provider runtime)", () => {
  it("lets the deterministic model provider proxy win model dispatch over the registered OpenAI handlers", async () => {
    const harness = track(
      await createTestRuntimeWithModelProvider({
        plugins: [openaiPlugin],
        fixtures: [
          {
            name: "deterministic-large",
            match: { modelType: ModelType.TEXT_LARGE },
            response: "mock-not-openai",
            times: 1,
          },
        ],
      })
    );

    const out = await harness.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: "hello",
    });

    // The deterministic provider answered, NOT the OpenAI API handler.
    expect(out).toBe("mock-not-openai");
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });

  it("drives a plugin action handler end-to-end through the deterministic model provider", async () => {
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
      await createTestRuntimeWithModelProvider({
        plugins: [openaiPlugin, replyPlugin],
        fixtures: [
          {
            name: "action-reply",
            match: { modelType: ModelType.TEXT_LARGE },
            response: "the agent reply",
            times: 1,
          },
        ],
      })
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
