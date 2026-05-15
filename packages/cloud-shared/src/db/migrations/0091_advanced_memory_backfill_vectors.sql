-- Backfill embedding_384 / embedding_1536 from the legacy real[] embedding
-- column. Rows whose dimension matches neither 384 nor 1536 are left untouched
-- and reported via RAISE NOTICE so the operator can investigate before the
-- legacy column is dropped.
DO $$
DECLARE
  ltm_skipped integer;
  sum_skipped integer;
BEGIN
  UPDATE "long_term_memories"
    SET "embedding_384" = "embedding"::vector(384)
    WHERE "embedding" IS NOT NULL
      AND array_length("embedding", 1) = 384
      AND "embedding_384" IS NULL;

  UPDATE "long_term_memories"
    SET "embedding_1536" = "embedding"::vector(1536)
    WHERE "embedding" IS NOT NULL
      AND array_length("embedding", 1) = 1536
      AND "embedding_1536" IS NULL;

  SELECT COUNT(*) INTO ltm_skipped
    FROM "long_term_memories"
    WHERE "embedding" IS NOT NULL
      AND array_length("embedding", 1) NOT IN (384, 1536);
  RAISE NOTICE 'long_term_memories backfill skipped % rows with non-{384,1536} dim', ltm_skipped;

  UPDATE "session_summaries"
    SET "embedding_384" = "embedding"::vector(384)
    WHERE "embedding" IS NOT NULL
      AND array_length("embedding", 1) = 384
      AND "embedding_384" IS NULL;

  UPDATE "session_summaries"
    SET "embedding_1536" = "embedding"::vector(1536)
    WHERE "embedding" IS NOT NULL
      AND array_length("embedding", 1) = 1536
      AND "embedding_1536" IS NULL;

  SELECT COUNT(*) INTO sum_skipped
    FROM "session_summaries"
    WHERE "embedding" IS NOT NULL
      AND array_length("embedding", 1) NOT IN (384, 1536);
  RAISE NOTICE 'session_summaries backfill skipped % rows with non-{384,1536} dim', sum_skipped;
END $$;
