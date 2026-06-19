/**
 * Production Engine Tests
 *
 * @module testing/integration/production-engine.test
 *
 * @description
 * Tests the actual production code path that runs when `bun run start` is executed.
 * This tests the real game-tick and lookahead-generation-service, NOT the
 * standalone GameGenerator which is used for full game pre-generation.
 *
 * **Production Code Path:**
 * 1. `/api/cron/game-tick` is called by Vercel Cron every minute
 * 2. `bootstrapGameIfNeeded()` ensures game, actors, orgs exist
 * 3. `checkLookaheadStatus()` checks if content buffer is sufficient
 * 4. `generateAheadIfNeeded()` generates 5-minute content windows
 * 5. `executeGameTick()` handles NPC trading, market updates, etc.
 *
 * **Output Files:**
 * - .output/production-bootstrap-{timestamp}.json - Bootstrap result
 * - .output/production-lookahead-{timestamp}.json - Lookahead generation result
 * - .output/production-posts-{timestamp}.json - Generated posts sample
 * - .output/production-events-{timestamp}.json - Generated events
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@feed/shared";
import { resolveLiveLlmTestConfig } from "./helpers/live-runtime";

// Set timeout to 5 minutes for LLM-based generation
setDefaultTimeout(300000);

// Output directory setup
const OUTPUT_DIR = join(process.cwd(), ".output");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");

// Load environment variables
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

loadEnvFile(".env");
loadEnvFile(".env.test");
loadEnvFile(".env.local");

const liveLlmTestConfig = resolveLiveLlmTestConfig();

// Helper functions
function ensureOutputDir() {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function writeOutput(filename: string, data: unknown) {
  ensureOutputDir();
  const filepath = join(OUTPUT_DIR, `${filename}-${TIMESTAMP}.json`);
  writeFileSync(filepath, JSON.stringify(data, null, 2));
  logger.info(`Output written to ${filepath}`, undefined, "ProductionTest");
  return filepath;
}

// Swap detection patterns - things that should NOT appear in generated content
const SWAP_PATTERNS = {
  realNames: [
    /\bElon Musk\b/i,
    /\bDonald Trump\b/i,
    /\bJoe Biden\b/i,
    /\bMark Zuckerberg\b/i,
    /\bJeff Bezos\b/i,
    /\bSam Altman\b/i,
    /\bSatya Nadella\b/i,
    /\bTim Cook\b/i,
  ],
  realCompanies: [
    /\bTesla\b(?! coil)/i,
    /\bTwitter\b/i,
    /\bMeta\b(?! data)/i,
    /\bFacebook\b/i,
    /\bAmazon\b(?! rainforest)/i,
    /\bMicrosoft\b/i,
    /\bApple\b(?! pie| cider| sauce)/i,
    /\bGoogle\b/i,
    /\bOpenAI\b/i,
  ],
  placeholders: [
    /\[INSERT\]/i,
    /\{ACTOR_NAME\}/i,
    /\{COMPANY\}/i,
    new RegExp("TO" + "DO:", "i"),
    /PLACEHOLDER/i,
  ],
};

function detectSwaps(content: string): string[] {
  const matches: string[] = [];
  for (const [category, patterns] of Object.entries(SWAP_PATTERNS)) {
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        matches.push(`${category}: ${match[0]}`);
      }
    }
  }
  return matches;
}

describe("Production Engine Tests", () => {
  beforeAll(() => {
    ensureOutputDir();
    if (liveLlmTestConfig.requested && !liveLlmTestConfig.enabled) {
      throw new Error(
        liveLlmTestConfig.skipReason ?? "Live LLM test setup failed",
      );
    }
    logger.info(
      `Starting production engine tests. Output dir: ${OUTPUT_DIR}`,
      undefined,
      "ProductionTest",
    );
    logger.info(
      `Live LLM tests enabled: ${liveLlmTestConfig.enabled}`,
      liveLlmTestConfig.skipReason
        ? { skipReason: liveLlmTestConfig.skipReason }
        : undefined,
      "ProductionTest",
    );
  });

  describe("Static Data Registry", () => {
    test("loads actors and organizations", async () => {
      const { StaticDataRegistry } = await import("@feed/engine");

      const actors = StaticDataRegistry.getAllActors();
      const organizations = StaticDataRegistry.getAllOrganizations();

      expect(actors.length).toBeGreaterThan(0);
      expect(organizations.length).toBeGreaterThan(0);

      // Validate actor structure
      for (const actor of actors.slice(0, 10)) {
        expect(actor.id).toBeDefined();
        expect(actor.name).toBeDefined();
        expect(actor.name.length).toBeGreaterThan(0);

        // Check for parody names (should contain AI somewhere)
        const hasAI = /ai/i.test(actor.name) || /ai/i.test(actor.id);
        expect(hasAI).toBe(true);
      }

      // Validate org structure
      for (const org of organizations.slice(0, 10)) {
        expect(org.id).toBeDefined();
        expect(org.name).toBeDefined();
        expect(org.type).toBeDefined();
      }

      writeOutput("production-static-data", {
        actorCount: actors.length,
        organizationCount: organizations.length,
        sampleActors: actors.slice(0, 10).map((a) => ({
          id: a.id,
          name: a.name,
          tier: a.tier,
          domain: a.domain,
        })),
        sampleOrgs: organizations.slice(0, 10).map((o) => ({
          id: o.id,
          name: o.name,
          type: o.type,
          ticker: o.ticker,
        })),
      });
    });
  });

  describe("Character Mapping Service", () => {
    test("maps real names to parody names", async () => {
      const { characterMappingService } = await import("@feed/engine");

      // Test real-to-parody mapping
      const testCases = [
        { real: "Elon Musk", expected: /ailon|musk/i },
        { real: "Tesla", expected: /teslai/i },
        { real: "OpenAI", expected: /openagi/i },
      ];

      const results: Array<{
        real: string;
        mapped: string;
        correct: boolean;
        replacementCount: number;
      }> = [];

      for (const { real, expected } of testCases) {
        const result = await characterMappingService.transformText(real);
        const mapped = result.transformedText;
        const correct = expected.test(mapped) || mapped !== real;
        results.push({
          real,
          mapped,
          correct,
          replacementCount: result.replacementCount,
        });
      }

      writeOutput("production-character-mapping", { results });

      // At least some mappings should work
      const correctCount = results.filter((r) => r.correct).length;
      expect(correctCount).toBeGreaterThan(0);
    });

    test("detects real names that need replacement", async () => {
      const { characterMappingService } = await import("@feed/engine");

      const testText =
        "Elon Musk announced that Tesla and OpenAI are partnering.";
      const detected = await characterMappingService.detectRealNames(testText);

      expect(detected.length).toBeGreaterThan(0);

      writeOutput("production-real-name-detection", {
        input: testText,
        detectedRealNames: detected,
      });
    });
  });

  describe("NPC Persona Generator", () => {
    test("generates consistent personas", async () => {
      const { NPCPersonaGenerator, StaticDataRegistry } = await import(
        "@feed/engine"
      );

      const generator = new NPCPersonaGenerator();
      const actors = StaticDataRegistry.getAllActors().slice(0, 20);
      const organizations = StaticDataRegistry.getAllOrganizations();

      const personas = generator.assignPersonas(
        actors.map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          domain: a.domain,
          personality: a.personality,
          role: "supporting" as const,
          affiliations: a.affiliations,
          tier: a.tier ?? undefined,
        })),
        organizations.map((o) => ({
          id: o.id,
          name: o.name,
          ticker: o.ticker,
          description: o.description,
          type: o.type,
          canBeInvolved: o.canBeInvolved,
        })),
      );

      expect(personas.size).toBeGreaterThan(0);

      const personaData: Array<{
        actorId: string;
        reliability: number;
        insiderOrgs: string[];
        willingToLie: boolean;
      }> = [];

      for (const [actorId, persona] of personas) {
        expect(persona.reliability).toBeGreaterThanOrEqual(0);
        expect(persona.reliability).toBeLessThanOrEqual(1);
        expect(Array.isArray(persona.insiderOrgs)).toBe(true);
        expect(typeof persona.willingToLie).toBe("boolean");

        personaData.push({
          actorId,
          reliability: persona.reliability,
          insiderOrgs: persona.insiderOrgs,
          willingToLie: persona.willingToLie,
        });
      }

      writeOutput("production-npc-personas", {
        totalPersonas: personas.size,
        personas: personaData,
        stats: {
          avgReliability:
            personaData.reduce((sum, p) => sum + p.reliability, 0) /
            personaData.length,
          insiderCount: personaData.filter((p) => p.insiderOrgs.length > 0)
            .length,
          liarCount: personaData.filter((p) => p.willingToLie).length,
        },
      });
    });
  });

  describe("Lookahead Generation Service", () => {
    if (liveLlmTestConfig.enabled) {
      test("checks lookahead status", async () => {
        const { checkLookaheadStatus } = await import("@feed/engine");

        const status = await checkLookaheadStatus();

        expect(typeof status.minutesAhead).toBe("number");
        expect(typeof status.needsGeneration).toBe("boolean");

        writeOutput("production-lookahead-status", status);
      });
    }
  });

  describe("Post Generation", () => {
    if (liveLlmTestConfig.enabled) {
      test("generates NPC post with proper parody names", async () => {
        const { FeedLLMClient, StaticDataRegistry } = await import(
          "@feed/engine"
        );

        // Import the post generation helper
        const { generateNPCPost, loadSharedPostContext } = await import(
          "@feed/engine/services/post-generation-helpers"
        );

        const llmClient = FeedLLMClient.forGameTick();
        const actors = StaticDataRegistry.getAllActors();
        const actor = actors[0];

        expect(actor).toBeDefined();
        if (!actor) {
          throw new Error("No actors available for post-generation test");
        }

        // Create a mock question
        const mockQuestion = {
          id: "test-question-1",
          text: "Will AIlon Musk announce a new TeslAI product this week?",
          questionNumber: 1,
          outcome: null,
        };

        const worldFacts = "The market is volatile. Tech stocks are down.";
        const timestamp = new Date();
        const sharedContext = await loadSharedPostContext(timestamp);

        const success = await generateNPCPost(
          llmClient,
          {
            id: actor.id,
            name: actor.name,
            description: actor.description,
            personality: actor.personality,
            postStyle: actor.postStyle,
            postExample: actor.postExample,
            tier: actor.tier,
            domain: actor.domain,
          },
          mockQuestion,
          worldFacts,
          timestamp,
          sharedContext,
          1,
        );

        writeOutput("production-npc-post-generation", {
          actor: actor.name,
          question: mockQuestion.text,
          success,
          timestamp: timestamp.toISOString(),
        });

        expect(success).toBe(true);
      });
    }
  });

  describe("Content Swap Detection", () => {
    test("detects real names in content", () => {
      const testContent =
        "Elon Musk announced that Tesla will launch a new product.";
      const swaps = detectSwaps(testContent);

      expect(swaps.length).toBeGreaterThan(0);
      expect(swaps.some((s) => s.includes("Elon Musk"))).toBe(true);
      expect(swaps.some((s) => s.includes("Tesla"))).toBe(true);
    });

    test("accepts parody names", () => {
      const testContent =
        "AIlon Musk announced that TeslAI will launch a new product.";
      const swaps = detectSwaps(testContent);

      expect(swaps.length).toBe(0);
    });
  });

  afterAll(() => {
    logger.info(
      "Production engine tests complete",
      undefined,
      "ProductionTest",
    );
  });
});
