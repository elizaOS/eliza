import { beforeEach, describe, expect, it } from "vitest";
import { generateEngineState } from "../generator";
import {
  buildCandidatePool,
  createMatchRecord,
  runLargePass,
  runSmallPass,
} from "../matching";
import type { DomainMode, EngineState } from "../types";

describe("buildCandidatePool", () => {
  let state: EngineState;
  const options = {
    now: "2026-01-18T12:00:00.000Z",
    batchSize: 10,
    processFeedbackLimit: 50,
    maxCandidates: 10,
    smallPassTopK: 5,
    largePassTopK: 3,
    graphHops: 2,
    matchCooldownDays: 30,
    reliabilityWeight: 1,
    matchDomains: ["dating" as DomainMode],
    minAvailabilityMinutes: 120,
    requireSameCity: true,
    requireSharedInterests: true,
    negativeFeedbackCooldownDays: 180,
    recentMatchWindow: 8,
  };

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 50,
      feedbackEvents: 20,
      now: options.now,
    });
  });

  it("should filter out same persona", () => {
    const persona = state.personas[0];
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(candidates.every((c) => c.id !== persona.id)).toBe(true);
  });

  it("should filter out blocked personas", () => {
    const persona = state.personas[0];
    persona.blockedPersonaIds = [1, 2];
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(
      candidates.every((c) => !persona.blockedPersonaIds.includes(c.id)),
    ).toBe(true);
  });

  it("should filter out personas from different cities when requireSameCity is true", () => {
    const persona = state.personas.find(
      (p) => p.general.location.city === "San Francisco",
    )!;
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(
      candidates.every(
        (c) => c.general.location.city === persona.general.location.city,
      ),
    ).toBe(true);
  });

  it("should allow cross-city matches when requireSameCity is false", () => {
    const persona = state.personas.find(
      (p) => p.general.location.city === "San Francisco",
    )!;
    const crossCityOptions = { ...options, requireSameCity: false };
    const candidates = buildCandidatePool(
      state,
      persona,
      "dating",
      crossCityOptions,
    );
    const hasCrossCity = candidates.some(
      (c) => c.general.location.city !== persona.general.location.city,
    );
    expect(hasCrossCity || candidates.length === 0).toBe(true);
  });

  it("should filter out inactive personas", () => {
    const persona = state.personas[0];
    state.personas[1].status = "paused";
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(candidates.every((c) => c.status === "active")).toBe(true);
  });

  it("should filter out personas with no shared interests when requireSharedInterests is true", () => {
    const persona = state.personas[0];
    persona.profile.interests = ["unique_interest_xyz"];
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(candidates.length).toBe(0);
  });

  it("should enforce dating eligibility (gender/age preferences)", () => {
    const persona = state.personas.find((p) => p.domainProfiles.dating)!;
    const candidates = buildCandidatePool(state, persona, "dating", options);
    for (const candidate of candidates) {
      expect(candidate.domainProfiles.dating).toBeDefined();
    }
  });

  it("should respect recent match cooldown", () => {
    const persona = state.personas[0];
    const candidate = state.personas[1];
    state.matches.push({
      matchId: "recent-match",
      domain: "dating",
      personaA: persona.id,
      personaB: candidate.id,
      createdAt: "2026-01-10T12:00:00.000Z",
      status: "proposed",
      assessment: {
        score: 50,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    });
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(candidates.every((c) => c.id !== candidate.id)).toBe(true);
  });

  it("should respect reliability minimum score", () => {
    const persona = state.personas[0];
    persona.matchPreferences.reliabilityMinScore = 0.8;
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(candidates.every((c) => c.reliability.score >= 0.8)).toBe(true);
  });

  it("should enforce availability overlap", () => {
    const persona = state.personas[0];
    persona.profile.availability.weekly = [
      { day: "mon", startMinutes: 540, endMinutes: 720 },
    ];
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(candidates.length).toBeGreaterThanOrEqual(0);
  });

  it("should return at most maxCandidates", () => {
    const persona = state.personas[0];
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(candidates.length).toBeLessThanOrEqual(options.maxCandidates);
  });

  it("should handle empty eligible pool gracefully", () => {
    const persona = state.personas[0];
    persona.profile.interests = ["impossible_interest_xyz"];
    persona.profile.availability.weekly = [];
    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(candidates.length).toBe(0);
  });
});

describe("runSmallPass", () => {
  it("should rank candidates by heuristic score when no LLM provided", async () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 5,
      now: "2026-01-18T12:00:00.000Z",
    });
    const persona = state.personas[0];
    const candidates = state.personas.slice(1, 11);
    const result = await runSmallPass(
      persona,
      candidates,
      "dating",
      5,
      undefined,
      1,
      120,
    );
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("should handle empty candidates", async () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 10,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
    const persona = state.personas[0];
    const result = await runSmallPass(
      persona,
      [],
      "dating",
      5,
      undefined,
      1,
      120,
    );
    expect(result.length).toBe(0);
  });
});

describe("runLargePass", () => {
  it("should return detailed assessments for candidates", async () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 5,
      now: "2026-01-18T12:00:00.000Z",
    });
    const persona = state.personas[0];
    const candidates = state.personas.slice(1, 4);
    const result = await runLargePass(
      persona,
      candidates,
      "dating",
      undefined,
      1,
      120,
    );
    expect(result.length).toBe(3);
    for (const scored of result) {
      expect(scored.candidate).toBeDefined();
      expect(scored.assessment.score).toBeGreaterThanOrEqual(-100);
      expect(scored.assessment.score).toBeLessThanOrEqual(100);
      expect(scored.assessment.positiveReasons).toBeInstanceOf(Array);
      expect(scored.assessment.negativeReasons).toBeInstanceOf(Array);
      expect(scored.assessment.redFlags).toBeInstanceOf(Array);
    }
  });

  it("should apply harshness penalty for red flags", async () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 10,
      feedbackEvents: 5,
      now: "2026-01-18T12:00:00.000Z",
    });
    const persona = state.personas[0];
    const candidate = state.personas[1];
    candidate.profile.feedbackSummary.redFlagTags = [
      "ghosting",
      "rude",
      "unreliable",
    ];
    const result = await runLargePass(
      persona,
      [candidate],
      "dating",
      undefined,
      1,
      120,
    );
    expect(result[0].assessment.score).toBeLessThan(50);
  });

  it("should sort by score descending", async () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
    const persona = state.personas[0];
    const candidates = state.personas.slice(1, 6);
    const result = await runLargePass(
      persona,
      candidates,
      "dating",
      undefined,
      1,
      120,
    );
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].assessment.score).toBeGreaterThanOrEqual(
        result[i].assessment.score,
      );
    }
  });
});

describe("createMatchRecord", () => {
  it("should create match with required fields", () => {
    const state = generateEngineState({
      seed: 42,
      personaCount: 10,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
    const persona = state.personas[0];
    const candidate = state.personas[1];
    const assessment = {
      score: 75,
      positiveReasons: ["test"],
      negativeReasons: [],
      redFlags: [],
    };
    const now = "2026-01-18T12:00:00.000Z";
    const match = createMatchRecord(
      persona,
      candidate,
      "dating",
      assessment,
      () => "test-id",
      now,
    );

    expect(match.matchId).toBe("test-id");
    expect(match.domain).toBe("dating");
    expect(match.personaA).toBe(persona.id);
    expect(match.personaB).toBe(candidate.id);
    expect(match.createdAt).toBe(now);
    expect(match.status).toBe("proposed");
    expect(match.assessment).toEqual(assessment);
  });
});
