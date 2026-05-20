/**
 * Game Tick Performance Test
 *
 * Verifies that game tick completes within acceptable time limits.
 * Tests both with and without content generation to measure baseline.
 *
 * Run with: bun test packages/testing/performance/game-tick-performance.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { asSystem } from '@feed/db';
import { executeGameTick } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';

// Performance thresholds (in milliseconds)
const PERFORMANCE_THRESHOLDS = {
  // Maximum time for tick without content generation (operational only)
  noContentMaxMs: 30000, // 30 seconds
  // Maximum time for tick with content generation
  withContentMaxMs: 120000, // 2 minutes
  // Warning threshold (log if exceeded but don't fail)
  warningThresholdMs: 60000, // 1 minute
  // Maximum time for any single tick (should never hit 800s timeout)
  absoluteMaxMs: 600000, // 10 minutes
};

describe('Game Tick Performance', () => {
  let gameState: { id: string; isRunning: boolean } | null = null;
  let initialGameRunning: boolean | undefined;

  beforeAll(async () => {
    // Check game state
    gameState = await asSystem(async (db) => {
      return await db.game.findFirst({
        where: { isContinuous: true },
      });
    }, 'perf-test-get-game-state');

    if (!gameState) {
      // Create game state if it doesn't exist
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
      }, 'perf-test-create-game-state');
    } else {
      initialGameRunning = gameState.isRunning;
      // Ensure game is running for tests
      if (!gameState.isRunning) {
        await asSystem(async (db) => {
          await db.game.updateMany({
            where: { isContinuous: true },
            data: { isRunning: true },
          });
        }, 'perf-test-enable-game');
      }
    }
  });

  afterAll(async () => {
    // Restore game state
    if (initialGameRunning !== undefined && !initialGameRunning) {
      await asSystem(async (db) => {
        await db.game.updateMany({
          where: { isContinuous: true },
          data: { isRunning: initialGameRunning },
        });
      }, 'perf-test-restore-game-state');
    }
  });

  test('game tick without content generation completes within threshold', async () => {
    const startTime = Date.now();

    // Execute tick with skipContentGeneration=true (operational tasks only)
    const result = await executeGameTick(true);

    const duration = Date.now() - startTime;

    console.log('📊 Game Tick (no content) Performance:');
    console.log(`   Duration: ${duration}ms`);
    console.log(`   Markets Updated: ${result.marketsUpdated}`);
    console.log(`   Questions Resolved: ${result.questionsResolved}`);
    console.log(`   Trending Calculated: ${result.trendingCalculated}`);

    // Verify performance
    expect(result).toBeDefined();
    expect(duration).toBeLessThan(PERFORMANCE_THRESHOLDS.noContentMaxMs);

    if (duration > PERFORMANCE_THRESHOLDS.warningThresholdMs) {
      console.warn(
        `⚠️  Warning: Tick took ${duration}ms (threshold: ${PERFORMANCE_THRESHOLDS.warningThresholdMs}ms)`
      );
    }
  }, 60000); // 1 minute test timeout

  test('game tick with content generation completes within threshold', async () => {
    const startTime = Date.now();

    // Execute full tick with content generation
    const result = await executeGameTick(false);

    const duration = Date.now() - startTime;

    console.log('📊 Game Tick (with content) Performance:');
    console.log(`   Duration: ${duration}ms`);
    console.log(`   Posts Created: ${result.postsCreated}`);
    console.log(`   Events Created: ${result.eventsCreated}`);
    console.log(`   Articles Created: ${result.articlesCreated}`);
    console.log(`   Markets Updated: ${result.marketsUpdated}`);
    console.log(`   Questions Resolved: ${result.questionsResolved}`);
    console.log(`   Questions Created: ${result.questionsCreated}`);

    // Verify performance
    expect(result).toBeDefined();
    expect(duration).toBeLessThan(PERFORMANCE_THRESHOLDS.withContentMaxMs);
    expect(duration).toBeLessThan(PERFORMANCE_THRESHOLDS.absoluteMaxMs);

    if (duration > PERFORMANCE_THRESHOLDS.warningThresholdMs) {
      console.warn(
        `⚠️  Warning: Full tick took ${duration}ms (threshold: ${PERFORMANCE_THRESHOLDS.warningThresholdMs}ms)`
      );
    }
  }, 180000); // 3 minute test timeout

  test('multiple consecutive ticks maintain consistent performance', async () => {
    const tickDurations: number[] = [];
    const TICK_COUNT = 3;

    for (let i = 0; i < TICK_COUNT; i++) {
      const startTime = Date.now();
      await executeGameTick(true); // Skip content for speed
      tickDurations.push(Date.now() - startTime);

      // Small delay between ticks to simulate real cron spacing
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    const avgDuration =
      tickDurations.reduce((a, b) => a + b, 0) / tickDurations.length;
    const maxDuration = Math.max(...tickDurations);
    const minDuration = Math.min(...tickDurations);
    const variance = maxDuration - minDuration;

    console.log('📊 Consecutive Ticks Performance:');
    console.log(
      `   Durations: ${tickDurations.map((d) => `${d}ms`).join(', ')}`
    );
    console.log(`   Average: ${avgDuration.toFixed(0)}ms`);
    console.log(`   Min: ${minDuration}ms, Max: ${maxDuration}ms`);
    console.log(`   Variance: ${variance}ms`);

    // Verify all ticks completed within threshold
    for (const duration of tickDurations) {
      expect(duration).toBeLessThan(PERFORMANCE_THRESHOLDS.noContentMaxMs);
    }

    // Variance should be reasonable (no huge outliers)
    expect(variance).toBeLessThan(PERFORMANCE_THRESHOLDS.noContentMaxMs / 2);
  }, 120000); // 2 minute test timeout
});
