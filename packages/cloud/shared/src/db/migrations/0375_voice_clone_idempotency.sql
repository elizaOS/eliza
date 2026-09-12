ALTER TABLE "voice_cloning_jobs" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "voice_cloning_jobs" ADD COLUMN IF NOT EXISTS "request_digest" text;
--> statement-breakpoint
ALTER TABLE "voice_cloning_jobs" ADD COLUMN IF NOT EXISTS "response_payload" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "voice_cloning_jobs_tenant_idempotency_uidx"
  ON "voice_cloning_jobs" ("organization_id", "user_id", "idempotency_key");
