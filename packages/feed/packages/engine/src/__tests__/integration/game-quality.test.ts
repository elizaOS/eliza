/**
 * Integration Tests: Game Quality
 *
 * @module engine/__tests__/integration/game-quality.test
 *
 * @description
 * Integration tests that validate generated game content quality with LLM calls.
 *
 * **Tests verify:**
 * 1. No undefined/missing fields in generated content
 * 2. All required data is present and valid
 * 3. Timestamps are properly formatted
 * 4. IDs are unique across game
 * 5. References (actor IDs, org IDs) are valid
 * 6. Content meets length requirements
 *
 * ⚠️ **IMPORTANT**: These tests use real API calls and are marked .skip by default.
 *
 * @usage
 * Run manually: `bun test src/engine/__tests__/integration/game-quality.test.ts`
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { logger } from "@feed/shared";
import { resolveLiveLlmTestConfig } from "../../../../testing/integration/helpers/live-runtime";
import { GameGenerator } from "../../GameGenerator";
import type { GeneratedGame } from "../../types/shared";
import { formatError } from "../../utils/error-utils";

// Set timeout to 10 minutes for LLM-based generation
setDefaultTimeout(600000);

// Load environment variables from .env files if they exist (for CI and local environments)
// Priority: process.env > .env.test > .env.local
const loadEnvFile = (filePath: string) => {
  if (!existsSync(filePath)) return;
  const envContent = readFileSync(filePath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const [key, ...valueParts] = trimmed.split("=");
      if (key && valueParts.length > 0) {
        const value = valueParts.join("=").replace(/^["']|["']$/g, "");
        // Only set if not already in process.env (env vars take precedence)
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
};

// Load .env.test first (created by CI prepare-env.sh), then .env.local (for local dev)
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
      "GAME QUALITY TESTS REQUIRE LLM API KEY. " +
        "Set GROQ_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY to run these tests. " +
        "These tests validate actual engine functionality and MUST NOT be skipped.",
    );
  }
};

describe.skipIf(!liveLlmConfig.enabled)(
  "Game Quality Integration Tests",
  () => {
    // Shared game instance - generated once before all tests
    let game: GeneratedGame | null = null;

    beforeAll(async () => {
      requireLLMKey();

      try {
        logger.info(
          "Generating shared game for all quality tests...",
          undefined,
          "QualityTest",
        );
        const generator = new GameGenerator();
        game = await generator.generateCompleteGame();
        logger.info("Game generated successfully", undefined, "QualityTest");
      } catch (error) {
        const errorMessage = formatError(error);
        // Game generation failure is a test failure, not a skip
        throw new Error(`Game generation failed: ${errorMessage}`);
      }
    });

    test("generated game has no undefined fields", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      logger.info("Validating game structure...", undefined, "QualityTest");

      const allActors = [
        ...game.setup.mainActors,
        ...game.setup.supportingActors,
        ...game.setup.extras,
      ];

      for (const actor of allActors) {
        expect(actor.id).toBeDefined();
        expect(actor.name).toBeDefined();
        expect(actor.description).toBeDefined();
        expect(actor.tier).toBeDefined();
        expect(actor.role).toBeDefined();

        if (actor.persona) {
          expect(typeof actor.persona.reliability).toBe("number");
          expect(actor.persona.reliability).toBeGreaterThanOrEqual(0);
          expect(actor.persona.reliability).toBeLessThanOrEqual(1);
          expect(Array.isArray(actor.persona.insiderOrgs)).toBe(true);
          expect(typeof actor.persona.willingToLie).toBe("boolean");
        }
      }
      logger.info(
        `✅ All ${allActors.length} actors have required fields`,
        undefined,
        "QualityTest",
      );

      let eventCount = 0;
      for (const day of game.timeline) {
        for (const event of day.events) {
          eventCount++;
          expect(event.id).toBeDefined();
          expect(event.day).toBeDefined();
          expect(event.type).toBeDefined();
          expect(event.description).toBeDefined();
          expect(event.description.length).toBeGreaterThan(0);
          expect(event.description.length).toBeLessThan(250); // Max length
          expect(event.actors).toBeDefined();
          expect(Array.isArray(event.actors)).toBe(true);
          expect(event.visibility).toBeDefined();
        }
      }

      logger.info(
        `✅ All ${eventCount} events have required fields`,
        undefined,
        "QualityTest",
      );

      let postCount = 0;
      for (const day of game.timeline) {
        for (const post of day.feedPosts) {
          postCount++;
          expect(post.id).toBeDefined();
          expect(post.content).toBeDefined();
          expect(post.content.length).toBeGreaterThan(0);
          expect(post.author).toBeDefined();
          expect(post.authorName).toBeDefined();
          expect(post.timestamp).toBeDefined();
          expect(post.day).toBeDefined();

          const timestamp = new Date(post.timestamp);
          expect(Number.isNaN(timestamp.getTime())).toBe(false);

          if (post.sentiment !== null && post.sentiment !== undefined) {
            expect(post.sentiment).toBeGreaterThanOrEqual(-1);
            expect(post.sentiment).toBeLessThanOrEqual(1);
          }

          if (post.clueStrength !== null && post.clueStrength !== undefined) {
            expect(post.clueStrength).toBeGreaterThanOrEqual(0);
            expect(post.clueStrength).toBeLessThanOrEqual(1);
          }
        }
      }

      logger.info(
        `✅ All ${postCount} feed posts have required fields`,
        undefined,
        "QualityTest",
      );
      logger.info(
        "✅ PASS: No undefined fields detected",
        undefined,
        "QualityTest",
      );
    });

    test("all actor IDs are unique", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const allActors = [
        ...game.setup.mainActors,
        ...game.setup.supportingActors,
        ...game.setup.extras,
      ];

      const ids = allActors.map((a) => a.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
      logger.info(
        `✅ All ${ids.length} actor IDs are unique`,
        undefined,
        "QualityTest",
      );
    });

    test("all event IDs are unique", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const allEvents = game.timeline.flatMap((day) => day.events);
      const ids = allEvents.map((e) => e.id);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(ids.length);
      logger.info(
        `✅ All ${ids.length} event IDs are unique`,
        undefined,
        "QualityTest",
      );
    });

    test("all actor references are valid", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      const allActors = [
        ...game.setup.mainActors,
        ...game.setup.supportingActors,
        ...game.setup.extras,
      ];
      const validActorIds = new Set(allActors.map((a) => a.id));
      const validOrgIds = new Set(game.setup.organizations.map((o) => o.id));

      for (const day of game.timeline) {
        for (const event of day.events) {
          for (const actorId of event.actors) {
            expect(validActorIds.has(actorId)).toBe(true);
          }
        }

        for (const post of day.feedPosts) {
          // Allow system authors
          if (
            post.author.startsWith("game-") ||
            post.author.startsWith("market-") ||
            post.author === "ambient"
          ) {
            continue;
          }

          const isValid =
            validActorIds.has(post.author) || validOrgIds.has(post.author);
          expect(isValid).toBe(true);
        }
      }

      logger.info(
        "✅ All actor and organization references are valid",
        undefined,
        "QualityTest",
      );
    });

    test("questions have metadata and arc plans", async () => {
      // Game must be generated - enforced by beforeAll
      expect(game).toBeDefined();

      for (const question of game.setup.questions) {
        expect(question.metadata).toBeDefined();
        expect(question.metadata?.arcPlan).toBeDefined();

        const arcPlan = question.metadata?.arcPlan!;

        expect(typeof arcPlan.uncertaintyPeakDay).toBe("number");
        expect(typeof arcPlan.clarityOnsetDay).toBe("number");
        expect(typeof arcPlan.verificationDay).toBe("number");
        expect(Array.isArray(arcPlan.insiders)).toBe(true);
        expect(Array.isArray(arcPlan.deceivers)).toBe(true);

        expect(arcPlan.clarityOnsetDay).toBeGreaterThan(
          arcPlan.uncertaintyPeakDay,
        );
        expect(arcPlan.verificationDay).toBeGreaterThan(
          arcPlan.clarityOnsetDay,
        );

        logger.info(
          `Q${question.id}: Uncertainty peak=${arcPlan.uncertaintyPeakDay}, Clarity=${arcPlan.clarityOnsetDay}, Verification=${arcPlan.verificationDay}`,
          undefined,
          "QualityTest",
        );
      }

      logger.info(
        "✅ All questions have valid arc plans",
        undefined,
        "QualityTest",
      );
    });
  },
);
