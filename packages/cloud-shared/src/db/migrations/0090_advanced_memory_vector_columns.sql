-- Add pgvector columns alongside the existing real[] embedding columns on
-- long_term_memories and session_summaries. The original real[] column is kept
-- for safe rollback; a later migration will drop it once backfill + dual-write
-- have been observed in staging.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "long_term_memories" ADD COLUMN IF NOT EXISTS "embedding_384" vector(384);
ALTER TABLE "long_term_memories" ADD COLUMN IF NOT EXISTS "embedding_1536" vector(1536);

ALTER TABLE "session_summaries" ADD COLUMN IF NOT EXISTS "embedding_384" vector(384);
ALTER TABLE "session_summaries" ADD COLUMN IF NOT EXISTS "embedding_1536" vector(1536);
