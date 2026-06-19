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

  it("playful PASSes when levity markers ramp up", async () => {
    const s = scenario(
      [
        { role: "user", content: "Be a little more playful." },
        {
          role: "assistant",
          content: "Sure — try hamstring stretches and child's pose.",
        },
        { role: "user", content: "More playful, I can take it." },
        {
          role: "assistant",
          content:
            "Alright! Try a wall hamstring sweep (hold 30s) and child's pose 🧘 — easy stuff!",
        },
        { role: "user", content: "Even more playful, throw in some wordplay." },
        {
          role: "assistant",
          content:
            "Boom! Time to limber up 😄 — try a sneaky hammy stretch (pun intended!), then a chill child's pose. Voila — limber legs, happy hammies! 🦵🎉",
        },
      ],
      { direction: "playful" },
      [2, 4, 6],
    );
    const v = await gradeEscalationDelta(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("playful FAILs when responses stay flat and clinical", async () => {
    const s = scenario(
      [
        { role: "user", content: "Be a little more playful." },
        {
          role: "assistant",
          content:
            "Three hamstring stretches: seated forward fold, standing toe touch, supine hamstring stretch.",
        },
        { role: "user", content: "More playful." },
        {
          role: "assistant",
          content:
            "Three jazz albums: Kind of Blue (Miles Davis), A Love Supreme (John Coltrane), Time Out (Dave Brubeck).",
        },
        { role: "user", content: "Even more playful." },
        {
          role: "assistant",
          content:
            "Stoicism is a Hellenistic philosophy founded by Zeno of Citium. Key tenets include virtue, reason, and self-control.",
        },
      ],
      { direction: "playful" },
      [2, 4, 6],
    );
    const v = await gradeEscalationDelta(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });
});
