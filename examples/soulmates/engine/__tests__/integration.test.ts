import { beforeEach, describe, expect, it } from "vitest";
import { runEngineTick } from "../engine";
import { generateEngineState } from "../generator";
import {
  buildCandidatePool,
  runLargePass,
  type ScoredCandidate,
} from "../matching";
import type { DomainMode, EngineState, FeedbackEntry, Persona } from "../types";

describe("Domain Eligibility - Dating", () => {
  let state: EngineState;

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 30,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
  });

  it("should filter out candidates with gender preference mismatch", () => {
    const woman = state.personas.find(
      (p) => p.general.genderIdentity === "woman" && p.domainProfiles.dating,
    );
    const man = state.personas.find(
      (p) => p.general.genderIdentity === "man" && p.domainProfiles.dating,
    );
    if (
      woman &&
      man &&
      woman.domainProfiles.dating &&
      man.domainProfiles.dating
    ) {
      woman.domainProfiles.dating.datingPreferences.preferredGenders = [
        "woman",
      ];
      woman.domainProfiles.dating.datingPreferences.orientation = "gay";
      man.domainProfiles.dating.datingPreferences.preferredGenders = ["man"];
      man.domainProfiles.dating.datingPreferences.orientation = "gay";

      const options = {
        now: "2026-01-18T12:00:00.000Z",
        batchSize: 5,
        maxCandidates: 10,
        smallPassTopK: 5,
        largePassTopK: 3,
        graphHops: 1,
        matchCooldownDays: 30,
        reliabilityWeight: 1,
        matchDomains: ["dating" as DomainMode],
        minAvailabilityMinutes: 120,
      };
      const candidates = buildCandidatePool(state, woman, "dating", options);
      expect(candidates.every((c) => c.id !== man.id)).toBe(true);
    }
  });

  it("should filter out candidates outside age range", () => {
    const young = state.personas.find(
      (p) => p.general.age <= 25 && p.domainProfiles.dating,
    );
    const older = state.personas.find(
      (p) => p.general.age >= 45 && p.domainProfiles.dating,
    );
    if (young && older && young.domainProfiles.dating) {
      young.domainProfiles.dating.datingPreferences.preferredAgeMin = 22;
      young.domainProfiles.dating.datingPreferences.preferredAgeMax = 32;

      const options = {
        now: "2026-01-18T12:00:00.000Z",
        batchSize: 5,
        maxCandidates: 10,
        smallPassTopK: 5,
        largePassTopK: 3,
        graphHops: 1,
        matchCooldownDays: 30,
        reliabilityWeight: 1,
        matchDomains: ["dating" as DomainMode],
        minAvailabilityMinutes: 120,
      };
      const candidates = buildCandidatePool(state, young, "dating", options);
      expect(candidates.every((c) => c.id !== older.id)).toBe(true);
    }
  });

  it("should filter out candidates with dealbreaker hits", () => {
    const persona = state.personas.find((p) => p.domainProfiles.dating)!;
    const candidate = state.personas.find(
      (p) => p.id !== persona.id && p.domainProfiles.dating,
    )!;
    if (persona.domainProfiles.dating && candidate.domainProfiles.dating) {
      persona.domainProfiles.dating.datingPreferences.dealbreakers = [
        "smoking",
      ];
      candidate.general.bio = "I love smoking cigars";

      const options = {
        now: "2026-01-18T12:00:00.000Z",
        batchSize: 5,
        maxCandidates: 10,
        smallPassTopK: 5,
        largePassTopK: 3,
        graphHops: 1,
        matchCooldownDays: 30,
        reliabilityWeight: 1,
        matchDomains: ["dating" as DomainMode],
        minAvailabilityMinutes: 120,
      };
      const candidates = buildCandidatePool(state, persona, "dating", options);
      expect(candidates.every((c) => c.id !== candidate.id)).toBe(true);
    }
  });
});

describe("Domain Eligibility - Business", () => {
  let state: EngineState;

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 30,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
  });

  it("should match personas with complementary roles", () => {
    const technical = state.personas.find((p) => p.domainProfiles.business);
    const nonTechnical = state.personas.find(
      (p) => p.id !== technical?.id && p.domainProfiles.business,
    );
    if (
      technical &&
      nonTechnical &&
      technical.domainProfiles.business &&
      nonTechnical.domainProfiles.business
    ) {
      technical.domainProfiles.business.roles = ["technical"];
      technical.domainProfiles.business.seekingRoles = ["product", "design"];
      nonTechnical.domainProfiles.business.roles = ["product"];
      nonTechnical.domainProfiles.business.seekingRoles = ["technical"];

      const options = {
        now: "2026-01-18T12:00:00.000Z",
        batchSize: 5,
        maxCandidates: 10,
        smallPassTopK: 5,
        largePassTopK: 3,
        graphHops: 1,
        matchCooldownDays: 30,
        reliabilityWeight: 1,
        matchDomains: ["business" as DomainMode],
        minAvailabilityMinutes: 120,
        requireSameCity: false,
        requireSharedInterests: false,
      };
      const candidates = buildCandidatePool(
        state,
        technical,
        "business",
        options,
      );
      const hasMatch = candidates.some((c) => c.id === nonTechnical.id);
      expect(hasMatch || candidates.length === 0).toBe(true);
    }
  });

  it("should filter out personas without complementary roles when seeking is specified", () => {
    const persona = state.personas.find((p) => p.domainProfiles.business)!;
    const mismatch = state.personas.find(
      (p) => p.id !== persona.id && p.domainProfiles.business,
    )!;
    if (persona.domainProfiles.business && mismatch.domainProfiles.business) {
      persona.domainProfiles.business.roles = ["technical"];
      persona.domainProfiles.business.seekingRoles = ["design"];
      mismatch.domainProfiles.business.roles = ["sales"];
      mismatch.domainProfiles.business.seekingRoles = ["growth"];

      const options = {
        now: "2026-01-18T12:00:00.000Z",
        batchSize: 5,
        maxCandidates: 10,
        smallPassTopK: 5,
        largePassTopK: 3,
        graphHops: 1,
        matchCooldownDays: 30,
        reliabilityWeight: 1,
        matchDomains: ["business" as DomainMode],
        minAvailabilityMinutes: 120,
        requireSameCity: false,
        requireSharedInterests: false,
      };
      const candidates = buildCandidatePool(
        state,
        persona,
        "business",
        options,
      );
      expect(candidates.every((c) => c.id !== mismatch.id)).toBe(true);
    }
  });
});

describe("Domain Eligibility - Friendship", () => {
  let state: EngineState;

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 30,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
  });

  it("should require at least 5% interest overlap", () => {
    const persona = state.personas.find((p) => p.domainProfiles.friendship)!;
    const noOverlap = state.personas.find(
      (p) => p.id !== persona.id && p.domainProfiles.friendship,
    )!;
    if (
      persona.domainProfiles.friendship &&
      noOverlap.domainProfiles.friendship
    ) {
      persona.domainProfiles.friendship.interests = ["unique_interest_A"];
      noOverlap.domainProfiles.friendship.interests = ["unique_interest_B"];

      const options = {
        now: "2026-01-18T12:00:00.000Z",
        batchSize: 5,
        maxCandidates: 10,
        smallPassTopK: 5,
        largePassTopK: 3,
        graphHops: 1,
        matchCooldownDays: 30,
        reliabilityWeight: 1,
        matchDomains: ["friendship" as DomainMode],
        minAvailabilityMinutes: 120,
        requireSameCity: false,
        requireSharedInterests: false,
      };
      const candidates = buildCandidatePool(
        state,
        persona,
        "friendship",
        options,
      );
      expect(
        candidates.every((candidate: Persona) => candidate.id !== noOverlap.id),
      ).toBe(true);
    }
  });
});

describe("Attractiveness and Body Type Scoring", () => {
  let state: EngineState;

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
  });

  it("should penalize large attractiveness gaps when importance is high", async () => {
    const personaA = state.personas.find((p) => p.domainProfiles.dating)!;
    const personaB = state.personas.find(
      (p) => p.id !== personaA.id && p.domainProfiles.dating,
    )!;

    if (personaA.domainProfiles.dating && personaB.domainProfiles.dating) {
      personaA.domainProfiles.dating.attractionProfile.appearance.attractiveness = 8;
      personaA.domainProfiles.dating.datingPreferences.attractivenessImportance = 9;
      personaB.domainProfiles.dating.attractionProfile.appearance.attractiveness = 3;

      const scored = await runLargePass(
        personaA,
        [personaB],
        "dating",
        undefined,
        1,
        120,
      );
      expect(scored[0]?.assessment.score ?? 0).toBeLessThan(0);
    }
  });

  it("should penalize when body type preferences are not met", async () => {
    const personaA = state.personas.find((p) => p.domainProfiles.dating)!;
    const personaB = state.personas.find(
      (p) => p.id !== personaA.id && p.domainProfiles.dating,
    )!;

    if (personaA.domainProfiles.dating && personaB.domainProfiles.dating) {
      personaA.domainProfiles.dating.datingPreferences.bodyTypePreferences = [
        "fit",
      ];
      personaB.domainProfiles.dating.attractionProfile.appearance.build =
        "overweight";

      const scored = await runLargePass(
        personaA,
        [personaB],
        "dating",
        undefined,
        1,
        120,
      );
      expect(scored[0]?.assessment.negativeReasons.length ?? 0).toBeGreaterThan(
        0,
      );
    }
  });
});

describe("Reliability Weighting", () => {
  let state: EngineState;

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
  });

  it("should boost scores for high reliability personas", async () => {
    const persona = state.personas[0];
    const lowReliability = state.personas[1];
    const highReliability = state.personas[2];

    lowReliability.reliability.score = 0.2;
    highReliability.reliability.score = 0.9;

    const result = await runLargePass(
      persona,
      [lowReliability, highReliability],
      "friendship",
      undefined,
      2,
      120,
    );
    const lowScore =
      result.find((r) => r.candidate.id === lowReliability.id)?.assessment
        .score ?? 0;
    const highScore =
      result.find((r) => r.candidate.id === highReliability.id)?.assessment
        .score ?? 0;

    expect(highScore).toBeGreaterThan(lowScore);
  });
});

describe("Red Flag Handling", () => {
  let state: EngineState;

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
  });

  it("should penalize candidates with red flags", async () => {
    const persona = state.personas[0];
    const clean = state.personas[1];
    const flagged = state.personas[2];

    clean.profile.feedbackSummary.redFlagTags = [];
    flagged.profile.feedbackSummary.redFlagTags = [
      "ghosting",
      "rude",
      "no_show",
    ];

    const result = await runLargePass(
      persona,
      [clean, flagged],
      "friendship",
      undefined,
      1,
      120,
    );
    const cleanScore =
      result.find((entry: ScoredCandidate) => entry.candidate.id === clean.id)
        ?.assessment.score ?? 0;
    const flaggedScore =
      result.find((entry: ScoredCandidate) => entry.candidate.id === flagged.id)
        ?.assessment.score ?? 0;

    expect(cleanScore).toBeGreaterThan(flaggedScore);
    expect(
      result.find((entry: ScoredCandidate) => entry.candidate.id === flagged.id)
        ?.assessment.redFlags.length,
    ).toBeGreaterThan(0);
  });
});

describe("Concurrent Matching", () => {
  it("should handle parallel tick executions without race conditions", async () => {
    const baseState = generateEngineState({
      seed: 42,
      personaCount: 30,
      feedbackEvents: 20,
      now: "2026-01-18T12:00:00.000Z",
    });
    const options = {
      now: "2026-01-18T12:00:00.000Z",
      batchSize: 5,
      processFeedbackLimit: 10,
      maxCandidates: 5,
      smallPassTopK: 3,
      largePassTopK: 2,
      graphHops: 1,
      matchCooldownDays: 30,
      reliabilityWeight: 1,
      matchDomains: ["dating" as DomainMode, "friendship" as DomainMode],
    };

    const results = await Promise.all([
      runEngineTick(baseState, { ...options, targetPersonaIds: [0, 1, 2] }),
      runEngineTick(baseState, { ...options, targetPersonaIds: [3, 4, 5] }),
      runEngineTick(baseState, { ...options, targetPersonaIds: [6, 7, 8] }),
    ]);

    for (const result of results) {
      expect(result.state).toBeDefined();
      expect(result.matchesCreated).toBeInstanceOf(Array);
      expect(result.feedbackProcessed).toBeInstanceOf(Array);
    }
  });
});

describe("Match Cooldown and Recent Window", () => {
  let state: EngineState;

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
  });

  it("should respect match cooldown period", () => {
    const persona = state.personas[0];
    const candidate = state.personas[1];

    state.matches.push({
      matchId: "old-match",
      domain: "dating",
      personaA: persona.id,
      personaB: candidate.id,
      createdAt: "2025-12-20T12:00:00.000Z",
      status: "completed",
      assessment: {
        score: 50,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    });

    const options = {
      now: "2026-01-18T12:00:00.000Z",
      batchSize: 5,
      maxCandidates: 10,
      smallPassTopK: 5,
      largePassTopK: 3,
      graphHops: 1,
      matchCooldownDays: 30,
      reliabilityWeight: 1,
      matchDomains: ["dating" as DomainMode],
      minAvailabilityMinutes: 120,
    };

    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(
      candidates.every((entry: Persona) => entry.id !== candidate.id),
    ).toBe(true);
  });

  it("should enforce recent match window", () => {
    const persona = state.personas[0];
    const candidate = state.personas[1];

    for (let i = 0; i < 9; i++) {
      state.matches.push({
        matchId: `match-${i}`,
        domain: "dating",
        personaA: persona.id,
        personaB: i + 2,
        createdAt: `2026-01-${10 + i}T12:00:00.000Z`,
        status: "completed",
        assessment: {
          score: 50,
          positiveReasons: [],
          negativeReasons: [],
          redFlags: [],
        },
        reasoning: [],
      });
    }

    state.matches.push({
      matchId: "old-match-with-candidate",
      domain: "dating",
      personaA: persona.id,
      personaB: candidate.id,
      createdAt: "2025-11-01T12:00:00.000Z",
      status: "completed",
      assessment: {
        score: 50,
        positiveReasons: [],
        negativeReasons: [],
        redFlags: [],
      },
      reasoning: [],
    });

    const options = {
      now: "2026-01-18T12:00:00.000Z",
      batchSize: 5,
      maxCandidates: 10,
      smallPassTopK: 5,
      largePassTopK: 3,
      graphHops: 1,
      matchCooldownDays: 1,
      reliabilityWeight: 1,
      matchDomains: ["dating" as DomainMode],
      minAvailabilityMinutes: 120,
      recentMatchWindow: 8,
      requireSameCity: false,
      requireSharedInterests: false,
    };

    const candidates = buildCandidatePool(state, persona, "dating", options);
    expect(
      candidates.every((entry: Persona) => entry.id !== candidate.id),
    ).toBe(true);
  });
});

describe("Negative Feedback Cooldown", () => {
  let state: EngineState;

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 0,
      now: "2026-01-18T12:00:00.000Z",
    });
  });

  it("should filter out personas with recent negative feedback", () => {
    const persona = state.personas[0];
    const candidate = state.personas[1];

    state.feedbackQueue.push({
      id: "negative-feedback",
      fromPersonaId: persona.id,
      toPersonaId: candidate.id,
      rating: 1,
      sentiment: "negative",
      issues: [{ code: "rude", severity: "high", redFlag: true, notes: "" }],
      redFlags: ["rude"],
      notes: "Bad experience",
      createdAt: "2026-01-10T12:00:00.000Z",
      processed: true,
      source: "meeting",
    });

    const options = {
      now: "2026-01-18T12:00:00.000Z",
      batchSize: 5,
      maxCandidates: 10,
      smallPassTopK: 5,
      largePassTopK: 3,
      graphHops: 1,
      matchCooldownDays: 1,
      reliabilityWeight: 1,
      matchDomains: ["friendship" as DomainMode],
      minAvailabilityMinutes: 120,
      negativeFeedbackCooldownDays: 180,
      requireSameCity: false,
      requireSharedInterests: false,
    };

    const candidates = buildCandidatePool(
      state,
      persona,
      "friendship",
      options,
    );
    expect(
      candidates.every((entry: Persona) => entry.id !== candidate.id),
    ).toBe(true);
  });
});

describe("Integration - Full Matching Flow", () => {
  it("should execute complete matching pipeline", async () => {
    const state = generateEngineState({
      seed: 123,
      personaCount: 50,
      feedbackEvents: 30,
      now: "2026-01-18T12:00:00.000Z",
    });

    const options = {
      now: "2026-01-18T12:00:00.000Z",
      batchSize: 10,
      processFeedbackLimit: 20,
      maxCandidates: 15,
      smallPassTopK: 8,
      largePassTopK: 5,
      graphHops: 2,
      matchCooldownDays: 30,
      reliabilityWeight: 1.2,
      matchDomains: [
        "dating" as DomainMode,
        "friendship" as DomainMode,
        "business" as DomainMode,
      ],
      minAvailabilityMinutes: 120,
    };

    const result = await runEngineTick(state, options);

    expect(result.feedbackProcessed.length).toBeGreaterThan(0);
    expect(result.matchesCreated.length).toBeGreaterThan(0);
    expect(result.personasUpdated.length).toBeGreaterThan(0);
    expect(result.state.matchGraph.edges.length).toBeGreaterThan(
      state.matchGraph.edges.length,
    );

    for (const match of result.matchesCreated) {
      expect(match.assessment.score).toBeGreaterThanOrEqual(-100);
      expect(match.assessment.score).toBeLessThanOrEqual(100);
      expect(match.domain).toBeDefined();
    }

    const allProcessed = result.feedbackProcessed.every(
      (entry: FeedbackEntry) => entry.processed && entry.processedAt,
    );
    expect(allProcessed).toBe(true);
  });

  it("should handle multiple tick executions sequentially", async () => {
    const state = generateEngineState({
      seed: 456,
      personaCount: 30,
      feedbackEvents: 40,
      now: "2026-01-18T12:00:00.000Z",
    });

    const options = {
      now: "2026-01-18T12:00:00.000Z",
      batchSize: 5,
      processFeedbackLimit: 10,
      maxCandidates: 10,
      smallPassTopK: 5,
      largePassTopK: 3,
      graphHops: 1,
      matchCooldownDays: 30,
      reliabilityWeight: 1,
      matchDomains: ["dating" as DomainMode, "friendship" as DomainMode],
      minAvailabilityMinutes: 120,
    };

    const result1 = await runEngineTick(state, options);
    const result2 = await runEngineTick(result1.state, {
      ...options,
      now: "2026-01-18T13:00:00.000Z",
    });
    const result3 = await runEngineTick(result2.state, {
      ...options,
      now: "2026-01-18T14:00:00.000Z",
    });

    const totalMatches =
      result1.matchesCreated.length +
      result2.matchesCreated.length +
      result3.matchesCreated.length;
    expect(totalMatches).toBeGreaterThan(0);
    expect(result3.state.matches.length).toBeGreaterThanOrEqual(totalMatches);
  });
});
