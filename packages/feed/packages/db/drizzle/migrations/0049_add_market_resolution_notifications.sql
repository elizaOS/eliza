ALTER TABLE "Notification"
ADD COLUMN IF NOT EXISTS "dedupeKey" text;
--> statement-breakpoint
ALTER TABLE "Notification"
ADD COLUMN IF NOT EXISTS "data" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_dedupeKey_unique" UNIQUE ("dedupeKey");
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "notificationDigestEnabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "notificationDigestFrequency" text DEFAULT 'daily' NOT NULL;
--> statement-breakpoint
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "notificationDigestDeliveryChannel" text DEFAULT 'both' NOT NULL;
--> statement-breakpoint
ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "notificationDigestLastSentAt" timestamp;
