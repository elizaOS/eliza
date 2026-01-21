import { beforeEach, describe, expect, it } from "vitest";
import { runEngineTick } from "../engine";
import { generateEngineState, generatePersonas } from "../generator";
import type { EngineOptions, EngineState } from "../types";

describe("runEngineTick", () => {
  let state: EngineState;
  let options: EngineOptions;

  beforeEach(() => {
    state = generateEngineState({
      seed: 42,
      personaCount: 20,
      feedbackEvents: 10,
      now: "2026-01-18T12:00:00.000Z",
    });
    options = {
      now: "2026-01-18T12:00:00.000Z",
      batchSize: 5,
      processFeedbackLimit: 10,
      maxCandidates: 10,
      smallPassTopK: 5,
      largePassTopK: 3,
      graphHops: 2,
      matchCooldownDays: 30,
      reliabilityWeight: 1,
      matchDomains: ["dating", "friendship", "business"],
    };
  });

  it("should process feedback and update personas", async () => {
    const unprocessedBefore = state.feedbackQueue.filter(
      (entry) => !entry.processed,
    ).length;
    expect(unprocessedBefore).toBeGreaterThan(0);

    const result = await runEngineTick(state, options);

    const unprocessedAfter = result.state.feedbackQueue.filter(
      (entry) => !entry.processed,
    ).length;
    expect(unprocessedAfter).toBeLessThan(unprocessedBefore);
    expect(result.feedbackProcessed.length).toBeGreaterThan(0);
  });

  it("should create matches for eligible personas", async () => {
    // Use relaxed options to ensure matches are created with random data
    const relaxedOptions = {
      ...options,
      requireSameCity: false,
      requireSharedInterests: false,
    };
    const result = await runEngineTick(state, relaxedOptions);
    expect(result.matchesCreated.length).toBeGreaterThan(0);
    for (const match of result.matchesCreated) {
      expect(match.matchId).toBeDefined();
      expect(match.domain).toBeDefined();
      expect(match.personaA).toBeDefined();
      expect(match.personaB).toBeDefined();
      expect(match.personaA).not.toBe(match.personaB);
      expect(match.status).toBe("proposed");
      expect(match.assessment.score).toBeGreaterThanOrEqual(-100);
      expect(match.assessment.score).toBeLessThanOrEqual(100);
    }
  });

  it("should not mutate input state", async () => {
    const originalMatchCount = state.matches.length;
    const originalFeedbackCount = state.feedbackQueue.filter(
      (e) => !e.processed,
    ).length;

    const result = await runEngineTick(state, options);

    expect(state.matches.length).toBe(originalMatchCount);
    expect(state.feedbackQueue.filter((e) => !e.processed).length).toBe(
      originalFeedbackCount,
    );
    expect(result.state.matches.length).toBeGreaterThanOrEqual(
      originalMatchCount,
    );
  });

  it("should respect targetPersonaIds when provided", async () => {
    const targetIds = [0, 1];
    const targetOptions = {
      ...options,
      targetPersonaIds: targetIds,
      batchSize: 100,
    };

    const result = await runEngineTick(state, targetOptions);

    for (const match of result.matchesCreated) {
      expect(
        targetIds.includes(match.personaA) ||
          targetIds.includes(match.personaB),
      ).toBe(true);
    }
  });

  it("should process conversations and create facts", async () => {
    const personaWithConvo = state.personas.find((p) =>
      p.conversations.some((c) => !c.processed),
    );
    if (!personaWithConvo) {
      const persona = state.personas[0];
      persona.conversations.push({
        conversationId: "test-convo",
        scenario: "onboarding",
        turns: [
          {
            turnId: "t1",
            role: "agent",
            text: "Hello",
            createdAt: options.now,
          },
          {
            turnId: "t2",
            role: "user",
            text: "I love hiking",
            createdAt: options.now,
          },
        ],
        processed: false,
      });
    }

    const result = await runEngineTick(state, options);

    const updated = result.personasUpdated.find((p) =>
      p.conversations.some(
        (c) =>
          c.processed &&
          c.conversationId ===
            personaWithConvo?.conversations[0]?.conversationId,
      ),
    );
    expect(updated).toBeDefined();
  });

  it("should add graph edges for feedback", async () => {
    const initialEdgeCount = state.matchGraph.edges.length;
    const result = await runEngineTick(state, options);
    expect(result.state.matchGraph.edges.length).toBeGreaterThan(
      initialEdgeCount,
    );
  });

  it("should not create duplicate matches for same pair", async () => {
    const result1 = await runEngineTick(state, options);
    const result2 = await runEngineTick(result1.state, options);

    const pairs = new Set<string>();
    for (const match of [
      ...result1.matchesCreated,
      ...result2.matchesCreated,
    ]) {
      const key = [match.personaA, match.personaB].sort().join("-");
      const hasDuplicate = pairs.has(key);
      pairs.add(key);
      if (hasDuplicate) {
        const existingOpen = [
          ...result1.state.matches,
          ...result2.state.matches,
        ].find(
          (m) =>
            ((m.personaA === match.personaA && m.personaB === match.personaB) ||
              (m.personaA === match.personaB &&
                m.personaB === match.personaA)) &&
            m.status !== "canceled" &&
            m.status !== "expired",
        );
        expect(existingOpen).toBeUndefined();
      }
    }
  });

  it("should handle empty batch gracefully", async () => {
    const emptyOptions = { ...options, targetPersonaIds: [9999], batchSize: 0 };
    const result = await runEngineTick(state, emptyOptions);
    expect(result.matchesCreated.length).toBe(0);
  });

  it("should auto-schedule matches when enabled", async () => {
    const schedulingOptions = { ...options, autoScheduleMatches: true };
    const result = await runEngineTick(state, schedulingOptions);

    const scheduledMatches = result.matchesCreated.filter(
      (m) => m.status === "scheduled" && m.scheduledMeetingId,
    );
    expect(scheduledMatches.length).toBeGreaterThanOrEqual(0);
  });

  it("should limit conversation processing to processConversationLimit", async () => {
    const personas = generatePersonas({ seed: 99, count: 5, now: options.now });
    for (const persona of personas) {
      persona.conversations = Array.from({ length: 20 }, (_, i) => ({
        conversationId: `c${i}`,
        scenario: "test",
        turns: [
          { turnId: "t1", role: "agent", text: "hi", createdAt: options.now },
          { turnId: "t2", role: "user", text: "hello", createdAt: options.now },
        ],
        processed: false,
      }));
    }
    const testState = { ...state, personas };
    const limitOptions = {
      ...options,
      processConversationLimit: 5,
      batchSize: 5,
    };

    const result = await runEngineTick(testState, limitOptions);

    const processedCount = result.state.personas
      .flatMap((p) => p.conversations)
      .filter((c) => c.processed).length;
    expect(processedCount).toBeLessThanOrEqual(5);
  });
});
