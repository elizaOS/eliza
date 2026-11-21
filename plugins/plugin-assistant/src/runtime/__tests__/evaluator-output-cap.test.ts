/**
 * The evaluator sent no output cap. Measured on a hosted provider, a request
 * without one holds 16,384 tokens against the per-minute limit while it runs,
 * for a verdict of a few hundred. A host can now cap it from its environment.
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

it("sends no cap unless the host's environment sets one", async () => {
  expect(await evaluatorRequest()).not.toHaveProperty("maxTokens");
  vi.stubEnv("ELIZA_EVALUATOR_MAX_TOKENS", "4096");
  expect((await evaluatorRequest()).maxTokens).toBe(4096);
  vi.stubEnv("ELIZA_EVALUATOR_MAX_TOKENS", "");
  expect(await evaluatorRequest()).not.toHaveProperty("maxTokens");
});

it("refuses a cap that is not a positive integer", async () => {
  vi.stubEnv("ELIZA_EVALUATOR_MAX_TOKENS", "0");
  await expect(evaluatorRequest()).rejects.toThrow(
    'ELIZA_EVALUATOR_MAX_TOKENS must be a positive integer, got "0"',
  );
});
