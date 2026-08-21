CREATE TABLE "subscription_allowance_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "allowance_period_id" uuid NOT NULL,
  "funding_reservation_id" uuid,
  "source_subscription_id" uuid,
  "source_subscription_revision" bigint,
  "source_invoice_id" text,
  "source_plan_key" text,
  "source_catalog_version" text,
  "sequence" integer NOT NULL,
  "kind" text NOT NULL,
  "amount" numeric(16,6) NOT NULL,
  "remaining_before" numeric(16,6) NOT NULL,
  "remaining_after" numeric(16,6) NOT NULL,
  "expired_before" numeric(16,6) NOT NULL,
  "expired_after" numeric(16,6) NOT NULL,
  "clawed_back_before" numeric(16,6) NOT NULL,
  "clawed_back_after" numeric(16,6) NOT NULL,
  "idempotency_key" text NOT NULL,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_allowance_transactions_period_tenant_fk" FOREIGN KEY (allowance_period_id, organization_id) REFERENCES subscription_allowance_periods(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_transactions_reservation_tenant_fk" FOREIGN KEY (funding_reservation_id, organization_id) REFERENCES billing_funding_reservations(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_transactions_source_revision_tenant_fk" FOREIGN KEY (source_subscription_id, organization_id, source_subscription_revision) REFERENCES billing_subscription_revisions(subscription_id, organization_id, revision) ON DELETE RESTRICT,
  CONSTRAINT "subscription_allowance_transactions_kind_check" CHECK (kind IN ('grant','reserve','settle','refund','expire','clawback','grant_adjustment','close')),
  CONSTRAINT "subscription_allowance_transactions_amount_check" CHECK (sequence > 0 AND ((kind = 'close' AND amount = 0) OR (kind <> 'close' AND amount > 0)) AND remaining_before >= 0 AND remaining_after >= 0 AND expired_before >= 0 AND expired_after >= 0 AND clawed_back_before >= 0 AND clawed_back_after >= 0),
  CONSTRAINT "subscription_allowance_transactions_idempotency_key_check" CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  CONSTRAINT "subscription_allowance_transactions_reservation_shape_check" CHECK ((kind IN ('reserve','settle','refund') AND funding_reservation_id IS NOT NULL) OR (kind IN ('grant','expire','clawback','grant_adjustment','close') AND funding_reservation_id IS NULL)),
  CONSTRAINT "subscription_allowance_transactions_adjustment_source_check" CHECK ((kind = 'grant_adjustment' AND source_subscription_id IS NOT NULL AND source_subscription_revision IS NOT NULL AND source_invoice_id ~ '^in_[A-Za-z0-9]+$' AND source_plan_key IN ('plus_monthly','pro_monthly') AND length(btrim(source_catalog_version)) > 0) OR (kind <> 'grant_adjustment' AND source_subscription_id IS NULL AND source_subscription_revision IS NULL AND source_invoice_id IS NULL AND source_plan_key IS NULL AND source_catalog_version IS NULL)),
  CONSTRAINT "subscription_allowance_transactions_snapshot_transition_check" CHECK ((kind = 'grant' AND remaining_before = 0 AND remaining_after = amount AND expired_before = expired_after AND clawed_back_before = clawed_back_after) OR (kind = 'grant_adjustment' AND remaining_after = remaining_before + amount AND expired_before = expired_after AND clawed_back_before = clawed_back_after) OR (kind = 'reserve' AND remaining_after = remaining_before - amount AND expired_before = expired_after AND clawed_back_before = clawed_back_after) OR (kind = 'settle' AND remaining_after = remaining_before AND expired_before = expired_after AND clawed_back_before = clawed_back_after) OR (kind = 'refund' AND (((remaining_after = remaining_before + amount) AND expired_before = expired_after) OR (remaining_after = remaining_before AND expired_after = expired_before + amount)) AND clawed_back_before = clawed_back_after) OR (kind = 'expire' AND remaining_after = remaining_before - amount AND expired_after = expired_before + amount AND clawed_back_before = clawed_back_after) OR (kind = 'clawback' AND remaining_after = remaining_before - amount AND clawed_back_after = clawed_back_before + amount AND expired_before = expired_after) OR (kind = 'close' AND remaining_after = remaining_before AND remaining_before = 0 AND expired_before = expired_after AND clawed_back_before = clawed_back_after))
);
CREATE UNIQUE INDEX "subscription_allowance_transactions_org_idempotency_idx" ON "subscription_allowance_transactions" (organization_id, idempotency_key);
CREATE UNIQUE INDEX "subscription_allowance_transactions_period_sequence_idx" ON "subscription_allowance_transactions" (allowance_period_id, sequence);
CREATE UNIQUE INDEX "subscription_allowance_transactions_period_grant_idx" ON "subscription_allowance_transactions" (allowance_period_id) WHERE kind = 'grant';
CREATE UNIQUE INDEX "subscription_allowance_transactions_source_invoice_idx" ON "subscription_allowance_transactions" (source_invoice_id) WHERE source_invoice_id IS NOT NULL;
CREATE INDEX "subscription_allowance_transactions_period_occurred_idx" ON "subscription_allowance_transactions" (allowance_period_id, occurred_at, id);
CREATE FUNCTION "reject_subscription_allowance_transaction_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'subscription allowance transactions are append-only' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER "subscription_allowance_transactions_immutable_guard" BEFORE UPDATE OR DELETE ON "subscription_allowance_transactions" FOR EACH ROW EXECUTE FUNCTION "reject_subscription_allowance_transaction_mutation"();
