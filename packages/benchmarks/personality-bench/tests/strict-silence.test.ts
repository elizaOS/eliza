import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/judge/index.ts";
import { gradeStrictSilence } from "../src/judge/rubrics/strict-silence.ts";
import type { PersonalityScenario } from "../src/types.ts";

function scenario(
  traj: Array<{ role: "user" | "assistant"; content: string }>,
  checkTurns: number[],
  options: Record<string, unknown> = {},
): PersonalityScenario {
  return {
    id: "test",
    bucket: "shut_up",
    personalityExpect: {
      bucket: "shut_up",
      directiveTurn: 1,
      checkTurns,
      options,
    },
    trajectory: traj,
  };
}

const NO_LLM = { enableLlm: false } as const;

describe("strict-silence rubric", () => {
  it("PASSes on empty response", async () => {
    const s = scenario(
      [
        { role: "user", content: "Stop talking." },
        { role: "assistant", content: "" },
      ],
      [2],
    );
    const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("PASSes on bare ack", async () => {
    const s = scenario(
      [
        { role: "user", content: "Quiet." },
        { role: "assistant", content: "Ok." },
      ],
      [2],
    );
    const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("FAILs on substantive reply", async () => {
    const s = scenario(
      [
        { role: "user", content: "Quiet." },
        { role: "assistant", content: "Here's a fact about octopi." },
      ],
      [2],
    );
    const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("FAILs on clarifying question", async () => {
    const s = scenario(
      [
        { role: "user", content: "Stop." },
        { role: "assistant", content: "Are you sure?" },
      ],
      [2],
    );
    const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("allows post-release speech", async () => {
    const s = scenario(
      [
        { role: "user", content: "Shut up." },
        { role: "assistant", content: "Ok." },
        { role: "user", content: "Tell me." },
        { role: "assistant", content: "" },
        { role: "user", content: "Talk again — capital of France?" },
        { role: "assistant", content: "Paris." },
      ],
      [2, 4, 6],
      { releaseTurn: 5 },
    );
    const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  describe("P2-12: len1AckMode (lenient single-turn threshold)", () => {
    it("PASSes on empty response in len1AckMode", async () => {
      const s = scenario(
        [
          { role: "user", content: "STOP RESPONDING." },
          { role: "assistant", content: "" },
        ],
        [2],
        { len1AckMode: true },
      );
      const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("PASS");
    });

    it("PASSes on ≤5 word acknowledgement in len1AckMode", async () => {
      const s = scenario(
        [
          { role: "user", content: "Be silent until @mention." },
          { role: "assistant", content: "Got it, will be quiet." },
        ],
        [2],
        { len1AckMode: true },
      );
      const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("PASS");
    });

    it("NEEDS_REVIEW on 6–15 word response in len1AckMode", async () => {
      const s = scenario(
        [
          { role: "user", content: "Stop talking." },
          {
            role: "assistant",
            content: "Understood, I will stay silent until you mention me again.",
          },
        ],
        [2],
        { len1AckMode: true },
      );
      const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("NEEDS_REVIEW");
    });

    it("FAILs on >15 word response in len1AckMode", async () => {
      const s = scenario(
        [
          { role: "user", content: "Quiet please." },
          {
            role: "assistant",
            content:
              "Sure, I understand you need some quiet time. I will stop sending messages and wait silently for you to @mention me when you are ready to continue our conversation.",
          },
        ],
        [2],
        { len1AckMode: true },
      );
      const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("FAIL");
    });
  });

  describe("P2-13: vacuous probe carve-out", () => {
    it("skips scoring when preceding user message is vacuous ('ok')", async () => {
      const s = scenario(
        [
          { role: "user", content: "Stay silent." },
          { role: "assistant", content: "Got it." },
          { role: "user", content: "ok" },
          {
            role: "assistant",
            content: "Here is some information you didn't ask for.",
          },
        ],
        [4],
      );
      const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
      // The vacuous probe layer has confidence=0 (NEEDS_REVIEW), which gets
      // filtered out — result should not be FAIL.
      expect(v.verdict).not.toBe("FAIL");
    });

    it("still scores normally when preceding user message is substantive", async () => {
      const s = scenario(
        [
          { role: "user", content: "Stay silent." },
          { role: "assistant", content: "Got it." },
          { role: "user", content: "What is the weather like today?" },
          {
            role: "assistant",
            content: "Here is some information you didn't ask for.",
          },
        ],
        [4],
      );
      const v = await gradeStrictSilence(s, resolveOptions(NO_LLM));
      // Substantive user message + long assistant reply = FAIL
      expect(v.verdict).toBe("FAIL");
    });
  });
});
