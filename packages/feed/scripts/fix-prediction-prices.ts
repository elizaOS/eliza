#!/usr/bin/env bun
/**
 * Fix Prediction Market Price Data
 *
 * Corrects PoolPosition entries where entryPrice and currentPrice were
 * stored with an incorrect * 100 scaling. The CPMM's avgPrice is
 * cost-per-share (typically 0.5-3.0+), not a 0-1 probability, so the
 * * 100 multiplication created values 100x too large.
 *
 * This script:
 * 1. Divides PoolPosition.entryPrice by 100 for prediction positions
 * 2. Divides PoolPosition.currentPrice by 100 for prediction positions
 * 3. Reports before/after statistics
 *
 * Usage:
 *   bun run scripts/fix-prediction-prices.ts              # Dry run (report only)
 *   bun run scripts/fix-prediction-prices.ts --apply       # Apply the fix
 */

import { parseArgs } from 'node:util';
import { db, eq, poolPositions, sql } from '@feed/db';

const { values: args } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
  },
  strict: true,
});

const dryRun = !args.apply;

async function main() {
  console.log('=== Prediction Market Price Fix ===');
  console.log(
    `Mode: ${dryRun ? 'DRY RUN (use --apply to execute)' : 'APPLYING FIXES'}\n`
  );

  // Get current state
  const stats = await db
    .select({
      total: sql<number>`count(*)`,
      minEntry: sql<number>`min("entryPrice")`,
      maxEntry: sql<number>`max("entryPrice")`,
      avgEntry: sql<number>`avg("entryPrice")`,
      minCurrent: sql<number>`min("currentPrice")`,
      maxCurrent: sql<number>`max("currentPrice")`,
    })
    .from(poolPositions)
    .where(eq(poolPositions.marketType, 'prediction'));

  const s = stats[0];
  if (!s || s.total === 0) {
    console.log('No prediction positions found. Nothing to fix.');
    process.exit(0);
  }

  console.log('BEFORE:');
  console.log(`  Prediction positions: ${s.total}`);
  console.log(
    `  entryPrice:   min=${s.minEntry?.toFixed(4)}, max=${s.maxEntry?.toFixed(4)}, avg=${s.avgEntry?.toFixed(4)}`
  );
  console.log(
    `  currentPrice: min=${s.minCurrent?.toFixed(4)}, max=${s.maxCurrent?.toFixed(4)}`
  );

  // Detect if data needs fixing: if max entryPrice > 10, it's likely scaled
  const needsFix = (s.maxEntry ?? 0) > 10;
  if (!needsFix) {
    console.log(
      '\n  Prices look correct (max entryPrice < 10). No fix needed.'
    );
    process.exit(0);
  }

  console.log(
    `\n  Max entryPrice ${s.maxEntry?.toFixed(2)} > 10 — data appears to have * 100 scaling.`
  );

  if (dryRun) {
    console.log(
      '\n  Would divide entryPrice and currentPrice by 100 for all prediction positions.'
    );
    console.log('  Run with --apply to execute.');
    process.exit(0);
  }

  // Apply fix
  console.log('\nApplying fix...');

  await db
    .update(poolPositions)
    .set({
      entryPrice: sql`"entryPrice" / 100`,
      currentPrice: sql`"currentPrice" / 100`,
    })
    .where(eq(poolPositions.marketType, 'prediction'));

  // Verify
  const after = await db
    .select({
      total: sql<number>`count(*)`,
      minEntry: sql<number>`min("entryPrice")`,
      maxEntry: sql<number>`max("entryPrice")`,
      avgEntry: sql<number>`avg("entryPrice")`,
      minCurrent: sql<number>`min("currentPrice")`,
      maxCurrent: sql<number>`max("currentPrice")`,
    })
    .from(poolPositions)
    .where(eq(poolPositions.marketType, 'prediction'));

  const a = after[0];
  console.log('\nAFTER:');
  console.log(
    `  entryPrice:   min=${a?.minEntry?.toFixed(4)}, max=${a?.maxEntry?.toFixed(4)}, avg=${a?.avgEntry?.toFixed(4)}`
  );
  console.log(
    `  currentPrice: min=${a?.minCurrent?.toFixed(4)}, max=${a?.maxCurrent?.toFixed(4)}`
  );
  console.log('\nDone.');

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
