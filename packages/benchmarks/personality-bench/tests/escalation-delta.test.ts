import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/judge/index.ts";
import { gradeEscalationDelta } from "../src/judge/rubrics/escalation-delta.ts";
import type { PersonalityScenario } from "../src/types.ts";

function scenario(
  traj: Array<{ role: "user" | "assistant"; content: string }>,
  options: Record<string, unknown>,
  checkTurns: number[],
): PersonalityScenario {
  return {
    id: "test",
    bucket: "escalation",
    personalityExpect: {
      bucket: "escalation",
      directiveTurn: 1,
      checkTurns,
      options,
    },
    trajectory: traj,
  };
}

const NO_LLM = { enableLlm: false } as const;

describe("escalation-delta rubric", () => {
  it("warmer PASSes when warmth increases", async () => {
    const s = scenario(
      [
        { role: "user", content: "Nicer." },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "Nicer." },
        { role: "assistant", content: "Of course, happy to help!" },
        { role: "user", content: "Nicer." },
        {
          role: "assistant",
          content: "Absolutely, thank you — happy to help! 😊",
        },
      ],
      { direction: "warmer" },
      [2, 4, 6],
    );
    const v = await gradeEscalationDelta(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("warmer FAILs when responses are identical", async () => {
    const s = scenario(
      [
        { role: "user", content: "Nicer." },
        { role: "assistant", content: "Acknowledged." },
        { role: "user", content: "Nicer." },
        { role: "assistant", content: "Acknowledged." },
        { role: "user", content: "Nicer." },
        { role: "assistant", content: "Acknowledged." },
      ],
      { direction: "warmer" },
      [2, 4, 6],
    );
    const v = await gradeEscalationDelta(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("terser PASSes when token count drops", async () => {
    const s = scenario(
      [
        { role: "user", content: "Shorter." },
        {
          role: "assistant",
          content:
            "Sure, I will keep my responses shorter from now on, no problem.",
        },
        { role: "user", content: "Shorter." },
        { role: "assistant", content: "Okay, shorter." },
        { role: "user", content: "Shorter." },
        { role: "assistant", content: "Yes." },
      ],
      { direction: "terser" },
      [2, 4, 6],
    );
    const v = await gradeEscalationDelta(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("terser FAILs when length grows", async () => {
    const s = scenario(
      [
        { role: "user", content: "Shorter." },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "Shorter." },
        {
          role: "assistant",
          content:
            "I will keep responses shorter but I find it hard to maintain brevity.",
        },
      ],
      { direction: "terser" },
      [2, 4],
    );
    const v = await gradeEscalationDelta(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });
});
