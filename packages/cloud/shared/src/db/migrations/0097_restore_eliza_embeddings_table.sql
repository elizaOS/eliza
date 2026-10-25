-- Restore the elizaOS plugin-sql embeddings side table.
-- Runtime creation still joins memories -> embeddings to detect available
-- vector dimensions, so dropping this table breaks runtime tests and local
-- agent startup even when the table is empty.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS "embeddings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "memory_id" uuid,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "dim_384" vector(384),
  "dim_512" vector(512),
  "dim_768" vector(768),
  "dim_1024" vector(1024),
  "dim_1536" vector(1536),
  "dim_3072" vector(3072)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'embedding_source_check'
  ) THEN
    ALTER TABLE "embeddings"
      ADD CONSTRAINT "embedding_source_check" CHECK ("memory_id" IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'embeddings_memory_id_memories_id_fk'
  ) THEN
    ALTER TABLE "embeddings"
      ADD CONSTRAINT "embeddings_memory_id_memories_id_fk"
      FOREIGN KEY ("memory_id") REFERENCES "public"."memories"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_embedding_memory" ON "embeddings" USING btree ("memory_id");
