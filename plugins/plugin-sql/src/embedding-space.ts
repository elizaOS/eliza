/** Separates vector representations and fences writes from binaries that cannot identify them. */
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
