/**
 * Posting Probability Service Test Suite
 *
 * Tests for simplified NPC posting probability calculation and weighted sampling.
 * Simplified: Equal base probability for all NPCs with spam prevention.
 *
 * NOTE: Tests use actual config values to stay in sync with npc-activity.ts
 */

import { describe, expect, test } from "bun:test";
import type { ActorStateRow } from "@feed/db";
import { ACTOR_TIERS } from "@feed/shared";
import { NPC_POSTING_CONFIG } from "../config/npc-activity";
import {
  calculatePostingProbability,
  type PostingActor,
  type PostingContext,
  postingProbabilityService,
  weightedRandomSample,
} from "../services/posting-probability-service";

// Extract config values for test assertions
const BASE_PROBABILITY = NPC_POSTING_CONFIG.baseProbability;
const MAX_POSTS_PER_DAY = NPC_POSTING_CONFIG.maxPostsPerDay;
const MIN_HOURS_BETWEEN_POSTS = NPC_POSTING_CONFIG.minHoursBetweenPosts;
const MENTION_BOOST = NPC_POSTING_CONFIG.mentionBoost;
const AFFILIATION_BOOST = NPC_POSTING_CONFIG.affiliationBoost;

/**
 * Create a minimal mock ActorStateRow for testing.
 * Only includes fields used by the probability calculation.
 */
const createMockState = (
  overrides: Partial<ActorStateRow> = {},
): ActorStateRow =>
  ({
    id: "test-actor",
    tradingBalance: "10000",
    reputationPoints: 10000,
    hasPool: false,
    lastPostAt: null,
    lastActiveAt: null,
    postsToday: 0,
    postsTodayResetAt: null,
    currentMood: "0",
    recentMemories: [],
    relationships: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as ActorStateRow;

// Mock context for testing
const createMockContext = (
  overrides: Partial<PostingContext> = {},
): PostingContext => ({
  currentHour: 14,
  currentTime: new Date("2026-01-05T14:00:00Z"), // Monday 2pm UTC
  recentlyMentionedActorIds: [],
  activeEventQuestionIds: [],
  activeEvents: [],
  ...overrides,
});

// Mock actor for testing
const createMockActor = (
  overrides: Partial<PostingActor> = {},
): PostingActor => ({
  id: "test-actor-1",
  domain: ["crypto"],
  personality: "A typical trader",
  affiliations: [],
  tier: ACTOR_TIERS.B_TIER,
  ...overrides,
});

describe("Posting Probability Service - Base Probability", () => {
  test("all tiers have equal base probability (simplified)", () => {
    const context = createMockContext();

    const sActor = createMockActor({ tier: ACTOR_TIERS.S_TIER });
    const bActor = createMockActor({ id: "b-actor", tier: ACTOR_TIERS.B_TIER });
    const cActor = createMockActor({ id: "c-actor", tier: ACTOR_TIERS.C_TIER });

    const sProb = calculatePostingProbability(sActor, null, context);
    const bProb = calculatePostingProbability(bActor, null, context);
    const cProb = calculatePostingProbability(cActor, null, context);

    // Simplified: equal probability for all tiers
    expect(sProb).toBe(BASE_PROBABILITY);
    expect(bProb).toBe(BASE_PROBABILITY);
    expect(cProb).toBe(BASE_PROBABILITY);
  });

  test("base probability matches config", () => {
    const actor = createMockActor();
    const context = createMockContext();
    const prob = calculatePostingProbability(actor, null, context);

    expect(prob).toBe(BASE_PROBABILITY);
  });

  test("probability is capped at 1.0", () => {
    const actor = createMockActor();
    // Create context with all boosts (mention + affiliation)
    const context = createMockContext({
      recentlyMentionedActorIds: [actor.id],
      activeEvents: [
        {
          questionId: "q1",
          affectedActorIds: [actor.id],
          affectedStocks: [],
        },
      ],
    });

    const prob = calculatePostingProbability(actor, null, context);
    expect(prob).toBeLessThanOrEqual(1.0);
  });
});

describe("Posting Probability Service - Daily Cap", () => {
  test("returns 0 when daily post cap is reached", () => {
    const actor = createMockActor();
    const state = createMockState({
      id: actor.id,
      postsToday: MAX_POSTS_PER_DAY,
      lastPostAt: new Date(),
    });
    const context = createMockContext();

    const prob = calculatePostingProbability(actor, state, context);
    expect(prob).toBe(0);
  });

  test("allows posting when under daily cap", () => {
    const actor = createMockActor();
    const contextTime = new Date("2026-01-05T14:00:00Z");
    const state = createMockState({
      id: actor.id,
      postsToday: 1,
      // Set lastPostAt to well before context time to pass the recency check
      lastPostAt: new Date(
        contextTime.getTime() - (MIN_HOURS_BETWEEN_POSTS + 2) * 60 * 60 * 1000,
      ),
    });
    const context = createMockContext({ currentTime: contextTime });

    const prob = calculatePostingProbability(actor, state, context);
    expect(prob).toBeGreaterThan(0);
  });
});

describe("Posting Probability Service - Recency Check", () => {
  test("returns 0 if posted within MIN_HOURS_BETWEEN_POSTS", () => {
    const actor = createMockActor();
    const contextTime = new Date("2026-01-05T14:00:00Z");
    const state = createMockState({
      id: actor.id,
      postsToday: 1,
      // Posted less than MIN_HOURS_BETWEEN_POSTS ago
      lastPostAt: new Date(
        contextTime.getTime() - (MIN_HOURS_BETWEEN_POSTS - 1) * 60 * 60 * 1000,
      ),
    });
    const context = createMockContext({ currentTime: contextTime });

    const prob = calculatePostingProbability(actor, state, context);
    expect(prob).toBe(0); // Should be blocked by recency
  });

  test("allows posting after MIN_HOURS_BETWEEN_POSTS", () => {
    const actor = createMockActor();
    const contextTime = new Date("2026-01-05T14:00:00Z");
    const state = createMockState({
      id: actor.id,
      postsToday: 1,
      // Posted more than MIN_HOURS_BETWEEN_POSTS ago
      lastPostAt: new Date(
        contextTime.getTime() - (MIN_HOURS_BETWEEN_POSTS + 1) * 60 * 60 * 1000,
      ),
    });
    const context = createMockContext({ currentTime: contextTime });

    const prob = calculatePostingProbability(actor, state, context);
    expect(prob).toBeGreaterThan(0);
  });

  test("allows posting with no previous post", () => {
    const actor = createMockActor();
    const state = createMockState({
      id: actor.id,
      postsToday: 0,
      lastPostAt: null, // Never posted
    });
    const context = createMockContext();

    const prob = calculatePostingProbability(actor, state, context);
    expect(prob).toBeGreaterThan(0);
  });
});

describe("Posting Probability Service - Mention Boost", () => {
  test("mentioned actors get probability boost", () => {
    const actor = createMockActor();
    const baseContext = createMockContext();
    const mentionedContext = createMockContext({
      recentlyMentionedActorIds: [actor.id],
    });

    const probBase = calculatePostingProbability(actor, null, baseContext);
    const probMentioned = calculatePostingProbability(
      actor,
      null,
      mentionedContext,
    );

    // Mention boost from config
    expect(probMentioned).toBe(probBase * MENTION_BOOST);
  });

  test("non-mentioned actors do not get mention boost", () => {
    const actor = createMockActor({ id: "actor-1" });
    const context = createMockContext({
      recentlyMentionedActorIds: ["actor-2", "actor-3"], // Different actors
    });

    const prob = calculatePostingProbability(actor, null, context);
    expect(prob).toBe(BASE_PROBABILITY); // Base probability only
  });
});

describe("Posting Probability Service - Affiliation Boost", () => {
  test("actors with affiliated events get probability boost", () => {
    const actor = createMockActor();
    const baseContext = createMockContext();
    const eventContext = createMockContext({
      activeEvents: [
        { questionId: "q1", affectedActorIds: [actor.id], affectedStocks: [] },
      ],
    });

    const probBase = calculatePostingProbability(actor, null, baseContext);
    const probEvent = calculatePostingProbability(actor, null, eventContext);

    // Affiliation boost from config
    expect(probEvent).toBe(probBase * AFFILIATION_BOOST);
  });

  test("combined mention and affiliation boosts stack", () => {
    const actor = createMockActor();
    const bothContext = createMockContext({
      recentlyMentionedActorIds: [actor.id],
      activeEvents: [
        { questionId: "q1", affectedActorIds: [actor.id], affectedStocks: [] },
      ],
    });

    const prob = calculatePostingProbability(actor, null, bothContext);
    // BASE_PROBABILITY * MENTION_BOOST * AFFILIATION_BOOST
    const expectedProb = BASE_PROBABILITY * MENTION_BOOST * AFFILIATION_BOOST;
    expect(prob).toBeCloseTo(expectedProb, 4);
  });
});

describe("Posting Probability Service - Weighted Random Sample", () => {
  test("returns empty array for empty input", () => {
    const result = weightedRandomSample([], 5);
    expect(result).toEqual([]);
  });

  test("returns all candidates if count exceeds length", () => {
    const candidates = [
      { probability: 0.5, id: "a" },
      { probability: 0.3, id: "b" },
    ];
    const result = weightedRandomSample(candidates, 10);
    expect(result.length).toBe(2);
  });

  test("returns requested count from larger pool", () => {
    const candidates = [
      { probability: 0.5, id: "a" },
      { probability: 0.3, id: "b" },
      { probability: 0.2, id: "c" },
      { probability: 0.1, id: "d" },
    ];
    const result = weightedRandomSample(candidates, 2);
    expect(result.length).toBe(2);
  });

  test("handles all-zero probabilities gracefully", () => {
    const candidates = [
      { probability: 0, id: "a" },
      { probability: 0, id: "b" },
      { probability: 0, id: "c" },
    ];
    const result = weightedRandomSample(candidates, 2);

    // Should still return 2 items (random selection fallback)
    expect(result.length).toBe(2);
  });

  test("higher probability candidates are selected more often", () => {
    const candidates = [
      { probability: 0.9, id: "high" },
      { probability: 0.01, id: "low" },
    ];

    let highCount = 0;
    // Increase iterations for more stable statistical results
    const iterations = 1000;

    for (let i = 0; i < iterations; i++) {
      const result = weightedRandomSample(candidates, 1);
      if (result[0]?.id === "high") {
        highCount++;
      }
    }

    // With 0.9/(0.9+0.01) ≈ 98.9% probability, expect at least 850 hits out of 1000
    // Using a generous threshold to avoid flakiness
    expect(highCount).toBeGreaterThan(850);
  });

  test("does not include duplicates in result", () => {
    const candidates = [
      { probability: 0.5, id: "a" },
      { probability: 0.3, id: "b" },
      { probability: 0.2, id: "c" },
    ];
    const result = weightedRandomSample(candidates, 3);

    const ids = result.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

describe("Posting Probability Service - Service Singleton", () => {
  test("calculate method works correctly", () => {
    const actor = createMockActor();
    const context = createMockContext();

    const prob = postingProbabilityService.calculate(actor, null, context);
    expect(prob).toBeGreaterThanOrEqual(0);
    expect(prob).toBeLessThanOrEqual(1.0);
  });

  test("weightedSample method works correctly", () => {
    const candidates = [
      { probability: 0.5, id: "a" },
      { probability: 0.3, id: "b" },
    ];

    const result = postingProbabilityService.weightedSample(candidates, 1);
    expect(result.length).toBe(1);
  });
});
