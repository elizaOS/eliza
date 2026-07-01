-- Ad Inventory / SSP (#10687): miniapps as ad publishers.
--
-- ad_slots       — a publisher-owned placement (app surface) with a floor CPM.
-- ad_slot_events — impression/click log; (impression_id, type) is unique, the
--                  exactly-once gate for revenue movement.
-- Additive: CREATE ... IF NOT EXISTS, inline FKs, no backfill.

CREATE TABLE IF NOT EXISTS "ad_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"floor_cpm" numeric(10, 4) DEFAULT '1.0000' NOT NULL,
	"total_impressions" integer DEFAULT 0 NOT NULL,
	"total_clicks" integer DEFAULT 0 NOT NULL,
	"total_revenue" numeric(12, 6) DEFAULT '0.000000' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_slots_app_idx" ON "ad_slots" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_slots_org_idx" ON "ad_slots" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_slots_status_idx" ON "ad_slots" USING btree ("status");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ad_slot_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot_id" uuid NOT NULL REFERENCES "ad_slots"("id") ON DELETE CASCADE,
	"campaign_id" uuid REFERENCES "ad_campaigns"("id") ON DELETE SET NULL,
	"creative_id" uuid REFERENCES "ad_creatives"("id") ON DELETE SET NULL,
	"type" text NOT NULL,
	"impression_id" text NOT NULL,
	"revenue" numeric(12, 6) DEFAULT '0.000000' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_slot_events_slot_idx" ON "ad_slot_events" USING btree ("slot_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_slot_events_campaign_idx" ON "ad_slot_events" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ad_slot_events_impression_type_idx" ON "ad_slot_events" USING btree ("impression_id","type");
