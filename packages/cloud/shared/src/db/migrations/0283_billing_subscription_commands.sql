CREATE TABLE "billing_subscription_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "subscription_id" uuid NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "target_plan_key" text,
  "expected_subscription_revision" bigint NOT NULL,
  "idempotency_key" text NOT NULL,
  "stripe_idempotency_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "provider_started_at" timestamp with time zone,
  "provider_response_digest" text,
  "error_code" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_subscription_commands_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_commands_user_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_commands_subscription_tenant_fk" FOREIGN KEY ("subscription_id", "organization_id") REFERENCES "billing_subscriptions"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_commands_intent_check" CHECK ((kind IN ('upgrade','downgrade') AND target_plan_key IN ('plus_monthly','pro_monthly')) OR (kind IN ('cancel','resume') AND target_plan_key IS NULL)),
  CONSTRAINT "billing_subscription_commands_idempotency_check" CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND stripe_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$' AND request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscription_commands_revision_check" CHECK (expected_subscription_revision > 0 AND attempt_count >= 0),
  CONSTRAINT "billing_subscription_commands_lease_check" CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT "billing_subscription_commands_provider_digest_check" CHECK (provider_response_digest IS NULL OR provider_response_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscription_commands_status_shape_check" CHECK (
    (status = 'queued' AND lease_token IS NULL AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NULL AND completed_at IS NULL)
    OR (status = 'processing' AND lease_token IS NOT NULL AND error_code IS NULL AND completed_at IS NULL)
    OR (status = 'provider_ambiguous' AND lease_token IS NULL AND provider_started_at IS NOT NULL AND provider_response_digest IS NULL AND error_code IS NOT NULL AND completed_at IS NULL)
    OR (status = 'succeeded' AND lease_token IS NULL AND provider_started_at IS NOT NULL AND provider_response_digest IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND lease_token IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'superseded' AND lease_token IS NULL AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_commands_id_org_idx" ON "billing_subscription_commands" ("id", "organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_commands_org_idempotency_idx" ON "billing_subscription_commands" ("organization_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_commands_stripe_idempotency_idx" ON "billing_subscription_commands" ("stripe_idempotency_key");
--> statement-breakpoint
CREATE INDEX "billing_subscription_commands_status_lease_idx" ON "billing_subscription_commands" ("status", "lease_expires_at");
--> statement-breakpoint
CREATE INDEX "billing_subscription_commands_org_created_idx" ON "billing_subscription_commands" ("organization_id", "created_at");
--> statement-breakpoint
CREATE FUNCTION "guard_billing_subscription_command_intent"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.organization_id, NEW.subscription_id, NEW.requested_by_user_id, NEW.kind,
    NEW.target_plan_key, NEW.expected_subscription_revision, NEW.idempotency_key,
    NEW.stripe_idempotency_key, NEW.request_digest)
    IS DISTINCT FROM
    ROW(OLD.organization_id, OLD.subscription_id, OLD.requested_by_user_id, OLD.kind,
    OLD.target_plan_key, OLD.expected_subscription_revision, OLD.idempotency_key,
    OLD.stripe_idempotency_key, OLD.request_digest)
  THEN
    RAISE EXCEPTION 'subscription command intent is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'billing_subscription_commands_intent_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "billing_subscription_commands_intent_guard"
BEFORE UPDATE ON "billing_subscription_commands"
FOR EACH ROW EXECUTE FUNCTION "guard_billing_subscription_command_intent"();
