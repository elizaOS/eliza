-- Durable invocation receipts for the managed-agent billing scheduler.
CREATE TABLE IF NOT EXISTS "agent_billing_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "invocation_key" text NOT NULL,
  "trigger_kind" text NOT NULL,
  "schedule" text,
  "scheduled_at" timestamptz,
  "status" text DEFAULT 'started' NOT NULL,
  "started_at" timestamptz DEFAULT now() NOT NULL,
  "billing_cutoff_at" timestamptz DEFAULT now() NOT NULL,
  "attempt_count" integer DEFAULT 1 NOT NULL,
  "lease_token" uuid NOT NULL,
  "lease_expires_at" timestamptz,
  "completed_at" timestamptz,
  "sandboxes_processed" integer DEFAULT 0 NOT NULL,
  "sandboxes_billed" integer DEFAULT 0 NOT NULL,
  "warnings_sent" integer DEFAULT 0 NOT NULL,
  "sandboxes_shutdown" integer DEFAULT 0 NOT NULL,
  "errors" integer DEFAULT 0 NOT NULL,
  "total_revenue" numeric(16,6) DEFAULT '0' NOT NULL,
  "duration_ms" bigint,
  "error_samples" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "agent_billing_runs_trigger_check" CHECK ("trigger_kind" IN ('scheduled', 'manual')),
  CONSTRAINT "agent_billing_runs_status_check" CHECK ("status" IN ('started', 'empty', 'succeeded', 'partial_failure', 'failed')),
  CONSTRAINT "agent_billing_runs_scheduled_identity_check" CHECK (("trigger_kind" = 'scheduled' AND "schedule" IS NOT NULL AND "scheduled_at" IS NOT NULL)
      OR ("trigger_kind" = 'manual' AND "schedule" IS NULL AND "scheduled_at" IS NULL)),
  CONSTRAINT "agent_billing_runs_identity_length_check" CHECK (char_length("invocation_key") BETWEEN 1 AND 512
      AND ("schedule" IS NULL OR char_length("schedule") BETWEEN 1 AND 64)),
  CONSTRAINT "agent_billing_runs_terminal_timestamp_check" CHECK (("status" = 'started' AND "completed_at" IS NULL
        AND "duration_ms" IS NULL AND "lease_expires_at" IS NOT NULL
        AND "lease_expires_at" > "updated_at")
      OR ("status" <> 'started' AND "completed_at" IS NOT NULL
        AND "completed_at" >= "started_at" AND "duration_ms" IS NOT NULL
        AND "duration_ms" = floor(extract(epoch from
          ("completed_at" - "started_at")) * 1000)::bigint
        AND "lease_expires_at" IS NULL)),
  CONSTRAINT "agent_billing_runs_nonnegative_counters_check" CHECK ("sandboxes_processed" >= 0
      AND "attempt_count" >= 1
      AND "sandboxes_billed" >= 0
      AND "warnings_sent" >= 0
      AND "sandboxes_shutdown" >= 0
      AND "errors" >= 0
      AND "total_revenue" >= 0
      AND ("duration_ms" IS NULL OR "duration_ms" >= 0)),
  CONSTRAINT "agent_billing_runs_outcome_counters_check" CHECK ("sandboxes_billed" + "warnings_sent" + "sandboxes_shutdown"
        <= "sandboxes_processed"
      AND ("status" <> 'empty' OR (
        "sandboxes_processed" = 0 AND "sandboxes_billed" = 0
        AND "warnings_sent" = 0 AND "sandboxes_shutdown" = 0
        AND "errors" = 0 AND "total_revenue" = 0
      ))
      AND ("status" <> 'succeeded' OR (
        "sandboxes_processed" > 0 AND "errors" = 0
      ))
      AND ("status" <> 'partial_failure' OR (
        "errors" > 0 AND "sandboxes_processed" > "errors"
        AND "sandboxes_billed" + "warnings_sent" + "sandboxes_shutdown" + "errors"
          <= "sandboxes_processed"
      ))
      AND ("status" <> 'failed' OR "errors" > 0)),
  CONSTRAINT "agent_billing_runs_error_samples_check" CHECK (jsonb_typeof("error_samples") = 'array'
    AND jsonb_array_length("error_samples") <= 20)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_billing_runs_invocation_key_idx" ON "agent_billing_runs" ("invocation_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_billing_runs_scheduled_at_idx" ON "agent_billing_runs" ("scheduled_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_billing_run_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "agent_billing_runs"("id") ON DELETE CASCADE,
  "sandbox_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "agent_name" text NOT NULL,
  "action" text NOT NULL,
  "amount" numeric(16,6) DEFAULT '0' NOT NULL,
  "new_balance" numeric(16,6),
  "transaction_id" text,
  "detail_code" text,
  "detail_message" text,
  "completed_at" timestamptz DEFAULT now() NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "agent_billing_run_items_action_check" CHECK ("action" IN ('billed', 'warning_sent', 'shutdown', 'skipped', 'error')),
  CONSTRAINT "agent_billing_run_items_financial_evidence_check" CHECK (("action" = 'billed' AND "transaction_id" IS NOT NULL
        AND "new_balance" IS NOT NULL AND "amount" >= 0)
      OR ("action" <> 'billed' AND "transaction_id" IS NULL
        AND "new_balance" IS NULL AND "amount" = 0)),
  CONSTRAINT "agent_billing_run_items_detail_bounds_check" CHECK (("detail_code" IS NULL OR char_length("detail_code") BETWEEN 1 AND 64)
      AND ("detail_message" IS NULL OR char_length("detail_message") BETWEEN 1 AND 240)
      AND ("action" <> 'error'
        OR ("detail_code" IS NOT NULL AND "detail_message" IS NOT NULL)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_billing_run_items_run_sandbox_idx" ON "agent_billing_run_items" ("run_id", "sandbox_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_billing_run_items_run_idx" ON "agent_billing_run_items" ("run_id");
