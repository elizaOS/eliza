import { initializeMemoryMode } from "@feed/db";
import { beforeAll, describe, expect, it } from "vitest";
import { organicPost } from "../../prompts/feed/organic-post";
import { renderPrompt } from "../../prompts/loader";
import { generateWorldContext } from "../../prompts/world-context";
import { actorContextBuilder } from "../../services/actor-context-builder";
import { StaticDataRegistry } from "../../services/static-data-registry";

/**
 * Strongest data-integrity check: assemble the real organic-post prompt the way
 * production does (world context + actor context builder) and assert every data
 * section — reality grounding, world-actor roster, character persona — is real
 * and present, with no unfilled template slots and no stubbed-out persona.
 *
 * Runs deterministically in memory mode (no live LLM, no Postgres).
 */
describe("organicPost prompt carries real grounding + persona", () => {
  let prompt = "";
  let actorName = "";
  let worldActors = "";
  let realityGrounding = "";

  beforeAll(async () => {
    await initializeMemoryMode();
    const wc = await generateWorldContext({
      includeMarkets: false,
      includePredictions: false,
      includeTrades: false,
    });
    worldActors = wc.worldActors;
    realityGrounding = wc.realityGrounding;

    const actorId = StaticDataRegistry.getActorIds()[0];
    const actor = StaticDataRegistry.getActor(actorId);
    if (!actor) throw new Error("no actor in static registry");
    actorName = actor.name;

    const ctx = await actorContextBuilder.buildContext(actor.id);
    if (!ctx) throw new Error("actorContextBuilder returned null");
    const characterInfo = actorContextBuilder.formatForPrompt(ctx);

    prompt = renderPrompt(organicPost, {
      characterName: actor.name,
      characterInfo,
      actorRules: "Stay in character.",
      antiRepetitionContext: "",
      runningBitContext: "",
      timeEnergy: "morning",
      domainHints: "tech, markets",
      domainContext: "AI industry",
      worldActors,
      realityGrounding,
    });
  });

  it("world context supplies real reality grounding", () => {
    expect(realityGrounding.length).toBeGreaterThan(1000);
    expect(realityGrounding).toContain("MANDATORY NAME MAPPINGS");
  });

  it("world context supplies a populated actor roster", () => {
    expect(worldActors.trim().length).toBeGreaterThan(0);
  });

  it("renders the prompt with no unfilled template slots", () => {
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it("injects the real reality grounding + actor roster into the prompt", () => {
    expect(prompt).toContain("MANDATORY NAME MAPPINGS");
    expect(prompt).toContain(actorName);
  });

  it("does not collapse the character persona to the 'unknown' stub", () => {
    // FeedGenerator's fallback is "PERSONALITY: unknown" when buildContext is null;
    // a real pack actor must render an actual persona.
    expect(prompt).not.toContain("PERSONALITY: unknown");
  });

  it("NEGATIVE CONTROL: empty grounding is detectable (not coming from static template text)", () => {
    const empty = renderPrompt(
      organicPost,
      {
        characterName: actorName,
        characterInfo: "x",
        actorRules: "x",
        antiRepetitionContext: "",
        runningBitContext: "",
        timeEnergy: "morning",
        domainHints: "x",
        domainContext: "y",
        worldActors: "",
        realityGrounding: "",
      },
      { allowEmpty: true },
    );
    expect(empty).not.toContain("MANDATORY NAME MAPPINGS");
  });
});
