CREATE TABLE IF NOT EXISTS "ai_billing_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "usage_record_id" uuid NOT NULL REFERENCES "usage_records"("id") ON DELETE cascade,
  "reservation_transaction_id" uuid REFERENCES "credit_transactions"("id") ON DELETE set null,
  "settlement_transaction_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_id" text,
  "provider" text NOT NULL,
  "model" text NOT NULL,
  "billing_source" text,
  "pricing_snapshot_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "provider_request_id" text,
  "provider_instance_id" text,
  "provider_endpoint" text,
  "usage_total_cost" numeric(12, 6) NOT NULL,
  "ledger_total" numeric(12, 6) NOT NULL,
  "status" text DEFAULT 'recorded' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "ai_billing_records_org_created_idx"
  ON "ai_billing_records" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "ai_billing_records_provider_model_idx"
  ON "ai_billing_records" ("provider", "model");
CREATE INDEX IF NOT EXISTS "ai_billing_records_provider_instance_idx"
  ON "ai_billing_records" ("provider_instance_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_billing_records_usage_record_unique"
  ON "ai_billing_records" ("usage_record_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ai_billing_records_org_idempotency_unique"
  ON "ai_billing_records" ("organization_id", "idempotency_key");

CREATE TABLE IF NOT EXISTS "analytics_alert_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "policy_id" text NOT NULL,
  "severity" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "source" text NOT NULL,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "dedupe_key" text NOT NULL,
  "evaluated_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "analytics_alert_events_org_created_idx"
  ON "analytics_alert_events" ("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "analytics_alert_events_org_status_idx"
  ON "analytics_alert_events" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "analytics_alert_events_severity_idx"
  ON "analytics_alert_events" ("severity");
CREATE UNIQUE INDEX IF NOT EXISTS "analytics_alert_events_org_dedupe_unique"
  ON "analytics_alert_events" ("organization_id", "dedupe_key");
