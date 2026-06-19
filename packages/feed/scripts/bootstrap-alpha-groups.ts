#!/usr/bin/env bun
/**
 * Bootstrap Alpha Group Tiers
 *
 * Creates all 3 tier groups (Inner Circle, Community, Followers) for every NPC.
 * This should be run once after deploying the tiered group system to ensure
 * all tier groups exist before the invite system starts processing.
 *
 * Usage:
 *   bun run scripts/bootstrap-alpha-groups.ts
 *
 * Options:
 *   --dry-run    Show what would be created without making changes
 *   --npc=<id>   Only bootstrap a specific NPC (for testing)
 */

import { StaticDataRegistry, TieredGroupService } from "@feed/engine";
import { logger } from "@feed/shared";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const specificNpc = args.find((a) => a.startsWith("--npc="))?.split("=")[1];

  logger.info(
    "Alpha Group Tier Bootstrap started",
    { dryRun, specificNpc },
    "bootstrap-alpha-groups",
  );

  if (dryRun) {
    logger.info(
      "DRY RUN MODE - No changes will be made",
      {},
      "bootstrap-alpha-groups",
    );
  }

  // Get all NPCs
  const allActors = StaticDataRegistry.getAllActors();
  const npcs = specificNpc
    ? allActors.filter((a) => a.id === specificNpc)
    : allActors.filter((a) => !a.isTest); // Exclude test actors

  if (npcs.length === 0) {
    logger.error("No NPCs found", { specificNpc }, "bootstrap-alpha-groups");
    process.exit(1);
  }

  // Calculate expected capacity
  const tier1Capacity = npcs.length * 12;
  const tier2Capacity = npcs.length * 50;
  const tier3Capacity = npcs.length * 500;
  const totalCapacity = tier1Capacity + tier2Capacity + tier3Capacity;

  logger.info(
    "NPCs to process",
    {
      npcCount: npcs.length,
      expectedGroups: npcs.length * 3,
      expectedCapacity: {
        tier1: tier1Capacity,
        tier2: tier2Capacity,
        tier3: tier3Capacity,
        total: totalCapacity,
      },
    },
    "bootstrap-alpha-groups",
  );

  if (dryRun) {
    logger.info(
      "Dry run complete",
      { npcCount: npcs.length },
      "bootstrap-alpha-groups",
    );
    process.exit(0);
  }

  // Process each NPC
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const [i, npc] of npcs.entries()) {
    const progress = { current: i + 1, total: npcs.length };

    try {
      const tiers = await TieredGroupService.ensureAllTiersExist(npc.id);

      // Count new vs existing
      const newTiers = tiers.filter((t) => t.memberCount === 1); // Only NPC owner = new

      if (newTiers.length > 0) {
        logger.info(
          "Created tiers for NPC",
          {
            ...progress,
            npcId: npc.id,
            npcName: npc.name,
            tiersCreated: newTiers.length,
          },
          "bootstrap-alpha-groups",
        );
        created += newTiers.length;
      } else {
        logger.debug(
          "All tiers already exist for NPC",
          { ...progress, npcId: npc.id, npcName: npc.name },
          "bootstrap-alpha-groups",
        );
        skipped += 3;
      }
    } catch (error) {
      logger.error(
        "Failed to create tiers for NPC",
        { ...progress, npcId: npc.id, npcName: npc.name, error: String(error) },
        "bootstrap-alpha-groups",
      );
      errors++;
    }
  }

  logger.info(
    "Bootstrap complete",
    { created, skipped, errors },
    "bootstrap-alpha-groups",
  );

  // Verify final state
  const analytics = await TieredGroupService.getGlobalAnalytics();

  logger.info(
    "Final state verification",
    {
      totalNpcs: analytics.totalNpcs,
      totalGroups: analytics.totalGroups,
      totalMembers: analytics.totalMembers,
      totalCapacity: analytics.totalCapacity,
      fillRate: `${(analytics.fillRate * 100).toFixed(1)}%`,
      tierBreakdown: analytics.tierBreakdown.map((tier) => ({
        tier: tier.tier,
        members: tier.members,
        capacity: tier.capacity,
        fillRate: `${(tier.fillRate * 100).toFixed(1)}%`,
      })),
    },
    "bootstrap-alpha-groups",
  );

  logger.info("Done!", {}, "bootstrap-alpha-groups");
  process.exit(0);
}

main().catch((error) => {
  logger.error(
    "Fatal error in bootstrap script",
    { error: String(error) },
    "bootstrap-alpha-groups",
  );
  process.exit(1);
});
