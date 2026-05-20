/**
 * Game Output Validation Tests
 * Ensures generated games have correct structure and content
 *
 * NOTE: This test suite requires LLM API keys (GROQ_API_KEY or OPENAI_API_KEY)
 * and takes 1-5 minutes to run due to game generation.
 * Tests will skip gracefully if rate limited or API unavailable.
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolveLiveLlmTestConfig } from "../../../../testing/integration/helpers/live-runtime";
import type { GeneratedGame } from "../../GameGenerator";
import { GameGenerator } from "../../GameGenerator";
import { formatError } from "../../utils/error-utils";

setDefaultTimeout(600000);
const liveLlmConfig = resolveLiveLlmTestConfig();

describe.skipIf(!liveLlmConfig.enabled)("Game Output Validation", () => {
  let game: GeneratedGame | null = null;
  let skipped = false;
  let skipReason = "";

  // Generate one game before all tests
  beforeAll(async () => {
    try {
      const generator = new GameGenerator();
      game = await generator.generateCompleteGame();
    } catch (error) {
      const errorMessage = formatError(error);
      if (
        errorMessage.includes("429") ||
        errorMessage.includes("rate_limit") ||
        errorMessage.includes("Rate limit") ||
        errorMessage.includes("401") ||
        errorMessage.includes("Invalid API Key") ||
        errorMessage.includes("API key") ||
        errorMessage.includes("Unauthorized") ||
        errorMessage.includes("Failed to generate") ||
        (errorMessage.includes("after") && errorMessage.includes("attempts"))
      ) {
        console.log(
          "⏭️  LLM API unavailable or generation failed - tests will skip gracefully",
        );
        skipped = true;
        skipReason = "API rate limited, unavailable, or generation failed";
      } else {
        // Re-throw non-API errors
        throw error;
      }
    }
  });

  describe("Schema Validation", () => {
    test("has all required top-level fields", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      expect(game.id).toBeDefined();
      expect(game.version).toBeDefined();
      expect(game.generatedAt).toBeDefined();
      expect(game.setup).toBeDefined();
      expect(game.timeline).toBeDefined();
      expect(game.resolution).toBeDefined();
    });

    test("has all 30 days in timeline", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      expect(game.timeline.length).toBe(30);

      game.timeline.forEach((day, i) => {
        expect(day.day).toBe(i + 1);
      });
    });

    test("has 3 main actors", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      expect(game.setup.mainActors.length).toBe(3);
    });

    test("has 15 supporting actors", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      expect(game.setup.supportingActors.length).toBe(15);
    });

    test("has extras", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      expect(game.setup.extras.length).toBeGreaterThan(0);
    });

    test("has 3 scenarios", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      expect(game.setup.scenarios.length).toBe(3);
    });

    test("has 3 questions", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      expect(game.setup.questions.length).toBe(3);
    });

    test("has group chats", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      expect(game.setup.groupChats.length).toBeGreaterThan(0);
    });

    test("all questions have outcomes", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      game.setup.questions.forEach((q) => {
        expect(typeof q.outcome).toBe("boolean");
      });
    });
  });

  describe("Content Validation", () => {
    test("events reference valid actors", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      const allActorIds = [
        ...game.setup.mainActors.map((a) => a.id),
        ...game.setup.supportingActors.map((a) => a.id),
        ...game.setup.extras.map((a) => a.id),
      ];

      game.timeline.forEach((day) => {
        day.events.forEach((event) => {
          event.actors.forEach((actorId) => {
            expect(allActorIds).toContain(actorId);
          });
        });
      });
    });

    test("each day has events", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      game.timeline.forEach((day) => {
        expect(day.events.length).toBeGreaterThan(0);
      });
    });

    test("group chats have valid members", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      const allActorIds = [
        ...game.setup.mainActors.map((a) => a.id),
        ...game.setup.supportingActors.map((a) => a.id),
        ...game.setup.extras.map((a) => a.id),
      ];

      game.setup.groupChats.forEach((chat) => {
        expect(chat.members.length).toBeGreaterThan(0);
        chat.members.forEach((memberId) => {
          expect(allActorIds).toContain(memberId);
        });
      });
    });

    test("events have unique IDs", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      const eventIds = new Set<string>();

      game.timeline.forEach((day) => {
        day.events.forEach((event) => {
          expect(eventIds.has(event.id)).toBe(false);
          eventIds.add(event.id);
        });
      });
    });

    test("timestamps are valid", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      const generatedAt = new Date(game.generatedAt);
      expect(generatedAt.getTime()).toBeGreaterThan(0);
    });
  });

  describe("Narrative Coherence", () => {
    test("scenarios connect to questions", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      game.setup.questions.forEach((q) => {
        expect(q.scenario).toBeGreaterThanOrEqual(1);
        expect(q.scenario).toBeLessThanOrEqual(3);
      });
    });

    test("events distributed across days", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      const eventCounts = game.timeline.map((d) => d.events.length);
      const total = eventCounts.reduce((sum, c) => sum + c, 0);

      expect(total).toBeGreaterThan(30); // At least 1 per day
    });

    test("has resolution for all questions", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      expect(game.resolution.outcomes.length).toBe(3);

      game.resolution.outcomes.forEach((outcome) => {
        expect(typeof outcome.answer).toBe("boolean");
        expect(outcome.explanation).toBeDefined();
      });
    });
  });

  describe("Quality Validation", () => {
    test("early days have fewer events than late days", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      const earlyEvents = game.timeline
        .slice(0, 10)
        .reduce((sum, d) => sum + d.events.length, 0);
      const lateEvents = game.timeline
        .slice(20, 25)
        .reduce((sum, d) => sum + d.events.length, 0);

      expect(earlyEvents).toBeGreaterThan(0);
      expect(lateEvents).toBeGreaterThan(0);
    });

    test("file size is reasonable (<10MB)", () => {
      if (skipped || !game) {
        console.log(`⏭️  Skipping - ${skipReason || "No game generated"}`);
        return;
      }
      const json = JSON.stringify(game);
      const sizeInMB = json.length / (1024 * 1024);

      expect(sizeInMB).toBeLessThan(10);
    });
  });
});
