import { describe, expect, it } from "vitest";
import { getQuestionExamples } from "../../data/question-examples";
import { renderPrompt } from "../../prompts/loader";
import { questionGeneration } from "../../prompts/game/question-generation";
import { getRealityGrounding } from "../../prompts/reality-grounding";
import { StaticDataRegistry } from "../../services/static-data-registry";

// Mirror of QuestionManager.isEligibleActor (inlined to avoid pulling the
// markets/DB import chain into this pure-data test).
const isEligibleActor = (actor: {
  role?: string | null;
  tier?: string | null;
}): boolean =>
  actor.role === "main" ||
  actor.role === "supporting" ||
  actor.tier === "S_TIER" ||
  actor.tier === "A_TIER";

/**
 * The question-generation prompt must be grounded on real example questions,
 * eligible actors, organizations, and reality grounding — the data that makes
 * generated markets coherent with the game world.
 */
describe("question generation data integrity", () => {
  it("provides >50 well-formed example questions", () => {
    const examples = getQuestionExamples();
    expect(examples.length).toBeGreaterThan(50);
    expect(examples.every((q) => q.startsWith("Will ") && q.endsWith("?"))).toBe(
      true,
    );
  });

  it("has enough eligible actors and companies to populate the prompt", () => {
    const eligible = StaticDataRegistry.getAllActors().filter(isEligibleActor);
    expect(eligible.length).toBeGreaterThan(10);
    const companies = StaticDataRegistry.getAllOrganizations().filter(
      (o) => o.type === "company",
    );
    expect(companies.length).toBeGreaterThanOrEqual(3);
  });

  it("injects example questions, actors, orgs and reality grounding into the prompt", () => {
    const examples = getQuestionExamples();
    const eligible = StaticDataRegistry.getAllActors().filter(isEligibleActor);
    const companies = StaticDataRegistry.getAllOrganizations().filter(
      (o) => o.type === "company",
    );
    const sampleQuestion = examples[0];
    const sampleActor = eligible[0].name;
    const sampleCompany = companies[0].name;

    const prompt = renderPrompt(
      questionGeneration,
      {
        exampleQuestions: examples.slice(0, 10).join("\n"),
        actorsList: eligible.map((a) => a.name).join(", "),
        orgsList: companies.map((o) => o.name).join(", "),
        realityGrounding: getRealityGrounding(),
        characterRoster: "",
        organizationRoster: "",
        scenariosList: "",
        currentDate: "Monday, June 22, 2026",
        numToGenerate: "5",
        activeQuestionsContext: "",
        dailyTopicContext: "",
        detailedCharacterProfiles: "",
        eventTimeline: "",
        ongoingNarrativesContext: "",
        phaseContext: "",
        recentContext: "",
        resolvedQuestionsContext: "",
        richGameContext: "",
      },
      { allowEmpty: true },
    );

    expect(prompt).toContain(sampleQuestion);
    expect(prompt).toContain(sampleActor);
    expect(prompt).toContain(sampleCompany);
    expect(prompt).toContain("MANDATORY NAME MAPPINGS");
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });
});
