/**
 * Routing coverage for the `morning_brief` LifeOps optimization task (#8795).
 * The briefing-narrative instructions must consult OptimizedPromptService and
 * use an optimized artifact when one is registered, falling back to the inline
 * baseline otherwise (absence of an artifact is a no-op, never a failure).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { buildNarrativePrompt } from "../src/actions/brief.js";

const SECTIONS = {
  calendar: [],
  inbox: [],
  life: [],
  money: [],
} as never;

function runtimeWithOptimizedPrompt(
  promptByTask: Record<string, string>,
): IAgentRuntime {
  return {
    getService: (name: string) =>
      name === "optimized_prompt"
        ? {
            getPrompt: (task: string) =>
              promptByTask[task]
                ? { prompt: promptByTask[task], optimizerSource: "gepa" }
                : null,
          }
        : null,
  } as unknown as IAgentRuntime;
}

describe("BRIEF narrative — OptimizedPromptService routing", () => {
  it("uses the inline baseline when no artifact is registered", () => {
    const prompt = buildNarrativePrompt({
      kind: "morning",
      period: "today",
      sections: SECTIONS,
    });
    expect(prompt).toContain("Render a concise narrative paragraph");
    expect(prompt).toContain("composing the owner's morning briefing");
  });

  it("uses the inline baseline when a runtime has no optimized prompt", () => {
    const runtime = runtimeWithOptimizedPrompt({});
    const prompt = buildNarrativePrompt({
      kind: "morning",
      period: "today",
      sections: SECTIONS,
      runtime,
    });
    expect(prompt).toContain("Render a concise narrative paragraph");
  });

  it("swaps in the optimized morning_brief artifact when present", () => {
    const runtime = runtimeWithOptimizedPrompt({
      morning_brief: "OPTIMIZED: be terse and lead with the day's single risk.",
    });
    const prompt = buildNarrativePrompt({
      kind: "morning",
      period: "today",
      sections: SECTIONS,
      runtime,
    });
    expect(prompt).toContain(
      "OPTIMIZED: be terse and lead with the day's single risk.",
    );
    // The inline baseline instructions are replaced by the artifact.
    expect(prompt).not.toContain("Render a concise narrative paragraph");
    // The dynamic header + data scaffold is preserved around the instructions.
    expect(prompt).toContain("composing the owner's morning briefing");
    expect(prompt).toContain("Data:");
  });
});
