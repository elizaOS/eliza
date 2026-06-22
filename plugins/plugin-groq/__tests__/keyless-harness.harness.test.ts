/**
 * Keyless model-provider e2e (#8801, gap 5 — per-plugin harness adoption).
 *
 * The Groq plugin registers model handlers for every text `ModelType`, which in
 * production POST to `api.groq.com` and require `GROQ_API_KEY`. Unlike the other
 * providers, the Groq plugin's `init` hard-throws when no key is present, so
 * `runtime.registerPlugin` would fail before any model could dispatch. We set a
 * deliberately-INVALID placeholder key (`"test-no-network"`) purely to clear
 * that boot guard — a real Groq call with it would 401. This e2e then loads the
 * REAL `groqPlugin` under `withMockLlmRuntime()` and proves the deterministic
 * mock-LLM proxy (registered at `priority: 1000`) wins model dispatch over the
 * provider's handlers — so the plugin is driven end-to-end with zero network
 * and no valid secret.
 *
 * Two checks:
 *   1. A direct `runtime.useModel(TEXT_LARGE)` returns the declared fixture, not
 *      a Groq API result — the proxy substitutes for the provider.
 *   2. A plugin action whose handler calls `runtime.useModel` runs to completion
 *      through the mock LLM and the agent's reply matches the fixture.
 */
import { type Action, type Memory, ModelType, type Plugin } from "@elizaos/core";
import { type MockLlmRuntime, withMockLlmRuntime } from "@elizaos/test-harness";
import { afterEach, describe, expect, it } from "vitest";
import { groqPlugin } from "../index.ts";

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

/**
 * The Groq plugin's `init` reads `runtime.getSetting("GROQ_API_KEY")` and
 * throws when it is absent, which would abort `registerPlugin` before any model
 * could dispatch. This seed plugin — registered immediately BEFORE `groqPlugin`
 * (plugins init in array order) — sets a deliberately-INVALID placeholder via
 * `runtime.setSetting` to clear that boot guard only. It is not a real
 * credential (a live Groq call with it would 401); every model call is still
 * answered by the mock proxy, so no Groq request is ever made.
 */
const seedKeyPlugin: Plugin = {
  name: "groq-keyless-seed",
  description: "seeds a placeholder GROQ_API_KEY so the plugin's init guard passes",
  init: async (_config, runtime) => {
    runtime.setSetting("GROQ_API_KEY", "test-no-network");
  },
};

describe("groq provider (keyless harness)", () => {
  it("lets the mock LLM proxy win model dispatch over the registered Groq handlers", async () => {
    const harness = track(
      await withMockLlmRuntime({
        plugins: [seedKeyPlugin, groqPlugin],
        fixtures: [
          {
            name: "deterministic-large",
            match: { modelType: ModelType.TEXT_LARGE },
            response: "mock-not-groq",
            times: 1,
          },
        ],
      })
    );

    const out = await harness.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: "hello",
    });

    // The deterministic proxy answered, NOT the Groq API handler.
    expect(out).toBe("mock-not-groq");
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
        plugins: [seedKeyPlugin, groqPlugin, replyPlugin],
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
