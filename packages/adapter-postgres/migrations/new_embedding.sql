-- Drop existing index if it exists
DROP INDEX IF EXISTS memories_embedding_idx;

-- First, clear existing embeddings (since we can't convert dimensions automatically)
UPDATE memories SET embedding = NULL;

-- Now alter the column type
ALTER TABLE memories
ALTER COLUMN embedding TYPE vector(768);

-- Recreate the index
CREATE INDEX memories_embedding_idx ON memories
USING ivfflat (embedding vector_cosine_ops);