CREATE TABLE "billing_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "stripe_subscription_id" text NOT NULL,
  "stripe_subscription_item_id" text NOT NULL,
  "plan_key" text NOT NULL,
  "catalog_version" text NOT NULL,
  "status" text NOT NULL,
  "current_period_start" timestamptz NOT NULL,
  "current_period_end" timestamptz NOT NULL,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "canceled_at" timestamptz,
  "ended_at" timestamptz,
  "dunning_started_at" timestamptz,
  "grace_expires_at" timestamptz,
  "pending_plan_key" text,
  "lifecycle_revision" bigint NOT NULL,
  "provider_object_version" bigint NOT NULL,
  "provider_event_id" text,
  "provider_event_created_at" timestamptz,
  "provider_object_digest" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_subscriptions_status_check" CHECK (status IN ('pending','active','grace','past_due','unpaid','canceled','incomplete_expired')),
  CONSTRAINT "billing_subscriptions_plan_check" CHECK (plan_key IN ('plus_monthly','pro_monthly') AND (pending_plan_key IS NULL OR pending_plan_key IN ('plus_monthly','pro_monthly')) AND length(btrim(catalog_version)) > 0),
  CONSTRAINT "billing_subscriptions_provider_id_check" CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$' AND stripe_subscription_item_id ~ '^si_[A-Za-z0-9]+$' AND (provider_event_id IS NULL OR provider_event_id ~ '^evt_[A-Za-z0-9]+$')),
  CONSTRAINT "billing_subscriptions_revision_check" CHECK (lifecycle_revision > 0 AND provider_object_version >= 0),
  CONSTRAINT "billing_subscriptions_period_check" CHECK (current_period_end > current_period_start),
  CONSTRAINT "billing_subscriptions_provider_fence_check" CHECK ((provider_event_id IS NULL) = (provider_event_created_at IS NULL) AND provider_object_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscriptions_dunning_check" CHECK (grace_expires_at IS NULL OR (dunning_started_at IS NOT NULL AND grace_expires_at > dunning_started_at)),
  CONSTRAINT "billing_subscriptions_pending_plan_check" CHECK (pending_plan_key IS NULL OR pending_plan_key <> plan_key)
);
CREATE UNIQUE INDEX "billing_subscriptions_id_org_idx" ON "billing_subscriptions" (id, organization_id);
CREATE UNIQUE INDEX "billing_subscriptions_stripe_subscription_idx" ON "billing_subscriptions" (stripe_subscription_id);
CREATE UNIQUE INDEX "billing_subscriptions_stripe_item_idx" ON "billing_subscriptions" (stripe_subscription_item_id);
CREATE UNIQUE INDEX "billing_subscriptions_provider_event_idx" ON "billing_subscriptions" (provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX "billing_subscriptions_live_org_idx" ON "billing_subscriptions" (organization_id) WHERE status IN ('pending','active','grace','past_due','unpaid');
CREATE INDEX "billing_subscriptions_org_updated_idx" ON "billing_subscriptions" (organization_id, updated_at);
--> statement-breakpoint
CREATE TABLE "billing_subscription_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "subscription_id" uuid NOT NULL,
  "revision" bigint NOT NULL,
  "source" text NOT NULL,
  "stripe_subscription_id" text NOT NULL,
  "stripe_subscription_item_id" text NOT NULL,
  "plan_key" text NOT NULL,
  "catalog_version" text NOT NULL,
  "status" text NOT NULL,
  "current_period_start" timestamptz NOT NULL,
  "current_period_end" timestamptz NOT NULL,
  "cancel_at_period_end" boolean NOT NULL,
  "canceled_at" timestamptz,
  "ended_at" timestamptz,
  "dunning_started_at" timestamptz,
  "grace_expires_at" timestamptz,
  "pending_plan_key" text,
  "provider_object_version" bigint NOT NULL,
  "provider_event_id" text,
  "provider_event_created_at" timestamptz,
  "provider_object_digest" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_subscription_revisions_subscription_tenant_fk" FOREIGN KEY (subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_revisions_source_check" CHECK (source IN ('checkout','webhook','reconciliation','backfill','admin')),
  CONSTRAINT "billing_subscription_revisions_status_check" CHECK (status IN ('pending','active','grace','past_due','unpaid','canceled','incomplete_expired')),
  CONSTRAINT "billing_subscription_revisions_plan_check" CHECK (plan_key IN ('plus_monthly','pro_monthly') AND (pending_plan_key IS NULL OR pending_plan_key IN ('plus_monthly','pro_monthly')) AND (pending_plan_key IS NULL OR pending_plan_key <> plan_key) AND length(btrim(catalog_version)) > 0),
  CONSTRAINT "billing_subscription_revisions_provider_id_check" CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$' AND stripe_subscription_item_id ~ '^si_[A-Za-z0-9]+$' AND (provider_event_id IS NULL OR provider_event_id ~ '^evt_[A-Za-z0-9]+$')),
  CONSTRAINT "billing_subscription_revisions_revision_check" CHECK (revision > 0 AND provider_object_version >= 0),
  CONSTRAINT "billing_subscription_revisions_period_check" CHECK (current_period_end > current_period_start),
  CONSTRAINT "billing_subscription_revisions_provider_fence_check" CHECK ((provider_event_id IS NULL) = (provider_event_created_at IS NULL) AND provider_object_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscription_revisions_dunning_check" CHECK (grace_expires_at IS NULL OR (dunning_started_at IS NOT NULL AND grace_expires_at > dunning_started_at))
);
CREATE UNIQUE INDEX "billing_subscription_revisions_id_org_idx" ON "billing_subscription_revisions" (id, organization_id);
CREATE UNIQUE INDEX "billing_subscription_revisions_revision_idx" ON "billing_subscription_revisions" (subscription_id, revision);
CREATE UNIQUE INDEX "billing_subscription_revisions_subscription_org_revision_idx" ON "billing_subscription_revisions" (subscription_id, organization_id, revision);
CREATE UNIQUE INDEX "billing_subscription_revisions_provider_event_idx" ON "billing_subscription_revisions" (provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX "billing_subscription_revisions_provider_version_idx" ON "billing_subscription_revisions" (subscription_id, provider_object_version);
CREATE INDEX "billing_subscription_revisions_org_recorded_idx" ON "billing_subscription_revisions" (organization_id, recorded_at);
CREATE FUNCTION "reject_subscription_revision_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'subscription lifecycle revisions are append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER "billing_subscription_revisions_immutable_guard" BEFORE UPDATE OR DELETE ON "billing_subscription_revisions" FOR EACH ROW EXECUTE FUNCTION "reject_subscription_revision_mutation"();
