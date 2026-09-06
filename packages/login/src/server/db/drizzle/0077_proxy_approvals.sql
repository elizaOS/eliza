-- Approval-gated credential proxy requests.

ALTER TABLE "secret_routes"
  ADD COLUMN IF NOT EXISTS "requires_approval" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "secret_routes"
  ADD COLUMN IF NOT EXISTS "approval_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "pending_proxy_request_status" AS ENUM (
    'pending',
    'approved',
    'denied',
    'executing',
    'executed',
    'expired',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_proxy_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "agent_id" varchar(64) NOT NULL,
  "route_id" uuid NOT NULL,
  "method" varchar(10) NOT NULL,
  "target_host" varchar(512) NOT NULL,
  "target_path" varchar(2048) NOT NULL,
  "request_digest" varchar(64) NOT NULL,
  "idempotency_key" varchar(255),
  "preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "safe_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "body_ciphertext" text NOT NULL,
  "body_iv" text NOT NULL,
  "body_auth_tag" text NOT NULL,
  "body_salt" text NOT NULL,
  "status" "pending_proxy_request_status" DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "approved_at" timestamp with time zone,
  "approved_by" varchar(255),
  "denied_at" timestamp with time zone,
  "denied_by" varchar(255),
  "denial_reason" text,
  "executed_at" timestamp with time zone,
  "execution_status_code" integer,
  "execution_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_proxy_requests_tenant_status_idx"
  ON "pending_proxy_requests" USING btree ("tenant_id","status","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_proxy_requests_agent_idx"
  ON "pending_proxy_requests" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_proxy_requests_route_idx"
  ON "pending_proxy_requests" USING btree ("route_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pending_proxy_requests_expires_at_idx"
  ON "pending_proxy_requests" USING btree ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pending_proxy_requests_idempotency_idx"
  ON "pending_proxy_requests" USING btree ("tenant_id","agent_id","idempotency_key");
