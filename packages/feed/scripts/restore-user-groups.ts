#!/usr/bin/env bun
/**
 * Restore User Groups
 *
 * Quick script to restore a user's alpha groups if they were lost.
 * Finds user by username or ID and assigns them to the configured default Tier 3 groups.
 *
 * Usage:
 *   bun run scripts/restore-user-groups.ts --username=@ravioliravioli
 *   bun run scripts/restore-user-groups.ts --user=<user-id>
 */

import { db, eq, ilike, users } from '@feed/db';
import {
  TieredGroupService,
  UserAlphaGroupAssignmentService,
} from '@feed/engine';
import { logger } from '@feed/shared';

async function main() {
  const args = process.argv.slice(2);
  const minGroups = UserAlphaGroupAssignmentService.TARGET_DEFAULT_GROUPS;

  // Parse arguments
  const usernameArg = args.find((a) => a.startsWith('--username='));
  const userIdArg = args.find((a) => a.startsWith('--user='));

  if (!usernameArg && !userIdArg) {
    console.error('Usage:');
    console.error(
      '  bun run scripts/restore-user-groups.ts --username=@username'
    );
    console.error('  bun run scripts/restore-user-groups.ts --user=<user-id>');
    process.exit(1);
  }

  let userId: string | null = null;
  let userName: string | null = null;

  if (usernameArg) {
    const rawUsername = usernameArg.slice('--username='.length).trim();
    // Remove @ prefix if present
    const username = rawUsername.replace(/^@/, '').trim();

    if (!username) {
      console.error(
        'Invalid --username value. Expected --username=@username (non-empty).'
      );
      process.exit(1);
    }

    const [user] = await db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
      })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (!user) {
      // Try case-insensitive search
      const [userCI] = await db
        .select({
          id: users.id,
          username: users.username,
          displayName: users.displayName,
        })
        .from(users)
        .where(ilike(users.username, username))
        .limit(1);

      if (!userCI) {
        console.error(`User not found: ${username}`);
        process.exit(1);
      }
      userId = userCI.id;
      userName = userCI.displayName || userCI.username;
    } else {
      userId = user.id;
      userName = user.displayName || user.username;
    }
  } else if (userIdArg) {
    const rawUserId = userIdArg.slice('--user='.length).trim();
    if (!rawUserId) {
      console.error(
        'Invalid --user value. Expected --user=<user-id> (non-empty).'
      );
      process.exit(1);
    }
    userId = rawUserId;

    const [user] = await db
      .select({ displayName: users.displayName, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      console.error(`User ID not found: ${userId}`);
      process.exit(1);
    }
    userName = user.displayName || user.username;
  }

  if (!userId) {
    console.error('Could not determine user ID');
    process.exit(1);
  }

  console.log(`\n🔧 Restoring groups for: ${userName} (${userId})\n`);

  // Step 1: Ensure tier groups exist (bootstrap)
  console.log('Step 1: Ensuring tier groups exist for all NPCs...');
  const { StaticDataRegistry } = await import('@feed/engine');
  const actors = StaticDataRegistry.getAllActors().filter((a) => !a.isTest);

  let groupsCreated = 0;
  for (const actor of actors) {
    const tiers = await TieredGroupService.ensureAllTiersExist(actor.id);
    const newTiers = tiers.filter((t) => t.memberCount === 1);
    groupsCreated += newTiers.length;
  }

  if (groupsCreated > 0) {
    console.log(`  ✅ Created ${groupsCreated} new tier groups`);
  } else {
    console.log(`  ✅ All tier groups already exist`);
  }

  // Step 2: Assign default groups
  console.log('\nStep 2: Assigning default groups...');
  const result =
    await UserAlphaGroupAssignmentService.assignDefaultGroups(userId);

  if (result.success && result.groupsAssigned === 0) {
    console.log(`  ℹ️  User already has ${minGroups}+ groups, no action needed`);
  } else if (result.success) {
    console.log(`  ✅ Assigned ${result.groupsAssigned} groups:`);
    for (const assignment of result.assignments) {
      console.log(`     - ${assignment.npcName}'s Followers (Tier 3)`);
    }
  } else {
    console.log(`  ⚠️  Assignment had issues:`);
    for (const error of result.errors) {
      console.log(`     - ${error}`);
    }
  }

  // Step 3: Show final state
  console.log('\nStep 3: Final group count...');
  const { count, groupMembers, groups, and } = await import('@feed/db');
  const [groupCount] = await db
    .select({ count: count() })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(
      and(
        eq(groupMembers.userId, userId),
        eq(groupMembers.isActive, true),
        eq(groups.type, 'npc')
      )
    );

  console.log(`  ✅ User is now in ${groupCount?.count ?? 0} NPC groups\n`);

  if ((groupCount?.count ?? 0) >= minGroups) {
    console.log(
      '✨ Restoration complete! User should now see groups in /chats\n'
    );
  } else {
    console.log(
      `⚠️  User still has fewer than ${minGroups} groups. This may indicate capacity issues.\n`
    );
  }

  process.exit(0);
}

main().catch((error) => {
  const errorObj = error instanceof Error ? error : new Error(String(error));
  logger.error(
    'Fatal error in restore-user-groups',
    errorObj,
    'restore-user-groups'
  );
  process.exit(1);
});
