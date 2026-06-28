-- Drop the unused multi-dim embeddings side table.
-- Originally created in 0000_last_reavers.sql with vector(384), vector(512),
-- vector(768), vector(1024), vector(1536), vector(3072) columns. Verified by
-- repo-wide grep: no application code reads from, writes to, or references the
-- table or its dim_* columns. The active vector columns live on
-- long_term_memories and session_summaries (see 0090).
DROP TABLE IF EXISTS "embeddings";
