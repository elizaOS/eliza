#!/usr/bin/env bun
/**
 * Migrate Existing Users to Default Alpha Groups
 *
 * Assigns 3 default Tier 3 (Followers) groups to existing users who
 * don't already have sufficient NPC group memberships.
 *
 * This is a one-time migration script to be run after deploying the
 * tiered group system. Future users will get their default groups
 * assigned automatically during signup.
 *
 * Usage:
 *   bun run scripts/migrate-users-to-default-groups.ts
 *
 * Options:
 *   --dry-run      Show what would be done without making changes
 *   --batch=<n>    Number of users to process per batch (default: 100)
 *   --limit=<n>    Maximum total users to process (default: unlimited)
 *   --user=<id>    Only process a specific user (for testing)
 */

import {
  and,
  count,
  db,
  eq,
  groupMembers,
  groups,
  inArray,
  isNull,
  nftSnapshot,
  users,
  whitelist,
} from '@feed/db';
import { UserAlphaGroupAssignmentService } from '@feed/engine';
import { logger } from '@feed/shared';

/** Default limit for batch processing when no limit specified */
const MIGRATE_USERS_DEFAULT_LIMIT = 100000;

interface MigrationStats {
  totalUsersProcessed: number;
  usersNeedingAssignment: number;
  usersSkipped: number;
  groupsAssigned: number;
  errors: number;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const batchSize =
    Number.parseInt(
      args.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? '100',
      10
    ) || 100;
  const limit =
    Number.parseInt(
      args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '0',
      10
    ) || 0;
  const specificUser = args.find((a) => a.startsWith('--user='))?.split('=')[1];

  logger.info(
    'Default Alpha Group Migration started',
    { dryRun, batchSize, limit: limit || 'unlimited', specificUser },
    'migrate-default-groups'
  );

  if (dryRun) {
    logger.info(
      'DRY RUN MODE - No changes will be made',
      {},
      'migrate-default-groups'
    );
  }

  const stats: MigrationStats = {
    totalUsersProcessed: 0,
    usersNeedingAssignment: 0,
    usersSkipped: 0,
    groupsAssigned: 0,
    errors: 0,
  };

  // First, check capacity
  const capacityStats =
    await UserAlphaGroupAssignmentService.getCapacityStats();

  logger.info(
    'Current Tier 3 capacity status',
    {
      totalGroups: capacityStats.totalTier3Groups,
      totalCapacity: capacityStats.totalTier3Capacity,
      currentMembers: capacityStats.currentTier3Members,
      availableSlots: capacityStats.availableSlots,
      fillRate: `${(capacityStats.fillRate * 100).toFixed(1)}%`,
      maxUsersCanServe: capacityStats.maxUsersCanServe,
    },
    'migrate-default-groups'
  );

  if (capacityStats.totalTier3Groups === 0) {
    logger.error(
      'No Tier 3 groups found - run bootstrap-alpha-groups.ts first',
      {},
      'migrate-default-groups'
    );
    process.exit(1);
  }

  // Get users needing assignment
  // Users who:
  // - Are not actors (not NPCs)
  // - Are not agents (agents inherit from owners)
  // - Are not banned
  // - Have completed profile (full signup)
  // - Have < 3 active NPC group memberships

  let usersToProcess: Array<{ id: string; username: string | null }> = [];

  if (specificUser) {
    // Single user mode
    const [user] = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(eq(users.id, specificUser))
      .limit(1);

    if (!user) {
      logger.error(
        'User not found',
        { userId: specificUser },
        'migrate-default-groups'
      );
      process.exit(1);
    }

    usersToProcess = [user];
  } else {
    // Batch mode - get all eligible users
    // This query gets users with fewer than 3 NPC group memberships
    // Get user IDs that have actual platform access:
    // 1. Users in NftSnapshot (top of leaderboard, eligible to mint)
    // 2. Users in Whitelist (manually granted access)
    // 3. Admin users
    const [snapshotUsers, whitelistedUsers, adminUsers] = await Promise.all([
      db.select({ userId: nftSnapshot.userId }).from(nftSnapshot),
      db
        .select({ userId: whitelist.userId })
        .from(whitelist)
        .where(isNull(whitelist.revokedAt)),
      db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.isAdmin, true),
            eq(users.isActor, false),
            eq(users.isAgent, false)
          )
        ),
    ]);

    const accessUserIds = new Set([
      ...snapshotUsers.map((u) => u.userId),
      ...whitelistedUsers.map((u) => u.userId),
      ...adminUsers.map((u) => u.id),
    ]);

    logger.info(
      'Access-granted users found',
      {
        nftSnapshot: snapshotUsers.length,
        whitelisted: whitelistedUsers.length,
        admins: adminUsers.length,
        uniqueTotal: accessUserIds.size,
      },
      'migrate-default-groups'
    );

    if (accessUserIds.size === 0) {
      logger.error(
        'No access-granted users found. Aborting.',
        {},
        'migrate-default-groups'
      );
      process.exit(1);
    }

    // Only process users who have platform access
    const accessUserIdArray = [...accessUserIds];
    usersToProcess = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(
        and(
          inArray(users.id, accessUserIdArray),
          eq(users.isActor, false),
          eq(users.isAgent, false),
          eq(users.isBanned, false),
          eq(users.profileComplete, true)
        )
      )
      .orderBy(users.createdAt)
      .limit(limit > 0 ? limit : MIGRATE_USERS_DEFAULT_LIMIT);
  }

  logger.info(
    'Found users to evaluate',
    { count: usersToProcess.length },
    'migrate-default-groups'
  );

  // Process in batches
  for (let i = 0; i < usersToProcess.length; i += batchSize) {
    const batch = usersToProcess.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(usersToProcess.length / batchSize);

    logger.info(
      `Processing batch ${batchNum}/${totalBatches}`,
      { batchSize: batch.length },
      'migrate-default-groups'
    );

    for (const user of batch) {
      stats.totalUsersProcessed++;

      // Check current NPC group count
      const [groupCount] = await db
        .select({ count: count() })
        .from(groupMembers)
        .innerJoin(groups, eq(groupMembers.groupId, groups.id))
        .where(
          and(
            eq(groupMembers.userId, user.id),
            eq(groupMembers.isActive, true),
            eq(groups.type, 'npc')
          )
        );

      const currentGroups = groupCount?.count ?? 0;
      const targetGroups =
        UserAlphaGroupAssignmentService.TARGET_DEFAULT_GROUPS;

      if (currentGroups >= targetGroups) {
        // User already has sufficient groups
        stats.usersSkipped++;
        logger.debug(
          'User already has sufficient groups',
          { userId: user.id, username: user.username, groups: currentGroups },
          'migrate-default-groups'
        );
        continue;
      }

      stats.usersNeedingAssignment++;

      if (dryRun) {
        logger.info(
          '[DRY RUN] Would assign groups to user',
          {
            userId: user.id,
            username: user.username,
            currentGroups,
            groupsNeeded: targetGroups - currentGroups,
          },
          'migrate-default-groups'
        );
        continue;
      }

      // Assign default groups
      const result = await UserAlphaGroupAssignmentService.assignDefaultGroups(
        user.id
      );

      if (result.success) {
        stats.groupsAssigned += result.groupsAssigned;
        logger.info(
          'Assigned groups to user',
          {
            userId: user.id,
            username: user.username,
            groupsAssigned: result.groupsAssigned,
            assignments: result.assignments.map((a) => ({
              npc: a.npcName,
              tier: a.tier,
            })),
          },
          'migrate-default-groups'
        );
      } else {
        if (result.errors.length > 0) {
          stats.errors++;
          logger.warn(
            'Failed to assign groups to user',
            { userId: user.id, username: user.username, errors: result.errors },
            'migrate-default-groups'
          );
        }
      }
    }

    // Small delay between batches to avoid overwhelming the database
    if (i + batchSize < usersToProcess.length && !dryRun) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  logger.info(
    'Migration complete',
    {
      ...stats,
      dryRun,
    },
    'migrate-default-groups'
  );

  // Final capacity check
  if (!dryRun) {
    const finalCapacity =
      await UserAlphaGroupAssignmentService.getCapacityStats();

    logger.info(
      'Final capacity status',
      {
        totalGroups: finalCapacity.totalTier3Groups,
        totalCapacity: finalCapacity.totalTier3Capacity,
        currentMembers: finalCapacity.currentTier3Members,
        availableSlots: finalCapacity.availableSlots,
        fillRate: `${(finalCapacity.fillRate * 100).toFixed(1)}%`,
        maxUsersCanServe: finalCapacity.maxUsersCanServe,
      },
      'migrate-default-groups'
    );
  }

  logger.info('Done!', {}, 'migrate-default-groups');
  process.exit(0);
}

main().catch((error) => {
  logger.error(
    'Fatal error in migration script',
    {
      error: String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
    'migrate-default-groups'
  );
  process.exit(1);
});
