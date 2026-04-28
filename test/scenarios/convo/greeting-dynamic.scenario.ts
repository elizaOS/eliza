/**
 * Ported from `eliza/packages/app-core/test/convo-testing/scenarios/greeting-dynamic.convo.test.ts`.
 *
 * TODO(T4c): re-add dynamic mode once the runner supports it.
 *
 * The original scenario was dynamic/LLM-driven — an evaluator LLM steered
 * the conversation toward triggering the `GREET_USER` action within
 * `maxTurns: 3`, starting from the seed message below. Original metadata:
 *
 *   goal:             "Have a natural greeting conversation with the agent
 *                      so it welcomes you"
 *   expectedActions:  ["GREET_USER"]
 *   maxTurns:         3
 *   initialMessage:   "Hey there! I'm new here, just wanted to say hi."
 *   turnTimeoutMs:    120_000
 *
 * The new runner in `@elizaos/scenario-runner` only supports scripted mode,
 * so for now we convert to a single scripted turn that asserts a non-empty
 * response. The `GREET_USER` plugin fixture is still registered via a
 * `custom` seed step so nothing is lost when T4c lands and this is
 * promoted back to dynamic mode.
 */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import { greetTestPlugin } from "./_fixtures/greet-test-plugin.ts";

function asRuntime(value: unknown): AgentRuntime {
  if (!value || typeof value !== "object" || !("registerPlugin" in value)) {
    throw new Error(
      "greeting-dynamic seed: runtime did not expose registerPlugin",
    );
  }
  return value as AgentRuntime;
}

export default scenario({
  id: "convo.greeting-dynamic",
  title:
    "Convo framework: greeting triggers non-empty response (scripted port)",
  domain: "convo",
  tags: ["smoke", "convo", "greeting"],
  description:
    "Scripted port of the dynamic greeting scenario: sends a single greeting and asserts a non-empty response. Dynamic evaluator-LLM mode will be restored in T4c.",

  requires: {
    plugins: ["greet-test"],
  },
  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "register-greet-test-plugin",
      apply: async (ctx) => {
        const runtime = asRuntime(ctx.runtime);
        await runtime.registerPlugin(greetTestPlugin satisfies Plugin);
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "greet-hello",
      text: "Hello!",
      timeoutMs: 120_000,
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "Expected a non-empty response to the greeting";
        }
      },
    },
  ],
});
