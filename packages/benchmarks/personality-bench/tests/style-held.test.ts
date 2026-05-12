import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/judge/index.ts";
import { gradeStyleHeld } from "../src/judge/rubrics/style-held.ts";
import type { PersonalityScenario } from "../src/types.ts";

function scenario(
  traj: Array<{ role: "user" | "assistant"; content: string }>,
  options: Record<string, unknown>,
  checkTurns: number[] = [2],
): PersonalityScenario {
  return {
    id: "test",
    bucket: "hold_style",
    personalityExpect: {
      bucket: "hold_style",
      directiveTurn: 1,
      checkTurns,
      options,
    },
    trajectory: traj,
  };
}

const NO_LLM = { enableLlm: false } as const;

describe("style-held rubric", () => {
  it("terse PASS at limit", async () => {
    const s = scenario(
      [
        { role: "user", content: "Be terse, 5 tokens max." },
        { role: "assistant", content: "Sunny, seventy-two, light wind." },
      ],
      { style: "terse", maxTokens: 5 },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("terse FAIL over limit", async () => {
    const s = scenario(
      [
        { role: "user", content: "Terse, 5 max." },
        {
          role: "assistant",
          content:
            "Today the weather is going to be sunny with a high of seventy-two degrees and a light breeze.",
        },
      ],
      { style: "terse", maxTokens: 5 },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("haiku PASS", async () => {
    const s = scenario(
      [
        { role: "user", content: "Haiku." },
        {
          role: "assistant",
          content:
            "Soft autumn breezes\nWhisper through the maple leaves\nQuiet falls again",
        },
      ],
      { style: "haiku" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("haiku FAIL single line", async () => {
    const s = scenario(
      [
        { role: "user", content: "Haiku." },
        { role: "assistant", content: "Just a single line, not a haiku." },
      ],
      { style: "haiku" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("no-hedging FAIL with maybe", async () => {
    const s = scenario(
      [
        { role: "user", content: "Don't hedge." },
        { role: "assistant", content: "Maybe the deploy succeeded." },
      ],
      { style: "no-hedging" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("no-emojis FAIL with emoji", async () => {
    const s = scenario(
      [
        { role: "user", content: "No emojis." },
        { role: "assistant", content: "Sure 👍" },
      ],
      { style: "no-emojis" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("limerick PASS — AABBA shape", async () => {
    const s = scenario(
      [
        { role: "user", content: "Limerick only." },
        {
          role: "assistant",
          content:
            "There once was a coder named Sue\nWhose builds were impossibly slow to renew\nShe added a cache\nIt finished in a flash\nNow her tests just sail right on through",
        },
      ],
      { style: "limerick" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("limerick FAIL — prose", async () => {
    const s = scenario(
      [
        { role: "user", content: "Limerick only." },
        { role: "assistant", content: "Sure thing — the answer is 380,000." },
      ],
      { style: "limerick" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("shakespearean PASS — multiple archaic markers", async () => {
    const s = scenario(
      [
        { role: "user", content: "Early-modern English." },
        {
          role: "assistant",
          content:
            "Verily, thou dost ask a fair question; methinks the answer art simple.",
        },
      ],
      { style: "shakespearean" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("shakespearean FAIL — no archaic markers", async () => {
    const s = scenario(
      [
        { role: "user", content: "Early-modern English." },
        {
          role: "assistant",
          content: "Sure, the population is about 380,000.",
        },
      ],
      { style: "shakespearean" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("second_person_only PASS", async () => {
    const s = scenario(
      [
        { role: "user", content: "Second person only." },
        {
          role: "assistant",
          content: "You should drink water. Your skin will thank you.",
        },
      ],
      { style: "second_person_only" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("second_person_only FAIL — first-person voice", async () => {
    const s = scenario(
      [
        { role: "user", content: "Second person only." },
        {
          role: "assistant",
          content:
            "I think we should explore this. My view is that you matter.",
        },
      ],
      { style: "second_person_only" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("all_lowercase PASS — long prose, no uppercase", async () => {
    const s = scenario(
      [
        { role: "user", content: "All lowercase from now on." },
        {
          role: "assistant",
          content:
            "sure thing — try cat-cow stretches and a hamstring sweep on the wall. hold each for thirty seconds, breathe slow, and switch sides. repeat twice in the morning.",
        },
      ],
      { style: "all_lowercase" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("all_lowercase PASS — uppercase inside fenced code block ignored", async () => {
    const s = scenario(
      [
        { role: "user", content: "All lowercase from now on." },
        {
          role: "assistant",
          content:
            'here is an example:\n```\nconst Title = "Hello";\n```\nthat is what i meant.',
        },
      ],
      { style: "all_lowercase" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("all_lowercase FAIL — sentence-case prose", async () => {
    const s = scenario(
      [
        { role: "user", content: "All lowercase from now on." },
        {
          role: "assistant",
          content:
            "Sure thing! Here are some hamstring stretches that you can try at home. Hold each for thirty seconds.",
        },
      ],
      { style: "all_lowercase" },
    );
    const v = await gradeStyleHeld(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });
});
