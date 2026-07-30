ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_requests_agent_idempotency_uidx"
	ON "approval_requests" USING btree ("agent_id", "idempotency_key")
	WHERE "idempotency_key" IS NOT NULL;
