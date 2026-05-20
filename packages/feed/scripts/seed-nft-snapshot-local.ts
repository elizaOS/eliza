#!/usr/bin/env bun

/**
 * Seed NFT Snapshot for Local Development
 *
 * Creates nftSnapshot entries for test users so they can mint NFTs locally.
 * This script:
 * 1. Gets all users from the database
 * 2. Creates snapshot entries for them (up to 100)
 * 3. Makes them eligible to mint NFTs
 *
 * Usage:
 *   bun run scripts/seed-nft-snapshot-local.ts
 */

import { closeDatabase, count, db, nftSnapshot, users } from '@feed/db';
import { nanoid } from 'nanoid';

export async function runLocalNftSnapshotSeed(options?: {
  closeAfter?: boolean;
}): Promise<void> {
  const closeAfter = options?.closeAfter ?? true;

  console.log('[SeedNFTSnapshot] Creating local development NFT snapshots...');

  // Check if snapshots already exist
  const [existingCount] = await db.select({ count: count() }).from(nftSnapshot);
  if ((existingCount?.count ?? 0) > 0) {
    console.log(
      `[SeedNFTSnapshot] ✅ Snapshots already exist (${existingCount?.count} entries)`
    );
    if (closeAfter) {
      await closeDatabase();
    }
    return;
  }

  // Get all users (up to 100)
  const allUsers = await db
    .select({
      id: users.id,
      walletAddress: users.walletAddress,
      username: users.username,
    })
    .from(users)
    .limit(100);

  if (allUsers.length === 0) {
    console.log(
      '[SeedNFTSnapshot] No users found in database. Run db:seed first.'
    );
    if (closeAfter) {
      await closeDatabase();
    }
    return;
  }

  console.log(
    `[SeedNFTSnapshot] Creating snapshots for ${allUsers.length} users...`
  );

  const snapshotTime = new Date();
  let created = 0;

  for (let i = 0; i < allUsers.length; i++) {
    const user = allUsers[i]!;
    const rank = i + 1;
    const points = 100000 - i * 1000; // Decreasing points by rank

    try {
      await db.insert(nftSnapshot).values({
        id: nanoid(),
        userId: user.id,
        walletAddress: user.walletAddress?.toLowerCase() ?? null,
        rank,
        points,
        snapshotTakenAt: snapshotTime,
        hasMinted: false,
      });
      created++;
    } catch (error) {
      // Skip if duplicate
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('duplicate') && !message.includes('unique')) {
        console.warn(
          `[SeedNFTSnapshot] Failed to create snapshot for user ${user.id}:`,
          message
        );
      }
    }
  }

  console.log(`[SeedNFTSnapshot] ✅ Created ${created} snapshot entries`);
  console.log('[SeedNFTSnapshot] All users are now eligible to mint NFTs!');

  if (closeAfter) {
    await closeDatabase();
  }
}

async function main(): Promise<void> {
  await runLocalNftSnapshotSeed({ closeAfter: true });
}

if (import.meta.main) {
  main().catch((error) => {
    console.error('[SeedNFTSnapshot] Failed:', error);
    process.exit(1);
  });
}
