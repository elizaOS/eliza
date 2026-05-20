/**
 * NPC Follow Graph Bootstrap
 *
 * Seeds follow relationships between NPCs based on shared affiliations.
 * NPCs follow actors they share organizations with + actors they have
 * relationship records with. This ensures the relevance-filtered feed
 * shows posts from actors they'd actually care about.
 *
 * Run once during game bootstrap or on demand.
 */

import { actorFollows, db } from "@feed/db";
import { generateSnowflakeId, logger } from "@feed/shared";
import { StaticDataRegistry } from "./static-data-registry";

export async function bootstrapNpcFollows(): Promise<number> {
  const allActors = StaticDataRegistry.getAllActors();
  const followPairs = new Set<string>();

  // Build follow pairs from shared affiliations
  for (const actor of allActors) {
    if (!actor.affiliations?.length) continue;

    for (const other of allActors) {
      if (other.id === actor.id) continue;
      if (!other.affiliations?.length) continue;

      const shared = actor.affiliations.some((a) =>
        other.affiliations?.includes(a),
      );
      if (shared) {
        // Canonical ordering to avoid duplicates
        const key =
          actor.id < other.id
            ? `${actor.id}:${other.id}`
            : `${other.id}:${actor.id}`;
        followPairs.add(key);
      }
    }
  }

  // Check existing follows to avoid duplicates
  const existing = await db
    .select({
      followerId: actorFollows.followerId,
      followingId: actorFollows.followingId,
    })
    .from(actorFollows);
  const existingSet = new Set(
    existing.map((f) => `${f.followerId}:${f.followingId}`),
  );

  // Insert new follows
  // Build batch of new follows to insert
  const newFollows: Array<{
    id: string;
    followerId: string;
    followingId: string;
    isMutual: boolean;
  }> = [];

  for (const pair of followPairs) {
    const [actor1, actor2] = pair.split(":");
    if (!actor1 || !actor2) continue;

    for (const [follower, following] of [
      [actor1, actor2],
      [actor2, actor1],
    ]) {
      const key = `${follower}:${following}`;
      if (existingSet.has(key)) continue;
      try {
        const id = await generateSnowflakeId();
        newFollows.push({
          id,
          followerId: follower!,
          followingId: following!,
          isMutual: true,
        });
      } catch (err) {
        logger.warn(
          "Failed to generate snowflake ID for follow",
          {
            follower,
            following,
            error: err instanceof Error ? err.message : String(err),
          },
          "NpcFollowBootstrap",
        );
      }
    }
  }

  // Batch insert (skip conflicts from race conditions)
  let created = 0;
  if (newFollows.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < newFollows.length; i += batchSize) {
      const batch = newFollows.slice(i, i + batchSize);
      try {
        await db.insert(actorFollows).values(batch).onConflictDoNothing();
        created += batch.length;
      } catch (err) {
        logger.warn(
          "Follow batch insert failed",
          {
            error: err instanceof Error ? err.message : String(err),
            batchIndex: i,
          },
          "NpcFollowBootstrap",
        );
      }
    }
  }

  logger.info(
    "NPC follow graph bootstrapped",
    { totalPairs: followPairs.size, followsCreated: created },
    "NpcFollowBootstrap",
  );

  return created;
}
