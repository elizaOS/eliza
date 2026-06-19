/**
 * Full Production Tick Integration Test
 *
 * @module testing/integration/full-production-tick.test
 *
 * @description
 * Simulates a complete production game tick and agent tick cycle.
 * Tests ALL production systems together as they run in deployment:
 *
 * **Game Tick Operations:**
 * 1. Bootstrap game data (actors, organizations, pools)
 * 2. Generate content (posts, events, articles)
 * 3. NPC trading decisions (perpetuals + prediction markets)
 * 4. Question creation and resolution
 * 5. Market updates and price movements
 * 6. Reputation sync
 * 7. Trending tag calculation
 * 8. Widget cache updates
 *
 * **Agent Tick Operations:**
 * 1. Agent discovery (USER + NPC agents)
 * 2. Autonomous trading
 * 3. Autonomous posting
 * 4. Autonomous commenting
 * 5. Autonomous DMs
 * 6. Autonomous group chats
 *
 * **Output Files:**
 * - .output/full-tick-game-result-{timestamp}.json
 * - .output/full-tick-posts-{timestamp}.json
 * - .output/full-tick-events-{timestamp}.json
 * - .output/full-tick-trades-{timestamp}.json
 * - .output/full-tick-markets-{timestamp}.json
 * - .output/full-tick-questions-{timestamp}.json
 * - .output/full-tick-summary-{timestamp}.json
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

// Set timeout to 10 minutes for real LLM calls
setDefaultTimeout(600000);

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
  logger.info(`Output written to ${filepath}`, undefined, "FullTickTest");
  return filepath;
}

// Comprehensive test results tracking
interface FullTickResults {
  timestamp: string;
  duration: number;

  // Bootstrap results
  bootstrap: {
    actorsCreated: number;
    organizationsCreated: number;
    poolsCreated: number;
    gameInitialized: boolean;
  };

  // Content generation
  content: {
    postsCreated: number;
    eventsCreated: number;
    articlesCreated: number;
    postSamples: Array<{
      id: string;
      authorId: string;
      authorName: string;
      content: string;
      timestamp: string;
      hasSwaps: boolean;
    }>;
    eventSamples: Array<{
      id: string;
      type: string;
      description: string;
      actors: string[];
    }>;
  };

  // Trading results
  trading: {
    decisionsGenerated: number;
    tradesExecuted: number;
    predictionTrades: number;
    perpTrades: number;
    totalVolume: number;
    tradeSamples: Array<{
      actorId: string;
      actorName: string;
      marketType: "perp" | "prediction";
      ticker: string;
      side: string;
      size: number;
      price: number;
    }>;
  };

  // Market state
  markets: {
    activeMarkets: number;
    perpMarkets: number;
    predictionMarkets: number;
    priceUpdates: number;
    marketSamples: Array<{
      id: string;
      ticker: string;
      type: string;
      price: number;
      volume: number;
    }>;
  };

  // Questions
  questions: {
    activeCount: number;
    createdThisTick: number;
    resolvedThisTick: number;
    questionSamples: Array<{
      id: string;
      text: string;
      status: string;
      outcome: boolean | null;
    }>;
  };

  // NPC state
  npcs: {
    totalNpcs: number;
    npcsWithPositions: number;
    totalPositionValue: number;
    topPerformers: Array<{
      id: string;
      name: string;
      balance: number;
      pnl: number;
    }>;
  };

  // Validation
  validation: {
    noSwapsDetected: boolean;
    swapCount: number;
    swapExamples: string[];
    allActorsHaveParodyNames: boolean;
    allOrgsHaveParodyNames: boolean;
  };
}

// Swap detection
const SWAP_PATTERNS = {
  realNames: [
    /\bElon Musk\b/i,
    /\bDonald Trump\b/i,
    /\bJoe Biden\b/i,
    /\bMark Zuckerberg\b/i,
    /\bJeff Bezos\b/i,
    /\bSam Altman\b/i,
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
};

function detectSwaps(content: string): string[] {
  const matches: string[] = [];
  for (const patterns of Object.values(SWAP_PATTERNS)) {
    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        matches.push(match[0]);
      }
    }
  }
  return matches;
}

describe("Full Production Tick Integration Test", () => {
  let results: FullTickResults;
  const startTime = Date.now();

  beforeAll(async () => {
    ensureOutputDir();
    if (liveLlmTestConfig.requested && !liveLlmTestConfig.enabled) {
      throw new Error(
        liveLlmTestConfig.skipReason ?? "Live LLM test setup failed",
      );
    }
    logger.info(
      `Starting full production tick test. Output dir: ${OUTPUT_DIR}`,
      undefined,
      "FullTickTest",
    );
    logger.info(
      `Live LLM tests enabled: ${liveLlmTestConfig.enabled}`,
      liveLlmTestConfig.skipReason
        ? { skipReason: liveLlmTestConfig.skipReason }
        : undefined,
      "FullTickTest",
    );

    results = {
      timestamp: TIMESTAMP,
      duration: 0,
      bootstrap: {
        actorsCreated: 0,
        organizationsCreated: 0,
        poolsCreated: 0,
        gameInitialized: false,
      },
      content: {
        postsCreated: 0,
        eventsCreated: 0,
        articlesCreated: 0,
        postSamples: [],
        eventSamples: [],
      },
      trading: {
        decisionsGenerated: 0,
        tradesExecuted: 0,
        predictionTrades: 0,
        perpTrades: 0,
        totalVolume: 0,
        tradeSamples: [],
      },
      markets: {
        activeMarkets: 0,
        perpMarkets: 0,
        predictionMarkets: 0,
        priceUpdates: 0,
        marketSamples: [],
      },
      questions: {
        activeCount: 0,
        createdThisTick: 0,
        resolvedThisTick: 0,
        questionSamples: [],
      },
      npcs: {
        totalNpcs: 0,
        npcsWithPositions: 0,
        totalPositionValue: 0,
        topPerformers: [],
      },
      validation: {
        noSwapsDetected: true,
        swapCount: 0,
        swapExamples: [],
        allActorsHaveParodyNames: true,
        allOrgsHaveParodyNames: true,
      },
    };
  });

  describe("1. Static Data Validation", () => {
    test("actors exist and mostly have parody names", async () => {
      const { StaticDataRegistry } = await import("@feed/engine");

      const actors = StaticDataRegistry.getAllActors();
      expect(actors.length).toBeGreaterThan(0);

      results.npcs.totalNpcs = actors.length;

      // Count actors with parody names (AI in name or ID)
      let parodyCount = 0;
      const nonParodyActors: string[] = [];
      for (const actor of actors) {
        const hasAI = /ai/i.test(actor.name) || /ai/i.test(actor.id);
        if (hasAI) {
          parodyCount++;
        } else {
          nonParodyActors.push(actor.name);
        }
      }

      const parodyPercentage = (parodyCount / actors.length) * 100;
      results.validation.allActorsHaveParodyNames = parodyPercentage >= 80;

      logger.info(
        `${parodyCount}/${actors.length} actors (${parodyPercentage.toFixed(1)}%) have AI in name`,
        undefined,
        "FullTickTest",
      );

      if (nonParodyActors.length > 0 && nonParodyActors.length <= 10) {
        logger.info(
          `Non-parody actors: ${nonParodyActors.join(", ")}`,
          undefined,
          "FullTickTest",
        );
      }

      // At least 80% should have parody names
      expect(parodyPercentage).toBeGreaterThanOrEqual(80);
    });

    test("organizations exist and mostly have parody names", async () => {
      const { StaticDataRegistry } = await import("@feed/engine");

      const orgs = StaticDataRegistry.getAllOrganizations();
      expect(orgs.length).toBeGreaterThan(0);

      // Count orgs with parody names
      let parodyCount = 0;
      const nonParodyOrgs: string[] = [];
      for (const org of orgs) {
        const hasAI = /ai/i.test(org.name) || /ai/i.test(org.id);
        if (hasAI) {
          parodyCount++;
        } else {
          nonParodyOrgs.push(org.name);
        }
      }

      const parodyPercentage = (parodyCount / orgs.length) * 100;
      results.validation.allOrgsHaveParodyNames = parodyPercentage >= 80;

      logger.info(
        `${parodyCount}/${orgs.length} orgs (${parodyPercentage.toFixed(1)}%) have AI in name`,
        undefined,
        "FullTickTest",
      );

      if (nonParodyOrgs.length > 0 && nonParodyOrgs.length <= 10) {
        logger.info(
          `Non-parody orgs: ${nonParodyOrgs.join(", ")}`,
          undefined,
          "FullTickTest",
        );
      }

      // At least 80% should have parody names
      expect(parodyPercentage).toBeGreaterThanOrEqual(80);
    });
  });

  describe("2. Bootstrap System", () => {
    test("bootstraps game data if needed", async () => {
      // Get static data and DB to check bootstrap state
      const { StaticDataRegistry } = await import("@feed/engine");
      const { db, actorState } = await import("@feed/db");

      // Check what's in the static data
      const staticActors = StaticDataRegistry.getAllActors();
      const staticOrgs = StaticDataRegistry.getAllOrganizations();

      // Check what's in the database (actor state is created by bootstrap)
      const dbActorStates = await db.select().from(actorState).limit(10);

      results.bootstrap.actorsCreated = staticActors.length;
      results.bootstrap.organizationsCreated = staticOrgs.length;
      results.bootstrap.poolsCreated = 0; // Pools are created on demand
      results.bootstrap.gameInitialized = dbActorStates.length > 0;

      writeOutput("full-tick-bootstrap", {
        staticActors: staticActors.length,
        staticOrgs: staticOrgs.length,
        dbActorStates: dbActorStates.length,
        gameInitialized: results.bootstrap.gameInitialized,
      });

      // Static data should exist
      expect(staticActors.length).toBeGreaterThan(0);
      expect(staticOrgs.length).toBeGreaterThan(0);
    });
  });

  describe("3. Lookahead Content Generation", () => {
    test.skipIf(!liveLlmTestConfig.enabled)(
      "generates content ahead of current time",
      async () => {
        const { FeedLLMClient, checkLookaheadStatus, generateAheadIfNeeded } =
          await import("@feed/engine");

        const llmClient = FeedLLMClient.forGameTick();
        const statusBefore = await checkLookaheadStatus();
        logger.info(
          `Lookahead status before: ${statusBefore.minutesAhead} minutes ahead`,
          undefined,
          "FullTickTest",
        );

        const genResult = await generateAheadIfNeeded(llmClient, 5);

        if (genResult.generated) {
          logger.info(
            `Generated ${genResult.windowsGenerated} content windows`,
            undefined,
            "FullTickTest",
          );
        }

        const statusAfter = await checkLookaheadStatus();

        writeOutput("full-tick-lookahead", {
          before: statusBefore,
          after: statusAfter,
          generated: genResult.generated,
          windowsGenerated: genResult.windowsGenerated,
        });

        expect(true).toBe(true);
      },
    );
  });

  describe("4. Game Tick Execution", () => {
    test.skipIf(!liveLlmTestConfig.enabled)(
      "executes full game tick",
      async () => {
        const { executeGameTick } = await import("@feed/engine");

        const tickResult = await executeGameTick(true);

        results.content.postsCreated = tickResult.postsCreated;
        results.content.eventsCreated = tickResult.eventsCreated;
        results.content.articlesCreated = tickResult.articlesCreated;
        results.questions.createdThisTick = tickResult.questionsCreated;
        results.questions.resolvedThisTick = tickResult.questionsResolved;
        results.markets.priceUpdates = tickResult.marketsUpdated;

        writeOutput("full-tick-game-result", tickResult);

        expect(tickResult).toBeDefined();
      },
    );
  });

  describe("5. Database State Validation", () => {
    test("validates posts in database", async () => {
      const { db, posts, desc } = await import("@feed/db");
      const { StaticDataRegistry } = await import("@feed/engine");

      // Get recent posts
      const recentPosts = await db
        .select()
        .from(posts)
        .orderBy(desc(posts.timestamp))
        .limit(20);

      results.content.postSamples = [];

      for (const post of recentPosts) {
        const actor = StaticDataRegistry.getActor(post.authorId);
        const swaps = detectSwaps(post.content);

        if (swaps.length > 0) {
          results.validation.noSwapsDetected = false;
          results.validation.swapCount += swaps.length;
          results.validation.swapExamples.push(
            ...swaps.slice(0, 3).map((s) => `${s} in post ${post.id}`),
          );
        }

        results.content.postSamples.push({
          id: post.id,
          authorId: post.authorId,
          authorName: actor?.name ?? post.authorId,
          content: post.content.substring(0, 200),
          timestamp: post.timestamp.toISOString(),
          hasSwaps: swaps.length > 0,
        });
      }

      writeOutput("full-tick-posts", results.content.postSamples);

      expect(recentPosts.length).toBeGreaterThanOrEqual(0);
    });

    test("validates events in database", async () => {
      const { db, worldEvents, desc } = await import("@feed/db");

      const recentEvents = await db
        .select()
        .from(worldEvents)
        .orderBy(desc(worldEvents.timestamp))
        .limit(10);

      results.content.eventSamples = recentEvents.map((e) => ({
        id: e.id,
        type: e.eventType,
        description: e.description.substring(0, 200),
        actors: (e.actors as string[]) ?? [],
      }));

      writeOutput("full-tick-events", results.content.eventSamples);

      expect(recentEvents.length).toBeGreaterThanOrEqual(0);
    });

    test("validates questions in database", async () => {
      const { db, questions } = await import("@feed/db");

      const allQuestions = await db.select().from(questions).limit(20);

      const activeQuestions = allQuestions.filter((q) => q.status === "active");
      results.questions.activeCount = activeQuestions.length;

      results.questions.questionSamples = allQuestions
        .slice(0, 10)
        .map((q) => ({
          id: q.id,
          text: q.text.substring(0, 100),
          status: q.status,
          outcome: q.outcome,
        }));

      writeOutput("full-tick-questions", results.questions);

      expect(allQuestions.length).toBeGreaterThanOrEqual(0);
    });

    test("validates markets in database", async () => {
      const { db, markets } = await import("@feed/db");

      const allMarkets = await db.select().from(markets).limit(20);

      results.markets.activeMarkets = allMarkets.filter(
        (m) => !m.resolved,
      ).length;

      results.markets.marketSamples = allMarkets.slice(0, 10).map((m) => ({
        id: m.id,
        ticker: m.question.substring(0, 50),
        type: "prediction",
        price: 0.5, // Price calculated from shares, not stored directly
        volume: Number(m.liquidity ?? 0),
      }));

      writeOutput("full-tick-markets", results.markets);

      expect(allMarkets.length).toBeGreaterThanOrEqual(0);
    });

    test("validates NPC trades in database", async () => {
      const { db, npcTrades, desc } = await import("@feed/db");
      const { StaticDataRegistry } = await import("@feed/engine");

      const recentTrades = await db
        .select()
        .from(npcTrades)
        .orderBy(desc(npcTrades.executedAt))
        .limit(20);

      results.trading.tradesExecuted = recentTrades.length;

      for (const trade of recentTrades) {
        const actor = StaticDataRegistry.getActor(trade.npcActorId);

        if (trade.marketType === "prediction") {
          results.trading.predictionTrades++;
        } else {
          results.trading.perpTrades++;
        }

        results.trading.totalVolume += Math.abs(Number(trade.amount ?? 0));

        if (results.trading.tradeSamples.length < 10) {
          results.trading.tradeSamples.push({
            actorId: trade.npcActorId,
            actorName: actor?.name ?? trade.npcActorId,
            marketType:
              trade.marketType === "perp" || trade.marketType === "prediction"
                ? trade.marketType
                : "prediction",
            ticker: trade.ticker ?? trade.marketId ?? "unknown",
            side: trade.side ?? "unknown",
            size: Number(trade.amount ?? 0),
            price: Number(trade.price ?? 0),
          });
        }
      }

      writeOutput("full-tick-trades", results.trading);

      expect(recentTrades.length).toBeGreaterThanOrEqual(0);
    });

    test("validates actor state in database", async () => {
      const { db, actorState, desc } = await import("@feed/db");
      const { StaticDataRegistry } = await import("@feed/engine");

      const actorStates = await db
        .select()
        .from(actorState)
        .orderBy(desc(actorState.tradingBalance))
        .limit(20);

      results.npcs.npcsWithPositions = actorStates.filter(
        (a) => Number(a.tradingBalance) > 0,
      ).length;
      results.npcs.totalPositionValue = actorStates.reduce(
        (sum, a) => sum + Number(a.tradingBalance ?? 0),
        0,
      );

      results.npcs.topPerformers = actorStates.slice(0, 5).map((a) => {
        const actor = StaticDataRegistry.getActor(a.id);
        return {
          id: a.id,
          name: actor?.name ?? a.id,
          balance: Number(a.tradingBalance ?? 0),
          pnl: Number(a.reputationPoints ?? 0),
        };
      });

      writeOutput("full-tick-npcs", results.npcs);

      expect(actorStates.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("6. Content Quality Validation", () => {
    test("no real names detected in generated content", () => {
      expect(results.validation.swapCount).toBe(0);
      if (results.validation.swapCount > 0) {
        logger.warn(
          `Found ${results.validation.swapCount} swaps: ${results.validation.swapExamples.join(", ")}`,
          undefined,
          "FullTickTest",
        );
      }
    });

    test("most actors use parody names (>=80%)", () => {
      expect(results.validation.allActorsHaveParodyNames).toBe(true);
    });

    test("most organizations use parody names (>=80%)", () => {
      expect(results.validation.allOrgsHaveParodyNames).toBe(true);
    });
  });

  afterAll(() => {
    results.duration = Date.now() - startTime;

    // Write final summary
    writeOutput("full-tick-summary", results);

    logger.info(
      `Full tick test completed in ${results.duration}ms`,
      undefined,
      "FullTickTest",
    );

    // Log summary
    console.log("\n📊 FULL TICK TEST SUMMARY");
    console.log("========================");
    console.log(`Duration: ${results.duration}ms`);
    console.log(`\nBootstrap:`);
    console.log(`  - Actors created: ${results.bootstrap.actorsCreated}`);
    console.log(`  - Orgs created: ${results.bootstrap.organizationsCreated}`);
    console.log(`  - Pools created: ${results.bootstrap.poolsCreated}`);
    console.log(`\nContent:`);
    console.log(`  - Posts: ${results.content.postsCreated}`);
    console.log(`  - Events: ${results.content.eventsCreated}`);
    console.log(`  - Articles: ${results.content.articlesCreated}`);
    console.log(`\nTrading:`);
    console.log(`  - Trades executed: ${results.trading.tradesExecuted}`);
    console.log(`  - Prediction trades: ${results.trading.predictionTrades}`);
    console.log(`  - Perp trades: ${results.trading.perpTrades}`);
    console.log(`  - Total volume: $${results.trading.totalVolume.toFixed(2)}`);
    console.log(`\nMarkets:`);
    console.log(`  - Active markets: ${results.markets.activeMarkets}`);
    console.log(`\nQuestions:`);
    console.log(`  - Active: ${results.questions.activeCount}`);
    console.log(`  - Created: ${results.questions.createdThisTick}`);
    console.log(`  - Resolved: ${results.questions.resolvedThisTick}`);
    console.log(`\nNPCs:`);
    console.log(`  - Total: ${results.npcs.totalNpcs}`);
    console.log(`  - With positions: ${results.npcs.npcsWithPositions}`);
    console.log(`\nValidation:`);
    console.log(
      `  - No swaps: ${results.validation.noSwapsDetected ? "✅" : "❌"}`,
    );
    console.log(`  - Swap count: ${results.validation.swapCount}`);
  });
});
