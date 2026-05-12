ALTER TABLE "generations" ADD COLUMN IF NOT EXISTS "is_public" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generations_is_public_idx" ON "generations" USING btree ("is_public") WHERE "is_public" = true;
