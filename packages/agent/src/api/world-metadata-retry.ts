/**
 * Read-mutate-write of a world's metadata that survives the revision
 * compare-and-swap. The API boundary grants ownership/roles on first contact
 * while the runtime's own connection bootstrap (and, right after boot,
 * deferred maintenance) may bump the same world's revision in between; a
 * single-shot `updateWorld` then fails with WORLD_METADATA_STALE_WRITE and the
 * whole turn returned 500 (live 2026-09-06: the first owner request after
 * every restart). The mutation is re-applied to a fresh read, bounded to a few
 * attempts; anything but a stale-write conflict propagates unchanged.
 */
import { ElizaError, type UUID, type World } from "@elizaos/core";

export const WORLD_METADATA_WRITE_ATTEMPTS = 3;

export interface WorldMetadataWriter {
  getWorld(worldId: UUID): Promise<World | null>;
  updateWorld(world: World): Promise<void>;
}

/**
 * Applies `mutate` to the freshly read world and writes it when `mutate`
 * reports a change. Returns the world as written (or as found when no change
 * was needed), or null when the world does not exist.
 */
export async function updateWorldMetadataWithRetry(
  runtime: WorldMetadataWriter,
  worldId: UUID,
  mutate: (world: World) => boolean,
): Promise<World | null> {
  let lastError: unknown;
  for (let attempt = 0; attempt < WORLD_METADATA_WRITE_ATTEMPTS; attempt += 1) {
    const world = await runtime.getWorld(worldId);
    if (!world) return null;
    if (!mutate(world)) return world;
    try {
      await runtime.updateWorld(world);
      return world;
    } catch (error) {
      // error-policy:J2 Only a revision conflict is retried against a fresh
      // read; every other failure keeps its cause and propagates.
      if (
        !(error instanceof ElizaError) ||
        error.code !== "WORLD_METADATA_STALE_WRITE"
      ) {
        throw error;
      }
      lastError = error;
    }
  }
  throw new ElizaError(
    "World metadata write kept conflicting with concurrent writers",
    {
      code: "WORLD_METADATA_STALE_WRITE",
      cause: lastError instanceof Error ? lastError : undefined,
      context: { worldId, attempts: WORLD_METADATA_WRITE_ATTEMPTS },
    },
  );
}
