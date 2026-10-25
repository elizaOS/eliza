-- #10732 — miniapp compliance-review gate + admin-approved USDC payouts.
--
-- Additive + idempotent. Two features:
--   (B) An automated binary (allow/ban) compliance-review gate for apps. Adds
--       `apps.review_status` (the monetization/charge gate, independent of
--       `is_approved` which stays the serve/visibility flag), a snapshot hash
--       for change-detection, and an append-only `app_reviews` audit table.
--       Existing apps are grandfathered to `approved` so nothing that monetizes
--       today breaks; new apps start in `draft` and must pass review.
--   (C) A `token_redemptions.asset` column so creator payouts can be USDC.
--       Existing rows are backfilled to `eliza` (the only asset paid so far);
--       new rows default to `usdc`.
--
-- Rollback (down):
--   ALTER TABLE "token_redemptions" DROP COLUMN IF EXISTS "asset";
--   DROP TABLE IF EXISTS "app_reviews";
--   ALTER TABLE "apps" DROP COLUMN IF EXISTS "reviewed_at";
--   ALTER TABLE "apps" DROP COLUMN IF EXISTS "review_content_hash";
--   ALTER TABLE "apps" DROP COLUMN IF EXISTS "review_status";
--   DROP TYPE IF EXISTS "redemption_asset";
--   DROP TYPE IF EXISTS "app_review_disposition";
--   DROP TYPE IF EXISTS "app_review_status";

DO $$ BEGIN
  CREATE TYPE "app_review_status" AS ENUM ('draft', 'submitted', 'under_review', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "app_review_disposition" AS ENUM ('allow', 'ban');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "redemption_asset" AS ENUM ('eliza', 'usdc');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "review_status" "app_review_status" DEFAULT 'draft' NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "review_content_hash" text;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp;
--> statement-breakpoint
-- Grandfather every existing app: it was live under the old `is_approved = true`
-- regime, so approve it. A NULL `review_content_hash` marks it as grandfathered
-- (enforcement treats that as approved-without-snapshot).
UPDATE "apps" SET "review_status" = 'approved', "reviewed_at" = now()
  WHERE "is_approved" = true AND "review_status" = 'draft';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"triggered_by_user_id" uuid,
	"disposition" "app_review_disposition" NOT NULL,
	"matched_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rationale" text NOT NULL,
	"pre_filter_matched" boolean DEFAULT false NOT NULL,
	"rubric_version" text NOT NULL,
	"model_provider" text,
	"model" text,
	"content_hash" text NOT NULL,
	"candidate_document" text NOT NULL,
	"trajectory_ref" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "app_reviews" ADD CONSTRAINT "app_reviews_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "app_reviews" ADD CONSTRAINT "app_reviews_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_reviews_app_idx" ON "app_reviews" ("app_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_reviews_app_created_idx" ON "app_reviews" ("app_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_reviews_disposition_idx" ON "app_reviews" ("disposition");
--> statement-breakpoint
-- Add USDC payout asset. Existing rows were all elizaOS-token payouts, so land
-- the column on 'eliza' first (backfill), then flip the default to 'usdc' for
-- new creator payouts.
ALTER TABLE "token_redemptions" ADD COLUMN IF NOT EXISTS "asset" "redemption_asset" DEFAULT 'eliza' NOT NULL;
--> statement-breakpoint
ALTER TABLE "token_redemptions" ALTER COLUMN "asset" SET DEFAULT 'usdc';
