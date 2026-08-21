CREATE TABLE "subscription_billing_fences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "subscription_id" uuid NOT NULL,
  "state" text DEFAULT 'open' NOT NULL,
  "fence_revision" bigint DEFAULT 1 NOT NULL,
  "provider_object_version" bigint NOT NULL,
  "provider_event_id" text,
  "provider_event_created_at" timestamp with time zone,
  "provider_object_digest" text NOT NULL,
  "deletion_requested_at" timestamp with time zone,
  "provider_deleted_at" timestamp with time zone,
  "released_at" timestamp with time zone,
  "last_reconciled_at" timestamp with time zone,
  "next_reconcile_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "subscription_billing_fences_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_billing_fences_subscription_tenant_fk" FOREIGN KEY ("subscription_id", "organization_id") REFERENCES "billing_subscriptions"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_billing_fences_provider_fence_check" CHECK (fence_revision > 0 AND provider_object_version >= 0 AND (provider_event_id IS NULL) = (provider_event_created_at IS NULL) AND (provider_event_id IS NULL OR provider_event_id ~ '^evt_[A-Za-z0-9]+$') AND provider_object_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "subscription_billing_fences_state_shape_check" CHECK (
    (state = 'open' AND deletion_requested_at IS NULL AND provider_deleted_at IS NULL AND released_at IS NULL)
    OR (state = 'deletion_requested' AND deletion_requested_at IS NOT NULL AND provider_deleted_at IS NULL AND released_at IS NULL)
    OR (state = 'provider_deleted' AND deletion_requested_at IS NOT NULL AND provider_deleted_at IS NOT NULL AND released_at IS NULL)
    OR (state = 'released' AND deletion_requested_at IS NOT NULL AND provider_deleted_at IS NOT NULL AND released_at IS NOT NULL)
    OR (state = 'quarantined' AND released_at IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_billing_fences_id_org_idx" ON "subscription_billing_fences" ("id", "organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_billing_fences_subscription_idx" ON "subscription_billing_fences" ("subscription_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_billing_fences_provider_event_idx" ON "subscription_billing_fences" ("provider_event_id") WHERE "provider_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "subscription_billing_fences_state_reconcile_idx" ON "subscription_billing_fences" ("state", "next_reconcile_at");
--> statement-breakpoint
CREATE FUNCTION "guard_subscription_billing_fence_advance"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.subscription_id <> OLD.subscription_id THEN
    RAISE EXCEPTION 'subscription billing fence tenant identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_billing_fences_identity_immutable';
  END IF;
  IF NEW.fence_revision <= OLD.fence_revision OR NEW.provider_object_version < OLD.provider_object_version THEN
    RAISE EXCEPTION 'subscription billing fence revisions must advance monotonically'
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_billing_fences_monotonic';
  END IF;
  IF (OLD.state = 'open' AND NEW.state NOT IN ('open','deletion_requested','quarantined'))
    OR (OLD.state = 'deletion_requested' AND NEW.state NOT IN ('deletion_requested','provider_deleted','quarantined'))
    OR (OLD.state = 'provider_deleted' AND NEW.state NOT IN ('provider_deleted','released','quarantined'))
    OR (OLD.state = 'released' AND NEW.state <> 'released')
    OR (OLD.state = 'quarantined' AND NEW.state NOT IN ('quarantined','deletion_requested','provider_deleted','released'))
  THEN
    RAISE EXCEPTION 'subscription billing fence state transition is invalid'
      USING ERRCODE = '23514', CONSTRAINT = 'subscription_billing_fences_state_transition';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "subscription_billing_fences_advance_guard"
BEFORE UPDATE ON "subscription_billing_fences"
FOR EACH ROW EXECUTE FUNCTION "guard_subscription_billing_fence_advance"();
