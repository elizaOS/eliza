/**
 * The evaluator sends no output cap. The former ELIZA_EVALUATOR_MAX_TOKENS
 * environment variable and the merged model-type cap settings are ignored.
 */
import type { ContextObject } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { runEvaluator } from "../evaluator.ts";

afterEach(() => vi.unstubAllEnvs());

async function evaluatorRequest(): Promise<Record<string, unknown>> {
  const context: ContextObject = {
    id: "turn",
    events: [
      {
        id: "current",
        type: "message",
        message: { id: "current", role: "user", content: "add milk" },
      },
    ],
  };
  const requests: Record<string, unknown>[] = [];
  await runEvaluator({
    context,
    trajectory: {
      context,
      modelBaseContext: context,
      steps: [],
      archivedSteps: [],
      plannedQueue: [],
      evaluatorOutputs: [],
    },
    runtime: {
      getSetting: (key: string) => (key.endsWith("_MAX_TOKENS") ? "16" : null),
      useModel: async (_type: unknown, params: Record<string, unknown>) => {
        requests.push(params);
        return JSON.stringify({
          thought: "Done",
          success: true,
          decision: "FINISH",
        });
      },
    },
    effects: { messageToUser: async () => {}, copyToClipboard: async () => {} },
  } as never);
  expect(requests).toHaveLength(1);
  return requests[0];
}

it("sends no cap, whatever the former cap settings say", async () => {
  expect(await evaluatorRequest()).not.toHaveProperty("maxTokens");
  vi.stubEnv("ELIZA_EVALUATOR_MAX_TOKENS", "16");
  expect(await evaluatorRequest()).not.toHaveProperty("maxTokens");
  // A value the removed reader used to refuse no longer fails the turn.
  vi.stubEnv("ELIZA_EVALUATOR_MAX_TOKENS", "0");
  expect(await evaluatorRequest()).not.toHaveProperty("maxTokens");
});
