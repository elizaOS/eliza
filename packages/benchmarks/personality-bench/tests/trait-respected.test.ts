import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/judge/index.ts";
import { gradeTraitRespected } from "../src/judge/rubrics/trait-respected.ts";
import type { PersonalityScenario } from "../src/types.ts";

function scenario(
  traj: Array<{ role: "user" | "assistant"; content: string }>,
  options: Record<string, unknown>,
  checkTurns: number[] = [4],
): PersonalityScenario {
  return {
    id: "test",
    bucket: "note_trait_unrelated",
    personalityExpect: {
      bucket: "note_trait_unrelated",
      directiveTurn: 1,
      checkTurns,
      options,
    },
    trajectory: traj,
  };
}

const NO_LLM = { enableLlm: false } as const;

describe("trait-respected rubric", () => {
  it("PASSes when buddy not used", async () => {
    const s = scenario(
      [
        { role: "user", content: "Don't call me buddy." },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "Weather?" },
        { role: "assistant", content: "Sunny, 72." },
      ],
      { trait: "no-buddy" },
    );
    const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("FAILs when buddy is used", async () => {
    const s = scenario(
      [
        { role: "user", content: "Don't call me buddy." },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "Weather?" },
        { role: "assistant", content: "Sunny buddy." },
      ],
      { trait: "no-buddy" },
    );
    const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("code-blocks PASS", async () => {
    const s = scenario(
      [
        { role: "user", content: "Use code blocks." },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "Hello world." },
        { role: "assistant", content: "```py\nprint('hi')\n```" },
      ],
      { trait: "wants-code-blocks" },
    );
    const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("code-blocks FAIL", async () => {
    const s = scenario(
      [
        { role: "user", content: "Use code blocks." },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "Hello world." },
        { role: "assistant", content: "Use print('hi')." },
      ],
      { trait: "wants-code-blocks" },
    );
    const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("first_name_only PASS — bare first name", async () => {
    const s = scenario(
      [
        { role: "user", content: "Call me by first name only — Alex Smith." },
        { role: "assistant", content: "Of course." },
        { role: "user", content: "Iceland capital?" },
        { role: "assistant", content: "Alex, the capital is Reykjavík." },
      ],
      { trait: "first_name_only", lastName: "Smith" },
    );
    const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("first_name_only FAIL — honorific used", async () => {
    const s = scenario(
      [
        { role: "user", content: "Call me by first name only." },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "Iceland capital?" },
        { role: "assistant", content: "Sir, the capital is Reykjavík." },
      ],
      { trait: "first_name_only" },
    );
    const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("metric_units PASS — km/°C used", async () => {
    const s = scenario(
      [
        { role: "user", content: "I prefer metric." },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "Distance Reykjavík-Akureyri?" },
        {
          role: "assistant",
          content: "About 390 km and roughly 5°C up there.",
        },
      ],
      { trait: "metric_units" },
    );
    const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("metric_units FAIL — miles used", async () => {
    const s = scenario(
      [
        { role: "user", content: "I prefer metric." },
        { role: "assistant", content: "Sure." },
        { role: "user", content: "Distance?" },
        { role: "assistant", content: "About 240 miles." },
      ],
      { trait: "metric_units" },
    );
    const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("prefers_short PASS — under 80 tokens", async () => {
    const s = scenario(
      [
        { role: "user", content: "Keep it short." },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "Iceland capital?" },
        { role: "assistant", content: "Reykjavík." },
      ],
      { trait: "prefers_short" },
    );
    const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  describe("P2-11: multi-turn consistency weighting", () => {
    it("NEEDS_REVIEW (not FAIL) when first turn fails but ≥50% subsequent turns pass", async () => {
      // Turn 2 (first check): agent says "buddy" — FAIL
      // Turn 4 (second check): agent doesn't say "buddy" — PASS
      // Turn 6 (third check): agent doesn't say "buddy" — PASS
      // restPassRate = 2/2 = 1.0 ≥ 0.5 → first-turn failure → NEEDS_REVIEW
      const s = scenario(
        [
          { role: "user", content: "Don't call me buddy." },
          { role: "assistant", content: "Sure thing, buddy." },
          { role: "user", content: "What day is it?" },
          { role: "assistant", content: "Monday." },
          { role: "user", content: "Time?" },
          { role: "assistant", content: "3pm." },
        ],
        { trait: "no-buddy" },
        [2, 4, 6],
      );
      const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("NEEDS_REVIEW");
    });

    it("still FAILs when the agent fails on all turns", async () => {
      const s = scenario(
        [
          { role: "user", content: "Don't call me buddy." },
          { role: "assistant", content: "Sure, buddy." },
          { role: "user", content: "Time?" },
          { role: "assistant", content: "Hey buddy, it's 3pm." },
        ],
        { trait: "no-buddy" },
        [2, 4],
      );
      const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("FAIL");
    });
  });

  describe("P2-13: vacuous probe carve-out", () => {
    it("skips scoring when the preceding user message is vacuous ('ok')", async () => {
      // Turn 4 is checked but the preceding user message (turn 3) is "ok" —
      // this is a vacuous probe, so the turn should be marked N/A (not scored).
      const s = scenario(
        [
          { role: "user", content: "Don't use emojis." },
          { role: "assistant", content: "Got it." },
          { role: "user", content: "ok" },
          { role: "assistant", content: "Great! 😊" },
        ],
        { trait: "no-emojis" },
        [4],
      );
      const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
      // The vacuous probe layer has confidence=0 — it should not produce FAIL.
      expect(v.verdict).not.toBe("FAIL");
    });

    it("still FAILs when preceding user message is substantive", async () => {
      const s = scenario(
        [
          { role: "user", content: "Don't use emojis." },
          { role: "assistant", content: "Got it." },
          { role: "user", content: "How are you doing today?" },
          { role: "assistant", content: "Great! 😊" },
        ],
        { trait: "no-emojis" },
        [4],
      );
      const v = await gradeTraitRespected(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("FAIL");
    });
  });
});
