ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "execution_attempt_id" uuid;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "execution_provider" text;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "provider_idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "execution_claimed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "dispatch_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "provider_receipt" jsonb;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "execution_error" text;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "reconciliation_resolved_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "reconciliation_resolved_by" text;
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN IF NOT EXISTS "reconciliation_reason" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_requests_subject_id_idx"
  ON "approval_requests" ("agent_id", "subject_user_id", "id");
