import { describe, expect, it } from "vitest";
import { realityGroundingContent } from "../../data/reality-grounding";
import { worldEventExamplesContent } from "../../data/world-event-examples";
import { worldFactsContent } from "../../data/world-facts";
import {
  getQuestionExamples,
} from "../../data/question-examples";
import { baselineEvent } from "../../prompts/game/baseline-event";
import {
  getFullRealityGrounding,
  getRealityGrounding,
  getWorldEventExamples,
} from "../../prompts/reality-grounding";
import { renderPrompt } from "../../prompts/loader";

/**
 * The recovered grounding content (reality-grounding / world-facts /
 * world-event-examples / question-examples) must be real and must actually
 * reach the LLM prompts that declare those slots — not be silently blanked.
 */
describe("world grounding content is real", () => {
  it("reality grounding carries the name-mapping rules", () => {
    expect(realityGroundingContent.length).toBeGreaterThan(1000);
    expect(realityGroundingContent).toContain("MANDATORY NAME MAPPINGS");
    expect(realityGroundingContent).toMatch(/AIlon Musk|OpenAGI|BitcAIn/);
    // No leftover pre-rename brand strings.
    expect(realityGroundingContent.toLowerCase()).not.toContain("babylon");
  });

  it("world facts carry the Feed-branded baseline", () => {
    expect(worldFactsContent).toContain("FEED WORLD FACTS");
    expect(worldFactsContent.toLowerCase()).not.toContain("babylon");
    expect(worldFactsContent.split("\n").filter((l) => l.startsWith("- ")).length)
      .toBeGreaterThan(3);
  });

  it("world event examples are non-empty satirical events", () => {
    expect(worldEventExamplesContent.length).toBeGreaterThan(200);
    expect(getWorldEventExamples()).toContain("WORLD EVENT EXAMPLES");
  });

  it("question examples are well-formed prediction questions", () => {
    const examples = getQuestionExamples();
    expect(examples.length).toBeGreaterThan(50);
    expect(examples.every((q) => q.startsWith("Will ") && q.endsWith("?"))).toBe(
      true,
    );
  });

  it("getRealityGrounding/getFullRealityGrounding inject the real body", () => {
    for (const text of [getRealityGrounding(), getFullRealityGrounding()]) {
      expect(text).toContain("MANDATORY NAME MAPPINGS");
      expect(text.length).toBeGreaterThan(1000);
    }
  });
});

describe("world event examples reach the event-generation prompt", () => {
  it("baselineEvent renders the supplied worldEventExamples (not a blank slot)", () => {
    const prompt = renderPrompt(
      baselineEvent,
      {
        realityGrounding: getRealityGrounding(),
        currentDate: "Monday, June 22, 2026",
        previousEvents: "",
        worldEventExamples: getWorldEventExamples(),
        dateStr: "2026-06-22",
        eventType: "announces",
        actorDescriptions: "AIlon Musk (CEO of TeslAI)",
      },
      { allowEmpty: true },
    );
    // The {{worldEventExamples}} slot was filled with real content.
    expect(prompt).toContain("WORLD EVENT EXAMPLES");
    expect(prompt).toMatch(/AIlon Musk|TeslAI|MetAI/);
    // No unfilled template placeholders remain.
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });
});
