-- Cloud schema/journal drift: the plugin-sql embeddings schema declares
-- space_id, write_nonce, dim_2048, and the embedding_space_write_check
-- constraint, but the only journal entry creating the table (0097) predates
-- them and no later entry adds them. Databases built by replaying this
-- journal (CI lanes, staging, production) reject every whole-row embeddings
-- query with 42703 errorMissingColumn, and the declared check constraint
-- cannot exist while its referenced columns are missing.
ALTER TABLE "embeddings" ADD COLUMN "space_id" text;
--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "write_nonce" uuid;
--> statement-breakpoint
ALTER TABLE "embeddings" ADD COLUMN "dim_2048" vector(2048);
--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embedding_space_write_check" CHECK ("embeddings"."space_id" IS NULL OR "embeddings"."write_nonce" IS NOT NULL);
