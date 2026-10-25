-- Shareable campaign performance reports (#11600).
--
-- Token bytes are returned once to the creator; only a SHA-256 hash is stored.
-- Public report reads fail closed when the row is revoked or expired.

CREATE TABLE IF NOT EXISTS "ad_report_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"campaign_id" uuid NOT NULL REFERENCES "ad_campaigns"("id") ON DELETE CASCADE,
	"token_hash" text NOT NULL UNIQUE,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_report_shares_campaign_idx" ON "ad_report_shares" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_report_shares_org_idx" ON "ad_report_shares" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_report_shares_token_hash_idx" ON "ad_report_shares" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_report_shares_status_idx" ON "ad_report_shares" USING btree ("status");
