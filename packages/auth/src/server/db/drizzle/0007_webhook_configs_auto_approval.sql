-- Webhook configuration table
CREATE TABLE IF NOT EXISTS "webhook_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "secret" text NOT NULL,
  "events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "max_retries" integer NOT NULL DEFAULT 5,
  "retry_backoff_ms" integer NOT NULL DEFAULT 60000,
  "description" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhook_configs_tenant_idx" ON "webhook_configs" USING btree ("tenant_id");

-- Auto-approval rules table (one per tenant)
CREATE TABLE IF NOT EXISTS "auto_approval_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "max_amount_wei" text NOT NULL DEFAULT '0',
  "auto_deny_after_hours" integer,
  "escalate_above_wei" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "auto_approval_rules_tenant_idx" ON "auto_approval_rules" USING btree ("tenant_id");
