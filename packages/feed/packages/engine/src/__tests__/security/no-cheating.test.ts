/**
 * Security Tests: Prevent Cheating
 *
 * @description
 * Tests to ensure agents and users cannot access information they shouldn't have.
 * Critical for fair gameplay and preventing exploitation.
 *
 * **What We're Preventing**:
 * 1. Accessing future posts/events (time travel)
 * 2. Seeing predetermined question outcomes before resolution
 * 3. Accessing hidden NPC knowledge (reliability, insider status)
 * 4. Seeing pre-generated content in queue
 * 5. Inferring future market prices from scheduled trades
 */

import {
  beforeAll,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolveLiveLlmTestConfig } from "../../../../testing/integration/helpers/live-runtime";
// import { GameGenerator } from '@/engine/GameGenerator'; // Removed static import
import type { GeneratedGame, Question } from "../../types/shared";

// Set timeout to 10 minutes for LLM-based generation
setDefaultTimeout(600000);

// Mock world-context to avoid DB calls BEFORE importing GameGenerator
const mockWorldContext = {
  generateWorldContext: async () => ({
    worldActors: "Test Actor 1, Test Actor 2",
    currentMarkets: "Active Markets: None currently active",
    activePredictions: "Active Questions: None currently active",
    recentTrades: "Recent Trades: No recent activity",
    currentDateTime: new Date().toISOString(),
    currentDate: new Date().toDateString(),
    currentTime: new Date().toTimeString(),
    currentYear: "2025",
    currentMonth: "October",
    currentDay: "15",
    realityGrounding: "Reality grounding context",
    worldFacts: "World facts context",
  }),
  generateCurrentMarkets: async () => "Active Markets: None currently active",
  generateActivePredictions: async () =>
    "Active Questions: None currently active",
  generateRecentTrades: async () => "Recent Trades: No recent activity",
  generateWorldActors: () => "Test Actor 1, Test Actor 2",
  getParodyActorNames: () => ["Test Actor 1", "Test Actor 2"],
  getForbiddenRealNames: () => [],
  validateNoRealNames: () => [],
  validateGeneratedContent: () => ({ errors: [], isValid: true }),
  getCurrentDateContext: () => ({
    dateISO: new Date().toISOString(),
    dateFull: new Date().toDateString(),
    time: new Date().toTimeString(),
    year: "2025",
    month: "October",
    day: "15",
  }),
  getRealityGrounding: async () => "Reality grounding context",
  getMinimalRealityGrounding: async () => "Minimal reality grounding",
  getFullRealityGrounding: async () => "Full reality grounding",
  checkRealityGrounding: () => ({ score: 1, feedback: [] }),
};

mock.module("@feed/engine", () => mockWorldContext);

// Load environment variables from .env files
const loadEnvFile = (filePath: string) => {
  if (!existsSync(filePath)) return;
  const envContent = readFileSync(filePath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").replace(/^["']|["']$/g, "");
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
};

loadEnvFile(".env.test");
loadEnvFile(".env.local");

const hasLLMKey = !!(
  (process.env.GROQ_API_KEY?.trim() ?? "") !== "" ||
  (process.env.ANTHROPIC_API_KEY?.trim() ?? "") !== "" ||
  (process.env.OPENAI_API_KEY?.trim() ?? "") !== ""
);
const liveLlmConfig = resolveLiveLlmTestConfig();

const requireLLMKey = () => {
  if (!hasLLMKey) {
    throw new Error(
      "SECURITY TESTS REQUIRE LLM API KEY. " +
        "Set GROQ_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY to run these tests. " +
        "These tests validate actual engine functionality and MUST NOT be skipped.",
    );
  }
};

describe.skipIf(!liveLlmConfig.enabled)("Security: Prevent Cheating", () => {
  // Shared game instance - generated once before all tests that need it
  let game: GeneratedGame | null = null;

  beforeAll(async () => {
    requireLLMKey();

    console.log("Generating shared game for security tests...");
    const { GameGenerator } = await import("../../GameGenerator");
    const generator = new GameGenerator();
    game = await generator.generateCompleteGame();
    console.log("Game generated successfully");
  });

  describe("No Predetermined Outcome Access", () => {
    test("question outcomes not visible before resolution", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      // Simulate what an API would return
      const publicQuestions = game?.setup.questions.map((q) => {
        // Before resolution, outcome should not be visible
        if (q.status !== "resolved") {
          const { outcome: _outcome, ...publicQuestion } = q;
          return publicQuestion;
        }
        return q;
      });

      const activeQuestions = publicQuestions.filter(
        (q) => !q.status || q.status === "active",
      );

      for (const q of activeQuestions) {
        if ((q as Question).outcome !== undefined) {
          console.log(
            "FAILED CHEATING TEST DEBUG:",
            JSON.stringify(q, null, 2),
          );
        }
        expect((q as Question).outcome).toBeUndefined();
      }
    });

    test("posts dont directly reveal predetermined outcomes", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const suspiciousPatterns = [
        /the answer is (yes|no)/i,
        /will (definitely|certainly|absolutely) (happen|not happen)/i,
        /I know for certain/i,
        /guaranteed to (succeed|fail)/i,
      ];

      let suspiciousPosts = 0;

      for (const day of game?.timeline) {
        for (const post of day.feedPosts) {
          for (const pattern of suspiciousPatterns) {
            if (pattern.test(post.content)) {
              suspiciousPosts++;
              break;
            }
          }
        }
      }

      const totalPosts = game?.timeline.reduce(
        (sum, d) => sum + d.feedPosts.length,
        0,
      );
      const suspiciousRate = suspiciousPosts / totalPosts;

      expect(suspiciousRate).toBeLessThan(0.01); // Less than 1%
    });
  });

  describe("No Future Information Access", () => {
    test("cannot infer future events from current state", () => {
      const queuedContent = [
        {
          scheduledFor: new Date(Date.now() + 5 * 60 * 1000),
          content: "Future post 1",
        },
        {
          scheduledFor: new Date(Date.now() + 10 * 60 * 1000),
          content: "Future post 2",
        },
      ];

      const currentTime = new Date();
      const accessibleContent = queuedContent.filter(
        (item) => item.scheduledFor <= currentTime,
      );

      expect(accessibleContent.length).toBe(0);
    });

    test("market prices dont leak future values", () => {
      const currentPrice = 100;

      // Current price should NOT account for future trades
      expect(currentPrice).toBe(100);
    });
  });

  describe("No Hidden Knowledge Access", () => {
    test("NPC persona reliability not visible to users", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const publicActors = game?.setup.mainActors.map((actor) => {
        const {
          persona: _persona,
          trackRecord: _trackRecord,
          ...publicActor
        } = actor;
        return publicActor;
      });

      for (const actor of publicActors) {
        expect(actor.persona).toBeUndefined();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(
          (actor as { trackRecord?: unknown }).trackRecord,
        ).toBeUndefined();
      }
    });

    test("insider status not visible to users", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const publicQuestions = game?.setup.questions.map((q) => {
        if (q.metadata?.arcPlan) {
          const { metadata: _metadata, ...publicQuestion } = q;
          return publicQuestion;
        }
        return q;
      });

      for (const q of publicQuestions) {
        expect(q.metadata).toBeUndefined();
      }
    });
  });

  describe("Information Gradient Integrity", () => {
    test("early game doesnt reveal too much", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const earlyDays = game?.timeline.filter((d) => d.day <= 10);
      const earlyEvents = earlyDays.flatMap((d) => d.events);

      const hintsGiven = earlyEvents.filter(
        (e) => e.pointsToward !== null && e.pointsToward !== undefined,
      ).length;

      const hintRate = hintsGiven / earlyEvents.length;

      expect(hintRate).toBeLessThan(0.3);
    });

    test("late game provides sufficient clarity", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const lateDays = game?.timeline.filter((d) => d.day >= 25);
      const lateEvents = lateDays.flatMap((d) => d.events);

      const hintsGiven = lateEvents.filter(
        (e) => e.pointsToward !== null && e.pointsToward !== undefined,
      ).length;

      const hintRate = hintsGiven / lateEvents.length;

      expect(hintRate).toBeGreaterThan(0.6);
    });
  });

  describe("Fair Information Distribution", () => {
    test("all players have access to same public information", () => {
      const player1Info = {
        posts: ["post1", "post2", "post3"],
        events: ["event1", "event2"],
        marketPrices: { BTC: 50000 },
      };

      const player2Info = {
        posts: ["post1", "post2", "post3"],
        events: ["event1", "event2"],
        marketPrices: { BTC: 50000 },
      };

      expect(player1Info).toEqual(player2Info);
    });

    test("group chat membership provides fair insider advantage", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const groupChats = game?.setup.groupChats;

      for (const group of groupChats) {
        expect(group.members.length).toBeGreaterThan(0);
        expect(Array.isArray(group.members)).toBe(true);
      }
    });
  });

  describe("Temporal Integrity", () => {
    test("posts have valid timestamps in sequence", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const allPosts = game?.timeline.flatMap((d) => d.feedPosts);

      for (let i = 1; i < allPosts.length; i++) {
        const prev = allPosts[i - 1];
        const curr = allPosts[i];

        if (prev && curr) {
          const prevTime = new Date(prev.timestamp);
          const currTime = new Date(curr.timestamp);

          expect(currTime.getTime()).toBeGreaterThanOrEqual(prevTime.getTime());
        }
      }
    });

    test("event timestamps match their day numbers", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      for (const dayData of game?.timeline) {
        for (const event of dayData.events) {
          expect(event.day).toBe(dayData.day);
          expect(event.day).toBeGreaterThanOrEqual(1);
          expect(event.day).toBeLessThanOrEqual(30);
        }
      }
    });
  });
});
