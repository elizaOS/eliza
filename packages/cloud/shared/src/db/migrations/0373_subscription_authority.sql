CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "provider" text NOT NULL DEFAULT 'stripe', "provider_environment" text NOT NULL, "stripe_customer_id" text NOT NULL,
  "stripe_subscription_id" text NOT NULL, "stripe_subscription_item_id" text NOT NULL, "plan_key" text NOT NULL, "catalog_version" text NOT NULL,
  "status" text NOT NULL, "current_period_start" timestamptz NOT NULL, "current_period_end" timestamptz NOT NULL,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false, "canceled_at" timestamptz, "ended_at" timestamptz,
  "dunning_started_at" timestamptz, "grace_expires_at" timestamptz, "pending_plan_key" text, "lifecycle_revision" bigint NOT NULL,
  "last_provider_event_id" text, "last_provider_event_created_at" timestamptz, "provider_object_digest" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_subscriptions_status_check" CHECK (status IN ('pending','incomplete','active','grace','past_due','unpaid','canceled','incomplete_expired')),
  CONSTRAINT "billing_subscriptions_plan_check" CHECK (plan_key IN ('plus_monthly','pro_monthly') AND (pending_plan_key IS NULL OR pending_plan_key IN ('plus_monthly','pro_monthly')) AND length(btrim(catalog_version)) > 0),
  CONSTRAINT "billing_subscriptions_provider_id_check" CHECK (provider = 'stripe' AND provider_environment IN ('test','live') AND stripe_customer_id ~ '^cus_[A-Za-z0-9]+$' AND stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$' AND stripe_subscription_item_id ~ '^si_[A-Za-z0-9]+$' AND (last_provider_event_id IS NULL OR last_provider_event_id ~ '^evt_[A-Za-z0-9]+$')),
  CONSTRAINT "billing_subscriptions_revision_check" CHECK (lifecycle_revision > 0), CONSTRAINT "billing_subscriptions_period_check" CHECK (current_period_end > current_period_start),
  CONSTRAINT "billing_subscriptions_provider_fence_check" CHECK ((last_provider_event_id IS NULL) = (last_provider_event_created_at IS NULL) AND provider_object_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscriptions_dunning_check" CHECK ((grace_expires_at IS NULL) = (dunning_started_at IS NULL) AND (grace_expires_at IS NULL OR grace_expires_at > dunning_started_at)),
  CONSTRAINT "billing_subscriptions_pending_plan_check" CHECK (pending_plan_key IS NULL OR pending_plan_key <> plan_key)
);
CREATE UNIQUE INDEX "billing_subscriptions_id_org_idx" ON "billing_subscriptions" (id, organization_id);
CREATE UNIQUE INDEX "billing_subscriptions_stripe_subscription_idx" ON "billing_subscriptions" (provider, provider_environment, stripe_subscription_id);
CREATE UNIQUE INDEX "billing_subscriptions_stripe_item_idx" ON "billing_subscriptions" (provider, provider_environment, stripe_subscription_item_id);
CREATE UNIQUE INDEX "billing_subscriptions_live_org_idx" ON "billing_subscriptions" (organization_id) WHERE status IN ('pending','incomplete','active','grace','past_due','unpaid');
CREATE INDEX "billing_subscriptions_org_updated_idx" ON "billing_subscriptions" (organization_id, updated_at);
--> statement-breakpoint
CREATE TABLE "billing_subscription_revisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "subscription_id" uuid NOT NULL, "revision" bigint NOT NULL, "source" text NOT NULL, "provider" text NOT NULL DEFAULT 'stripe',
  "provider_environment" text NOT NULL, "stripe_customer_id" text NOT NULL, "stripe_subscription_id" text NOT NULL,
  "stripe_subscription_item_id" text NOT NULL, "plan_key" text NOT NULL, "catalog_version" text NOT NULL, "status" text NOT NULL,
  "current_period_start" timestamptz NOT NULL, "current_period_end" timestamptz NOT NULL, "cancel_at_period_end" boolean NOT NULL,
  "canceled_at" timestamptz, "ended_at" timestamptz, "dunning_started_at" timestamptz, "grace_expires_at" timestamptz,
  "pending_plan_key" text, "provider_event_id" text, "provider_event_created_at" timestamptz, "provider_object_digest" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_subscription_revisions_subscription_tenant_fk" FOREIGN KEY (subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_revisions_source_check" CHECK (source IN ('checkout','webhook','reconciliation','backfill','admin')),
  CONSTRAINT "billing_subscription_revisions_status_check" CHECK (status IN ('pending','incomplete','active','grace','past_due','unpaid','canceled','incomplete_expired')),
  CONSTRAINT "billing_subscription_revisions_plan_check" CHECK (plan_key IN ('plus_monthly','pro_monthly') AND (pending_plan_key IS NULL OR pending_plan_key IN ('plus_monthly','pro_monthly')) AND (pending_plan_key IS NULL OR pending_plan_key <> plan_key) AND length(btrim(catalog_version)) > 0),
  CONSTRAINT "billing_subscription_revisions_provider_id_check" CHECK (provider = 'stripe' AND provider_environment IN ('test','live') AND stripe_customer_id ~ '^cus_[A-Za-z0-9]+$' AND stripe_subscription_id ~ '^sub_[A-Za-z0-9]+$' AND stripe_subscription_item_id ~ '^si_[A-Za-z0-9]+$' AND (provider_event_id IS NULL OR provider_event_id ~ '^evt_[A-Za-z0-9]+$')),
  CONSTRAINT "billing_subscription_revisions_revision_check" CHECK (revision > 0), CONSTRAINT "billing_subscription_revisions_period_check" CHECK (current_period_end > current_period_start),
  CONSTRAINT "billing_subscription_revisions_provider_fence_check" CHECK ((provider_event_id IS NULL) = (provider_event_created_at IS NULL) AND provider_object_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscription_revisions_dunning_check" CHECK ((grace_expires_at IS NULL) = (dunning_started_at IS NULL) AND (grace_expires_at IS NULL OR grace_expires_at > dunning_started_at))
);
CREATE UNIQUE INDEX "billing_subscription_revisions_id_org_idx" ON "billing_subscription_revisions" (id, organization_id);
CREATE UNIQUE INDEX "billing_subscription_revisions_revision_idx" ON "billing_subscription_revisions" (subscription_id, revision);
CREATE UNIQUE INDEX "billing_subscription_revisions_subscription_org_revision_idx" ON "billing_subscription_revisions" (subscription_id, organization_id, revision);
CREATE UNIQUE INDEX "billing_subscription_revisions_provider_event_idx" ON "billing_subscription_revisions" (provider, provider_environment, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX "billing_subscription_revisions_org_recorded_idx" ON "billing_subscription_revisions" (organization_id, recorded_at);
--> statement-breakpoint
CREATE TABLE "organization_entitlements" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE, "plan_key" text NOT NULL, "state" text NOT NULL,
  "entitlement_effective" boolean NOT NULL, "effective_from" timestamptz NOT NULL, "effective_until" timestamptz,
  "completions_rpm" integer NOT NULL, "embeddings_rpm" integer NOT NULL, "standard_rpm" integer NOT NULL, "strict_rpm" integer NOT NULL,
  "cloud_characters_ceiling" integer, "agent_sandboxes_ceiling" integer, "containers_ceiling" integer, "storage_gib_ceiling" integer, "apps_ceiling" integer,
  "catalog_version" text NOT NULL, "projection_revision" bigint NOT NULL, "source_digest" text NOT NULL,
  "source_subscription_id" uuid, "source_subscription_revision" bigint, "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(), "rebuilt_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_entitlements_subscription_tenant_fk" FOREIGN KEY (source_subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "organization_entitlements_source_revision_tenant_fk" FOREIGN KEY (source_subscription_id, organization_id, source_subscription_revision) REFERENCES billing_subscription_revisions(subscription_id, organization_id, revision) ON DELETE RESTRICT,
  CONSTRAINT "organization_entitlements_plan_state_check" CHECK (plan_key IN ('free','plus_monthly','pro_monthly') AND state IN ('free','active','grace','past_due','unpaid') AND ((plan_key = 'free' AND state = 'free' AND entitlement_effective AND source_subscription_id IS NULL AND source_subscription_revision IS NULL) OR (plan_key <> 'free' AND state <> 'free' AND source_subscription_id IS NOT NULL AND source_subscription_revision IS NOT NULL AND (entitlement_effective = (state IN ('active','grace')))))),
  CONSTRAINT "organization_entitlements_effective_bounds_check" CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT "organization_entitlements_rates_check" CHECK (completions_rpm >= 0 AND embeddings_rpm >= 0 AND standard_rpm >= 0 AND strict_rpm >= 0),
  CONSTRAINT "organization_entitlements_ceilings_check" CHECK ((cloud_characters_ceiling IS NULL OR cloud_characters_ceiling >= 0) AND (agent_sandboxes_ceiling IS NULL OR agent_sandboxes_ceiling >= 0) AND (containers_ceiling IS NULL OR containers_ceiling >= 0) AND (storage_gib_ceiling IS NULL OR storage_gib_ceiling >= 0) AND (apps_ceiling IS NULL OR apps_ceiling >= 0)),
  CONSTRAINT "organization_entitlements_revisions_check" CHECK (projection_revision >= 0 AND (source_subscription_revision IS NULL OR source_subscription_revision > 0)),
  CONSTRAINT "organization_entitlements_catalog_version_check" CHECK (length(btrim(catalog_version)) > 0), CONSTRAINT "organization_entitlements_source_digest_check" CHECK (source_digest ~ '^[0-9a-f]{64}$')
);
INSERT INTO organization_entitlements (organization_id, plan_key, state, entitlement_effective, effective_from, completions_rpm, embeddings_rpm, standard_rpm, strict_rpm, cloud_characters_ceiling, agent_sandboxes_ceiling, containers_ceiling, storage_gib_ceiling, apps_ceiling, catalog_version, projection_revision, source_digest)
SELECT id, 'free', 'free', true, now(), 60, 100, 30, 5, 5, 5, 1, 5, 25, 'v1', 0, '79e8741542b6d430565b42253cb5afe09619c8e5764c545d4d19cab68fd1304b' FROM organizations;
CREATE FUNCTION seed_free_organization_entitlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO organization_entitlements (organization_id, plan_key, state, entitlement_effective, effective_from, completions_rpm, embeddings_rpm, standard_rpm, strict_rpm, cloud_characters_ceiling, agent_sandboxes_ceiling, containers_ceiling, storage_gib_ceiling, apps_ceiling, catalog_version, projection_revision, source_digest) VALUES (NEW.id, 'free', 'free', true, now(), 60, 100, 30, 5, 5, 5, 1, 5, 25, 'v1', 0, '79e8741542b6d430565b42253cb5afe09619c8e5764c545d4d19cab68fd1304b'); RETURN NEW; END $$;
CREATE TRIGGER "organizations_seed_free_entitlement" AFTER INSERT ON "organizations" FOR EACH ROW EXECUTE FUNCTION seed_free_organization_entitlement();
--> statement-breakpoint
CREATE TABLE "subscription_allowance_periods" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "subscription_id" uuid NOT NULL, "subscription_revision" bigint NOT NULL, "provider" text NOT NULL DEFAULT 'stripe', "provider_environment" text NOT NULL,
  "stripe_invoice_id" text NOT NULL, "plan_key" text NOT NULL, "catalog_version" text NOT NULL, "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL, "expires_at" timestamptz NOT NULL, "state" text NOT NULL DEFAULT 'open', "granted_amount" numeric(16,6) NOT NULL,
  "adjustment_amount" numeric(16,6) NOT NULL DEFAULT 0.000000, "available_amount" numeric(16,6) NOT NULL,
  "reserved_amount" numeric(16,6) NOT NULL DEFAULT 0.000000, "settled_amount" numeric(16,6) NOT NULL DEFAULT 0.000000,
  "expired_amount" numeric(16,6) NOT NULL DEFAULT 0.000000, "clawed_back_amount" numeric(16,6) NOT NULL DEFAULT 0.000000,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_allowance_periods_subscription_tenant_fk" FOREIGN KEY (subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_periods_revision_tenant_fk" FOREIGN KEY (subscription_id, organization_id, subscription_revision) REFERENCES billing_subscription_revisions(subscription_id, organization_id, revision) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_periods_invoice_id_check" CHECK (provider = 'stripe' AND provider_environment IN ('test','live') AND stripe_invoice_id ~ '^in_[A-Za-z0-9]+$'),
  CONSTRAINT "subscription_allowance_periods_period_check" CHECK (period_end > period_start AND expires_at = period_end),
  CONSTRAINT "subscription_allowance_periods_plan_catalog_check" CHECK (plan_key IN ('plus_monthly','pro_monthly') AND length(btrim(catalog_version)) > 0),
  CONSTRAINT "subscription_allowance_periods_state_check" CHECK (state IN ('open','expired','clawed_back','closed')),
  CONSTRAINT "subscription_allowance_periods_amounts_check" CHECK (granted_amount > 0 AND adjustment_amount >= 0 AND available_amount >= 0 AND reserved_amount >= 0 AND settled_amount >= 0 AND expired_amount >= 0 AND clawed_back_amount >= 0 AND available_amount + reserved_amount + settled_amount + expired_amount + clawed_back_amount = granted_amount + adjustment_amount),
  CONSTRAINT "subscription_allowance_periods_terminal_amounts_check" CHECK ((state = 'open') OR (state = 'expired' AND available_amount = 0) OR (state = 'clawed_back' AND available_amount = 0 AND reserved_amount = 0 AND clawed_back_amount > 0) OR (state = 'closed' AND available_amount = 0 AND reserved_amount = 0)),
  CONSTRAINT "subscription_allowance_periods_revision_check" CHECK (subscription_revision > 0)
);
CREATE UNIQUE INDEX "subscription_allowance_periods_id_org_idx" ON "subscription_allowance_periods" (id, organization_id);
CREATE UNIQUE INDEX "subscription_allowance_periods_invoice_idx" ON "subscription_allowance_periods" (provider, provider_environment, stripe_invoice_id);
CREATE UNIQUE INDEX "subscription_allowance_periods_period_idx" ON "subscription_allowance_periods" (subscription_id, period_start, period_end);
CREATE INDEX "subscription_allowance_periods_org_period_idx" ON "subscription_allowance_periods" (organization_id, period_end);
ALTER TABLE "subscription_allowance_periods" ADD CONSTRAINT "subscription_allowance_periods_no_overlap" EXCLUDE USING gist (subscription_id WITH =, tstzrange(period_start, period_end, '[)') WITH &&);
--> statement-breakpoint
CREATE TABLE "billing_funding_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "logical_operation_id" text NOT NULL, "request_digest" text NOT NULL, "funding_class" text NOT NULL, "requested_amount" numeric(16,6) NOT NULL,
  "reserved_amount" numeric(16,6) NOT NULL, "uncollected_overage_amount" numeric(16,6) NOT NULL DEFAULT 0,
  "status" text NOT NULL DEFAULT 'reserved', "settlement_key" text, "settlement_digest" text,
  "cancellation_key" text, "cancellation_digest" text, "expires_at" timestamptz NOT NULL, "finalized_at" timestamptz, "canceled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_funding_reservations_identity_check" CHECK (logical_operation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_funding_reservations_amount_check" CHECK (requested_amount > 0 AND reserved_amount = requested_amount),
  CONSTRAINT "billing_funding_reservations_funding_class_check" CHECK (funding_class IN ('allowance_eligible','cash_only')),
  CONSTRAINT "billing_funding_reservations_terminal_shape_check" CHECK ((status = 'reserved' AND finalized_at IS NULL AND canceled_at IS NULL AND settlement_key IS NULL AND settlement_digest IS NULL AND cancellation_key IS NULL AND cancellation_digest IS NULL) OR (status = 'finalized' AND finalized_at IS NOT NULL AND canceled_at IS NULL AND settlement_key IS NOT NULL AND settlement_digest ~ '^[0-9a-f]{64}$' AND cancellation_key IS NULL AND cancellation_digest IS NULL) OR (status = 'canceled' AND canceled_at IS NOT NULL AND finalized_at IS NULL AND cancellation_key IS NOT NULL AND cancellation_digest ~ '^[0-9a-f]{64}$' AND settlement_key IS NULL AND settlement_digest IS NULL)),
  CONSTRAINT "billing_funding_reservations_expiry_check" CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX "billing_funding_reservations_id_org_idx" ON "billing_funding_reservations" (id, organization_id);
CREATE UNIQUE INDEX "billing_funding_reservations_org_operation_idx" ON "billing_funding_reservations" (organization_id, logical_operation_id);
CREATE UNIQUE INDEX "billing_funding_reservations_org_settlement_key_idx" ON "billing_funding_reservations" (organization_id, settlement_key) WHERE settlement_key IS NOT NULL;
CREATE UNIQUE INDEX "billing_funding_reservations_org_cancellation_key_idx" ON "billing_funding_reservations" (organization_id, cancellation_key) WHERE cancellation_key IS NOT NULL;
CREATE INDEX "billing_funding_reservations_org_status_expiry_idx" ON "billing_funding_reservations" (organization_id, status, expires_at);
--> statement-breakpoint
CREATE TABLE "billing_funding_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL, "reservation_id" uuid NOT NULL, "sequence" integer NOT NULL,
  "source" text NOT NULL, "allowance_period_id" uuid, "purchased_credit_reservation_transaction_id" uuid,
  "purchased_credit_settlement_transaction_id" uuid, "purchased_credit_refund_transaction_id" uuid,
  "reserved_amount" numeric(16,6) NOT NULL, "finalized_amount" numeric(16,6) NOT NULL DEFAULT 0.000000,
  "released_amount" numeric(16,6) NOT NULL DEFAULT 0.000000, "expired_refund_amount" numeric(16,6) NOT NULL DEFAULT 0.000000,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_funding_allocations_reservation_tenant_fk" FOREIGN KEY (reservation_id, organization_id) REFERENCES billing_funding_reservations(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_funding_allocations_allowance_period_tenant_fk" FOREIGN KEY (allowance_period_id, organization_id) REFERENCES subscription_allowance_periods(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_funding_allocations_credit_reserve_tenant_fk" FOREIGN KEY (purchased_credit_reservation_transaction_id, organization_id) REFERENCES credit_transactions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_funding_allocations_credit_settle_tenant_fk" FOREIGN KEY (purchased_credit_settlement_transaction_id, organization_id) REFERENCES credit_transactions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_funding_allocations_credit_refund_tenant_fk" FOREIGN KEY (purchased_credit_refund_transaction_id, organization_id) REFERENCES credit_transactions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_funding_allocations_amount_check" CHECK (sequence > 0 AND reserved_amount > 0 AND finalized_amount >= 0 AND released_amount >= 0 AND expired_refund_amount >= 0 AND finalized_amount + released_amount + expired_refund_amount <= reserved_amount),
  CONSTRAINT "billing_funding_allocations_source_shape_check" CHECK ((source = 'allowance' AND allowance_period_id IS NOT NULL AND purchased_credit_reservation_transaction_id IS NULL AND purchased_credit_settlement_transaction_id IS NULL AND purchased_credit_refund_transaction_id IS NULL) OR (source = 'purchased_credit' AND allowance_period_id IS NULL AND purchased_credit_reservation_transaction_id IS NOT NULL))
);
CREATE UNIQUE INDEX "billing_funding_allocations_id_org_idx" ON "billing_funding_allocations" (id, organization_id);
CREATE UNIQUE INDEX "billing_funding_allocations_reservation_seq_idx" ON "billing_funding_allocations" (reservation_id, sequence);
CREATE UNIQUE INDEX "billing_funding_allocations_credit_reserve_idx" ON "billing_funding_allocations" (purchased_credit_reservation_transaction_id) WHERE purchased_credit_reservation_transaction_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "subscription_allowance_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "allowance_period_id" uuid NOT NULL, "funding_allocation_id" uuid, "source_subscription_id" uuid, "source_subscription_revision" bigint,
  "source_invoice_id" text, "source_plan_key" text, "source_catalog_version" text, "sequence" integer NOT NULL, "kind" text NOT NULL,
  "amount" numeric(16,6) NOT NULL, "available_before" numeric(16,6) NOT NULL, "available_after" numeric(16,6) NOT NULL,
  "reserved_before" numeric(16,6) NOT NULL, "reserved_after" numeric(16,6) NOT NULL, "settled_before" numeric(16,6) NOT NULL,
  "settled_after" numeric(16,6) NOT NULL, "expired_before" numeric(16,6) NOT NULL, "expired_after" numeric(16,6) NOT NULL,
  "clawed_back_before" numeric(16,6) NOT NULL, "clawed_back_after" numeric(16,6) NOT NULL, "idempotency_key" text NOT NULL,
  "request_digest" text NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb, "occurred_at" timestamptz NOT NULL DEFAULT now(), "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_allowance_transactions_period_tenant_fk" FOREIGN KEY (allowance_period_id, organization_id) REFERENCES subscription_allowance_periods(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_transactions_allocation_tenant_fk" FOREIGN KEY (funding_allocation_id, organization_id) REFERENCES billing_funding_allocations(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_transactions_source_revision_tenant_fk" FOREIGN KEY (source_subscription_id, organization_id, source_subscription_revision) REFERENCES billing_subscription_revisions(subscription_id, organization_id, revision) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_transactions_kind_check" CHECK (kind IN ('grant','reserve','finalize','release','expired_refund','expire','clawback','grant_adjustment','close')),
  CONSTRAINT "subscription_allowance_transactions_amount_check" CHECK (sequence > 0 AND ((kind = 'close' AND amount = 0) OR (kind <> 'close' AND amount > 0)) AND available_before >= 0 AND available_after >= 0 AND reserved_before >= 0 AND reserved_after >= 0 AND settled_before >= 0 AND settled_after >= 0 AND expired_before >= 0 AND expired_after >= 0 AND clawed_back_before >= 0 AND clawed_back_after >= 0),
  CONSTRAINT "subscription_allowance_transactions_idempotency_key_check" CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "subscription_allowance_transactions_reservation_shape_check" CHECK ((kind IN ('reserve','finalize','release','expired_refund') AND funding_allocation_id IS NOT NULL) OR (kind IN ('grant','expire','clawback','grant_adjustment','close') AND funding_allocation_id IS NULL)),
  CONSTRAINT "subscription_allowance_transactions_adjustment_source_check" CHECK ((kind = 'grant_adjustment' AND source_subscription_id IS NOT NULL AND source_subscription_revision IS NOT NULL AND source_invoice_id ~ '^in_[A-Za-z0-9]+$' AND source_plan_key IN ('plus_monthly','pro_monthly') AND length(btrim(source_catalog_version)) > 0) OR (kind <> 'grant_adjustment' AND source_subscription_id IS NULL AND source_subscription_revision IS NULL AND source_invoice_id IS NULL AND source_plan_key IS NULL AND source_catalog_version IS NULL)),
  CONSTRAINT "subscription_allowance_transactions_snapshot_transition_check" CHECK ((kind = 'grant' AND available_before = 0 AND available_after = amount AND reserved_before = reserved_after AND settled_before = settled_after AND expired_before = expired_after AND clawed_back_before = clawed_back_after) OR (kind = 'grant_adjustment' AND available_after = available_before + amount AND reserved_before = reserved_after AND settled_before = settled_after AND expired_before = expired_after AND clawed_back_before = clawed_back_after) OR (kind = 'reserve' AND available_after = available_before - amount AND reserved_after = reserved_before + amount AND settled_before = settled_after AND expired_before = expired_after AND clawed_back_before = clawed_back_after) OR (kind = 'finalize' AND available_before = available_after AND reserved_after = reserved_before - amount AND settled_after = settled_before + amount AND expired_before = expired_after AND clawed_back_before = clawed_back_after) OR (kind = 'release' AND available_after = available_before + amount AND reserved_after = reserved_before - amount AND settled_before = settled_after AND expired_before = expired_after AND clawed_back_before = clawed_back_after) OR (kind = 'expired_refund' AND available_before = available_after AND reserved_after = reserved_before - amount AND settled_before = settled_after AND expired_after = expired_before + amount AND clawed_back_before = clawed_back_after) OR (kind = 'expire' AND available_after = available_before - amount AND expired_after = expired_before + amount AND reserved_before = reserved_after AND settled_before = settled_after AND clawed_back_before = clawed_back_after) OR (kind = 'clawback' AND available_after = available_before - amount AND clawed_back_after = clawed_back_before + amount AND reserved_before = reserved_after AND settled_before = settled_after AND expired_before = expired_after) OR (kind = 'close' AND available_before = 0 AND available_after = 0 AND reserved_before = 0 AND reserved_after = 0 AND settled_before = settled_after AND expired_before = expired_after AND clawed_back_before = clawed_back_after))
);
CREATE UNIQUE INDEX "subscription_allowance_transactions_org_idempotency_idx" ON "subscription_allowance_transactions" (organization_id, idempotency_key);
CREATE UNIQUE INDEX "subscription_allowance_transactions_period_sequence_idx" ON "subscription_allowance_transactions" (allowance_period_id, sequence);
CREATE UNIQUE INDEX "subscription_allowance_transactions_period_grant_idx" ON "subscription_allowance_transactions" (allowance_period_id) WHERE kind = 'grant';
CREATE UNIQUE INDEX "subscription_allowance_transactions_source_invoice_idx" ON "subscription_allowance_transactions" (source_invoice_id) WHERE source_invoice_id IS NOT NULL;
CREATE INDEX "subscription_allowance_transactions_period_occurred_idx" ON "subscription_allowance_transactions" (allowance_period_id, occurred_at, id);
--> statement-breakpoint
CREATE TABLE "billing_subscription_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "subscription_id" uuid, "requested_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT, "kind" text NOT NULL,
  "target_plan_key" text, "expected_subscription_revision" bigint, "idempotency_key" text NOT NULL, "provider_idempotency_key" text NOT NULL,
  "request_digest" text NOT NULL, "status" text NOT NULL DEFAULT 'PREPARED', "state_revision" bigint NOT NULL DEFAULT 1,
  "execution_generation" bigint NOT NULL DEFAULT 0, "attempt_count" integer NOT NULL DEFAULT 0, "lease_token" uuid, "lease_expires_at" timestamptz,
  "provider_started_at" timestamptz, "provider_response_digest" text, "error_code" text, "completed_at" timestamptz,
  "result_subscription_id" uuid, "applied_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_subscription_commands_subscription_tenant_fk" FOREIGN KEY (subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_commands_result_subscription_tenant_fk" FOREIGN KEY (result_subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_commands_intent_check" CHECK ((kind = 'checkout' AND subscription_id IS NULL AND expected_subscription_revision IS NULL AND target_plan_key IS NOT NULL AND target_plan_key IN ('plus_monthly','pro_monthly')) OR (kind IN ('upgrade','downgrade') AND subscription_id IS NOT NULL AND expected_subscription_revision > 0 AND target_plan_key IS NOT NULL AND target_plan_key IN ('plus_monthly','pro_monthly')) OR (kind IN ('cancel','resume') AND subscription_id IS NOT NULL AND expected_subscription_revision > 0 AND target_plan_key IS NULL)),
  CONSTRAINT "billing_subscription_commands_idempotency_check" CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND provider_idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$' AND request_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscription_commands_revision_check" CHECK (attempt_count >= 0 AND state_revision > 0 AND execution_generation >= 0),
  CONSTRAINT "billing_subscription_commands_lease_check" CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)), CONSTRAINT "billing_subscription_commands_provider_digest_check" CHECK (provider_response_digest IS NULL OR provider_response_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscription_commands_status_shape_check" CHECK ((status = 'PREPARED' AND execution_generation = 0 AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NULL AND completed_at IS NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'OUTCOME_UNKNOWN' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NULL AND completed_at IS NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'SUCCEEDED' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'APPLIED' AND kind = 'checkout' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL AND result_subscription_id IS NOT NULL AND applied_at IS NOT NULL) OR (status = 'FAILED' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'SUPERSEDED' AND execution_generation = 0 AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL))
);
CREATE UNIQUE INDEX "billing_subscription_commands_id_org_idx" ON "billing_subscription_commands" (id, organization_id);
CREATE UNIQUE INDEX "billing_subscription_commands_org_idempotency_idx" ON "billing_subscription_commands" (organization_id, idempotency_key);
CREATE UNIQUE INDEX "billing_subscription_commands_provider_idempotency_idx" ON "billing_subscription_commands" (provider_idempotency_key);
CREATE UNIQUE INDEX "billing_subscription_commands_live_checkout_org_idx" ON "billing_subscription_commands" (organization_id) WHERE kind = 'checkout' AND status IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED');
CREATE INDEX "billing_subscription_commands_status_lease_idx" ON "billing_subscription_commands" (status, lease_expires_at);
CREATE INDEX "billing_subscription_commands_org_created_idx" ON "billing_subscription_commands" (organization_id, created_at);
--> statement-breakpoint
CREATE TABLE "subscription_billing_fences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "subscription_id" uuid NOT NULL, "state" text NOT NULL DEFAULT 'open', "fence_revision" bigint NOT NULL DEFAULT 1,
  "provider_event_id" text, "provider_event_created_at" timestamptz, "provider_object_digest" text NOT NULL,
  "deletion_requested_at" timestamptz, "provider_deleted_at" timestamptz, "released_at" timestamptz,
  "last_reconciled_at" timestamptz, "next_reconcile_at" timestamptz, "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_billing_fences_subscription_tenant_fk" FOREIGN KEY (subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "subscription_billing_fences_provider_fence_check" CHECK (fence_revision > 0 AND (provider_event_id IS NULL) = (provider_event_created_at IS NULL) AND (provider_event_id IS NULL OR length(btrim(provider_event_id)) > 0) AND provider_object_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "subscription_billing_fences_state_shape_check" CHECK ((state = 'open' AND deletion_requested_at IS NULL AND provider_deleted_at IS NULL AND released_at IS NULL) OR (state = 'deletion_requested' AND deletion_requested_at IS NOT NULL AND provider_deleted_at IS NULL AND released_at IS NULL) OR (state = 'provider_deleted' AND deletion_requested_at IS NOT NULL AND provider_deleted_at IS NOT NULL AND released_at IS NULL) OR (state = 'released' AND deletion_requested_at IS NOT NULL AND provider_deleted_at IS NOT NULL AND released_at IS NOT NULL) OR (state = 'quarantined' AND released_at IS NULL))
);
CREATE UNIQUE INDEX "subscription_billing_fences_id_org_idx" ON "subscription_billing_fences" (id, organization_id);
CREATE UNIQUE INDEX "subscription_billing_fences_subscription_idx" ON "subscription_billing_fences" (subscription_id);
CREATE UNIQUE INDEX "subscription_billing_fences_provider_event_idx" ON "subscription_billing_fences" (provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE INDEX "subscription_billing_fences_state_reconcile_idx" ON "subscription_billing_fences" (state, next_reconcile_at);
--> statement-breakpoint
CREATE TABLE "billing_subscription_event_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "subscription_id" uuid NOT NULL, "provider_event_id" text NOT NULL, "event_type" text NOT NULL, "provider_object_type" text NOT NULL,
  "provider_object_id" text NOT NULL, "livemode" boolean NOT NULL, "event_created_at" timestamptz NOT NULL, "payload_digest" text NOT NULL,
  "status" text NOT NULL DEFAULT 'received', "attempt_count" integer NOT NULL DEFAULT 0, "lease_token" uuid, "lease_expires_at" timestamptz,
  "applied_subscription_revision" bigint, "disposition" text, "error_code" text, "processed_at" timestamptz,
  "received_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_subscription_event_receipts_subscription_tenant_fk" FOREIGN KEY (subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_event_receipts_revision_tenant_fk" FOREIGN KEY (subscription_id, organization_id, applied_subscription_revision) REFERENCES billing_subscription_revisions(subscription_id, organization_id, revision) ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_event_receipts_event_shape_check" CHECK (length(btrim(provider_event_id)) > 0 AND length(btrim(event_type)) > 0 AND length(btrim(provider_object_id)) > 0 AND provider_object_type IN ('subscription','invoice') AND payload_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "billing_subscription_event_receipts_progress_check" CHECK (attempt_count >= 0 AND (lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT "billing_subscription_event_receipts_status_shape_check" CHECK ((status = 'received' AND lease_token IS NULL AND applied_subscription_revision IS NULL AND disposition IS NULL AND error_code IS NULL AND processed_at IS NULL) OR (status = 'processing' AND lease_token IS NOT NULL AND applied_subscription_revision IS NULL AND disposition IS NULL AND error_code IS NULL AND processed_at IS NULL) OR (status = 'applied' AND lease_token IS NULL AND applied_subscription_revision IS NOT NULL AND disposition IS NOT NULL AND error_code IS NULL AND processed_at IS NOT NULL) OR (status = 'ignored' AND lease_token IS NULL AND applied_subscription_revision IS NULL AND disposition IS NOT NULL AND error_code IS NULL AND processed_at IS NOT NULL) OR (status IN ('failed','quarantined') AND lease_token IS NULL AND applied_subscription_revision IS NULL AND error_code IS NOT NULL AND processed_at IS NOT NULL))
);
CREATE UNIQUE INDEX "billing_subscription_event_receipts_id_org_idx" ON "billing_subscription_event_receipts" (id, organization_id);
CREATE UNIQUE INDEX "billing_subscription_event_receipts_event_idx" ON "billing_subscription_event_receipts" (provider_event_id);
CREATE INDEX "billing_subscription_event_receipts_status_lease_idx" ON "billing_subscription_event_receipts" (status, lease_expires_at);
--> statement-breakpoint
CREATE TABLE "billing_subscription_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "subscription_id" uuid NOT NULL, "command_id" uuid, "event_receipt_id" uuid, "kind" text NOT NULL, "severity" text NOT NULL,
  "fingerprint" text NOT NULL, "status" text NOT NULL DEFAULT 'open', "occurrence_count" integer NOT NULL DEFAULT 1, "context" jsonb NOT NULL,
  "first_observed_at" timestamptz NOT NULL DEFAULT now(), "last_observed_at" timestamptz NOT NULL DEFAULT now(), "next_retry_at" timestamptz,
  "resolved_by_user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT, "resolution" text, "resolved_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(), "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_subscription_incidents_subscription_tenant_fk" FOREIGN KEY (subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_incidents_command_tenant_fk" FOREIGN KEY (command_id, organization_id) REFERENCES billing_subscription_commands(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_incidents_receipt_tenant_fk" FOREIGN KEY (event_receipt_id, organization_id) REFERENCES billing_subscription_event_receipts(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "billing_subscription_incidents_vocabulary_check" CHECK (kind IN ('provider_unavailable','provider_timeout','provider_drift','command_ambiguous','event_processing','reconciliation','deletion_fence') AND severity IN ('warning','error','critical') AND status IN ('open','resolved')),
  CONSTRAINT "billing_subscription_incidents_fingerprint_check" CHECK (fingerprint ~ '^[0-9a-f]{64}$' AND occurrence_count > 0 AND last_observed_at >= first_observed_at),
  CONSTRAINT "billing_subscription_incidents_resolution_shape_check" CHECK ((status = 'open' AND resolved_by_user_id IS NULL AND resolution IS NULL AND resolved_at IS NULL) OR (status = 'resolved' AND resolution IS NOT NULL AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX "billing_subscription_incidents_id_org_idx" ON "billing_subscription_incidents" (id, organization_id);
CREATE UNIQUE INDEX "billing_subscription_incidents_open_fingerprint_idx" ON "billing_subscription_incidents" (organization_id, subscription_id, fingerprint) WHERE status = 'open';
CREATE INDEX "billing_subscription_incidents_status_retry_idx" ON "billing_subscription_incidents" (status, next_retry_at);
--> statement-breakpoint
CREATE FUNCTION reject_subscription_append_only_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514'; END $$;
CREATE TRIGGER "billing_subscription_revisions_immutable_guard" BEFORE UPDATE OR DELETE OR TRUNCATE ON "billing_subscription_revisions" FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
CREATE TRIGGER "subscription_allowance_transactions_immutable_guard" BEFORE UPDATE OR DELETE OR TRUNCATE ON "subscription_allowance_transactions" FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
--> statement-breakpoint
CREATE FUNCTION guard_billing_subscription_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.organization_id, NEW.subscription_id, NEW.requested_by_user_id, NEW.kind, NEW.target_plan_key, NEW.expected_subscription_revision, NEW.idempotency_key, NEW.provider_idempotency_key, NEW.request_digest) IS DISTINCT FROM ROW(OLD.organization_id, OLD.subscription_id, OLD.requested_by_user_id, OLD.kind, OLD.target_plan_key, OLD.expected_subscription_revision, OLD.idempotency_key, OLD.provider_idempotency_key, OLD.request_digest) THEN RAISE EXCEPTION 'subscription command intent is immutable' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "billing_subscription_commands_intent_guard" BEFORE UPDATE ON "billing_subscription_commands" FOR EACH ROW EXECUTE FUNCTION guard_billing_subscription_command_intent();
CREATE FUNCTION guard_subscription_billing_fence_advance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.subscription_id <> OLD.subscription_id THEN RAISE EXCEPTION 'subscription billing fence identity is immutable' USING ERRCODE = '23514'; END IF;
  IF NEW.fence_revision <= OLD.fence_revision THEN RAISE EXCEPTION 'subscription billing fence revision must advance monotonically' USING ERRCODE = '23514'; END IF;
  IF (OLD.state = 'open' AND NEW.state NOT IN ('open','deletion_requested','quarantined')) OR (OLD.state = 'deletion_requested' AND NEW.state NOT IN ('deletion_requested','provider_deleted','quarantined')) OR (OLD.state = 'provider_deleted' AND NEW.state NOT IN ('provider_deleted','released','quarantined')) OR (OLD.state = 'released' AND NEW.state <> 'released') OR (OLD.state = 'quarantined' AND NEW.state NOT IN ('quarantined','deletion_requested','provider_deleted','released')) THEN RAISE EXCEPTION 'subscription billing fence state transition is invalid' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "subscription_billing_fences_advance_guard" BEFORE UPDATE ON "subscription_billing_fences" FOR EACH ROW EXECUTE FUNCTION guard_subscription_billing_fence_advance();
CREATE FUNCTION guard_billing_subscription_event_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF ROW(NEW.organization_id, NEW.subscription_id, NEW.provider_event_id, NEW.event_type, NEW.provider_object_type, NEW.provider_object_id, NEW.livemode, NEW.event_created_at, NEW.payload_digest) IS DISTINCT FROM ROW(OLD.organization_id, OLD.subscription_id, OLD.provider_event_id, OLD.event_type, OLD.provider_object_type, OLD.provider_object_id, OLD.livemode, OLD.event_created_at, OLD.payload_digest) THEN RAISE EXCEPTION 'subscription event identity is immutable' USING ERRCODE = '23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER "billing_subscription_event_receipts_identity_guard" BEFORE UPDATE ON "billing_subscription_event_receipts" FOR EACH ROW EXECUTE FUNCTION guard_billing_subscription_event_identity();
