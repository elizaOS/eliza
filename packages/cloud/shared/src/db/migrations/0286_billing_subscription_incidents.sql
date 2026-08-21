CREATE TABLE "billing_subscription_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "subscription_id" uuid NOT NULL,
  "command_id" uuid,
  "event_receipt_id" uuid,
  "kind" text NOT NULL,
  "severity" text NOT NULL,
  "fingerprint" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "occurrence_count" integer DEFAULT 1 NOT NULL,
  "context" jsonb NOT NULL,
  "first_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "next_retry_at" timestamp with time zone,
  "resolved_by_user_id" uuid,
  "resolution" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_subscription_incidents_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_incidents_resolved_user_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_incidents_subscription_tenant_fk" FOREIGN KEY ("subscription_id", "organization_id") REFERENCES "billing_subscriptions"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_incidents_command_tenant_fk" FOREIGN KEY ("command_id", "organization_id") REFERENCES "billing_subscription_commands"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_incidents_receipt_tenant_fk" FOREIGN KEY ("event_receipt_id", "organization_id") REFERENCES "billing_subscription_event_receipts"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_incidents_vocabulary_check" CHECK (kind IN ('provider_unavailable','provider_timeout','provider_drift','command_ambiguous','event_processing','reconciliation','deletion_fence') AND severity IN ('warning','error','critical') AND status IN ('open','resolved')),
  CONSTRAINT "billing_subscription_incidents_fingerprint_check" CHECK (fingerprint ~ '^[0-9a-f]{64}$' AND occurrence_count > 0 AND last_observed_at >= first_observed_at),
  CONSTRAINT "billing_subscription_incidents_resolution_shape_check" CHECK ((status = 'open' AND resolved_by_user_id IS NULL AND resolution IS NULL AND resolved_at IS NULL) OR (status = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_incidents_id_org_idx" ON "billing_subscription_incidents" ("id", "organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_incidents_open_fingerprint_idx" ON "billing_subscription_incidents" ("organization_id", "subscription_id", "fingerprint") WHERE "status" = 'open';
--> statement-breakpoint
CREATE INDEX "billing_subscription_incidents_status_retry_idx" ON "billing_subscription_incidents" ("status", "next_retry_at");
