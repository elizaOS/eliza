CREATE TABLE "billing_subscription_event_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "subscription_id" uuid NOT NULL,
  "stripe_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "stripe_object_type" text NOT NULL,
  "stripe_object_id" text NOT NULL,
  "livemode" boolean NOT NULL,
  "event_created_at" timestamp with time zone NOT NULL,
  "payload_digest" text NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "applied_subscription_revision" bigint,
  "disposition" text,
  "error_code" text,
  "processed_at" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "billing_subscription_event_receipts_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_event_receipts_subscription_tenant_fk" FOREIGN KEY ("subscription_id", "organization_id") REFERENCES "billing_subscriptions"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_event_receipts_revision_tenant_fk" FOREIGN KEY ("subscription_id", "organization_id", "applied_subscription_revision") REFERENCES "billing_subscription_revisions"("subscription_id", "organization_id", "revision") ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_event_receipts_event_shape_check" CHECK (stripe_event_id ~ '^evt_[A-Za-z0-9]+$' AND length(btrim(event_type)) > 0 AND ((stripe_object_type = 'subscription' AND stripe_object_id ~ '^sub_[A-Za-z0-9]+$') OR (stripe_object_type = 'invoice' AND stripe_object_id ~ '^in_[A-Za-z0-9]+$')) AND payload_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscription_event_receipts_progress_check" CHECK (attempt_count >= 0 AND (lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT "billing_subscription_event_receipts_status_shape_check" CHECK (
    (status = 'received' AND lease_token IS NULL AND applied_subscription_revision IS NULL AND disposition IS NULL AND error_code IS NULL AND processed_at IS NULL)
    OR (status = 'processing' AND lease_token IS NOT NULL AND applied_subscription_revision IS NULL AND disposition IS NULL AND error_code IS NULL AND processed_at IS NULL)
    OR (status = 'applied' AND lease_token IS NULL AND applied_subscription_revision IS NOT NULL AND disposition IS NOT NULL AND error_code IS NULL AND processed_at IS NOT NULL)
    OR (status = 'ignored' AND lease_token IS NULL AND applied_subscription_revision IS NULL AND disposition IS NOT NULL AND error_code IS NULL AND processed_at IS NOT NULL)
    OR (status IN ('failed','quarantined') AND lease_token IS NULL AND applied_subscription_revision IS NULL AND error_code IS NOT NULL AND processed_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_event_receipts_id_org_idx" ON "billing_subscription_event_receipts" ("id", "organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscription_event_receipts_event_idx" ON "billing_subscription_event_receipts" ("stripe_event_id");
--> statement-breakpoint
CREATE INDEX "billing_subscription_event_receipts_status_lease_idx" ON "billing_subscription_event_receipts" ("status", "lease_expires_at");
--> statement-breakpoint
CREATE FUNCTION "guard_billing_subscription_event_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.organization_id, NEW.subscription_id, NEW.stripe_event_id, NEW.event_type,
    NEW.stripe_object_type, NEW.stripe_object_id, NEW.livemode, NEW.event_created_at,
    NEW.payload_digest)
    IS DISTINCT FROM
    ROW(OLD.organization_id, OLD.subscription_id, OLD.stripe_event_id, OLD.event_type,
    OLD.stripe_object_type, OLD.stripe_object_id, OLD.livemode, OLD.event_created_at,
    OLD.payload_digest)
  THEN
    RAISE EXCEPTION 'subscription event identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'billing_subscription_event_receipts_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "billing_subscription_event_receipts_identity_guard"
BEFORE UPDATE ON "billing_subscription_event_receipts"
FOR EACH ROW EXECUTE FUNCTION "guard_billing_subscription_event_identity"();
