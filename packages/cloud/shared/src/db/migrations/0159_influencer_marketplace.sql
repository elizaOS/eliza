-- Influencer marketing marketplace (#10687).
--
-- influencer_profiles — creator-published profile (reach/niche/rate card).
-- influencer_bookings  — advertiser⇄influencer escrowed offer; money moves are
--                        gated by the booking.status CAS in the service.
-- Additive: CREATE ... IF NOT EXISTS, inline FKs, no backfill.

CREATE TABLE IF NOT EXISTS "influencer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"display_name" text NOT NULL,
	"niche" text,
	"bio" text,
	"platforms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rate_card" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "influencer_profiles_user_idx" ON "influencer_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "influencer_profiles_org_idx" ON "influencer_profiles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "influencer_profiles_status_idx" ON "influencer_profiles" USING btree ("status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "influencer_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"advertiser_org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"influencer_profile_id" uuid NOT NULL REFERENCES "influencer_profiles"("id") ON DELETE CASCADE,
	"influencer_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"brief" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"deliverable_url" text,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "influencer_bookings_advertiser_idx" ON "influencer_bookings" USING btree ("advertiser_org_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "influencer_bookings_profile_idx" ON "influencer_bookings" USING btree ("influencer_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "influencer_bookings_status_idx" ON "influencer_bookings" USING btree ("status");
