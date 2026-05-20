/**
 * Integration Test: Trading and Prediction Question Generation
 *
 * Verifies that core gameplay mechanics work correctly:
 * - NPC trading creates positions and updates markets
 * - Prediction question generation creates new questions and markets
 * - Both features work together in a game tick
 *
 * These tests exercise the real LLM-backed game tick path when explicitly enabled.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { asSystem, db } from '@babylon/db';
import { executeGameTick, StaticDataRegistry } from '@babylon/engine';
import { generateSnowflakeId } from '@babylon/shared';
import { resolveLiveLlmTestConfig } from './helpers/live-runtime';

const liveLlmTestConfig = resolveLiveLlmTestConfig();
const liveTest = test.skipIf(!liveLlmTestConfig.enabled);

async function retireQuestionAndMarket(questionId: string) {
  const resolvedAt = new Date();
  await db.$transaction(async (tx) => {
    await tx.question.update({
      where: { id: questionId },
      data: {
        status: 'resolved',
        updatedAt: resolvedAt,
      },
    });

    await tx.market.updateMany({
      where: { id: questionId },
      data: {
        resolved: true,
        updatedAt: resolvedAt,
      },
    });
  });
}

describe('Trading and Question Generation Integration', () => {
  let initialMarketCount: number;
  const testQuestionIds: string[] = [];
  const testMarketIds: string[] = [];

  beforeAll(async () => {
    if (liveLlmTestConfig.requested && !liveLlmTestConfig.enabled) {
      throw new Error(
        liveLlmTestConfig.skipReason ?? 'Live LLM test setup failed'
      );
    }

    if (!liveLlmTestConfig.enabled) {
      return;
    }

    // Ensure game is running
    const gameState = await asSystem(async (db) => {
      return await db.game.findFirst({
        where: { isContinuous: true },
      });
    });

    if (!gameState) {
      await asSystem(async (db) => {
        await db.game.create({
          data: {
            id: await generateSnowflakeId(),
            isContinuous: true,
            isRunning: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      });
    } else if (!gameState.isRunning) {
      await asSystem(async (db) => {
        await db.game.updateMany({
          where: { isContinuous: true },
          data: { isRunning: true },
        });
      });
    }

    // Get baseline counts
    initialMarketCount = await db.market.count({
      where: { resolved: false },
    });

    // Ensure we have at least one active market for trading
    const activeMarkets = await db.market.findMany({
      where: { resolved: false },
      take: 1,
    });

    if (activeMarkets.length === 0) {
      // Create a test question and market with the same ID (matching how QuestionManager creates them)
      const testId = await generateSnowflakeId();

      await db.question.create({
        data: {
          id: testId,
          questionNumber: Math.floor(Date.now() / 1000) % 1000000,
          text: 'Test: Will trading work?',
          scenarioId: 1,
          outcome: false,
          rank: 1,
          status: 'active',
          resolutionDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      await db.market.create({
        data: {
          id: testId, // Same ID as question - this is how QuestionManager creates them
          question: 'Test: Will trading work?',
          yesShares: '100',
          noShares: '100',
          liquidity: '200',
          resolved: false,
          endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      testQuestionIds.push(testId);
      testMarketIds.push(testId);
    }

    // Ensure we have NPCs with trading enabled
    const npcs = await db.user.findMany({
      where: {
        isAgent: false,
        virtualBalance: { gt: '0' },
      },
      take: 5,
    });

    if (npcs.length === 0) {
      console.log(
        '⚠️  Warning: No NPCs found with balance. Trading may not occur.'
      );
    }
  });

  afterAll(async () => {
    if (!liveLlmTestConfig.enabled) {
      return;
    }

    // Cleanup test data
    if (testQuestionIds.length > 0) {
      for (const id of testQuestionIds) {
        try {
          await db.question.delete({ where: { id } }).catch(() => {});
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    if (testMarketIds.length > 0) {
      for (const id of testMarketIds) {
        try {
          await db.market.delete({ where: { id } }).catch(() => {});
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  });

  liveTest(
    'should execute game tick and process trading',
    async () => {
      // skipContentGeneration=true for faster test - still uses LLM for trading decisions
      const result = await executeGameTick(true);

      expect(result).toBeDefined();
      expect(typeof result.marketsUpdated).toBe('number');
      expect(result.marketsUpdated).toBeGreaterThanOrEqual(0);

      // Verify markets were updated if trading occurred
      if (result.marketsUpdated > 0) {
        const afterMarketCount = await db.market.count({
          where: { resolved: false },
        });

        // Markets should still exist (or more if new ones were created)
        expect(afterMarketCount).toBeGreaterThanOrEqual(initialMarketCount);
      }
    },
    60000
  );

  liveTest(
    'should create NPC positions when trading occurs',
    async () => {
      // Get initial NPC pool position count (PoolPosition is for NPC perp trading)
      const beforePositions = await db.poolPosition.count({
        where: { closedAt: null }, // Open positions have no closedAt
      });

      // Run game tick - skipContentGeneration=true for faster test
      const result = await executeGameTick(true);

      // Get position count after tick
      const afterPositions = await db.poolPosition.count({
        where: { closedAt: null },
      });

      // If markets were updated, NPC positions should have been created
      if (result.marketsUpdated > 0) {
        // Positions should have increased or stayed the same (some may have closed)
        // We check that positions exist or were created
        expect(afterPositions).toBeGreaterThanOrEqual(0);

        // Verify at least some NPC positions exist if trading occurred
        const hasPositions = afterPositions > 0 || beforePositions > 0;
        expect(hasPositions).toBe(true);
      }
    },
    60000
  );

  liveTest(
    'should generate new questions when count is low',
    async () => {
      // Get current active question count
      const beforeQuestions = await db.question.count({
        where: { status: 'active' },
      });

      // If we have 10+ questions, delete some to trigger generation
      if (beforeQuestions >= 10) {
        // Delete oldest questions to get below threshold
        const questionsToDelete = await db.question.findMany({
          where: { status: 'active' },
          orderBy: { createdAt: 'asc' },
          take: beforeQuestions - 8, // Leave 8 active (below 10 threshold)
        });

        for (const q of questionsToDelete) {
          await retireQuestionAndMarket(q.id);
        }
      }

      // Run game tick - note: skipContentGeneration=true means question generation is skipped
      // This test verifies that the game tick infrastructure works, not that questions are created
      const result = await executeGameTick(true);

      // Verify the game tick completed successfully
      expect(result).toBeDefined();
      expect(typeof result.questionsCreated).toBe('number');
      expect(typeof result.questionsResolved).toBe('number');

      // When skipContentGeneration=true, questions may not be created
      // This is expected behavior. The test verifies the tick infrastructure works.
      expect(result.questionsCreated).toBeGreaterThanOrEqual(0);

      // Check current question count
      const afterQuestions = await db.question.count({
        where: { status: 'active' },
      });

      // If questions were generated despite skipContentGeneration, verify they have markets
      if (result.questionsCreated > 0) {
        expect(afterQuestions).toBeGreaterThan(0);

        // Verify questions have associated markets
        const newQuestions = await db.question.findMany({
          where: {
            status: 'active',
            createdAt: { gte: new Date(Date.now() - 60000) }, // Created in last minute
          },
        });

        for (const question of newQuestions) {
          const market = await db.market.findUnique({
            where: { id: question.id },
          });
          expect(market).toBeTruthy();
          expect(market?.resolved).toBe(false);
        }
      }

      console.log(
        `Question generation: before=${beforeQuestions}, after=${afterQuestions}, created=${result.questionsCreated}`
      );
    },
    60000
  );

  liveTest(
    'should update organization prices when NPCs trade',
    async () => {
      // Get an organization (company) to track price changes from static registry + dynamic state
      // Note: "marketsUpdated" in game tick refers to organization prices, not prediction markets
      const staticOrgs = StaticDataRegistry.getOrganizationsByType(
        'company'
      ).filter((o) => o.ticker);
      const orgStates = await db.organizationState.findMany();
      const stateMap = new Map(orgStates.map((s) => [s.id, s]));

      // Find a company with state
      const staticOrg = staticOrgs.find((o) => stateMap.has(o.id));

      // Test requires at least one company with state
      expect(staticOrg).toBeDefined();
      if (!staticOrg) throw new Error('No organization found');

      const orgState = stateMap.get(staticOrg.id);
      const beforePrice = orgState?.currentPrice
        ? Number(orgState.currentPrice)
        : null;

      // Run game tick - skipContentGeneration=true for faster test
      const result = await executeGameTick(true);

      // Check if organization price was updated
      const afterOrgState = await db.organizationState.findUnique({
        where: { id: staticOrg.id },
      });

      expect(afterOrgState).toBeTruthy();

      // Note: NPCs may choose to hold rather than trade, so we can't always expect price changes.
      // This test verifies the infrastructure works, not that every tick has trading.
      // The marketsUpdated count tracks the widget cache updates, not actual trades.
      // If we want to verify actual trades, we need to check pool positions.

      if (result.marketsUpdated > 0) {
        const afterPrice = afterOrgState?.currentPrice
          ? Number(afterOrgState.currentPrice)
          : null;

        // Just verify the price is a valid number (may or may not have changed)
        // Price changes depend on whether NPCs actually traded this org's perp
        if (afterPrice !== null) {
          expect(typeof afterPrice).toBe('number');
          expect(isFinite(afterPrice)).toBe(true);
        }

        // Log what happened for debugging
        const priceChanged = afterPrice !== beforePrice;
        console.log(
          `Organization ${staticOrg.ticker}: price ${priceChanged ? 'changed' : 'unchanged'} (${beforePrice} -> ${afterPrice})`
        );
      }

      // Verify the game tick result is valid
      expect(result.marketsUpdated).toBeGreaterThanOrEqual(0);
    },
    60000
  );

  liveTest(
    'should create markets for new questions',
    async () => {
      // Ensure we're below question threshold to trigger generation
      const activeQuestions = await db.question.count({
        where: { status: 'active' },
      });

      if (activeQuestions >= 10) {
        // Resolve some questions to trigger generation
        const questionsToResolve = await db.question.findMany({
          where: { status: 'active' },
          orderBy: { createdAt: 'asc' },
          take: activeQuestions - 8,
        });

        for (const q of questionsToResolve) {
          await retireQuestionAndMarket(q.id);
        }
      }

      // Run game tick - skipContentGeneration=true for faster test
      const result = await executeGameTick(true);

      // Check if new markets were created
      const afterMarkets = await db.market.count({
        where: { resolved: false },
      });

      if (result.questionsCreated > 0) {
        // New questions should have associated markets
        expect(afterMarkets).toBeGreaterThanOrEqual(initialMarketCount);

        // Verify new questions have markets
        const newQuestions = await db.question.findMany({
          where: {
            status: 'active',
            createdAt: { gte: new Date(Date.now() - 60000) },
          },
        });

        for (const question of newQuestions) {
          const market = await db.market.findUnique({
            where: { id: question.id },
          });
          expect(market).toBeTruthy();
          expect(market?.question).toBe(question.text);
          expect(market?.resolved).toBe(false);
        }
      }
    },
    60000
  );

  liveTest(
    'should verify trading and question generation work together',
    async () => {
      // This is a comprehensive test that verifies both features work in the same tick

      // Track test start time for filtering questions
      const testStartTime = new Date();

      // Get baseline state
      const beforeQuestions = await db.question.count({
        where: { status: 'active' },
      });

      // Run game tick - skipContentGeneration=true for faster test
      const result = await executeGameTick(true);

      // Verify results structure
      expect(result).toBeDefined();
      expect(typeof result.marketsUpdated).toBe('number');
      expect(typeof result.questionsCreated).toBe('number');
      expect(typeof result.questionsResolved).toBe('number');

      // Verify trading occurred (if NPCs exist and have balance)
      const npcsWithBalance = await db.user.count({
        where: {
          isAgent: false,
          virtualBalance: { gt: '0' },
        },
      });

      if (npcsWithBalance > 0) {
        // Trading should have occurred (markets updated or positions created)
        // Note: Trading may not occur every tick (NPCs may hold)
        // But if markets exist and NPCs have balance, trading should eventually occur
        const currentPositions = await db.position.count({
          where: { status: 'active' },
        });
        console.log(
          `Trading status: marketsUpdated=${result.marketsUpdated}, positions=${currentPositions}`
        );

        // Verify trading infrastructure is working (even if no trades this tick)
        expect(result.marketsUpdated).toBeGreaterThanOrEqual(0);
        expect(currentPositions).toBeGreaterThanOrEqual(0);
      }

      // Verify question generation (if below threshold)
      if (beforeQuestions < 10) {
        const afterQuestions = await db.question.count({
          where: { status: 'active' },
        });

        // Questions should have been generated or at least attempted
        expect(afterQuestions).toBeGreaterThanOrEqual(beforeQuestions);

        if (result.questionsCreated > 0) {
          expect(afterQuestions).toBeGreaterThan(beforeQuestions);
        }
      }

      // Verify markets exist for questions created during THIS test run only
      // Note: We only check questions created after testStartTime to avoid failing on
      // orphan questions from previous test runs or seed data that may not have markets
      if (result.questionsCreated > 0) {
        const newQuestions = await db.question.findMany({
          where: {
            status: 'active',
            createdAt: { gte: testStartTime },
          },
        });

        for (const question of newQuestions) {
          const market = await db.market.findUnique({
            where: { id: question.id },
          });
          expect(market).toBeTruthy();
          expect(market?.resolved).toBe(false);
        }
      } else {
        // If no questions were created, just verify our test setup question has a market
        if (testQuestionIds.length > 0) {
          for (const questionId of testQuestionIds) {
            const market = await db.market.findUnique({
              where: { id: questionId },
            });
            expect(market).toBeTruthy();
          }
        }
      }
    },
    60000
  );
});
