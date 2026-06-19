-- HNSW cosine-distance indexes for the active vector columns.
-- OpenAI embeddings (text-embedding-3-small / -large) and most modern open
-- models normalize on cosine similarity, so vector_cosine_ops is the correct
-- operator class for the <=> distance operator.
CREATE INDEX IF NOT EXISTS "long_term_memories_emb384_hnsw"
  ON "long_term_memories" USING hnsw ("embedding_384" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "long_term_memories_emb1536_hnsw"
  ON "long_term_memories" USING hnsw ("embedding_1536" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "session_summaries_emb384_hnsw"
  ON "session_summaries" USING hnsw ("embedding_384" vector_cosine_ops);

CREATE INDEX IF NOT EXISTS "session_summaries_emb1536_hnsw"
  ON "session_summaries" USING hnsw ("embedding_1536" vector_cosine_ops);
