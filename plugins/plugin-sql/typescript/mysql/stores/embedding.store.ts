import type { UUID } from "@elizaos/core";
import { eq } from "drizzle-orm";
import { DIMENSION_MAP, type EmbeddingDimensionColumn } from "../tables";
import { embeddingTable, memoryTable } from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Sets the embedding dimension based on a numeric dimension value.
 * Returns the corresponding DIMENSION_MAP column name for MySQL's native VECTOR type.
 *
 * @param dimension - The numeric embedding dimension (e.g. 384, 512, 768, 1024, 1536, 3072)
 * @returns The DIMENSION_MAP column name (e.g. "dim384", "dim512", etc.)
 */
export function setEmbeddingDimension(
  dimension: number
): EmbeddingDimensionColumn {
  return DIMENSION_MAP[dimension as keyof typeof DIMENSION_MAP];
}

/**
 * Queries the database to determine which embedding dimension column is currently in use
 * for a given agent. Checks existing memories with embeddings to detect which
 * dimension column has non-null data.
 *
 * @param db - The Drizzle MySQL database instance
 * @param agentId - The agent's UUID to check embeddings for
 * @returns The detected EmbeddingDimensionColumn, or null if no embeddings exist
 */
export async function getEmbeddingDimension(
  db: DrizzleDatabase,
  agentId: UUID
): Promise<EmbeddingDimensionColumn | null> {
  const existingMemory = await db
    .select()
    .from(memoryTable)
    .innerJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
    .where(eq(memoryTable.agentId, agentId))
    .limit(1);

  if (existingMemory.length > 0) {
    // The join result includes both memoryTable and embeddingTable columns
    interface JoinedMemoryResult {
      memories: typeof memoryTable.$inferSelect;
      embeddings: typeof embeddingTable.$inferSelect;
    }
    const joinedResult = existingMemory[0] as JoinedMemoryResult;
    const found = Object.entries(DIMENSION_MAP).find(([_, colName]) => {
      const embeddingCol = colName as keyof typeof embeddingTable.$inferSelect;
      return joinedResult.embeddings[embeddingCol] !== null;
    });

    if (found) {
      return found[1] as EmbeddingDimensionColumn;
    }
  }

  return null;
}

/**
 * Ensures the embedding dimension is configured for the agent.
 * Checks existing memories to detect which dimension column is in use,
 * then returns the configured dimension column for the requested dimension.
 *
 * This is the store equivalent of the base class ensureEmbeddingDimension method.
 * Uses MySQL's DIMENSION_MAP which maps to native VECTOR columns.
 *
 * @param db - The Drizzle MySQL database instance
 * @param agentId - The agent's UUID
 * @param dimension - The desired embedding dimension (e.g. 384, 512, 768, 1024, 1536, 3072)
 * @returns The EmbeddingDimensionColumn to use for this agent
 */
export async function getEmbeddingConfig(
  db: DrizzleDatabase,
  agentId: UUID,
  dimension: number
): Promise<EmbeddingDimensionColumn> {
  // Check existing memories to find what dimension column is currently in use
  const existingMemory = await db
    .select()
    .from(memoryTable)
    .innerJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
    .where(eq(memoryTable.agentId, agentId))
    .limit(1);

  if (existingMemory.length > 0) {
    // Access embedding columns directly from the joined result
    interface JoinedMemoryResult {
      memories: typeof memoryTable.$inferSelect;
      embeddings: typeof embeddingTable.$inferSelect;
    }
    const joinedResult = existingMemory[0] as JoinedMemoryResult;
    Object.entries(DIMENSION_MAP).find(([_, colName]) => {
      const embeddingCol = colName as keyof typeof embeddingTable.$inferSelect;
      return joinedResult.embeddings[embeddingCol] !== null;
    });
    // We don't actually need to use usedDimension for now, but it's good to know it's there.
  }

  return DIMENSION_MAP[dimension as keyof typeof DIMENSION_MAP];
}
