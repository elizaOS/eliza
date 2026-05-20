#!/usr/bin/env bun
/**
 * Run Game Tick Script
 *
 * Executes a game tick directly without needing the web server.
 * Useful for testing or running against a specific database.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." bun run scripts/run-game-tick.ts
 *   DATABASE_URL="postgresql://..." bun run scripts/run-game-tick.ts --loop --interval=60
 *
 * Options:
 *   --loop        Run continuously in a loop
 *   --interval=N  Seconds between ticks (default: 60, only with --loop)
 */

import { closeDatabase } from '@babylon/db';
import { executeGameTick } from '@babylon/engine';
import { logger } from '@babylon/shared';

async function runTick(): Promise<void> {
  logger.info(
    '════════════════════════════════════════════════════════════',
    undefined,
    'RunGameTick'
  );
  logger.info('Executing game tick...', undefined, 'RunGameTick');

  const startTime = Date.now();
  const result = await executeGameTick();
  const duration = Date.now() - startTime;

  logger.info(
    '════════════════════════════════════════════════════════════',
    undefined,
    'RunGameTick'
  );
  logger.info(
    'Tick completed',
    {
      duration: `${duration}ms`,
      postsCreated: result.postsCreated,
      eventsCreated: result.eventsCreated,
      articlesCreated: result.articlesCreated,
      marketsUpdated: result.marketsUpdated,
      questionsResolved: result.questionsResolved,
      questionsCreated: result.questionsCreated,
    },
    'RunGameTick'
  );
  logger.info(
    '════════════════════════════════════════════════════════════',
    undefined,
    'RunGameTick'
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const loopMode = args.includes('--loop');
  const intervalArg = args.find((a) => a.startsWith('--interval='));
  const intervalSeconds = intervalArg
    ? parseInt(intervalArg.split('=')[1], 10)
    : 60;

  if (!process.env.DATABASE_URL) {
    logger.error(
      'DATABASE_URL environment variable is required',
      undefined,
      'RunGameTick'
    );
    process.exit(1);
  }

  logger.info(
    `Game Tick Runner ${loopMode ? `(loop mode, ${intervalSeconds}s interval)` : '(single tick)'}`,
    undefined,
    'RunGameTick'
  );

  if (loopMode) {
    // Run in a loop
    let running = true;
    let tickCount = 0;

    const cleanup = () => {
      running = false;
      logger.info(
        `Stopping after ${tickCount} ticks...`,
        undefined,
        'RunGameTick'
      );
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    while (running) {
      tickCount++;
      logger.info(`Tick #${tickCount}`, undefined, 'RunGameTick');
      await runTick();

      if (running) {
        logger.info(
          `Waiting ${intervalSeconds}s until next tick...`,
          undefined,
          'RunGameTick'
        );
        await new Promise((resolve) =>
          setTimeout(resolve, intervalSeconds * 1000)
        );
      }
    }

    await closeDatabase();
  } else {
    // Single tick mode
    await runTick();
    await closeDatabase();
  }
}

main().catch((error) => {
  logger.error('Failed to run game tick', { error }, 'RunGameTick');
  process.exit(1);
});
