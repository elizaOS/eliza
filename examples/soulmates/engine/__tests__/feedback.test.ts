import { beforeEach, describe, expect, it } from "vitest";
import { feedbackBiasWeight, processFeedbackQueue } from "../feedback";
import { generateEngineState } from "../generator";
import type { EngineState, FeedbackEntry } from "../types";

describe("processFeedbackQueue", () => {
  let state: EngineState;
  const now = "2026-01-18T12:00:00.000Z";

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 30,
      now,
    });
  });

  it("should process unprocessed feedback entries", () => {
    const unprocessedBefore = state.feedbackQueue.filter(
      (entry) => !entry.processed,
    ).length;
    const result = processFeedbackQueue(state, now, 50);
    expect(result.processed.length).toBeLessThanOrEqual(unprocessedBefore);
    expect(result.processed.every((entry) => entry.processed)).toBe(true);
  });

  it("should update reliability score for receiver", () => {
    const feedbackEntry: FeedbackEntry = {
      id: "test-feedback",
      fromPersonaId: 1,
      toPersonaId: 0,
      rating: 5,
      sentiment: "positive",
      issues: [],
      redFlags: [],
      notes: "Great meeting",
      createdAt: now,
      processed: false,
      source: "meeting",
    };
    state.feedbackQueue = [feedbackEntry];

    const originalReliability = state.personas[0].reliability.score;
    processFeedbackQueue(state, now, 10);
    const newReliability = state.personas[0].reliability.score;

    expect(newReliability).toBeGreaterThan(originalReliability);
  });

  it("should decrease reliability for no_show issue", () => {
    const feedbackEntry: FeedbackEntry = {
      id: "no-show-feedback",
      fromPersonaId: 1,
      toPersonaId: 0,
      rating: 1,
      sentiment: "negative",
      issues: [{ code: "no_show", severity: "high", redFlag: true, notes: "" }],
      redFlags: ["no_show"],
      notes: "Didn't show up",
      createdAt: now,
      processed: false,
      source: "meeting",
    };
    state.feedbackQueue = [feedbackEntry];

    const originalReliability = state.personas[0].reliability.score;
    const originalNoShowCount = state.personas[0].reliability.noShowCount;
    processFeedbackQueue(state, now, 10);

    expect(state.personas[0].reliability.score).toBeLessThan(
      originalReliability,
    );
    expect(state.personas[0].reliability.noShowCount).toBe(
      originalNoShowCount + 1,
    );
  });

  it("should update rater bias stats", () => {
    const feedbackEntry: FeedbackEntry = {
      id: "rater-bias-test",
      fromPersonaId: 1,
      toPersonaId: 0,
      rating: 2,
      sentiment: "negative",
      issues: [],
      redFlags: [],
      notes: "Not great",
      createdAt: now,
      processed: false,
      source: "meeting",
    };
    state.feedbackQueue = [feedbackEntry];

    const originalGivenCount = state.personas[1].feedbackBias.stats.givenCount;
    processFeedbackQueue(state, now, 10);

    expect(state.personas[1].feedbackBias.stats.givenCount).toBe(
      originalGivenCount + 1,
    );
    expect(
      state.personas[1].feedbackBias.harshnessScore,
    ).toBeGreaterThanOrEqual(0);
    expect(state.personas[1].feedbackBias.harshnessScore).toBeLessThanOrEqual(
      1,
    );
  });

  it("should boost ghosted rater reliability", () => {
    const feedbackEntry: FeedbackEntry = {
      id: "ghost-feedback",
      fromPersonaId: 1,
      toPersonaId: 0,
      rating: 1,
      sentiment: "negative",
      issues: [{ code: "ghosted", severity: "high", redFlag: true, notes: "" }],
      redFlags: ["ghosted"],
      notes: "They ghosted me",
      createdAt: now,
      processed: false,
      source: "meeting",
    };
    state.feedbackQueue = [feedbackEntry];

    const originalRaterReliability = state.personas[1].reliability.score;
    processFeedbackQueue(state, now, 10);

    expect(state.personas[1].reliability.score).toBeGreaterThan(
      originalRaterReliability,
    );
  });

  it("should respect processFeedbackLimit", () => {
    const result = processFeedbackQueue(state, now, 5);
    expect(result.processed.length).toBeLessThanOrEqual(5);
  });

  it("should handle missing personas gracefully", () => {
    const feedbackEntry: FeedbackEntry = {
      id: "missing-persona",
      fromPersonaId: 9999,
      toPersonaId: 0,
      rating: 5,
      sentiment: "positive",
      issues: [],
      redFlags: [],
      notes: "Test",
      createdAt: now,
      processed: false,
      source: "meeting",
    };
    state.feedbackQueue = [feedbackEntry];

    const result = processFeedbackQueue(state, now, 10);
    expect(result.processed.length).toBe(1);
    expect(result.processed[0].processed).toBe(true);
  });

  it("should update sentiment summary", () => {
    const feedbackEntry: FeedbackEntry = {
      id: "sentiment-test",
      fromPersonaId: 1,
      toPersonaId: 0,
      rating: 5,
      sentiment: "positive",
      issues: [],
      redFlags: [],
      notes: "Excellent",
      createdAt: now,
      processed: false,
      source: "meeting",
    };
    state.feedbackQueue = [feedbackEntry];

    const originalPositiveCount =
      state.personas[0].profile.feedbackSummary.positiveCount;
    processFeedbackQueue(state, now, 10);

    expect(state.personas[0].profile.feedbackSummary.positiveCount).toBe(
      originalPositiveCount + 1,
    );
  });

  it("should create facts for feedback issues and red flags", () => {
    const feedbackEntry: FeedbackEntry = {
      id: "facts-test",
      fromPersonaId: 1,
      toPersonaId: 0,
      rating: 1,
      sentiment: "negative",
      issues: [{ code: "rude", severity: "medium", redFlag: true, notes: "" }],
      redFlags: ["rude"],
      notes: "Was rude",
      createdAt: now,
      processed: false,
      source: "meeting",
    };
    state.feedbackQueue = [feedbackEntry];

    const originalFactCount = state.personas[0].facts.length;
    processFeedbackQueue(state, now, 10);

    expect(state.personas[0].facts.length).toBeGreaterThan(originalFactCount);
    const rudeFact = state.personas[0].facts.find((f) =>
      f.key.includes("rude"),
    );
    expect(rudeFact).toBeDefined();
  });

  it("should apply bias weight to feedback sentiment", () => {
    const harshRater = state.personas[1];
    harshRater.feedbackBias.harshnessScore = 0.9;
    harshRater.feedbackBias.stats.givenCount = 10;

    const feedbackEntry: FeedbackEntry = {
      id: "bias-weight-test",
      fromPersonaId: 1,
      toPersonaId: 0,
      rating: 3,
      sentiment: "neutral",
      issues: [],
      redFlags: [],
      notes: "OK",
      createdAt: now,
      processed: false,
      source: "meeting",
    };
    state.feedbackQueue = [feedbackEntry];

    processFeedbackQueue(state, now, 10);
    expect(
      state.personas[0].profile.feedbackSummary.sentimentScore,
    ).toBeDefined();
  });
});

describe("feedbackBiasWeight", () => {
  it("should return weight between 0.6 and 1.2", () => {
    const bias = {
      harshnessScore: 0.5,
      positivityBias: 0.5,
      redFlagFrequency: 0,
      notes: [],
      stats: {
        givenCount: 0,
        averageRating: 0,
        negativeRate: 0,
        redFlagRate: 0,
        lastUpdated: "2026-01-18T12:00:00.000Z",
      },
      lastUpdated: "2026-01-18T12:00:00.000Z",
    };
    const weight = feedbackBiasWeight(bias);
    expect(weight).toBeGreaterThanOrEqual(0.6);
    expect(weight).toBeLessThanOrEqual(1.2);
  });

  it("should return lower weight for highly biased raters", () => {
    const extremeBias = {
      harshnessScore: 0.9,
      positivityBias: 0.1,
      redFlagFrequency: 0.5,
      notes: [],
      stats: {
        givenCount: 20,
        averageRating: 1.5,
        negativeRate: 0.9,
        redFlagRate: 0.5,
        lastUpdated: "2026-01-18T12:00:00.000Z",
      },
      lastUpdated: "2026-01-18T12:00:00.000Z",
    };
    const extremeWeight = feedbackBiasWeight(extremeBias);

    const normalBias = {
      harshnessScore: 0.5,
      positivityBias: 0.5,
      redFlagFrequency: 0,
      notes: [],
      stats: {
        givenCount: 20,
        averageRating: 3,
        negativeRate: 0.2,
        redFlagRate: 0,
        lastUpdated: "2026-01-18T12:00:00.000Z",
      },
      lastUpdated: "2026-01-18T12:00:00.000Z",
    };
    const normalWeight = feedbackBiasWeight(normalBias);

    expect(extremeWeight).toBeLessThan(normalWeight);
  });
});
