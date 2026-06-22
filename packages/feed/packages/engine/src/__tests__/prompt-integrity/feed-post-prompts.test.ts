import { beforeAll, describe, expect, it } from "vitest";
import { organicPost } from "../../prompts/feed/organic-post";
import { renderPrompt } from "../../prompts/loader";
import { generateWorldContext } from "../../prompts/world-context";
import { StaticDataRegistry } from "../../services/static-data-registry";

/**
 * Assemble the real organic-post prompt with the production world-context
 * builder and a real pack-actor persona, then assert every grounding section —
 * reality grounding, world-actor roster, character identity — is present and
 * real, with no unfilled template slots.
 *
 * Deterministic: no live LLM and no Postgres (world context is built from the
 * static reality-grounding + pack roster; persona is read from the static pack).
 */
describe("organicPost prompt carries real grounding + persona", () => {
  let prompt = "";
  let actorName = "";
  let worldActors = "";
  let realityGrounding = "";

  beforeAll(async () => {
    // DB-free sections only: actors + reality grounding + world facts (the
    // markets/predictions/trades sections require live data and are disabled).
    const wc = await generateWorldContext({
      includeMarkets: false,
      includePredictions: false,
      includeTrades: false,
      includeWorldFacts: false,
    });
    worldActors = wc.worldActors;
    realityGrounding = wc.realityGrounding;

    const actorId = StaticDataRegistry.getActorIds()[0];
    const actor = StaticDataRegistry.getActor(actorId);
    if (!actor) throw new Error("no actor in static registry");
    actorName = actor.name;

    // Real persona built from the static pack fields (the DB-backed
    // actorContextBuilder is exercised by the live server e2e, not this unit).
    const characterInfo = [
      `NAME: ${actor.name}`,
      `PERSONALITY: ${actor.personality ?? actor.description ?? ""}`,
      `VOICE: ${actor.voice ?? ""}`,
      `DOMAINS: ${actor.domain.join(", ")}`,
    ].join("\n");

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

  it("injects the real reality grounding + actor roster + identity into the prompt", () => {
    expect(prompt).toContain("MANDATORY NAME MAPPINGS");
    expect(prompt).toContain(actorName);
    expect(prompt).toContain("DOMAINS:");
  });

  it("NEGATIVE CONTROL: empty grounding is detectable (not static template text)", () => {
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
