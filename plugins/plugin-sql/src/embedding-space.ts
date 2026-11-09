/** Separates vector representations and fences writes from binaries that cannot identify them. */
import {
  ElizaError,
  getEmbeddingVectorSpaceIdentity,
  identifyEmbeddingVector,
} from "@elizaos/core";
import { eq, isNull, type SQL, sql } from "drizzle-orm";
import { embeddingTable } from "./schema/embedding";

export function embeddingSpaceCondition(spaceId: string | null): SQL {
  return spaceId === null ? isNull(embeddingTable.spaceId) : eq(embeddingTable.spaceId, spaceId);
}

/** Execute in one transaction before activating a named representation. */
export const EMBEDDING_WRITE_FENCE_STATEMENTS = [
  sql`LOCK TABLE embeddings IN SHARE ROW EXCLUSIVE MODE`,
  sql`CREATE OR REPLACE FUNCTION eliza_embedding_write_fence() RETURNS trigger
    LANGUAGE plpgsql AS $body$
    BEGIN
      IF OLD.space_id IS NOT NULL AND (NEW.space_id IS NULL OR NEW.write_nonce IS NOT DISTINCT FROM OLD.write_nonce) THEN
        RAISE EXCEPTION 'Embedding representation is versioned; restart this writer with a compatible runtime'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $body$`,
  sql`DROP TRIGGER IF EXISTS eliza_embedding_write_fence ON embeddings`,
  sql`CREATE TRIGGER eliza_embedding_write_fence BEFORE UPDATE OF
    dim_384, dim_512, dim_768, dim_1024, dim_1536, dim_2048, dim_3072, space_id
    ON embeddings FOR EACH ROW EXECUTE FUNCTION eliza_embedding_write_fence()`,
];

export interface EmbeddingWriteContext {
  readonly column: import("./schema/embedding").EmbeddingDimensionColumn;
  readonly spaceId: string | null;
}

/** Bind a vector to the selected column and require provenance for named representations. */
export function captureEmbeddingTarget(
  embedding: number[],
  column: EmbeddingWriteContext["column"],
  activeSpace: string | null
): EmbeddingWriteContext {
  const identity = getEmbeddingVectorSpaceIdentity(embedding);
  const context = { column, spaceId: identity ?? null };
  assertEmbeddingWrite(context, column, activeSpace);
  if (activeSpace !== null) {
    if (embedding.length !== Number(column.slice(3))) {
      throw new ElizaError("Embedding vector does not match the active dimension", {
        code: "EMBEDDING_DIMENSION_MISMATCH",
      });
    }
    for (const value of embedding) {
      if (!Number.isFinite(value)) {
        throw new ElizaError("Embedding vector contains a non-finite value", {
          code: "EMBEDDING_VECTOR_INVALID",
        });
      }
    }
  }
  return context;
}

/** Recheck immediately before writing, while retaining the original label and column. */
export function assertEmbeddingWrite(
  context: EmbeddingWriteContext,
  column: EmbeddingWriteContext["column"],
  activeSpace: string | null
): void {
  if (context.spaceId !== activeSpace || context.column !== column) {
    throw new ElizaError("Embedding representation changed before the vector could be stored", {
      code: "EMBEDDING_SPACE_MISMATCH",
      context: {
        expectedSpace: context.spaceId,
        activeSpace,
        expectedColumn: context.column,
        activeColumn: column,
      },
    });
  }
}

/** Preserve the stored representation when a vector is cached across an activation. */
export function readEmbeddingVector(embedding: ArrayLike<number>, spaceId: string | null): number[];
export function readEmbeddingVector(
  embedding: ArrayLike<number> | null | undefined,
  spaceId: string | null
): number[] | undefined;
export function readEmbeddingVector(
  embedding: ArrayLike<number> | null | undefined,
  spaceId: string | null
): number[] | undefined {
  return embedding ? identifyEmbeddingVector(Array.from(embedding), spaceId) : undefined;
}
