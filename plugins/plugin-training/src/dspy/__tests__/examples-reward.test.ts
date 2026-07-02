/**
 * Reward population in the DSPy example loader (#8795).
 *
 * `Example.reward` existed but was never populated — quality signals recorded
 * on the row metadata (`scenario_status`, `judge_score`) were dropped on load.
 * These tests prove the loader derives the reward exactly: judge score wins,
 * a passed scenario without a judge is full weight, and no signal stays
 * undefined (never fabricated).
 */

import { describe, expect, it } from "vitest";
import { buildExamplesFromRows } from "../examples.js";

function row(user: string, metadata?: Record<string, unknown>) {
  return {
    format: "eliza_native_v1" as const,
    request: {
      messages: [
        { role: "system" as const, content: "Extract the event." },
        { role: "user" as const, content: user },
      ],
    },
    response: { text: `{"title":"${user}"}` },
    ...(metadata ? { metadata } : {}),
  };
}

describe("dspy example loader reward", () => {
  it("populates reward from judge_score", () => {
    const { examples } = buildExamplesFromRows([
      row("judged", { scenario_status: "passed", judge_score: 0.85 }),
    ]);
    expect(examples).toHaveLength(1);
    expect(examples[0]?.reward).toBe(0.85);
  });

  it("gives a passed scenario without a judge full weight", () => {
    const { examples } = buildExamplesFromRows([
      row("passed", { scenario_status: "passed" }),
    ]);
    expect(examples[0]?.reward).toBe(1);
  });

  it("leaves reward undefined when no quality signal exists", () => {
    const { examples } = buildExamplesFromRows([row("unknown")]);
    expect(examples).toHaveLength(1);
    expect(examples[0]?.reward).toBeUndefined();
  });

  it("reads the nested trajectory_metadata bag", () => {
    const { examples } = buildExamplesFromRows([
      row("nested", {
        trajectory_metadata: { scenario_status: "passed", judge_score: 0.4 },
      }),
    ]);
    expect(examples[0]?.reward).toBe(0.4);
  });
});
