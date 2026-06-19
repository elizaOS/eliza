/**
 * Engine Generation Output Tests
 *
 * @module testing/integration/engine-generation-output.test
 *
 * @description
 * Comprehensive tests that validate engine generation output quality.
 * All outputs are written to .output/ for manual review.
 *
 * **Tests verify:**
 * 1. Game generation produces valid content (no swap/hallucination)
 * 2. NPC personas are correctly assigned and used
 * 3. Feed posts match actor personalities
 * 4. Events are coherent and don't contain swapped data
 * 5. Group messages are contextually appropriate
 * 6. Market decisions follow NPC strategies
 *
 * **Output Files:**
 * - .output/game-generation-{timestamp}.json - Full generated game
 * - .output/actors-validation-{timestamp}.json - Actor data validation
 * - .output/feed-posts-{timestamp}.json - Feed post samples
 * - .output/events-validation-{timestamp}.json - Event validation
 * - .output/npc-trades-{timestamp}.json - NPC trading decisions
 * - .output/test-summary-{timestamp}.json - Overall test results
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
import {
  GameGenerator,
  type GameResult,
  GameSimulator,
  type GeneratedGame,
} from "@feed/engine";
import { logger } from "@feed/shared";
import { resolveLiveLlmTestConfig } from "./helpers/live-runtime";

// Set timeout to 15 minutes for LLM-based generation
setDefaultTimeout(900000);

// Output directory setup
const OUTPUT_DIR = join(process.cwd(), ".output");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");

// Test results accumulator
interface TestResults {
  timestamp: string;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  warnings: string[];
  errors: string[];
  outputFiles: string[];
  validationResults: {
    actorsValid: boolean;
    eventsValid: boolean;
    feedPostsValid: boolean;
    groupMessagesValid: boolean;
    noSwapDetected: boolean;
    npcPersonasValid: boolean;
  };
}

const testResults: TestResults = {
  timestamp: TIMESTAMP,
  testsRun: 0,
  testsPassed: 0,
  testsFailed: 0,
  warnings: [],
  errors: [],
  outputFiles: [],
  validationResults: {
    actorsValid: false,
    eventsValid: false,
    feedPostsValid: false,
    groupMessagesValid: false,
    noSwapDetected: false,
    npcPersonasValid: false,
  },
};

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
  testResults.outputFiles.push(filepath);
  logger.info(`Output written to ${filepath}`, undefined, "EngineTest");
  return filepath;
}

// Swap detection patterns - things that should NOT appear in generated content
const SWAP_PATTERNS = {
  // Real names that should be parodied
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
  // Real company names that should be parodied
  realCompanies: [
    /\bTesla\b(?! coil)/i, // Allow "Tesla coil"
    /\bTwitter\b/i,
    /\bMeta\b(?! data)/i, // Allow "metadata"
    /\bFacebook\b/i,
    /\bAmazon\b(?! rainforest)/i,
    /\bMicrosoft\b/i,
    /\bApple\b(?! pie| cider| sauce)/i, // Allow food references
    /\bGoogle\b/i,
    /\bOpenAI\b/i,
  ],
  // Placeholder/template text that shouldn't appear
  placeholders: [
    /\[INSERT\]/i,
    /\{ACTOR_NAME\}/i,
    /\{COMPANY\}/i,
    new RegExp("TO" + "DO:", "i"),
    /PLACEHOLDER/i,
    /undefined/,
    /null/,
    /NaN/,
  ],
  // Generic/template responses
  genericResponses: [
    /^Lorem ipsum/i,
    /^Test post/i,
    /^Sample content/i,
    /^This is a test/i,
  ],
};

function detectSwaps(
  content: string,
): { hasSwap: boolean; matches: string[]; category: string }[] {
  const results: { hasSwap: boolean; matches: string[]; category: string }[] =
    [];

  for (const [category, patterns] of Object.entries(SWAP_PATTERNS)) {
    const matches: string[] = [];
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        matches.push(match[0]);
      }
    }
    if (matches.length > 0) {
      results.push({ hasSwap: true, matches, category });
    }
  }

  return results;
}

function validateActorData(actor: {
  id: string;
  name: string;
  description?: string;
  personality?: string;
  tier?: string;
  role?: string;
  affiliations?: string[];
  persona?: {
    reliability?: number;
    insiderOrgs?: string[];
    willingToLie?: boolean;
  };
}): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!actor.id || actor.id.length === 0) {
    issues.push("Missing or empty id");
  }
  if (!actor.name || actor.name.length === 0) {
    issues.push("Missing or empty name");
  }
  if (!actor.description || actor.description.length < 10) {
    issues.push("Missing or too short description");
  }
  if (!actor.tier) {
    issues.push("Missing tier");
  }
  if (!actor.role) {
    issues.push("Missing role");
  }

  // Check for swaps in actor data
  const nameSwaps = detectSwaps(actor.name);
  if (nameSwaps.length > 0) {
    issues.push(
      `Swap detected in name: ${nameSwaps.map((s) => s.matches.join(", ")).join("; ")}`,
    );
  }

  const descSwaps = detectSwaps(actor.description || "");
  if (descSwaps.length > 0) {
    issues.push(
      `Swap detected in description: ${descSwaps.map((s) => s.matches.join(", ")).join("; ")}`,
    );
  }

  return { valid: issues.length === 0, issues };
}

function validateFeedPost(post: {
  id: string;
  content: string;
  author: string;
  authorName: string;
  timestamp: string;
  day: number;
  sentiment?: number | null;
  clueStrength?: number | null;
}): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!post.id) issues.push("Missing id");
  if (!post.content || post.content.length === 0) issues.push("Empty content");
  if (!post.author) issues.push("Missing author");
  if (!post.authorName) issues.push("Missing authorName");
  if (!post.timestamp) issues.push("Missing timestamp");
  if (typeof post.day !== "number") issues.push("Invalid day");

  // Content length validation
  if (post.content && post.content.length > 500) {
    issues.push(`Content too long: ${post.content.length} chars`);
  }

  // Check for swaps
  const contentSwaps = detectSwaps(post.content || "");
  if (contentSwaps.length > 0) {
    issues.push(
      `Swap detected in content: ${contentSwaps.map((s) => s.matches.join(", ")).join("; ")}`,
    );
  }

  // Validate sentiment range
  if (
    post.sentiment !== null &&
    post.sentiment !== undefined &&
    (post.sentiment < -1 || post.sentiment > 1)
  ) {
    issues.push(`Invalid sentiment: ${post.sentiment}`);
  }

  // Validate clue strength range
  if (
    post.clueStrength !== null &&
    post.clueStrength !== undefined &&
    (post.clueStrength < 0 || post.clueStrength > 1)
  ) {
    issues.push(`Invalid clueStrength: ${post.clueStrength}`);
  }

  return { valid: issues.length === 0, issues };
}

function validateEvent(event: {
  id: string;
  day: number;
  type: string;
  description: string;
  actors: string[];
  visibility: string;
  relatedQuestion?: number | null;
  pointsToward?: string | null;
}): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  if (!event.id) issues.push("Missing id");
  if (typeof event.day !== "number") issues.push("Invalid day");
  if (!event.type) issues.push("Missing type");
  if (!event.description || event.description.length === 0) {
    issues.push("Empty description");
  }
  if (!Array.isArray(event.actors)) issues.push("actors is not an array");
  if (!event.visibility) issues.push("Missing visibility");

  // Description length validation
  if (event.description && event.description.length > 300) {
    issues.push(`Description too long: ${event.description.length} chars`);
  }

  // Check for swaps
  const descSwaps = detectSwaps(event.description || "");
  if (descSwaps.length > 0) {
    issues.push(
      `Swap detected in description: ${descSwaps.map((s) => s.matches.join(", ")).join("; ")}`,
    );
  }

  return { valid: issues.length === 0, issues };
}

describe("Engine Generation Output Tests", () => {
  let game: GeneratedGame | null = null;
  let simulatorResult: GameResult | null = null;

  function requireGeneratedGame(): GeneratedGame {
    if (!game) {
      throw new Error(
        "LLM-generated game is unavailable because the prerequisite generation test did not complete successfully",
      );
    }

    return game;
  }

  beforeAll(async () => {
    ensureOutputDir();
    if (liveLlmTestConfig.requested && !liveLlmTestConfig.enabled) {
      throw new Error(
        liveLlmTestConfig.skipReason ?? "Live LLM test setup failed",
      );
    }
    logger.info(
      `Starting engine generation tests. Output dir: ${OUTPUT_DIR}`,
      undefined,
      "EngineTest",
    );
    logger.info(
      `Live LLM tests enabled: ${liveLlmTestConfig.enabled}`,
      liveLlmTestConfig.skipReason
        ? { skipReason: liveLlmTestConfig.skipReason }
        : undefined,
      "EngineTest",
    );
  });

  afterAll(() => {
    // Write final test summary
    writeOutput("test-summary", testResults);
    logger.info(
      `Tests complete. ${testResults.testsPassed}/${testResults.testsRun} passed`,
      undefined,
      "EngineTest",
    );
  });

  describe("GameSimulator (No LLM)", () => {
    test("runs complete simulation without LLM", async () => {
      testResults.testsRun++;

      const simulator = new GameSimulator({
        outcome: true,
        numAgents: 10,
        duration: 30,
        seed: 12345, // Fixed seed for reproducibility
      });

      simulatorResult = await simulator.runCompleteGame();

      expect(simulatorResult).toBeDefined();
      expect(simulatorResult.id).toBeDefined();
      expect(simulatorResult.outcome).toBe(true);
      expect(simulatorResult.agents.length).toBe(10);
      expect(simulatorResult.events.length).toBeGreaterThan(0);

      // Write output
      writeOutput("simulator-result", {
        id: simulatorResult.id,
        question: simulatorResult.question,
        outcome: simulatorResult.outcome,
        duration: simulatorResult.duration,
        totalBets: simulatorResult.totalBets,
        agentCount: simulatorResult.agents.length,
        eventCount: simulatorResult.events.length,
        winners: simulatorResult.winners,
        losers: simulatorResult.losers,
        market: simulatorResult.market,
        agents: simulatorResult.agents,
        reputationChanges: simulatorResult.reputationChanges,
      });

      testResults.testsPassed++;
    });

    test("simulator agents have valid data", async () => {
      testResults.testsRun++;

      expect(simulatorResult).toBeDefined();

      const agentValidation = {
        totalAgents: simulatorResult?.agents.length,
        validAgents: 0,
        invalidAgents: 0,
        issues: [] as { agentId: string; issues: string[] }[],
      };

      for (const agent of simulatorResult?.agents) {
        const issues: string[] = [];

        if (!agent.id) issues.push("Missing id");
        if (!agent.name) issues.push("Missing name");
        if (typeof agent.balance !== "number") issues.push("Invalid balance");
        if (typeof agent.isInsider !== "boolean")
          issues.push("Invalid isInsider");
        if (!agent.strategy) issues.push("Missing strategy");

        if (issues.length > 0) {
          agentValidation.invalidAgents++;
          agentValidation.issues.push({ agentId: agent.id, issues });
        } else {
          agentValidation.validAgents++;
        }
      }

      writeOutput("simulator-agents-validation", agentValidation);

      expect(agentValidation.invalidAgents).toBe(0);
      testResults.testsPassed++;
    });
  });

  describe("GameGenerator (With LLM)", () => {
    test.skipIf(!liveLlmTestConfig.enabled)(
      "generates complete game with valid actors",
      async () => {
        testResults.testsRun++;

        logger.info("Generating complete game...", undefined, "EngineTest");
        const generator = new GameGenerator();
        game = await generator.generateCompleteGame();

        expect(game).toBeDefined();
        expect(game.id).toBeDefined();
        expect(game.setup).toBeDefined();
        expect(game.timeline).toBeDefined();
        expect(game.resolution).toBeDefined();

        // Write full game output
        writeOutput("game-generation", game);

        testResults.testsPassed++;
      },
    );

    test.skipIf(!liveLlmTestConfig.enabled)(
      "validates all actors have no swaps",
      async () => {
        testResults.testsRun++;
        const game = requireGeneratedGame();

        const allActors = [
          ...game.setup.mainActors,
          ...game.setup.supportingActors,
          ...game.setup.extras,
        ];

        const actorValidation = {
          totalActors: allActors.length,
          validActors: 0,
          invalidActors: 0,
          swapsDetected: 0,
          issues: [] as {
            actorId: string;
            actorName: string;
            issues: string[];
          }[],
        };

        for (const actor of allActors) {
          const result = validateActorData(actor);
          if (result.valid) {
            actorValidation.validActors++;
          } else {
            actorValidation.invalidActors++;
            actorValidation.issues.push({
              actorId: actor.id,
              actorName: actor.name,
              issues: result.issues,
            });
            if (result.issues.some((i) => i.includes("Swap detected"))) {
              actorValidation.swapsDetected++;
            }
          }
        }

        writeOutput("actors-validation", actorValidation);

        testResults.validationResults.actorsValid =
          actorValidation.invalidActors === 0;
        testResults.validationResults.noSwapDetected =
          actorValidation.swapsDetected === 0;

        expect(actorValidation.swapsDetected).toBe(0);
        testResults.testsPassed++;
      },
    );

    test.skipIf(!liveLlmTestConfig.enabled)(
      "validates NPC personas are assigned",
      async () => {
        testResults.testsRun++;
        const game = requireGeneratedGame();

        const allActors = [
          ...game.setup.mainActors,
          ...game.setup.supportingActors,
          ...game.setup.extras,
        ];

        const personaValidation = {
          totalActors: allActors.length,
          actorsWithPersona: 0,
          actorsWithoutPersona: 0,
          personaStats: {
            avgReliability: 0,
            insiderCount: 0,
            liarCount: 0,
          },
          issues: [] as { actorId: string; issue: string }[],
        };

        let totalReliability = 0;

        for (const actor of allActors) {
          if (actor.persona) {
            personaValidation.actorsWithPersona++;
            totalReliability += actor.persona.reliability ?? 0;

            if (
              actor.persona.insiderOrgs &&
              actor.persona.insiderOrgs.length > 0
            ) {
              personaValidation.personaStats.insiderCount++;
            }

            if (actor.persona.willingToLie) {
              personaValidation.personaStats.liarCount++;
            }

            // Validate persona fields
            if (
              typeof actor.persona.reliability !== "number" ||
              actor.persona.reliability < 0 ||
              actor.persona.reliability > 1
            ) {
              personaValidation.issues.push({
                actorId: actor.id,
                issue: `Invalid reliability: ${actor.persona.reliability}`,
              });
            }
          } else {
            personaValidation.actorsWithoutPersona++;
          }
        }

        if (personaValidation.actorsWithPersona > 0) {
          personaValidation.personaStats.avgReliability =
            totalReliability / personaValidation.actorsWithPersona;
        }

        writeOutput("npc-personas-validation", personaValidation);

        testResults.validationResults.npcPersonasValid =
          personaValidation.actorsWithPersona > 0 &&
          personaValidation.issues.length === 0;

        // At least some actors should have personas
        expect(personaValidation.actorsWithPersona).toBeGreaterThan(0);
        testResults.testsPassed++;
      },
    );

    test.skipIf(!liveLlmTestConfig.enabled)(
      "validates all feed posts have no swaps",
      async () => {
        testResults.testsRun++;
        const game = requireGeneratedGame();

        const allPosts = game.timeline.flatMap((day) => day.feedPosts);

        const postValidation = {
          totalPosts: allPosts.length,
          validPosts: 0,
          invalidPosts: 0,
          swapsDetected: 0,
          samplePosts: [] as {
            day: number;
            author: string;
            content: string;
            valid: boolean;
          }[],
          issues: [] as { postId: string; day: number; issues: string[] }[],
        };

        for (const post of allPosts) {
          // Ensure day is a number (handle undefined case)
          const postDay = post.day ?? 0;
          const postForValidation = {
            ...post,
            day: postDay,
          };
          const result = validateFeedPost(postForValidation);
          if (result.valid) {
            postValidation.validPosts++;
          } else {
            postValidation.invalidPosts++;
            postValidation.issues.push({
              postId: post.id,
              day: postDay,
              issues: result.issues,
            });
            if (result.issues.some((i) => i.includes("Swap detected"))) {
              postValidation.swapsDetected++;
            }
          }
        }

        // Sample posts for review (first 5 from each phase)
        const phases = [
          { name: "early", days: [1, 2, 3, 4, 5] },
          { name: "middle", days: [11, 12, 13, 14, 15] },
          { name: "late", days: [21, 22, 23, 24, 25] },
          { name: "resolution", days: [26, 27, 28, 29, 30] },
        ];

        for (const phase of phases) {
          const phasePosts = allPosts.filter((p) =>
            phase.days.includes(p.day ?? 0),
          );
          const samples = phasePosts.slice(0, 5);
          for (const post of samples) {
            const postDay = post.day ?? 0;
            const postForValidation = {
              ...post,
              day: postDay,
            };
            postValidation.samplePosts.push({
              day: postDay,
              author: post.authorName,
              content: post.content,
              valid: validateFeedPost(postForValidation).valid,
            });
          }
        }

        writeOutput("feed-posts-validation", postValidation);

        testResults.validationResults.feedPostsValid =
          postValidation.swapsDetected === 0;

        expect(postValidation.swapsDetected).toBe(0);
        testResults.testsPassed++;
      },
    );

    test.skipIf(!liveLlmTestConfig.enabled)(
      "validates all events have no swaps",
      async () => {
        testResults.testsRun++;
        const game = requireGeneratedGame();

        const allEvents = game.timeline.flatMap((day) => day.events);

        const eventValidation = {
          totalEvents: allEvents.length,
          validEvents: 0,
          invalidEvents: 0,
          swapsDetected: 0,
          eventsByType: {} as Record<string, number>,
          sampleEvents: [] as {
            day: number;
            type: string;
            description: string;
            valid: boolean;
          }[],
          issues: [] as { eventId: string; day: number; issues: string[] }[],
        };

        for (const event of allEvents) {
          // Count by type
          eventValidation.eventsByType[event.type] =
            (eventValidation.eventsByType[event.type] || 0) + 1;

          const result = validateEvent(event);
          if (result.valid) {
            eventValidation.validEvents++;
          } else {
            eventValidation.invalidEvents++;
            eventValidation.issues.push({
              eventId: event.id,
              day: event.day,
              issues: result.issues,
            });
            if (result.issues.some((i) => i.includes("Swap detected"))) {
              eventValidation.swapsDetected++;
            }
          }
        }

        // Sample events for review
        const sampleDays = [1, 5, 10, 15, 20, 25, 30];
        for (const day of sampleDays) {
          const dayEvents = allEvents.filter((e) => e.day === day);
          const samples = dayEvents.slice(0, 3);
          for (const event of samples) {
            eventValidation.sampleEvents.push({
              day: event.day,
              type: event.type,
              description: event.description,
              valid: validateEvent(event).valid,
            });
          }
        }

        writeOutput("events-validation", eventValidation);

        testResults.validationResults.eventsValid =
          eventValidation.swapsDetected === 0;

        expect(eventValidation.swapsDetected).toBe(0);
        testResults.testsPassed++;
      },
    );

    test.skipIf(!liveLlmTestConfig.enabled)(
      "validates group messages have no swaps",
      async () => {
        testResults.testsRun++;
        const game = requireGeneratedGame();

        const groupMessageValidation = {
          totalDays: game.timeline.length,
          totalMessages: 0,
          validMessages: 0,
          invalidMessages: 0,
          swapsDetected: 0,
          sampleMessages: [] as {
            day: number;
            groupId: string;
            from: string;
            message: string;
            valid: boolean;
          }[],
          issues: [] as { day: number; groupId: string; issues: string[] }[],
        };

        for (const day of game.timeline) {
          for (const [groupId, messages] of Object.entries(day.groupChats)) {
            for (const msg of messages) {
              groupMessageValidation.totalMessages++;

              const issues: string[] = [];
              if (!msg.from) issues.push("Missing from");
              if (!msg.message || msg.message.length === 0) {
                issues.push("Empty message");
              }

              // Check for swaps
              const swaps = detectSwaps(msg.message || "");
              if (swaps.length > 0) {
                issues.push(
                  `Swap detected: ${swaps.map((s) => s.matches.join(", ")).join("; ")}`,
                );
                groupMessageValidation.swapsDetected++;
              }

              if (issues.length > 0) {
                groupMessageValidation.invalidMessages++;
                groupMessageValidation.issues.push({
                  day: day.day,
                  groupId,
                  issues,
                });
              } else {
                groupMessageValidation.validMessages++;
              }
            }
          }
        }

        // Sample messages for review
        const sampleDays = [5, 15, 25];
        for (const dayNum of sampleDays) {
          const dayData = game.timeline.find((d) => d.day === dayNum);
          if (dayData) {
            for (const [groupId, messages] of Object.entries(
              dayData.groupChats,
            )) {
              const samples = messages.slice(0, 2);
              for (const msg of samples) {
                groupMessageValidation.sampleMessages.push({
                  day: dayNum,
                  groupId,
                  from: msg.from,
                  message: msg.message,
                  valid: detectSwaps(msg.message || "").length === 0,
                });
              }
            }
          }
        }

        writeOutput("group-messages-validation", groupMessageValidation);

        testResults.validationResults.groupMessagesValid =
          groupMessageValidation.swapsDetected === 0;

        expect(groupMessageValidation.swapsDetected).toBe(0);
        testResults.testsPassed++;
      },
    );

    test.skipIf(!liveLlmTestConfig.enabled)(
      "validates questions have arc plans",
      async () => {
        testResults.testsRun++;
        const game = requireGeneratedGame();

        const questionValidation = {
          totalQuestions: game.setup.questions.length,
          questionsWithArcPlan: 0,
          questionsWithoutArcPlan: 0,
          arcPlanStats: [] as {
            questionId: number | string;
            text: string;
            outcome: boolean;
            uncertaintyPeakDay: number;
            clarityOnsetDay: number;
            verificationDay: number;
            insiderCount: number;
            deceiverCount: number;
          }[],
          issues: [] as { questionId: number | string; issues: string[] }[],
        };

        for (const question of game.setup.questions) {
          const issues: string[] = [];

          if (!question.metadata?.arcPlan) {
            questionValidation.questionsWithoutArcPlan++;
            issues.push("Missing arc plan");
          } else {
            questionValidation.questionsWithArcPlan++;

            const arcPlan = question.metadata.arcPlan;

            // Validate arc plan structure
            if (typeof arcPlan.uncertaintyPeakDay !== "number") {
              issues.push("Invalid uncertaintyPeakDay");
            }
            if (typeof arcPlan.clarityOnsetDay !== "number") {
              issues.push("Invalid clarityOnsetDay");
            }
            if (typeof arcPlan.verificationDay !== "number") {
              issues.push("Invalid verificationDay");
            }

            // Validate day ordering
            if (arcPlan.clarityOnsetDay <= arcPlan.uncertaintyPeakDay) {
              issues.push(
                `clarityOnsetDay (${arcPlan.clarityOnsetDay}) should be after uncertaintyPeakDay (${arcPlan.uncertaintyPeakDay})`,
              );
            }
            if (arcPlan.verificationDay <= arcPlan.clarityOnsetDay) {
              issues.push(
                `verificationDay (${arcPlan.verificationDay}) should be after clarityOnsetDay (${arcPlan.clarityOnsetDay})`,
              );
            }

            questionValidation.arcPlanStats.push({
              questionId: question.id,
              text: question.text,
              outcome: question.outcome ?? false,
              uncertaintyPeakDay: arcPlan.uncertaintyPeakDay,
              clarityOnsetDay: arcPlan.clarityOnsetDay,
              verificationDay: arcPlan.verificationDay,
              insiderCount: arcPlan.insiders?.length || 0,
              deceiverCount: arcPlan.deceivers?.length || 0,
            });
          }

          if (issues.length > 0) {
            questionValidation.issues.push({
              questionId: question.id,
              issues,
            });
          }
        }

        writeOutput("questions-validation", questionValidation);

        expect(questionValidation.questionsWithArcPlan).toBeGreaterThan(0);
        testResults.testsPassed++;
      },
    );

    test.skipIf(!liveLlmTestConfig.enabled)(
      "validates organizations are properly structured",
      async () => {
        testResults.testsRun++;
        const game = requireGeneratedGame();

        const orgValidation = {
          totalOrganizations: game.setup.organizations.length,
          validOrganizations: 0,
          invalidOrganizations: 0,
          organizationsByType: {} as Record<string, number>,
          issues: [] as { orgId: string; issues: string[] }[],
        };

        for (const org of game.setup.organizations) {
          const issues: string[] = [];

          if (!org.id) issues.push("Missing id");
          if (!org.name) issues.push("Missing name");
          if (!org.type) issues.push("Missing type");
          if (!org.description) issues.push("Missing description");

          // Count by type
          if (org.type) {
            orgValidation.organizationsByType[org.type] =
              (orgValidation.organizationsByType[org.type] || 0) + 1;
          }

          // Check for swaps
          const nameSwaps = detectSwaps(org.name || "");
          if (nameSwaps.length > 0) {
            issues.push(
              `Swap detected in name: ${nameSwaps.map((s) => s.matches.join(", ")).join("; ")}`,
            );
          }

          if (issues.length > 0) {
            orgValidation.invalidOrganizations++;
            orgValidation.issues.push({ orgId: org.id, issues });
          } else {
            orgValidation.validOrganizations++;
          }
        }

        writeOutput("organizations-validation", orgValidation);

        expect(orgValidation.invalidOrganizations).toBe(0);
        testResults.testsPassed++;
      },
    );

    test.skipIf(!liveLlmTestConfig.enabled)(
      "validates timeline progression",
      async () => {
        testResults.testsRun++;
        const game = requireGeneratedGame();

        const timelineValidation = {
          totalDays: game.timeline.length,
          expectedDays: 30,
          daysPresent: game.timeline.map((d) => d.day),
          missingDays: [] as number[],
          duplicateDays: [] as number[],
          dayStats: [] as {
            day: number;
            eventCount: number;
            postCount: number;
            groupMessageCount: number;
          }[],
        };

        // Check for missing/duplicate days
        const dayCounts = new Map<number, number>();
        for (const day of game.timeline) {
          dayCounts.set(day.day, (dayCounts.get(day.day) || 0) + 1);
        }

        for (let i = 1; i <= 30; i++) {
          const count = dayCounts.get(i) || 0;
          if (count === 0) {
            timelineValidation.missingDays.push(i);
          } else if (count > 1) {
            timelineValidation.duplicateDays.push(i);
          }
        }

        // Day stats
        for (const day of game.timeline) {
          const groupMessageCount = Object.values(day.groupChats).reduce(
            (sum, msgs) => sum + msgs.length,
            0,
          );

          timelineValidation.dayStats.push({
            day: day.day,
            eventCount: day.events.length,
            postCount: day.feedPosts.length,
            groupMessageCount,
          });
        }

        writeOutput("timeline-validation", timelineValidation);

        expect(timelineValidation.totalDays).toBe(30);
        expect(timelineValidation.missingDays.length).toBe(0);
        expect(timelineValidation.duplicateDays.length).toBe(0);
        testResults.testsPassed++;
      },
    );

    test.skipIf(!liveLlmTestConfig.enabled)(
      "validates resolution has all questions resolved",
      async () => {
        testResults.testsRun++;
        const game = requireGeneratedGame();

        const resolutionValidation = {
          totalQuestions: game.setup.questions.length,
          resolvedQuestions: game.resolution.outcomes.length,
          outcomes: game.resolution.outcomes.map((o) => ({
            questionId: o.questionId,
            answer: o.answer,
            hasExplanation: !!o.explanation && o.explanation.length > 0,
            hasKeyEvents: o.keyEvents && o.keyEvents.length > 0,
          })),
          hasFinalNarrative:
            !!game.resolution.finalNarrative &&
            game.resolution.finalNarrative.length > 0,
          issues: [] as string[],
        };

        const resolvedIds = new Set(
          game.resolution.outcomes.map((o) => o.questionId),
        );
        for (const question of game.setup.questions) {
          if (!resolvedIds.has(question.id)) {
            resolutionValidation.issues.push(
              `Question ${question.id} not resolved`,
            );
          }
        }

        const narrativeSwaps = detectSwaps(
          game.resolution.finalNarrative || "",
        );
        if (narrativeSwaps.length > 0) {
          resolutionValidation.issues.push(
            `Swap detected in final narrative: ${narrativeSwaps.map((s) => s.matches.join(", ")).join("; ")}`,
          );
        }

        writeOutput("resolution-validation", resolutionValidation);

        expect(resolutionValidation.resolvedQuestions).toBe(
          resolutionValidation.totalQuestions,
        );
        expect(resolutionValidation.issues.length).toBe(0);
        testResults.testsPassed++;
      },
    );
  });
});
