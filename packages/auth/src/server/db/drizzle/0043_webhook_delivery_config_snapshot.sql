ALTER TABLE "webhook_deliveries"
ADD COLUMN IF NOT EXISTS "webhook_config_id" uuid REFERENCES "webhook_configs"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries"
ADD COLUMN IF NOT EXISTS "secret" text;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries"
ADD COLUMN IF NOT EXISTS "events" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_webhook_config_idx"
ON "webhook_deliveries" USING btree ("webhook_config_id");
