#!/usr/bin/env bun
/**
 * Diagnose User Group Assignment
 *
 * Helps debug why a user may not have gotten their 3 default groups.
 *
 * Usage:
 *   bun run scripts/diagnose-user-groups.ts --user=<userId>
 */

import {
  and,
  chats,
  count,
  db,
  eq,
  groupMembers,
  groups,
  users,
} from '@feed/db';
import {
  StaticDataRegistry,
  TIER_CONFIG,
  UserAlphaGroupAssignmentService,
} from '@feed/engine';

async function main() {
  const args = process.argv.slice(2);
  const userId = args.find((a) => a.startsWith('--user='))?.split('=')[1];

  if (!userId) {
    console.log(
      'Usage: bun run scripts/diagnose-user-groups.ts --user=<userId>'
    );
    process.exit(1);
  }

  console.log('\n🔍 Diagnosing group assignment for user:', userId);
  console.log('='.repeat(60));

  // 1. Get user info
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      isActor: users.isActor,
      isAgent: users.isAgent,
      isBanned: users.isBanned,
      profileComplete: users.profileComplete,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    console.log('❌ User not found');
    process.exit(1);
  }

  console.log('\n📋 User Info:');
  console.log('  - Username:', user.username);
  console.log('  - Is Actor:', user.isActor);
  console.log('  - Is Agent:', user.isAgent);
  console.log('  - Is Banned:', user.isBanned);
  console.log('  - Profile Complete:', user.profileComplete);

  if (user.isActor) {
    console.log('\n⚠️  User is an NPC actor - cannot assign groups');
    process.exit(0);
  }
  if (user.isAgent) {
    console.log('\n⚠️  User is an agent - inherits from owner');
    process.exit(0);
  }

  // 2. Check current NPC group memberships
  const currentMemberships = await db
    .select({
      groupId: groupMembers.groupId,
      groupName: groups.name,
      tier: groups.tier,
      ownerId: groups.ownerId,
      joinedAt: groupMembers.joinedAt,
    })
    .from(groupMembers)
    .innerJoin(groups, eq(groupMembers.groupId, groups.id))
    .where(
      and(
        eq(groupMembers.userId, userId),
        eq(groupMembers.isActive, true),
        eq(groups.type, 'npc')
      )
    );

  console.log('\n📊 Current NPC Group Memberships:', currentMemberships.length);
  for (const m of currentMemberships) {
    const actor = StaticDataRegistry.getActor(m.ownerId);
    console.log(
      `  - ${m.groupName} (Tier ${m.tier}, NPC: ${actor?.name || m.ownerId})`
    );
  }

  const targetGroups = UserAlphaGroupAssignmentService.TARGET_DEFAULT_GROUPS;
  const groupsNeeded = targetGroups - currentMemberships.length;
  console.log('\n📈 Groups Needed:', Math.max(0, groupsNeeded));

  if (groupsNeeded <= 0) {
    console.log(`✅ User already has ${targetGroups}+ NPC groups`);
    process.exit(0);
  }

  // 3. Check Tier 3 group availability
  console.log('\n🔍 Checking Tier 3 group availability...');

  // Count total Tier 3 groups
  const [tier3Count] = await db
    .select({ count: count() })
    .from(groups)
    .where(and(eq(groups.type, 'npc'), eq(groups.tier, 3)));

  console.log('  - Total Tier 3 groups:', tier3Count?.count ?? 0);

  // Count Tier 3 groups WITH chats (required for assignment)
  const tier3WithChats = await db
    .select({
      groupId: groups.id,
      npcId: groups.ownerId,
      chatId: chats.id,
    })
    .from(groups)
    .leftJoin(chats, eq(chats.groupId, groups.id))
    .where(and(eq(groups.type, 'npc'), eq(groups.tier, 3)));

  const withChats = tier3WithChats.filter((g) => g.chatId !== null);
  const withoutChats = tier3WithChats.filter((g) => g.chatId === null);

  console.log('  - Tier 3 groups WITH chats:', withChats.length);
  console.log('  - Tier 3 groups WITHOUT chats:', withoutChats.length);

  if (withoutChats.length > 0) {
    console.log('\n⚠️  WARNING: Some Tier 3 groups are missing chats!');
    console.log(
      '    This is likely the issue - groups without chats cannot be joined.'
    );
    console.log('    Run: bun run scripts/fix-missing-tier-chats.ts');
  }

  // 4. Check capacity
  const capacityStats =
    await UserAlphaGroupAssignmentService.getCapacityStats();
  console.log('\n📊 Tier 3 Capacity:');
  console.log('  - Total Capacity:', capacityStats.totalTier3Capacity);
  console.log('  - Current Members:', capacityStats.currentTier3Members);
  console.log('  - Available Slots:', capacityStats.availableSlots);
  console.log(
    '  - Fill Rate:',
    `${(capacityStats.fillRate * 100).toFixed(1)}%`
  );

  // 5. Get NPCs user is already with
  const existingNpcIds = new Set(currentMemberships.map((m) => m.ownerId));

  // 6. Find available groups for this user
  const allTier3 = await db
    .select({
      groupId: groups.id,
      npcId: groups.ownerId,
      maxMembers: groups.maxMembers,
      chatId: chats.id,
      memberCount: count(groupMembers.id),
    })
    .from(groups)
    .leftJoin(chats, eq(chats.groupId, groups.id))
    .leftJoin(
      groupMembers,
      and(eq(groupMembers.groupId, groups.id), eq(groupMembers.isActive, true))
    )
    .where(and(eq(groups.type, 'npc'), eq(groups.tier, 3)))
    .groupBy(groups.id, groups.ownerId, groups.maxMembers, chats.id);

  let availableForUser = 0;
  let excludedNoChat = 0;
  let excludedFull = 0;
  let excludedAlreadyMember = 0;

  for (const g of allTier3) {
    if (!g.chatId) {
      excludedNoChat++;
      continue;
    }
    if (existingNpcIds.has(g.npcId)) {
      excludedAlreadyMember++;
      continue;
    }
    const maxMembers = g.maxMembers ?? TIER_CONFIG[3].maxMembers;
    const memberCount = g.memberCount ?? 0;
    if (memberCount >= maxMembers) {
      excludedFull++;
      continue;
    }
    availableForUser++;
  }

  console.log('\n📋 Groups Available for This User:');
  console.log('  - Available:', availableForUser);
  console.log('  - Excluded (no chat):', excludedNoChat);
  console.log('  - Excluded (already member):', excludedAlreadyMember);
  console.log('  - Excluded (full):', excludedFull);

  if (availableForUser < groupsNeeded) {
    console.log(
      `\n⚠️  Not enough available groups (need ${groupsNeeded}, have ${availableForUser})`
    );
  }

  // 7. Suggest fix
  console.log('\n' + '='.repeat(60));
  if (excludedNoChat > 0) {
    console.log('\n🔧 FIX NEEDED: Create missing chats for Tier 3 groups');
    console.log(
      '   The TieredGroupService.ensureAllTiersExist() should create chats,'
    );
    console.log(
      '   but some groups are missing them. This needs investigation.'
    );
  } else if (availableForUser >= groupsNeeded) {
    console.log('\n🔧 TRY: Re-run assignment for this user');
    console.log(
      '   const result = await UserAlphaGroupAssignmentService.assignDefaultGroups("' +
        userId +
        '");'
    );
    console.log('   console.log(result);');
  }

  console.log('\nDone!');
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
