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
});
