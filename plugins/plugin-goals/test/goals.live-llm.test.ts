/**
 * LIVE real-LLM test for the goals semantic evaluator.
 *
 * Drives the PRODUCTION `evaluateGoalProgressWithLlm` (real prompt → real model
 * → real JSON parse → strict enum validation, with the production repair pass)
 * against a real local OpenAI-compatible LLM (Ollama by default). It is the
 * goals-domain counterpart of the inbox live-LLM test — proving a second
 * decomposed plugin's LLM path works against an actual model, no mock.
 *
 * The evaluator only needs `runtime.useModel`, so a minimal runtime stub backed
 * by the local endpoint is enough (no full runtime boot). Gated like the other
 * live tests: SKIPS by default, runs on `GOALS_LLM_LIVE_TEST=1` (or post-merge).
 * No external credentials — LOCAL model.
 *
 *   GOALS_LLM_LIVE_TEST=1 bun run --cwd plugins/plugin-goals test goals.live-llm
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsGoalDefinition } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { evaluateGoalProgressWithLlm } from "../src/goal-semantic-evaluator.ts";

const LIVE =
  process.env.GOALS_LLM_LIVE_TEST === "1" ||
  process.env.TEST_LANE === "post-merge";

const BASE_URL = (
  process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1"
).replace(/\/$/, "");
const MODEL = process.env.OLLAMA_MODEL ?? "gpt-4o-mini";

async function callLocalLlm(prompt: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM endpoint ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

// Only `useModel` is exercised by the evaluator.
const runtimeStub = {
  useModel: async (_type: unknown, params: { prompt?: string }) =>
    callLocalLlm(String(params.prompt)),
} as unknown as IAgentRuntime;

// Serialized into the prompt by the evaluator; field presence only shapes the
// prompt text, so a plausible literal cast is sufficient for a live test.
const goal = {
  id: "goal-fitness",
  title: "Run a half marathon",
  description: "Train consistently to finish a 21km race in under 2h30m.",
  status: "active",
  cadence: "weekly",
  createdAt: "2026-01-05T00:00:00.000Z",
} as unknown as LifeOpsGoalDefinition;

describe.skipIf(!LIVE)("goals semantic evaluator — LIVE local LLM", () => {
  it("a real local LLM produces a valid semantic evaluation (parse + enum)", async () => {
    const result = await evaluateGoalProgressWithLlm({
      runtime: runtimeStub,
      evidence: {
        recentTasks: [
          { title: "10km long run", completedAt: "2026-06-15", status: "done" },
          {
            title: "Interval session",
            completedAt: "2026-06-12",
            status: "done",
          },
        ],
        measurements: [
          { metric: "longest_run_km", value: 16, at: "2026-06-15" },
        ],
        notes: "Consistent training the past two weeks; longest run now 16km.",
      },
      goal,
      nowIso: "2026-06-18T12:00:00.000Z",
    });

    // The production evaluator (prompt → real model → parse → enum validation →
    // repair pass) returned a structured evaluation from a real LLM.
    expect(result).not.toBeNull();
    expect(["idle", "needs_attention", "on_track", "at_risk"]).toContain(
      result?.reviewState,
    );
    expect(typeof result?.explanation).toBe("string");
    if (result?.progressScore !== null && result?.progressScore !== undefined) {
      expect(result.progressScore).toBeGreaterThanOrEqual(0);
      expect(result.progressScore).toBeLessThanOrEqual(1);
    }
    if (result?.confidence !== null && result?.confidence !== undefined) {
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    }
  }, 120_000);
});
