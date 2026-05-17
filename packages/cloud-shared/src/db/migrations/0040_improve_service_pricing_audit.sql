CREATE INDEX IF NOT EXISTS "service_pricing_audit_service_idx" ON "service_pricing_audit" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_pricing_audit_pricing_created_idx" ON "service_pricing_audit" USING btree ("service_pricing_id","created_at");--> statement-breakpoint
ALTER TABLE "service_pricing_audit" ADD COLUMN IF NOT EXISTS "ip_address" text;--> statement-breakpoint
ALTER TABLE "service_pricing_audit" ADD COLUMN IF NOT EXISTS "user_agent" text;
