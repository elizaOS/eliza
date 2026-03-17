import { logger, type UUID } from "@elizaos/core";
import { eq } from "drizzle-orm";
import {
  DIMENSION_MAP,
  type EmbeddingDimensionColumn,
  embeddingTable,
  memoryTable,
} from "../tables";
import type { DrizzleDatabase } from "../types";

/**
 * Maps a numeric embedding dimension to the corresponding database column name.
 * This converts a dimension number (e.g. 384, 512, 768, 1024, 1536, 3072)
 * to the matching EmbeddingDimensionColumn string used in the schema.
 *
 * @param {number} dimension - The embedding dimension number.
 * @returns {EmbeddingDimensionColumn} The database column name for this dimension.
 */
export function setEmbeddingDimension(dimension: number): EmbeddingDimensionColumn {
  return DIMENSION_MAP[dimension as keyof typeof DIMENSION_MAP];
}

/**
 * Returns the current embedding dimension column value.
 * This is an identity accessor for consistency with the store pattern.
 *
 * @param {EmbeddingDimensionColumn} embeddingDimension - The current embedding dimension column.
 * @returns {EmbeddingDimensionColumn} The same embedding dimension column.
 */
export function getEmbeddingDimension(
  embeddingDimension: EmbeddingDimensionColumn
): EmbeddingDimensionColumn {
  return embeddingDimension;
}

/**
 * Queries the database to determine the embedding configuration for a given agent.
 * Inspects existing embeddings to discover which dimension column is in use, then
 * returns the appropriate EmbeddingDimensionColumn via DIMENSION_MAP lookup.
 *
 * If no existing embeddings are found, returns the column for the requested dimension.
 *
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID} agentId - The agent ID to check embeddings for.
 * @param {number} dimension - The requested embedding dimension (fallback).
 * @returns {Promise<EmbeddingDimensionColumn>} The embedding dimension column to use.
 */
export async function getEmbeddingConfig(
  db: DrizzleDatabase,
  agentId: UUID,
  dimension: number
): Promise<EmbeddingDimensionColumn> {
  const existingMemory = await db
    .select()
    .from(memoryTable)
    .innerJoin(embeddingTable, eq(embeddingTable.memoryId, memoryTable.id))
    .where(eq(memoryTable.agentId, agentId))
    .limit(1);

  if (existingMemory.length > 0) {
    // The join result includes both memoryTable and embeddingTable columns
    // Access embedding columns directly from the joined result
    interface JoinedMemoryResult {
      memories: typeof memoryTable.$inferSelect;
      embeddings: typeof embeddingTable.$inferSelect;
    }
    const joinedResult = existingMemory[0] as JoinedMemoryResult;
    const usedEntry = Object.entries(DIMENSION_MAP).find(([_, colName]) => {
      const embeddingCol = colName as keyof typeof embeddingTable.$inferSelect;
      return joinedResult.embeddings[embeddingCol] !== null;
    });

    if (usedEntry) {
      logger.debug(
        {
          src: "plugin:sql",
          agentId,
          detectedDimension: usedEntry[0],
          column: usedEntry[1],
        },
        "Detected existing embedding dimension from database"
      );
      return usedEntry[1] as EmbeddingDimensionColumn;
    }
  }

  // No existing embeddings found, use the requested dimension
  return DIMENSION_MAP[dimension as keyof typeof DIMENSION_MAP];
}
