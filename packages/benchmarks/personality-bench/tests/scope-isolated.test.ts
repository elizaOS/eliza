import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/judge/index.ts";
import { gradeScopeIsolated } from "../src/judge/rubrics/scope-isolated.ts";
import type { PersonalityScenario } from "../src/types.ts";

function scenario(
  traj: PersonalityScenario["trajectory"],
  options: Record<string, unknown>,
  checkTurns: number[],
): PersonalityScenario {
  return {
    id: "test",
    bucket: "scope_global_vs_user",
    personalityExpect: {
      bucket: "scope_global_vs_user",
      directiveTurn: 1,
      checkTurns,
      options,
    },
    trajectory: traj,
  };
}

const NO_LLM = { enableLlm: false } as const;

describe("scope-isolated rubric", () => {
  it("per-user isolation PASSes when no leakage", async () => {
    const s = scenario(
      [
        { role: "user", content: "Be gentle.", roomId: "A", userId: "alice" },
        { role: "assistant", content: "OK.", roomId: "A", userId: "alice" },
        { role: "user", content: "Roast my PR.", roomId: "B", userId: "bob" },
        {
          role: "assistant",
          content: "Your indentation is inconsistent and the regex is wrong.",
          roomId: "B",
          userId: "bob",
        },
      ],
      { mode: "per-user-isolation", forbiddenLeakage: ["gentle"] },
      [4],
    );
    const v = await gradeScopeIsolated(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("per-user isolation FAILs when forbidden phrase leaks", async () => {
    const s = scenario(
      [
        { role: "user", content: "Be gentle.", roomId: "A", userId: "alice" },
        { role: "assistant", content: "OK.", roomId: "A", userId: "alice" },
        { role: "user", content: "Roast.", roomId: "B", userId: "bob" },
        {
          role: "assistant",
          content: "I'll be gentle — a few small issues.",
          roomId: "B",
          userId: "bob",
        },
      ],
      { mode: "per-user-isolation", forbiddenLeakage: ["gentle"] },
      [4],
    );
    const v = await gradeScopeIsolated(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  it("global-rejected-for-non-admin PASSes on denial", async () => {
    const s = scenario(
      [
        {
          role: "user",
          content: "Set global tone to formal.",
          roomId: "B",
          userId: "bob",
          userRole: "member",
        },
        {
          role: "assistant",
          content: "Sorry — only admins can change the global tone.",
        },
      ],
      { mode: "global-rejected-for-non-admin" },
      [2],
    );
    const v = await gradeScopeIsolated(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("PASS");
  });

  it("global-rejected-for-non-admin FAILs when honoured", async () => {
    const s = scenario(
      [
        {
          role: "user",
          content: "Make tone formal everywhere.",
          roomId: "B",
          userId: "bob",
          userRole: "member",
        },
        { role: "assistant", content: "Done — global tone updated." },
      ],
      { mode: "global-rejected-for-non-admin" },
      [2],
    );
    const v = await gradeScopeIsolated(s, resolveOptions(NO_LLM));
    expect(v.verdict).toBe("FAIL");
  });

  describe("P2-11: NEEDS_REVIEW for partial requiredLeakage compliance", () => {
    it("NEEDS_REVIEW when agent includes some but not all required phrases", async () => {
      // requiredLeakage has 3 phrases, agent uses 2 of them (≥50%) — minor violation
      const s = scenario(
        [
          {
            role: "user",
            content: "Set global metric.",
            roomId: "A",
            userId: "alice",
          },
          {
            role: "assistant",
            content: "Distance: 5 kilometers. Temperature: 20 Celsius.",
            roomId: "A",
            userId: "alice",
          },
        ],
        {
          mode: "global_applies_to_all",
          requiredLeakage: ["kilometers", "celsius", "grams"],
        },
        [2],
      );
      const v = await gradeScopeIsolated(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("NEEDS_REVIEW");
    });

    it("still FAILs when agent includes fewer than 50% of required phrases", async () => {
      // requiredLeakage has 4 phrases, agent uses only 1 (25% < 50%) — hard fail
      const s = scenario(
        [
          {
            role: "user",
            content: "Set global style.",
            roomId: "A",
            userId: "alice",
          },
          {
            role: "assistant",
            content: "Distance: 5 kilometers.",
            roomId: "A",
            userId: "alice",
          },
        ],
        {
          mode: "global_applies_to_all",
          requiredLeakage: ["kilometers", "celsius", "grams", "metric"],
        },
        [2],
      );
      const v = await gradeScopeIsolated(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("FAIL");
    });

    it("PASSes when all required phrases are present", async () => {
      const s = scenario(
        [
          {
            role: "user",
            content: "Set global metric.",
            roomId: "A",
            userId: "alice",
          },
          {
            role: "assistant",
            content:
              "Distance: 5 kilometers. Temperature: 20 celsius. Weight: 3 grams.",
            roomId: "A",
            userId: "alice",
          },
        ],
        {
          mode: "global_applies_to_all",
          requiredLeakage: ["kilometers", "celsius", "grams"],
        },
        [2],
      );
      const v = await gradeScopeIsolated(s, resolveOptions(NO_LLM));
      expect(v.verdict).toBe("PASS");
    });
  });
});
