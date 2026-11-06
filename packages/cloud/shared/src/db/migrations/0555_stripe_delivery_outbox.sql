-- Every verified Stripe delivery is recorded as work in its own dedupe row, in
-- the same insert, so a 200 to Stripe always means the work is durable.
ALTER TABLE "webhook_events"
 ADD COLUMN IF NOT EXISTS "delivery_payload" jsonb,
 ADD COLUMN IF NOT EXISTS "delivery_attempts" integer DEFAULT 0 NOT NULL,
 ADD COLUMN IF NOT EXISTS "delivery_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
 ADD COLUMN IF NOT EXISTS "delivery_lease_token" uuid,
 ADD COLUMN IF NOT EXISTS "delivery_lease_expires_at" timestamp with time zone,
 ADD COLUMN IF NOT EXISTS "delivery_completed_at" timestamp with time zone,
 ADD COLUMN IF NOT EXISTS "delivery_dead_lettered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_delivery_lease_check" CHECK (("delivery_lease_token" IS NULL) = ("delivery_lease_expires_at" IS NULL));
