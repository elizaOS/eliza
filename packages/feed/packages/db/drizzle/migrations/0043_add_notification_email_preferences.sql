-- Add user notification email preferences (BAB-189)
-- Allows opt-in email notifications with granular delivery controls

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailNotificationsEnabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailNotificationsRealtime" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailNotificationsDailySummary" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailNotificationsWeeklySummary" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailNotificationsMonthlySummary" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailNotificationsUnsubscribedAt" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "User_emailNotificationsEnabled_idx" ON "User" USING btree ("emailNotificationsEnabled");
