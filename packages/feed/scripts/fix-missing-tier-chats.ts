#!/usr/bin/env bun
/**
 * Fix Missing Tier Chats
 *
 * Creates Chat records for NPC tier groups that are missing them.
 * This can happen if groups were created before the tiered system
 * or if there was a partial failure during bootstrap.
 *
 * Usage:
 *   bun run scripts/fix-missing-tier-chats.ts
 *
 * Options:
 *   --dry-run    Show what would be fixed without making changes
 */

import {
  and,
  chatParticipants,
  chats,
  db,
  eq,
  groupMembers,
  groups,
  isNull,
} from "@feed/db";
import { StaticDataRegistry } from "@feed/engine";
import { generateSnowflakeId } from "@feed/shared";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  console.log("\n🔧 Fix Missing Tier Chats");
  console.log("=".repeat(60));

  if (dryRun) {
    console.log("DRY RUN MODE - No changes will be made\n");
  }

  // Find all NPC tier groups without chats
  const groupsWithoutChats = await db
    .select({
      id: groups.id,
      name: groups.name,
      ownerId: groups.ownerId,
      tier: groups.tier,
    })
    .from(groups)
    .leftJoin(chats, eq(chats.groupId, groups.id))
    .where(
      and(
        eq(groups.type, "npc"),
        isNull(chats.id), // No associated chat
      ),
    );

  console.log(`Found ${groupsWithoutChats.length} groups without chats\n`);

  if (groupsWithoutChats.length === 0) {
    console.log("✅ All NPC groups have associated chats!");
    process.exit(0);
  }

  let fixed = 0;
  let errors = 0;

  for (const group of groupsWithoutChats) {
    const actor = StaticDataRegistry.getActor(group.ownerId);
    const npcName = actor?.name || group.ownerId;

    console.log(`Group: ${group.name} (Tier ${group.tier}, NPC: ${npcName})`);

    if (dryRun) {
      console.log(`  [DRY RUN] Would create chat for group ${group.id}`);
      fixed++;
      continue;
    }

    try {
      const chatId = await generateSnowflakeId();
      const participantId = await generateSnowflakeId();
      const now = new Date();

      // Get existing members before transaction
      const existingMembers = await db
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, group.id),
            eq(groupMembers.isActive, true),
          ),
        );

      // Wrap all inserts in a transaction for atomicity
      await db.$transaction(async (tx) => {
        // Create the chat
        await tx.insert(chats).values({
          id: chatId,
          name: group.name,
          isGroup: true,
          groupId: group.id,
          createdAt: now,
          updatedAt: now,
        });

        // Add NPC as participant (they should already be in GroupMember)
        await tx.insert(chatParticipants).values({
          id: participantId,
          chatId,
          userId: group.ownerId,
          joinedAt: now,
          isActive: true,
        });

        // Add existing group members as chat participants
        for (const member of existingMembers) {
          // Skip NPC (already added)
          if (member.userId === group.ownerId) continue;

          try {
            await tx.insert(chatParticipants).values({
              id: await generateSnowflakeId(),
              chatId,
              userId: member.userId,
              joinedAt: now,
              isActive: true,
            });
          } catch (insertError) {
            // Only ignore duplicate-key errors; rethrow other errors
            const errorMessage = String(insertError);
            const isDuplicateKey =
              errorMessage.includes("unique constraint") ||
              errorMessage.includes("duplicate key") ||
              errorMessage.includes("UNIQUE constraint failed");
            if (!isDuplicateKey) {
              console.log(
                `  ⚠️ Error adding participant ${member.userId}: ${errorMessage}`,
              );
              throw insertError;
            }
          }
        }
      });

      console.log(
        `  ✅ Created chat ${chatId} with ${existingMembers.length} participants`,
      );
      fixed++;
    } catch (error) {
      console.log(`  ❌ Error: ${error}`);
      errors++;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`\n📊 Results: ${fixed} fixed, ${errors} errors\n`);

  if (!dryRun && fixed > 0) {
    console.log("✅ Fixed! Now run the migration script again:");
    console.log(
      "   bun run scripts/migrate-users-to-default-groups.ts --user=<your-id>",
    );
  }

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
