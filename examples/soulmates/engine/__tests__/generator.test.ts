import { describe, expect, it } from "vitest";
import { generateEngineState, generatePersonas } from "../generator";

describe("generatePersonas", () => {
  it("should generate specified number of personas", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 50,
      now: "2026-01-18T12:00:00.000Z",
    });
    expect(personas.length).toBe(50);
  });

  it("should assign unique sequential IDs", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 20,
      now: "2026-01-18T12:00:00.000Z",
    });
    const ids = personas.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(20);
    expect(ids).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });

  it("should assign at least one domain to each persona", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 50,
      now: "2026-01-18T12:00:00.000Z",
    });
    for (const persona of personas) {
      expect(persona.domains.length).toBeGreaterThanOrEqual(1);
      expect(
        persona.domains.every((d) =>
          ["dating", "business", "friendship"].includes(d),
        ),
      ).toBe(true);
    }
  });

  it("should create domain profiles matching assigned domains", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 50,
      now: "2026-01-18T12:00:00.000Z",
    });
    for (const persona of personas) {
      if (persona.domains.includes("dating")) {
        expect(persona.domainProfiles.dating).toBeDefined();
      }
      if (persona.domains.includes("business")) {
        expect(persona.domainProfiles.business).toBeDefined();
      }
      if (persona.domains.includes("friendship")) {
        expect(persona.domainProfiles.friendship).toBeDefined();
      }
    }
  });

  it("should generate valid age ranges for dating preferences", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 100,
      now: "2026-01-18T12:00:00.000Z",
    });
    for (const persona of personas) {
      if (persona.domainProfiles.dating) {
        const prefs = persona.domainProfiles.dating.datingPreferences;
        expect(prefs.preferredAgeMin).toBeGreaterThanOrEqual(18);
        expect(prefs.preferredAgeMax).toBeGreaterThanOrEqual(
          prefs.preferredAgeMin,
        );
        expect(prefs.preferredAgeMax).toBeLessThanOrEqual(99);
      }
    }
  });

  it("should generate valid attractiveness scores", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 100,
      now: "2026-01-18T12:00:00.000Z",
    });
    for (const persona of personas) {
      if (persona.domainProfiles.dating) {
        const attractiveness =
          persona.domainProfiles.dating.attractionProfile.appearance
            .attractiveness;
        expect(attractiveness).toBeGreaterThanOrEqual(1);
        expect(attractiveness).toBeLessThanOrEqual(10);
      }
    }
  });

  it("should generate diverse ethnicities", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 100,
      now: "2026-01-18T12:00:00.000Z",
    });
    const ethnicities = new Set(
      personas
        .filter((p) => p.domainProfiles.dating)
        .map(
          (p) =>
            p.domainProfiles.dating?.attractionProfile.appearance.ethnicity,
        ),
    );
    expect(ethnicities.size).toBeGreaterThan(3);
  });

  it("should generate diverse genders", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 100,
      now: "2026-01-18T12:00:00.000Z",
    });
    const genders = new Set(personas.map((p) => p.general.genderIdentity));
    expect(genders.size).toBeGreaterThan(2);
  });

  it("should generate diverse orientations", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 100,
      now: "2026-01-18T12:00:00.000Z",
    });
    const orientations = new Set(
      personas
        .filter((p) => p.domainProfiles.dating)
        .map((p) => p.domainProfiles.dating?.datingPreferences.orientation),
    );
    expect(orientations.size).toBeGreaterThan(2);
  });

  it("should generate personas in both SF and NY", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 100,
      now: "2026-01-18T12:00:00.000Z",
    });
    const cities = new Set(personas.map((p) => p.general.location.city));
    expect(cities.has("San Francisco") || cities.has("New York")).toBe(true);
  });

  it("should generate conversations with varying lengths", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 50,
      now: "2026-01-18T12:00:00.000Z",
    });
    const convoLengths = personas.map((p) => p.conversations.length);
    const hasVariance = new Set(convoLengths).size > 1;
    expect(hasVariance).toBe(true);
  });

  it("should generate facts from conversations and profile", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 20,
      now: "2026-01-18T12:00:00.000Z",
    });
    for (const persona of personas) {
      expect(persona.facts.length).toBeGreaterThan(0);
      const factTypes = new Set(persona.facts.map((f) => f.type));
      expect(factTypes.size).toBeGreaterThan(0);
    }
  });

  it("should generate reliability scores between 0 and 1", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 100,
      now: "2026-01-18T12:00:00.000Z",
    });
    for (const persona of personas) {
      expect(persona.reliability.score).toBeGreaterThanOrEqual(0);
      expect(persona.reliability.score).toBeLessThanOrEqual(1);
    }
  });

  it("should generate consistent output for same seed", () => {
    const personas1 = generatePersonas({
      seed: 99,
      count: 10,
      now: "2026-01-18T12:00:00.000Z",
    });
    const personas2 = generatePersonas({
      seed: 99,
      count: 10,
      now: "2026-01-18T12:00:00.000Z",
    });
    expect(personas1).toEqual(personas2);
  });

  it("should generate different output for different seeds", () => {
    const personas1 = generatePersonas({
      seed: 100,
      count: 10,
      now: "2026-01-18T12:00:00.000Z",
    });
    const personas2 = generatePersonas({
      seed: 200,
      count: 10,
      now: "2026-01-18T12:00:00.000Z",
    });
    expect(personas1).not.toEqual(personas2);
  });

  it("should mark some conversations as processed and some unprocessed", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 50,
      now: "2026-01-18T12:00:00.000Z",
    });
    const allConvos = personas.flatMap((p) => p.conversations);
    const processed = allConvos.filter((c) => c.processed);
    const unprocessed = allConvos.filter((c) => !c.processed);
    expect(processed.length).toBeGreaterThan(0);
    expect(unprocessed.length).toBeGreaterThan(0);
  });

  it("should set processedAt only for processed conversations", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 50,
      now: "2026-01-18T12:00:00.000Z",
    });
    for (const persona of personas) {
      for (const convo of persona.conversations) {
        if (convo.processed) {
          expect(convo.processedAt).toBeDefined();
        } else {
          expect(convo.processedAt).toBeUndefined();
        }
      }
    }
  });

  it("should generate valid fact evidence references", () => {
    const personas = generatePersonas({
      seed: 42,
      count: 20,
      now: "2026-01-18T12:00:00.000Z",
    });
    for (const persona of personas) {
      for (const fact of persona.facts) {
        if (fact.evidence.length > 0) {
          const convoId = fact.evidence[0].conversationId;
          const convo = persona.conversations.find(
            (c) => c.conversationId === convoId,
          );
          if (convo) {
            expect(convo.turns.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe("generateEngineState", () => {
  it("should generate engine state with all required fields", () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 10,
      now: "2026-01-18T12:00:00.000Z",
    });
    expect(state.personas).toBeDefined();
    expect(state.matches).toBeDefined();
    expect(state.meetings).toBeDefined();
    expect(state.feedbackQueue).toBeDefined();
    expect(state.safetyReports).toBeDefined();
    expect(state.communities).toBeDefined();
    expect(state.credits).toBeDefined();
    expect(state.messages).toBeDefined();
    expect(state.matchGraph).toBeDefined();
  });

  it("should generate specified number of personas", () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 30,
      feedbackEvents: 10,
      now: "2026-01-18T12:00:00.000Z",
    });
    expect(state.personas.length).toBe(30);
  });

  it("should generate specified number of feedback events", () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 15,
      now: "2026-01-18T12:00:00.000Z",
    });
    expect(state.feedbackQueue.length).toBe(15);
  });

  it("should generate feedback with valid persona references", () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 20,
      now: "2026-01-18T12:00:00.000Z",
    });
    const personaIds = new Set(state.personas.map((p) => p.id));
    for (const entry of state.feedbackQueue) {
      expect(personaIds.has(entry.fromPersonaId)).toBe(true);
      expect(personaIds.has(entry.toPersonaId)).toBe(true);
      expect(entry.fromPersonaId).not.toBe(entry.toPersonaId);
    }
  });

  it("should build match graph from feedback", () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 20,
      now: "2026-01-18T12:00:00.000Z",
    });
    expect(state.matchGraph.edges.length).toBeGreaterThan(0);
    for (const edge of state.matchGraph.edges) {
      expect(edge.weight).toBeGreaterThanOrEqual(0);
      expect(edge.weight).toBeLessThanOrEqual(1);
      expect(edge.type).toBe("feedback_positive");
    }
  });

  it("should mark all initial feedback as unprocessed", () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 20,
      now: "2026-01-18T12:00:00.000Z",
    });
    expect(state.feedbackQueue.every((entry) => !entry.processed)).toBe(true);
  });

  it("should initialize empty matches and meetings arrays", () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 10,
      now: "2026-01-18T12:00:00.000Z",
    });
    expect(state.matches.length).toBe(0);
    expect(state.meetings.length).toBe(0);
  });
});
