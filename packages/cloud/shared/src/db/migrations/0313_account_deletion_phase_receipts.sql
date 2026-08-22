-- Adds generation-fenced saga phase receipts without raw provider identifiers.

CREATE TABLE "account_deletion_phase_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "phase" text NOT NULL,
  "phase_order" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "lease_generation" bigint DEFAULT 0 NOT NULL,
  "lease_owner_digest" text,
  "lease_expires_at" timestamp,
  "idempotency_key_digest" text NOT NULL,
  "provider_operation_digest" text,
  "provider_receipt_digest" text,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 12 NOT NULL,
  "retry_class" text,
  "next_attempt_at" timestamp,
  "before_provider_call_at" timestamp,
  "provider_acknowledged_at" timestamp,
  "reconciled_at" timestamp,
  "completed_at" timestamp,
  "last_error_code" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "account_deletion_phase_receipts_request_phase_unique" UNIQUE("request_id", "phase"),
  CONSTRAINT "account_deletion_phase_receipts_status_check"
    CHECK ("status" IN ('pending', 'leased', 'calling', 'reconciling', 'retry',
      'completed', 'canceled', 'action_required')),
  CONSTRAINT "account_deletion_phase_receipts_attempt_check"
    CHECK ("phase_order" >= 0 AND "attempt_count" >= 0 AND "max_attempts" > 0
      AND "lease_generation" >= 0)
);
ALTER TABLE "account_deletion_phase_receipts" ADD CONSTRAINT
  "account_deletion_phase_receipts_request_id_account_deletion_requests_id_fk"
  FOREIGN KEY ("request_id") REFERENCES "public"."account_deletion_requests"("id")
  ON DELETE cascade ON UPDATE no action;
CREATE INDEX "account_deletion_phase_receipts_work_idx"
  ON "account_deletion_phase_receipts" USING btree ("status", "next_attempt_at");
