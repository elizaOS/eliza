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
});
