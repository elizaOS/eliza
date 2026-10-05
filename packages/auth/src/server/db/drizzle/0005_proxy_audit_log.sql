-- Proxy audit log table migration

CREATE TABLE IF NOT EXISTS "proxy_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "target_host" varchar(512) NOT NULL,
  "target_path" varchar(512) NOT NULL,
  "method" varchar(10) NOT NULL,
  "status_code" integer NOT NULL,
  "latency_ms" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "proxy_audit_log_tenant_idx" ON "proxy_audit_log" ("tenant_id");
CREATE INDEX IF NOT EXISTS "proxy_audit_log_agent_idx" ON "proxy_audit_log" ("agent_id");
CREATE INDEX IF NOT EXISTS "proxy_audit_log_created_at_idx" ON "proxy_audit_log" ("created_at");
