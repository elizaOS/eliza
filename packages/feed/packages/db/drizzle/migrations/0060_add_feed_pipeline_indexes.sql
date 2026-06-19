-- Expression indexes for the lower(trim(...)) join between questions and markets.
-- These joins run 3x per feed build and cause full table scans without indexes.
-- Note: Using blocking CREATE INDEX (not CONCURRENTLY) — acceptable while
-- Question/Market/Post tables are <100k rows. Rewrite with CONCURRENTLY
-- (in a manual out-of-transaction migration) before tables exceed that threshold.
CREATE INDEX IF NOT EXISTS idx_questions_text_lower_trim
  ON "Question" (lower(trim(text)));

CREATE INDEX IF NOT EXISTS idx_markets_question_lower_trim
  ON "Market" (lower(trim(question)));

-- Partial composite index for the discovery candidates query which scans
-- non-deleted posts in a 14-30 day window ordered by engagement.
CREATE INDEX IF NOT EXISTS idx_posts_active_timestamp
  ON "Post" ("timestamp" DESC)
  WHERE "deletedAt" IS NULL
    AND "commentOnPostId" IS NULL
    AND "parentCommentId" IS NULL;
