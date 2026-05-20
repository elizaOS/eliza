#!/usr/bin/env bun

/**
 * Database Seed Script
 *
 * Seeds the database using the engine's GameBootstrapService.
 * This is the canonical way to seed game data - the engine handles all logic.
 *
 * Usage:
 *   bun run scripts/seed-database.ts          # Seed everything
 *   bun run scripts/seed-database.ts --force  # Force reseed all data
 *   bun run scripts/seed-database.ts --stats  # Show database stats
 */

import { closeDatabase } from '@feed/db';
import { GameBootstrapService } from '@feed/engine';
import { logger } from '@feed/shared';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const forceReseed = args.includes('--force');
  const showStats = args.includes('--stats');

  logger.info(
    '════════════════════════════════════════════════════════════',
    undefined,
    'SeedDatabase'
  );
  logger.info(
    'Feed Database Seeder',
    { forceReseed, showStats },
    'SeedDatabase'
  );
  logger.info(
    '════════════════════════════════════════════════════════════',
    undefined,
    'SeedDatabase'
  );

  try {
    if (showStats) {
      const stats = await GameBootstrapService.getStats();
      logger.info('Database Statistics', stats, 'SeedDatabase');
      return;
    }

    if (forceReseed) {
      logger.info('Force reseeding all data...', undefined, 'SeedDatabase');
      const result = await GameBootstrapService.forceFullSync();
      logger.info('Force reseed complete', result, 'SeedDatabase');
    } else {
      logger.info(
        'Running bootstrap (will only seed missing data)...',
        undefined,
        'SeedDatabase'
      );
      const result = await GameBootstrapService.bootstrapIfNeeded();
      if (result) {
        logger.info('Bootstrap complete', result, 'SeedDatabase');
      } else {
        logger.info(
          'Bootstrap skipped (recently run or no changes needed)',
          undefined,
          'SeedDatabase'
        );
        // Force a fresh check
        const freshResult = await GameBootstrapService.forceFullSync();
        logger.info('Fresh sync complete', freshResult, 'SeedDatabase');
      }
    }

    // Show final stats
    const stats = await GameBootstrapService.getStats();
    logger.info(
      '════════════════════════════════════════════════════════════',
      undefined,
      'SeedDatabase'
    );
    logger.info('Database Summary', stats, 'SeedDatabase');
    logger.info(
      '════════════════════════════════════════════════════════════',
      undefined,
      'SeedDatabase'
    );

    logger.info('Seed complete!', undefined, 'SeedDatabase');
  } catch (error) {
    logger.error('Seed failed', { error }, 'SeedDatabase');
    throw error;
  } finally {
    await closeDatabase();
  }
}

if (import.meta.main) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}

export { GameBootstrapService };
