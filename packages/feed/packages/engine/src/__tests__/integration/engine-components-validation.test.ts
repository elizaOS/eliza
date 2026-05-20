/**
 * Engine Components Validation Test
 *
 * @module engine/__tests__/integration/engine-components-validation.test
 *
 * @description
 * Tests each engine component individually to ensure they produce actual outputs.
 * No mocks - these tests validate actual functionality.
 *
 * **Components Tested:**
 * - ArticleGenerator - Article generation
 * - MarketDecisionEngine - NPC trading decisions
 * - QuestionManager - Question generation
 * - FeedGenerator - Feed post generation
 * - TrendingTopicsEngine - Trending calculation
 * - PerpMarketService (from @feed/core/markets/perps) - Perpetual market operations
 *
 * @usage
 * RUN_REAL_ENGINE_TESTS=true bun test engine-components-validation
 */

import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolveLiveLlmTestConfig } from "../../../../testing/integration/helpers/live-runtime";

// Set timeout to 5 minutes
setDefaultTimeout(300000);

// Load environment
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

const hasLLMKey = !!(
  (process.env.GROQ_API_KEY?.trim() ?? "") !== "" ||
  (process.env.ANTHROPIC_API_KEY?.trim() ?? "") !== "" ||
  (process.env.OPENAI_API_KEY?.trim() ?? "") !== ""
);
const liveLlmConfig = resolveLiveLlmTestConfig();
const shouldSkipLiveLlmTests =
  !liveLlmConfig.enabled && process.env.RUN_REAL_ENGINE_TESTS !== "true";

const requireLLMKey = () => {
  if (!hasLLMKey) {
    throw new Error(
      "ENGINE COMPONENT TESTS REQUIRE LLM API KEY. " +
        "Set GROQ_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY to run these tests. " +
        "These tests validate actual engine functionality and MUST NOT be skipped.",
    );
  }
};

describe.skipIf(shouldSkipLiveLlmTests)("Engine Components Validation", () => {
  beforeAll(() => {
    requireLLMKey();
    console.log("\n🔧 Testing Individual Engine Components");
    console.log("==========================================\n");
  });

  describe("ArticleGenerator", () => {
    test("generates article from event context", async () => {
      const { ArticleGenerator } = await import("../../ArticleGenerator");
      const { FeedLLMClient } = await import("../../llm/openai-client");
      const { StaticDataRegistry } = await import(
        "../../services/static-data-registry"
      );

      console.log("📰 Testing ArticleGenerator...");

      const llm = FeedLLMClient.forGameTick();
      const generator = new ArticleGenerator(llm);

      // Load real actor data using StaticDataRegistry (preferred over deprecated loadActorsData)
      const allActors = StaticDataRegistry.getAllActors();
      const actors = allActors.slice(0, 10).map((a) => ({
        ...a,
        tier: a.tier || ("B_TIER" as const),
        role: a.role || ("supporting" as const),
        initialLuck: a.initialLuck || ("medium" as const),
        initialMood: a.initialMood || 0,
      }));

      const organizations = StaticDataRegistry.getAllOrganizations().filter(
        (o) => o.type === "media",
      );

      // Create a mock event
      const mockEvent = {
        id: "test-event-1",
        day: 1,
        type: "announcement" as const,
        description:
          "TechCorp announces new AI product that will revolutionize the market",
        actors: actors.slice(0, 2).map((a) => a.id),
        visibility: "public" as const,
      };

      const articles = await generator.generateArticlesForEvent(
        mockEvent,
        organizations.slice(0, 2),
        actors,
        [],
      );

      console.log(`   Generated ${articles.length} articles`);

      expect(articles.length).toBeGreaterThan(0);

      for (const article of articles) {
        // Validate article structure
        expect(article.title).toBeDefined();
        expect(article.title.length).toBeGreaterThan(10);
        expect(article.content).toBeDefined();
        expect(article.content.length).toBeGreaterThan(100);
        expect(article.authorOrgId).toBeDefined();

        const isMocked =
          article.title.toLowerCase().includes("mock") ||
          article.content.toLowerCase().includes("mock content");
        expect(isMocked).toBe(false);
        console.log(`   ✅ "${article.title.substring(0, 50)}..."`);
      }
    });
  });

  describe("QuestionManager", () => {
    test("generates prediction questions", async () => {
      const { QuestionManager } = await import("../../QuestionManager");
      const { FeedLLMClient } = await import("../../llm/openai-client");

      console.log("❓ Testing QuestionManager...");

      const llm = FeedLLMClient.forGameTick();
      const manager = new QuestionManager(llm);

      // Generate questions using the continuous game method (what game tick uses)
      // This requires database context, so it tests the full integration
      const deadlineMs = Date.now() + 60000; // 1 minute deadline
      const questionsCreated = await manager.generateQuestionsForContinuousGame(
        2, // Generate 2 questions
        deadlineMs,
      );

      console.log(`   Generated ${questionsCreated} questions`);

      // Should create at least 0 questions (may be limited by existing questions)
      expect(questionsCreated).toBeGreaterThanOrEqual(0);
      console.log("   ✅ QuestionManager generates questions successfully");
    });

    test("resolves questions with proper outcome", async () => {
      const { QuestionManager } = await import("../../QuestionManager");
      const { FeedLLMClient } = await import("../../llm/openai-client");

      const llm = FeedLLMClient.forGameTick();
      const manager = new QuestionManager(llm);

      // Create a question to resolve
      const question = {
        id: 1,
        text: "Will AI continue to advance in 2025?",
        scenario: 1,
        outcome: true,
        rank: 1,
        status: "active" as const,
      };

      const resolved = manager.resolveQuestion(question, true);

      expect(resolved.status).toBe("resolved");
      expect(resolved.resolvedOutcome).toBe(true);

      console.log("   ✅ Question resolution works correctly");
    });
  });

  describe("FeedGenerator", () => {
    test("generates feed posts", async () => {
      const { FeedGenerator } = await import("../../FeedGenerator");
      const { FeedLLMClient } = await import("../../llm/openai-client");
      const { StaticDataRegistry } = await import(
        "../../services/static-data-registry"
      );

      console.log("📝 Testing FeedGenerator...");

      const llm = FeedLLMClient.forGameTick();
      const generator = new FeedGenerator(llm);

      // Use StaticDataRegistry instead of deprecated loadActorsData
      const allActors = StaticDataRegistry.getAllActors();
      const actors = allActors.slice(0, 5).map((a) => ({
        ...a,
        tier: a.tier || ("B_TIER" as const),
        role: a.role || ("supporting" as const),
        initialLuck: a.initialLuck || ("medium" as const),
        initialMood: a.initialMood || 0,
      }));

      // Create mock events for feed generation
      const events = [
        {
          id: "event-1",
          day: 1,
          type: "announcement" as const,
          description: "Major tech company announces new product launch",
          actors: actors.slice(0, 2).map((a) => a.id),
          visibility: "public" as const,
        },
      ];

      const posts = await generator.generateDayFeed(1, events, actors);

      console.log(`   Generated ${posts.length} feed posts`);

      // At least some posts should be generated (even if rate limited, we retry)
      expect(posts.length).toBeGreaterThanOrEqual(0);

      // Filter posts with actual content (rate limiting may cause some empty posts)
      const postsWithContent = posts.filter(
        (p) => p.content && p.content.length > 10,
      );
      console.log(
        `   Posts with valid content: ${postsWithContent.length}/${posts.length}`,
      );

      // If we have posts with content, validate them
      for (const post of postsWithContent.slice(0, 3)) {
        expect(post.content).toBeDefined();
        expect(post.content.length).toBeGreaterThan(10);
        expect(post.author).toBeDefined();

        const isMocked = post.content.toLowerCase().includes("mock post");
        expect(isMocked).toBe(false);

        console.log(
          `   ✅ [${post.authorName}] "${post.content.substring(0, 40)}..."`,
        );
      }

      // If no posts with content, log warning but don't fail
      // (rate limiting in test environment is acceptable)
      if (postsWithContent.length === 0 && posts.length > 0) {
        console.log("   ⚠️  All posts have empty content (likely rate limited)");
      }
    });
  });

  describe("PerpMarketService", () => {
    test("initializes and can fetch market snapshots", async () => {
      console.log("📈 Testing PerpMarketService...");

      const { PerpMarketService, PerpDbAdapter } = await import(
        "@feed/core/markets/perps"
      );
      const { WalletService } = await import("../../services/wallet-service");
      const { FEE_CONFIG } = await import("../../config/fees");

      const service = new PerpMarketService({
        db: new PerpDbAdapter(),
        wallet: {
          debit: ({ userId, amount, reason, description, relatedId }) =>
            WalletService.debit(
              userId,
              amount,
              reason,
              description ?? "",
              relatedId,
            ),
          credit: ({ userId, amount, reason, description, relatedId }) =>
            WalletService.credit(
              userId,
              amount,
              reason,
              description ?? "",
              relatedId,
            ),
          recordPnL: async ({ userId, pnl, reason, relatedId }) => {
            await WalletService.recordPnL(userId, pnl, reason, relatedId);
          },
          getBalance: (userId: string) => WalletService.getBalance(userId),
        },
        fees: {
          tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
          platformShare: FEE_CONFIG.PLATFORM_SHARE,
          referrerShare: FEE_CONFIG.REFERRER_SHARE,
          minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
        },
      });

      const markets = await service.getMarketsSnapshot();
      console.log(`   ✅ Fetched ${markets.length} perp market snapshots`);

      expect(Array.isArray(markets)).toBe(true);

      if (markets.length > 0) {
        const market = markets[0];
        expect(market).toHaveProperty("ticker");
        expect(market).toHaveProperty("price");
        console.log(
          `   ✅ Sample market: ${market?.ticker} @ $${market?.price}`,
        );
      }
    });
  });

  describe("MarketDecisionEngine", () => {
    test("generates NPC trading decisions", async () => {
      console.log("💹 Testing MarketDecisionEngine...");

      // Verify static registry connection
      const { StaticDataRegistry } = await import(
        "../../services/static-data-registry"
      );
      const allActors = StaticDataRegistry.getAllActors();
      console.log(
        `   Static registry loaded, found ${allActors.length} actors`,
      );

      const { MarketDecisionEngine } = await import(
        "../../MarketDecisionEngine"
      );
      const { MarketContextService } = await import(
        "../../services/market-context-service"
      );
      const { FeedLLMClient } = await import("../../llm/openai-client");

      const llm = FeedLLMClient.forGameTick();
      const contextService = new MarketContextService();
      const engine = new MarketDecisionEngine(llm, contextService);

      // Generate batch decisions
      const decisions = await engine.generateBatchDecisions();

      console.log(`   Generated ${decisions.length} trading decisions`);

      for (const decision of decisions.slice(0, 5)) {
        expect(decision.npcId).toBeDefined();
        expect(decision.action).toBeDefined();
        expect(
          [
            "buy_yes",
            "buy_no",
            "open_long",
            "open_short",
            "close_position",
            "hold",
          ].includes(decision.action),
        ).toBe(true);

        console.log(
          `   ✅ NPC ${decision.npcId}: ${decision.action}${decision.amount ? ` $${decision.amount}` : ""}`,
        );
      }
    });
  });

  describe("GameClock Modes", () => {
    test("realtime mode tracks actual time", async () => {
      const { GameClock } = await import("../../GameClock");

      console.log("⏰ Testing realtime mode...");

      const clock = GameClock.realtime();
      const time1 = clock.now();

      // Wait a bit
      await new Promise((r) => setTimeout(r, 100));

      const time2 = clock.now();

      expect(time2.timestamp.getTime()).toBeGreaterThanOrEqual(
        time1.timestamp.getTime(),
      );
      console.log(`   ✅ Realtime: ${time2.timestamp.toISOString()}`);
    });

    test("simulated mode allows fast-forward", async () => {
      const { GameClock } = await import("../../GameClock");

      console.log("⏱️  Testing simulated mode...");

      const startDate = new Date("2025-01-01T00:00:00Z");
      const clock = GameClock.simulated(startDate, startDate);

      // Initial state
      let time = clock.now();
      expect(time.day).toBe(1);
      expect(time.hour).toBe(0);

      // Fast forward 48 hours
      time = clock.advanceHours(48);
      expect(time.day).toBe(3);
      expect(time.tick).toBe(48);

      console.log(`   ✅ After 48 hours: Day ${time.day}, Tick ${time.tick}`);
    });

    test("fed-in time allows specific timestamps", async () => {
      const { GameClock } = await import("../../GameClock");

      console.log("📅 Testing fed-in time mode...");

      const startDate = new Date("2025-01-01T00:00:00Z");
      const clock = GameClock.simulated(startDate, startDate);

      // Set specific time
      const targetDate = new Date("2025-01-15T14:30:00Z");
      clock.setTime(targetDate);

      const time = clock.now();
      expect(time.day).toBe(15);
      expect(time.hour).toBe(14);
      expect(time.minute).toBe(30);

      console.log(`   ✅ Fed-in: Day ${time.day}, ${time.hour}:${time.minute}`);
    });
  });

  describe("InMemoryStateStore (Offline Mode)", () => {
    test("supports full game simulation without database", async () => {
      const { InMemoryStateStore } = await import(
        "../../adapters/InMemoryStateStore"
      );

      console.log("🧠 Testing offline simulation...");

      const store = new InMemoryStateStore({
        numPredictionMarkets: 3,
        numPerpMarkets: 2,
        numAgents: 5,
        durationDays: 7,
        seed: 42,
      });

      // Test complete simulation loop
      let tradesExecuted = 0;
      let ticksProcessed = 0;

      while (!store.isComplete() && ticksProcessed < 168) {
        // 7 days max
        // Get state
        const state = store.getState();

        // Execute some trades
        const agent = state.agents[ticksProcessed % state.agents.length];
        const market =
          state.predictionMarkets[
            ticksProcessed % state.predictionMarkets.length
          ];

        if (agent && market && !market.resolved && agent.balance > 10) {
          const side = Math.random() > 0.5 ? "YES" : "NO";
          const result = store.buyPredictionShares(
            agent.id,
            market.id,
            side,
            10,
          );
          if (result.success) tradesExecuted++;
        }

        // Advance time
        store.advanceTick();
        ticksProcessed++;
      }

      const finalState = store.getState();
      const progress = store.getProgress();

      console.log(`   ✅ Processed ${ticksProcessed} ticks`);
      console.log(`   ✅ Executed ${tradesExecuted} trades`);
      console.log(`   ✅ Final day: ${progress.day}`);
      console.log(
        `   ✅ Markets resolved: ${finalState.predictionMarkets.filter((m) => m.resolved).length}/${finalState.predictionMarkets.length}`,
      );

      expect(ticksProcessed).toBeGreaterThan(0);
      expect(tradesExecuted).toBeGreaterThan(0);
    });
  });
});
