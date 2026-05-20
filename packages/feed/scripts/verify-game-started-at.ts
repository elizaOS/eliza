#!/usr/bin/env bun
/**
 * Verify Game startedAt Script
 *
 * Checks if the continuous game has a valid startedAt timestamp set.
 * This is critical for proper game day calculation.
 *
 * Usage: bun scripts/verify-game-started-at.ts
 */

import { db, eq, games } from '@feed/db';
import { getGameDayNumber } from '@feed/engine/utils/date-utils';

async function verifyGameStartedAt() {
  console.log('🔍 Checking continuous game startedAt...\n');

  const [game] = await db
    .select({
      id: games.id,
      currentDay: games.currentDay,
      startedAt: games.startedAt,
      createdAt: games.createdAt,
      lastTickAt: games.lastTickAt,
      isRunning: games.isRunning,
    })
    .from(games)
    .where(eq(games.isContinuous, true))
    .limit(1);

  if (!game) {
    console.error('❌ No continuous game found in database!');
    console.log(
      '   Run: POST /api/game/control with action: "start" to create one.'
    );
    process.exit(1);
  }

  console.log('Game Found:');
  console.log(`  ID: ${game.id}`);
  console.log(`  Is Running: ${game.isRunning}`);
  console.log(`  Current Day (stored): ${game.currentDay}`);
  console.log(`  Started At: ${game.startedAt?.toISOString() ?? 'NULL ⚠️'}`);
  console.log(`  Created At: ${game.createdAt.toISOString()}`);
  console.log(`  Last Tick At: ${game.lastTickAt?.toISOString() ?? 'NULL'}`);
  console.log('');

  if (!game.startedAt) {
    console.error('❌ CRITICAL: startedAt is NULL!');
    console.log(
      '   Game day calculation will always return undefined and default to 1.'
    );
    console.log('');
    console.log('   To fix, you can update the game with:');
    console.log(
      '   UPDATE "Game" SET "startedAt" = "createdAt" WHERE "isContinuous" = true;'
    );
    console.log('');
    console.log(
      '   ⚠️  Caveat: Using createdAt assumes the game ran continuously since creation.'
    );
    console.log(
      '   If the game was paused for extended periods, adjust startedAt accordingly.'
    );
    process.exit(1);
  }

  // Calculate expected day using centralized utility
  const now = new Date();
  const expectedDay = getGameDayNumber(game.startedAt, now);

  console.log('Day Calculation:');
  console.log(`  Now: ${now.toISOString()}`);
  console.log(
    `  Hours since start: ${((now.getTime() - game.startedAt.getTime()) / (1000 * 60 * 60)).toFixed(2)}`
  );
  console.log(`  Expected Day (1-indexed): ${expectedDay}`);
  console.log(`  Stored Day: ${game.currentDay}`);
  console.log('');

  if (game.currentDay !== expectedDay) {
    console.warn(
      `⚠️  Stored day (${game.currentDay}) differs from calculated day (${expectedDay})`
    );
    if (game.isRunning) {
      console.log(
        '   Game is running - this will be corrected on the next game tick.'
      );
    } else {
      console.log(
        '   Game is NOT running - start the game or manually correct the day.'
      );
    }
  } else {
    console.log('✅ Game day tracking is correct!');
  }

  process.exit(0);
}

verifyGameStartedAt().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
