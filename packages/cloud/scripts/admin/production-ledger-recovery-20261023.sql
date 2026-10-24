\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '300s';
LOCK TABLE drizzle.__drizzle_migrations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 373
     OR (SELECT max(id) FROM drizzle.__drizzle_migrations) <> 373
     OR (SELECT count(*) FROM drizzle.__drizzle_migrations WHERE (id=371 AND hash='64d86e3a03e8ea2aed9e5da3ec96d6c1ecf0cb954521136a4124358fce6d6049') OR (id=372 AND hash='506220a7a7e4b208c56c4210c3cc9798a64547e8a3ad8935d653c5f0ce9a59ba') OR (id=373 AND hash='a465de981b9ebd4f0f4c0e60c594c825f3b0110b28fdf64340b8b1ef5c2108a0')) <> 3 THEN
    RAISE EXCEPTION 'ledger_shape_mismatch: production ledger is not the reviewed 373-row state';
  END IF;
END $$;
CREATE TABLE drizzle.__drizzle_migrations_retired_20261023 AS SELECT *, now() AS retired_at FROM drizzle.__drizzle_migrations WHERE (id=371 AND hash='64d86e3a03e8ea2aed9e5da3ec96d6c1ecf0cb954521136a4124358fce6d6049') OR (id=372 AND hash='506220a7a7e4b208c56c4210c3cc9798a64547e8a3ad8935d653c5f0ce9a59ba') OR (id=373 AND hash='a465de981b9ebd4f0f4c0e60c594c825f3b0110b28fdf64340b8b1ef5c2108a0');
DELETE FROM drizzle.__drizzle_migrations WHERE (id=371 AND hash='64d86e3a03e8ea2aed9e5da3ec96d6c1ecf0cb954521136a4124358fce6d6049') OR (id=372 AND hash='506220a7a7e4b208c56c4210c3cc9798a64547e8a3ad8935d653c5f0ce9a59ba') OR (id=373 AND hash='a465de981b9ebd4f0f4c0e60c594c825f3b0110b28fdf64340b8b1ef5c2108a0');
SELECT setval(pg_get_serial_sequence('drizzle.__drizzle_migrations','id'), 370, true);
-- apply 0387_agent_compute_funding
-- Dedicated funding intervals use the existing per-source reservation ledger.
CREATE TABLE IF NOT EXISTS "agent_compute_funding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"funding_reservation_id" uuid NOT NULL,
	"previous_funding_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"hourly_rate" numeric(16, 6) NOT NULL,
	"provider_node_id" text,
	"provider_container_id" text,
	"provider_bound_at" timestamp with time zone,
	"host_lease_confirmed_at" timestamp with time zone,
	"settled_through" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_compute_funding_identity_unique" UNIQUE("id","agent_id","organization_id"),
	CONSTRAINT "agent_compute_funding_period_check" CHECK ("agent_compute_funding"."period_end" > "agent_compute_funding"."period_start" AND "agent_compute_funding"."hourly_rate" > 0
        AND "agent_compute_funding"."hourly_rate" <> 'NaN'::numeric),
	CONSTRAINT "agent_compute_funding_provider_check" CHECK (num_nonnulls("agent_compute_funding"."provider_node_id", "agent_compute_funding"."provider_container_id", "agent_compute_funding"."provider_bound_at") IN (0, 3)
        AND ("agent_compute_funding"."provider_container_id" IS NULL OR "agent_compute_funding"."provider_container_id" ~ '^[0-9a-f]{64}$')
        AND ("agent_compute_funding"."provider_node_id" IS NULL OR length("agent_compute_funding"."provider_node_id") > 0)),
	CONSTRAINT "agent_compute_funding_host_confirmation_check" CHECK ("agent_compute_funding"."host_lease_confirmed_at" IS NULL OR
        ("agent_compute_funding"."provider_bound_at" IS NOT NULL
          AND "agent_compute_funding"."host_lease_confirmed_at" >= "agent_compute_funding"."provider_bound_at"
          AND "agent_compute_funding"."host_lease_confirmed_at" < "agent_compute_funding"."period_end")),
	CONSTRAINT "agent_compute_funding_settlement_check" CHECK (("agent_compute_funding"."settled_at" IS NULL AND "agent_compute_funding"."settled_through" IS NULL)
        OR ("agent_compute_funding"."settled_at" IS NOT NULL AND "agent_compute_funding"."settled_through" IS NOT NULL
          AND "agent_compute_funding"."settled_through" BETWEEN "agent_compute_funding"."period_start" AND "agent_compute_funding"."period_end")),
	CONSTRAINT "agent_compute_funding_predecessor_fk" FOREIGN KEY ("previous_funding_id","agent_id","organization_id") REFERENCES "public"."agent_compute_funding"("id","agent_id","organization_id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_compute_funding_agent_tenant_fk" FOREIGN KEY ("agent_id","organization_id") REFERENCES "public"."agent_sandboxes"("id","organization_id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "agent_compute_funding_reservation_tenant_fk" FOREIGN KEY ("funding_reservation_id","organization_id") REFERENCES "public"."billing_funding_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action
);
;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_compute_funding_predecessor_idx" ON "agent_compute_funding" USING btree ("previous_funding_id");
;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_compute_funding_reservation_idx" ON "agent_compute_funding" USING btree ("funding_reservation_id");
;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_compute_funding_open_agent_idx" ON "agent_compute_funding" USING btree ("agent_id") WHERE "agent_compute_funding"."settled_at" IS NULL;
;
CREATE INDEX IF NOT EXISTS "agent_compute_funding_expiry_idx" ON "agent_compute_funding" USING btree ("period_end") WHERE "agent_compute_funding"."settled_at" IS NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('0138969b1e4d1a7cfe93fd0af5c5b25a8f8045ef89b6e42c73467fdb2a9d2acf', 1796083200014);
-- apply 0388_agent_compute_funded_receipts
ALTER TABLE "agent_billing_records" ALTER COLUMN "credit_transaction_id" DROP NOT NULL;
;
ALTER TABLE "agent_billing_records" ADD COLUMN IF NOT EXISTS "compute_funding_id" uuid;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_compute_funding_tenant_fk') THEN
    ALTER TABLE "agent_billing_records" ADD CONSTRAINT "agent_billing_records_compute_funding_tenant_fk" FOREIGN KEY ("compute_funding_id","sandbox_id","organization_id") REFERENCES "public"."agent_compute_funding"("id","agent_id","organization_id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;
;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_billing_records_compute_funding_idx" ON "agent_billing_records" USING btree ("compute_funding_id") WHERE "agent_billing_records"."compute_funding_id" IS NOT NULL;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_funding_source_check') THEN
    ALTER TABLE "agent_billing_records" ADD CONSTRAINT "agent_billing_records_funding_source_check" CHECK (true) NOT VALID;
  END IF;
END $$;
;
CREATE OR REPLACE FUNCTION guard_agent_funded_billing_receipt() RETURNS trigger AS $$
BEGIN
  IF NEW.compute_funding_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_compute_funding f
    JOIN billing_funding_reservations r ON r.id=f.funding_reservation_id AND r.organization_id=f.organization_id
    WHERE f.id=NEW.compute_funding_id AND f.organization_id=NEW.organization_id AND f.agent_id=NEW.sandbox_id
      AND f.settled_at IS NOT NULL AND f.settled_through=NEW.billing_period_end
      AND date_trunc('milliseconds',f.period_start)=NEW.billing_period_start
      AND r.status='finalized' AND r.uncollected_overage_amount=0
      AND NEW.amount=(SELECT sum(a.finalized_amount) FROM billing_funding_allocations a
        WHERE a.reservation_id=r.id AND a.organization_id=r.organization_id)
  ) THEN
    RAISE EXCEPTION 'agent billing receipt must match its finalized funding and metered period'
      USING ERRCODE='23514', CONSTRAINT='agent_billing_records_funding_evidence_guard';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='agent_billing_records'::regclass AND tgname='agent_billing_records_funding_evidence_guard') THEN
    CREATE TRIGGER agent_billing_records_funding_evidence_guard BEFORE INSERT ON agent_billing_records
      FOR EACH ROW EXECUTE FUNCTION guard_agent_funded_billing_receipt();
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('85a84458165c1572cc8dd3656a2bb91ec68501345bc819b18723165c398065f1', 1796083200015);
-- apply 0389_agent_compute_stop_receipts
ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "provider_stopped_at" timestamp with time zone;
;
ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "provider_stop_receipt" jsonb;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_compute_funding'::regclass AND conname='agent_compute_funding_stop_receipt_check') THEN
    ALTER TABLE "agent_compute_funding" ADD CONSTRAINT "agent_compute_funding_stop_receipt_check" CHECK (num_nonnulls("agent_compute_funding"."provider_stopped_at", "agent_compute_funding"."provider_stop_receipt") IN (0, 2)
        AND ("agent_compute_funding"."provider_stopped_at" IS NULL OR ("agent_compute_funding"."settled_at" IS NOT NULL
          AND jsonb_typeof("agent_compute_funding"."provider_stop_receipt") = 'object'
          AND (("agent_compute_funding"."provider_stop_receipt"->>'fundingId' = "agent_compute_funding"."id"::text
            AND "agent_compute_funding"."provider_stop_receipt"->>'containerId' = "agent_compute_funding"."provider_container_id"
            AND jsonb_typeof("agent_compute_funding"."provider_stop_receipt"->'stoppedAtMs') = 'number'
            AND jsonb_typeof("agent_compute_funding"."provider_stop_receipt"->'bootId') = 'string') IS TRUE))));
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('b0ec10dac3d0049a0beeea59803d74752c940e999d80c3f39d0d670f23c41754', 1796083200016);
-- apply 0390_agent_compute_runtime_readiness
-- A host start/health response does not prove application restore completed.
ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "runtime_ready_at" timestamp with time zone;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('86e00ab46a192635b92481a75f950c87b1ba2c40c87d25f341e88373004e2c1e', 1796083200017);
-- apply 0391_agent_compute_subjects
CREATE TABLE IF NOT EXISTS "agent_compute_subjects" (
  "agent_id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "retired_at" timestamptz,
  CONSTRAINT "agent_compute_subjects_tenant_unique" UNIQUE ("agent_id", "organization_id")
);
;
-- Hold both writers while backfilling and moving the retained financial FK.
LOCK TABLE "agent_sandboxes", "agent_compute_funding" IN SHARE ROW EXCLUSIVE MODE;
;
INSERT INTO "agent_compute_subjects" ("agent_id", "organization_id", "created_at")
SELECT "agent_id", "organization_id", min("created_at") FROM "agent_compute_funding"
GROUP BY "agent_id", "organization_id" ON CONFLICT ("agent_id") DO NOTHING;
;
CREATE OR REPLACE FUNCTION guard_agent_compute_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.agent_id, NEW.organization_id) IS DISTINCT FROM (OLD.agent_id, OLD.organization_id) THEN
      RAISE EXCEPTION 'Compute funding identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  PERFORM 1 FROM agent_sandboxes WHERE id = NEW.agent_id
    AND organization_id = NEW.organization_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compute funding requires a live tenant agent'; END IF;
  INSERT INTO agent_compute_subjects (agent_id, organization_id)
    VALUES (NEW.agent_id, NEW.organization_id) ON CONFLICT (agent_id) DO NOTHING;
  PERFORM 1 FROM agent_compute_subjects WHERE agent_id = NEW.agent_id
    AND organization_id = NEW.organization_id AND retired_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Compute billing identity is retired or belongs to another tenant'; END IF;
  RETURN NEW;
END $$;
;
DROP TRIGGER IF EXISTS "guard_agent_compute_subject" ON "agent_compute_funding";
;
CREATE TRIGGER "guard_agent_compute_subject" BEFORE INSERT OR UPDATE ON "agent_compute_funding"
  FOR EACH ROW EXECUTE FUNCTION guard_agent_compute_subject();
;
CREATE OR REPLACE FUNCTION guard_agent_compute_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM agent_compute_subjects WHERE agent_id = NEW.id) THEN
      RAISE EXCEPTION 'A retained compute billing identity cannot be reused';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.organization_id) IS DISTINCT FROM (OLD.id, OLD.organization_id)
      AND EXISTS (SELECT 1 FROM agent_compute_subjects WHERE agent_id = OLD.id) THEN
      RAISE EXCEPTION 'A funded agent identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM agent_compute_funding WHERE agent_id = OLD.id AND settled_at IS NULL) THEN
    RAISE EXCEPTION 'Unsettled compute must be stopped before agent deletion';
  END IF;
  UPDATE agent_compute_subjects SET retired_at = COALESCE(retired_at, clock_timestamp())
    WHERE agent_id = OLD.id AND organization_id = OLD.organization_id;
  RETURN OLD;
END $$;
;
DROP TRIGGER IF EXISTS "guard_agent_compute_retirement" ON "agent_sandboxes";
;
CREATE TRIGGER "guard_agent_compute_retirement" BEFORE INSERT OR DELETE OR UPDATE OF id, organization_id ON "agent_sandboxes"
  FOR EACH ROW EXECUTE FUNCTION guard_agent_compute_retirement();
;
ALTER TABLE "agent_compute_funding" DROP CONSTRAINT IF EXISTS "agent_compute_funding_agent_tenant_fk";
;
ALTER TABLE "agent_compute_funding" ADD CONSTRAINT "agent_compute_funding_agent_tenant_fk"
  FOREIGN KEY ("agent_id", "organization_id") REFERENCES "agent_compute_subjects"("agent_id", "organization_id") ON DELETE RESTRICT;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('d0f513a7fb332561f0849b29dbe2f6b0b4f3aa02a74d7afc2c322863e5c408e6', 1796083200018);
-- apply 0392_agent_compute_retirement_backup
-- A stopped container can be reclaimed only from its transaction-bound current backup.
ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "retirement_backup_id" uuid;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_compute_funding'::regclass AND conname='agent_compute_funding_retirement_backup_check') THEN
    ALTER TABLE "agent_compute_funding" ADD CONSTRAINT "agent_compute_funding_retirement_backup_check"
      CHECK ("retirement_backup_id" IS NULL OR ("settled_at" IS NOT NULL AND "provider_stopped_at" IS NOT NULL));
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('641b955e5b3cefc93ef9469b843fa14b905f23b3bba6dc14e9d68665130ad180', 1796083200019);
-- apply 0393_agent_compute_activation_minimum
-- Existing records keep zero; accepted new activations carry an explicit minimum.
ALTER TABLE "agent_compute_funding" ADD COLUMN IF NOT EXISTS "minimum_charge_remaining" numeric(16,6) NOT NULL DEFAULT 0;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_compute_funding'::regclass AND conname='agent_compute_funding_minimum_charge_check') THEN
    ALTER TABLE "agent_compute_funding" ADD CONSTRAINT "agent_compute_funding_minimum_charge_check"
      CHECK (minimum_charge_remaining >= 0 AND minimum_charge_remaining <> 'NaN'::numeric);
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('80a883a8cde2e93f861e78f1ab4ddcdf55a0bc5fc52ef4c4a81dbcd217b0a0fd', 1796083200020);
-- apply 0394_agent_billing_activation_minimum
-- Existing records keep zero; accepted new activations carry an explicit minimum.
ALTER TABLE "agent_billing_records" ADD COLUMN IF NOT EXISTS "minimum_charge_amount" numeric(16,6) NOT NULL DEFAULT 0;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_minimum_charge_check') THEN
    ALTER TABLE "agent_billing_records" ADD CONSTRAINT "agent_billing_records_minimum_charge_check"
      CHECK (minimum_charge_amount >= 0 AND minimum_charge_amount <= amount AND minimum_charge_amount <> 'NaN'::numeric);
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('cacd80919062f0abe236f4e52aa499db792fa36414db802a68661d53d01588ac', 1796083200021);
-- apply 0395_app_creator_settlement_endpoints
-- Replace the complete validator atomically so existing v1 receipts retain their rules.
-- The replacement stays together to avoid exposing mixed receipt versions during deployment.
-- Preserve historical receipt rules while new settlements conserve committed creator endpoints.
ALTER TABLE app_reservation_settlements
  ADD COLUMN creator_rule_version integer NOT NULL DEFAULT 1,
  ADD COLUMN creator_original_ledger_entry_id uuid,
  ADD COLUMN creator_initial_amount numeric(16,4),
  ADD COLUMN creator_final_amount numeric(16,4),
  ADD CONSTRAINT app_reservation_creator_original_fk FOREIGN KEY (creator_original_ledger_entry_id)
    REFERENCES redeemable_earnings_ledger(id) ON DELETE RESTRICT,
  ADD CONSTRAINT app_reservation_creator_rule_check CHECK (
    (creator_rule_version = 1 AND creator_original_ledger_entry_id IS NULL
      AND creator_initial_amount IS NULL AND creator_final_amount IS NULL)
    OR (creator_rule_version = 2 AND creator_initial_amount IS NOT NULL
      AND creator_final_amount IS NOT NULL AND creator_initial_amount >= 0 AND creator_final_amount >= 0));
;
CREATE OR REPLACE FUNCTION validate_app_reservation_settlement_receipt() RETURNS trigger AS $$
DECLARE
  reservation_row credit_transactions%ROWTYPE;
  adjustment_row credit_transactions%ROWTYPE;
  creator_ledger_amount numeric;
  creator_expected_movement numeric;
  original_creator redeemable_earnings_ledger%ROWTYPE;
  initial_creator_amount numeric;
  final_creator_amount numeric;
  creator_ledger_user uuid;
  creator_ledger_source text;
  app_projection_app uuid;
  app_projection_user uuid;
  app_projection_amount numeric;
  app_projection_ledger text;
BEGIN
  SELECT * INTO reservation_row
  FROM credit_transactions
  WHERE id = NEW.reservation_transaction_id
    AND organization_id = NEW.organization_id
  FOR UPDATE;
  IF NOT FOUND
     OR reservation_row.type <> 'debit'
     OR reservation_row.metadata->>'type' <> 'app_chat_reservation'
     OR reservation_row.metadata->>'settlement_marker' <> 'app_chat_reservation_v1'
     OR lower(reservation_row.metadata->>'appId') IS DISTINCT FROM NEW.app_id::text
     OR lower(reservation_row.metadata->>'userId') IS DISTINCT FROM NEW.user_id::text
     OR lower(NULLIF(reservation_row.metadata->>'creatorUserId', ''))::uuid
          IS DISTINCT FROM NEW.creator_user_id
     OR abs(reservation_row.amount) IS DISTINCT FROM NEW.reserved_total_cost
     OR COALESCE(reservation_row.metadata->>'reserved_amount',
                 reservation_row.metadata->>'baseCost')::numeric
          IS DISTINCT FROM NEW.reserved_base_cost
     OR EXISTS (
       SELECT 1 FROM app_reservation_settlement_quarantines
       WHERE reservation_transaction_id = NEW.reservation_transaction_id
     ) THEN
    RAISE EXCEPTION 'app reservation receipt does not match immutable reservation facts'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_reservation_match';
  END IF;

  IF round(NEW.reserved_base_cost * (1 + NEW.markup_percentage / 100), 6)
       IS DISTINCT FROM NEW.reserved_total_cost
     OR round(NEW.actual_base_cost * (1 + NEW.markup_percentage / 100), 6)
       IS DISTINCT FROM NEW.actual_total_cost
     OR NEW.actual_total_cost - NEW.reserved_total_cost
       IS DISTINCT FROM NEW.organization_adjustment
     OR round((NEW.actual_base_cost - NEW.reserved_base_cost)
       * NEW.markup_percentage / 100, 6) IS DISTINCT FROM NEW.creator_adjustment
     OR NEW.actual_base_cost - NEW.reserved_base_cost
       IS DISTINCT FROM NEW.platform_adjustment THEN
    RAISE EXCEPTION 'app reservation receipt economics are inconsistent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_economic_match';
  END IF;

  IF NEW.credit_transaction_id IS NOT NULL THEN
    SELECT * INTO adjustment_row
    FROM credit_transactions
    WHERE id = NEW.credit_transaction_id
      AND organization_id = NEW.organization_id;
  END IF;
  IF (NEW.outcome = 'refund' AND (
        NEW.credit_transaction_id IS NULL OR adjustment_row.type <> 'refund'
        OR adjustment_row.amount IS DISTINCT FROM -NEW.organization_adjustment
        OR adjustment_row.stripe_payment_intent_id
          IS DISTINCT FROM 'reconcile-refund:' || NEW.reservation_transaction_id::text
      ))
     OR (NEW.outcome = 'overage' AND (
        NEW.credit_transaction_id IS NULL OR adjustment_row.type <> 'debit'
        OR adjustment_row.amount IS DISTINCT FROM -NEW.organization_adjustment
        OR adjustment_row.stripe_payment_intent_id
          IS DISTINCT FROM 'reconcile-charge:' || NEW.reservation_transaction_id::text
      ))
     OR (NEW.outcome IN ('none', 'uncollected_overage')
       AND NEW.credit_transaction_id IS NOT NULL) THEN
    RAISE EXCEPTION 'app reservation receipt adjustment ledger does not match outcome'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_adjustment_match';
  END IF;

  creator_expected_movement := trunc(NEW.creator_adjustment, 4);
  IF NEW.creator_rule_version = 2 THEN
    initial_creator_amount := trunc(round(NEW.reserved_base_cost * NEW.markup_percentage / 100, 6), 4);
    final_creator_amount := CASE WHEN NEW.outcome = 'uncollected_overage' THEN initial_creator_amount
      ELSE trunc(round(NEW.actual_base_cost * NEW.markup_percentage / 100, 6), 4) END;
    IF NEW.creator_initial_amount IS DISTINCT FROM initial_creator_amount
       OR NEW.creator_final_amount IS DISTINCT FROM final_creator_amount THEN
      RAISE EXCEPTION 'app creator endpoints differ from collected settlement authority'
        USING ERRCODE = '23514', CONSTRAINT = 'app_reservation_creator_endpoint_match';
    END IF;
    IF initial_creator_amount = 0 THEN
      IF NEW.creator_original_ledger_entry_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM redeemable_earnings_ledger
        WHERE lower(metadata->>'chargeTransactionId') = NEW.reservation_transaction_id::text
      ) THEN
        RAISE EXCEPTION 'subunit original app earning must have explicit absent ledger authority'
          USING ERRCODE = '23514', CONSTRAINT = 'app_reservation_creator_original_match';
      END IF;
    ELSE
      SELECT * INTO original_creator FROM redeemable_earnings_ledger
      WHERE id = NEW.creator_original_ledger_entry_id FOR UPDATE;
      IF NOT FOUND OR original_creator.amount IS DISTINCT FROM initial_creator_amount
         OR original_creator.user_id IS DISTINCT FROM NEW.creator_user_id
         OR original_creator.entry_type IS DISTINCT FROM 'earning'
         OR original_creator.earnings_source IS DISTINCT FROM 'miniapp'
         OR lower(original_creator.metadata->>'chargeTransactionId') IS DISTINCT FROM NEW.reservation_transaction_id::text
         OR lower(original_creator.metadata->>'app_id') IS DISTINCT FROM NEW.app_id::text
         OR lower(original_creator.metadata->>'transaction_user_id') IS DISTINCT FROM NEW.user_id::text
         OR original_creator.metadata->>'earnings_type' IS DISTINCT FROM 'inference_markup'
         OR original_creator.metadata->>'original_source_id' IS DISTINCT FROM
              'app-charge:' || NEW.reservation_transaction_id::text || ':inference_markup:deduct'
         OR (SELECT count(*) FROM redeemable_earnings_ledger
              WHERE lower(metadata->>'chargeTransactionId') = NEW.reservation_transaction_id::text) <> 1 THEN
        RAISE EXCEPTION 'app creator original earning identity does not match reservation'
          USING ERRCODE = '23514', CONSTRAINT = 'app_reservation_creator_original_match';
      END IF;
    END IF;
    creator_expected_movement := final_creator_amount - initial_creator_amount;
  END IF;

  IF NEW.redeemable_ledger_entry_id IS NOT NULL THEN
    SELECT amount, user_id, earnings_source
      INTO creator_ledger_amount, creator_ledger_user, creator_ledger_source
    FROM redeemable_earnings_ledger
    WHERE id = NEW.redeemable_ledger_entry_id;
  END IF;
  IF NEW.outcome IN ('refund', 'overage') AND creator_expected_movement <> 0 THEN
    IF NEW.redeemable_ledger_entry_id IS NULL
       OR creator_ledger_user IS DISTINCT FROM NEW.creator_user_id
       OR creator_ledger_source <> 'miniapp'
       OR creator_ledger_amount IS DISTINCT FROM creator_expected_movement THEN
      RAISE EXCEPTION 'app reservation creator ledger does not match receipt'
        USING ERRCODE = '23514',
              CONSTRAINT = 'app_reservation_settlements_creator_match';
    END IF;
  ELSIF NEW.redeemable_ledger_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'app reservation receipt has an unexpected creator ledger'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_creator_match';
  END IF;

  IF NEW.app_earnings_transaction_id IS NOT NULL THEN
    SELECT app_id, user_id, amount, metadata->>'redeemableLedgerEntryId'
      INTO app_projection_app, app_projection_user, app_projection_amount, app_projection_ledger
    FROM app_earnings_transactions
    WHERE id = NEW.app_earnings_transaction_id;
    IF app_projection_app IS DISTINCT FROM NEW.app_id
       OR app_projection_user IS DISTINCT FROM NEW.user_id
       OR app_projection_amount IS DISTINCT FROM creator_expected_movement
       OR app_projection_ledger IS DISTINCT FROM NEW.redeemable_ledger_entry_id::text THEN
      RAISE EXCEPTION 'app reservation app projection does not match receipt'
        USING ERRCODE = '23514',
              CONSTRAINT = 'app_reservation_settlements_app_projection_match';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
;
CREATE OR REPLACE FUNCTION guard_app_reservation_creator_projection() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE redeemable_ledger_entry_id = OLD.id OR creator_original_ledger_entry_id = OLD.id
     )
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.earnings_source IS DISTINCT FROM OLD.earnings_source
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
       OR NEW.metadata IS DISTINCT FROM OLD.metadata) THEN
    RAISE EXCEPTION 'referenced app reservation creator projection is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'redeemable_earnings_app_settlement_projection_immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
;
CREATE OR REPLACE FUNCTION guard_app_reservation_creator_projection_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() <= 1
     AND EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE redeemable_ledger_entry_id = OLD.id OR creator_original_ledger_entry_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'referenced app reservation creator projection cannot be deleted directly'
      USING ERRCODE = '23514', CONSTRAINT = 'redeemable_earnings_app_settlement_projection_delete';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
;
CREATE OR REPLACE FUNCTION guard_app_reservation_creator_projection_truncate() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_reservation_settlements WHERE redeemable_ledger_entry_id IS NOT NULL OR creator_original_ledger_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'referenced app reservation creator projections cannot be truncated'
      USING ERRCODE = '23514', CONSTRAINT = 'redeemable_earnings_app_settlement_projection_truncate';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('dd846efa9863966e155803e7bcf1abc7f3f49470a03dfc9ca5a0aee228f9fe05', 1796083200022);
-- apply 0396_agent_funded_rate_segments
-- Serialize the cutover with lifecycle and funding writers. Historical segments
-- remain immutable; corrected rates apply only from this migration onward.
LOCK TABLE agent_sandboxes, agent_compute_funding IN SHARE ROW EXCLUSIVE MODE;
;
CREATE OR REPLACE FUNCTION append_agent_compute_billing_rate_segment() RETURNS trigger AS $$
DECLARE next_state text;
DECLARE next_rate numeric(16,6);
DECLARE next_effective_at timestamptz;
BEGIN
  next_state := CASE
    WHEN NEW.pool_status IS NOT NULL OR NEW.execution_tier = 'shared' THEN 'exempt'
    WHEN NEW.status = 'running' THEN 'running'
    WHEN NEW.status = 'stopped' AND NEW.last_backup_at IS NOT NULL THEN 'backup'
    ELSE 'not_billable'
  END;
  -- Funded Dedicated starts accept a durable tariff before provisioning. Backup
  -- metadata updates must not replace that tariff with the legacy default.
  next_rate := CASE next_state WHEN 'running' THEN COALESCE((
    SELECT funding.hourly_rate FROM agent_compute_funding funding
    WHERE funding.organization_id = NEW.organization_id
      AND funding.agent_id = NEW.id AND funding.settled_at IS NULL
  ), 0.010000) WHEN 'backup' THEN 0.002500 ELSE 0.000000 END;
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.execution_tier, NEW.last_backup_at, NEW.pool_status)
      IS DISTINCT FROM ROW(OLD.status, OLD.execution_tier, OLD.last_backup_at, OLD.pool_status) THEN
    -- The workload row lock serializes these trigger calls. Advance beyond its
    -- durable cursor so equal clock readings cannot let a random UUID reorder state.
    next_effective_at := clock_timestamp();
    SELECT GREATEST(
      next_effective_at,
      COALESCE(MAX(segment.effective_at) + interval '1 microsecond', next_effective_at)
    ) INTO next_effective_at
    FROM compute_billing_rate_segments segment
    WHERE segment.organization_id = NEW.organization_id
      AND segment.workload_kind = 'agent'
      AND segment.workload_id = NEW.id;
    INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at)
    VALUES (NEW.organization_id, 'agent', NEW.id, NEW.lifecycle_revision,
      next_state, next_rate, next_effective_at);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_compute_billing_rate_segment_append ON agent_sandboxes;

CREATE TRIGGER agent_compute_billing_rate_segment_append
  AFTER INSERT OR UPDATE OF status, execution_tier, last_backup_at, pool_status
  ON agent_sandboxes FOR EACH ROW
  EXECUTE FUNCTION append_agent_compute_billing_rate_segment();
;
INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at)
SELECT sandbox.organization_id, 'agent', sandbox.id, sandbox.lifecycle_revision,
       'running', funding.hourly_rate,
       GREATEST(clock_timestamp(), latest.effective_at + interval '1 microsecond')
FROM agent_sandboxes sandbox
JOIN agent_compute_funding funding
  ON funding.agent_id = sandbox.id
  AND funding.organization_id = sandbox.organization_id
  AND funding.settled_at IS NULL AND funding.host_lease_confirmed_at IS NOT NULL
JOIN LATERAL (
  SELECT segment.billing_state, segment.rate_per_hour, segment.effective_at
  FROM compute_billing_rate_segments segment
  WHERE segment.organization_id = sandbox.organization_id
    AND segment.workload_kind = 'agent' AND segment.workload_id = sandbox.id
  ORDER BY segment.effective_at DESC, segment.id DESC LIMIT 1
) latest ON true
WHERE sandbox.status = 'running' AND sandbox.pool_status IS NULL
  AND sandbox.execution_tier IS DISTINCT FROM 'shared'
  AND latest.billing_state = 'running'
  AND latest.rate_per_hour IS DISTINCT FROM funding.hourly_rate;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('5b0996257d92611cc57f888b2a458674ce026125c6adb9709bb0afb0f1ff356d', 1796083200023);
-- apply 0397_subscription_checkout_contract
-- Persist the original checkout request once; existing pending commands remain unreconstructable.
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "checkout_contract" jsonb;
;
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'billing_checkout_contract_shape'
  AND conrelid = 'billing_subscription_commands'::regclass) THEN
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_checkout_contract_shape" CHECK (
  checkout_contract IS NULL OR ((kind = 'checkout' AND jsonb_typeof(checkout_contract) = 'object'
  AND jsonb_typeof(checkout_contract->'payload') = 'object'
  AND jsonb_typeof(checkout_contract->'digest') = 'string'
  AND (checkout_contract->>'digest') ~ '^[a-f0-9]{64}$') IS TRUE)
);
END IF;
END $$;
;
CREATE OR REPLACE FUNCTION preserve_subscription_checkout_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.checkout_contract IS NOT NULL AND NEW.checkout_contract IS DISTINCT FROM OLD.checkout_contract THEN
    RAISE EXCEPTION 'Original checkout contract is immutable';
  END IF;
  IF OLD.checkout_contract IS NULL AND NEW.checkout_contract IS NOT NULL AND OLD.status <> 'PREPARED' THEN
    RAISE EXCEPTION 'Original checkout contract requires prepared command';
  END IF;
  RETURN NEW;
END;
$$;
;
DROP TRIGGER IF EXISTS preserve_subscription_checkout_contract ON billing_subscription_commands;
;
CREATE TRIGGER preserve_subscription_checkout_contract BEFORE UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION preserve_subscription_checkout_contract();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('c595b8921baa1832d69dcb94204b8104619e46c83ecdac9c46ad725ebf18c93a', 1796083200024);
-- apply 0398_provider_unconfirmed_deletion_billing
-- Serialize provenance checks and rate cutover with lifecycle and funding writers.
LOCK TABLE agent_sandboxes, agent_compute_funding, containers,
  agent_compute_stop_intents, container_compute_stop_intents IN SHARE ROW EXCLUSIVE MODE;

-- Reject unavailable historical authority before changing schema, functions or rows.
DO $$
DECLARE unresolved text;
BEGIN
WITH history AS (
  SELECT c.id, c.organization_id, c.lifecycle_revision,
    latest.id AS latest_id, latest.billing_state, latest.rate_per_hour,
    to_jsonb(latest)->>'lifecycle_status' AS lifecycle_status,
    previous.billing_state AS previous_state,
    previous.rate_per_hour AS previous_rate,
    latest.lifecycle_revision AS latest_revision,
    previous.lifecycle_revision AS previous_revision,
    EXISTS (
      SELECT 1 FROM container_compute_stop_intents proof
      JOIN compute_billing_rate_segments fence
        ON fence.organization_id = proof.organization_id
       AND fence.workload_kind = 'container' AND fence.workload_id = proof.container_id
       AND fence.lifecycle_revision = proof.lifecycle_revision
       AND fence.effective_at = proof.provider_confirmed_at
       AND fence.billing_state = 'not_billable' AND fence.rate_per_hour = 0
      WHERE proof.organization_id = c.organization_id AND proof.container_id = c.id
        AND proof.provider_confirmed_at IS NOT NULL
        AND c.lifecycle_revision BETWEEN proof.lifecycle_revision AND proof.lifecycle_revision + 2
        AND NOT EXISTS (
          SELECT 1 FROM compute_billing_rate_segments later
          WHERE later.organization_id = c.organization_id AND later.workload_kind = 'container'
            AND later.workload_id = c.id AND later.effective_at > fence.effective_at
            AND later.rate_per_hour > 0
        )
    ) AS stopped_proof
  FROM containers c
  LEFT JOIN LATERAL (
    SELECT * FROM compute_billing_rate_segments r
    WHERE r.organization_id = c.organization_id AND r.workload_kind = 'container'
      AND r.workload_id = c.id ORDER BY effective_at DESC, id DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT * FROM compute_billing_rate_segments r
    WHERE r.organization_id = c.organization_id AND r.workload_kind = 'container'
      AND r.workload_id = c.id AND (r.effective_at, r.id) < (latest.effective_at, latest.id)
    ORDER BY effective_at DESC, id DESC LIMIT 1
  ) previous ON true
  WHERE c.status = 'deleting'
), recovery AS (
  SELECT *, CASE
    WHEN lifecycle_status = 'deleting' OR billing_state = 'running' OR stopped_proof THEN billing_state
    WHEN billing_state = 'not_billable' AND previous_state = 'running'
      AND latest_revision = previous_revision + 1 THEN 'running'
    ELSE NULL END AS recovered_state,
    CASE WHEN lifecycle_status = 'deleting' OR billing_state = 'running' OR stopped_proof THEN rate_per_hour
      WHEN billing_state = 'not_billable' AND previous_state = 'running'
        AND latest_revision = previous_revision + 1 THEN previous_rate
      ELSE NULL END AS recovered_rate
  FROM history
)
  SELECT string_agg(id::text, ',' ORDER BY id) INTO unresolved
  FROM recovery WHERE recovered_state IS NULL;
  IF unresolved IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'CONTAINER_DELETION_BILLING_HISTORY_UNRESOLVED',
      DETAIL = unresolved,
      HINT = 'Reconcile each owned workload through provider-confirmed stop recovery or restore its verified lifecycle history; do not infer a charge from deleting status.';
  END IF;
  SELECT string_agg(id::text, ',' ORDER BY id) INTO unresolved FROM agent_sandboxes a
  WHERE status IN ('deletion_pending', 'deletion_failed') AND billing_status = 'suspended'
    AND pool_status IS NULL AND execution_tier <> 'shared' AND deleted_at IS NULL
    AND (deletion_previous_billing_status IS NULL OR deletion_previous_status IS NULL)
    AND (deletion_previous_status = 'stopped' AND last_backup_at IS NULL) IS NOT TRUE
  AND NOT EXISTS (
    SELECT 1 FROM agent_compute_funding funding
    JOIN compute_billing_rate_segments stopped
      ON stopped.organization_id = funding.organization_id
     AND stopped.workload_kind = 'agent' AND stopped.workload_id = funding.agent_id
     AND stopped.effective_at = funding.settled_through
     AND stopped.billing_state = 'not_billable' AND stopped.rate_per_hour = 0
    JOIN LATERAL (
      SELECT billing_state, rate_per_hour, effective_at
      FROM compute_billing_rate_segments current_segment
      WHERE current_segment.organization_id = funding.organization_id
        AND current_segment.workload_kind = 'agent'
        AND current_segment.workload_id = funding.agent_id
      ORDER BY effective_at DESC, id DESC LIMIT 1
    ) current_rate ON current_rate.billing_state = 'not_billable'
      AND current_rate.rate_per_hour = 0 AND current_rate.effective_at >= stopped.effective_at
    WHERE funding.organization_id = a.organization_id AND funding.agent_id = a.id
      AND funding.settled_at IS NOT NULL AND funding.provider_stopped_at IS NOT NULL
      AND funding.provider_stop_receipt IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM compute_billing_rate_segments later
        WHERE later.organization_id = a.organization_id AND later.workload_kind = 'agent'
          AND later.workload_id = a.id AND later.effective_at > stopped.effective_at
          AND later.rate_per_hour > 0
      )
  );
  IF unresolved IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE = 'AGENT_DELETION_BILLING_PROVENANCE_UNRESOLVED',
      DETAIL = unresolved,
      HINT = 'Resolve missing pre-deletion billing authority against the owned lifecycle records before retrying; do not assume active billing.';
  END IF;
END $$;

ALTER TABLE compute_billing_rate_segments ADD COLUMN IF NOT EXISTS lifecycle_status text;

-- Provider-backed compute remains billable while deletion is only requested,
-- pending, failed, or timed out. Provider-confirmed terminal states stay zero.

CREATE OR REPLACE FUNCTION append_agent_compute_billing_rate_segment() RETURNS trigger AS $$
DECLARE next_state text;
DECLARE next_rate numeric(16,6);
DECLARE next_effective_at timestamptz;
DECLARE deleting_update boolean;
DECLARE prior_state text;
DECLARE prior_rate numeric(16,6);
BEGIN
  deleting_update := TG_OP = 'UPDATE' AND NEW.status IN ('deletion_pending', 'deletion_failed')
    AND NEW.pool_status IS NULL AND NEW.execution_tier <> 'shared';
  IF deleting_update THEN
    SELECT billing_state, rate_per_hour INTO prior_state, prior_rate
      FROM compute_billing_rate_segments
      WHERE organization_id = OLD.organization_id AND workload_kind = 'agent'
        AND workload_id = OLD.id
      ORDER BY effective_at DESC, id DESC LIMIT 1;
    IF prior_state IS NULL OR prior_rate IS NULL THEN
      RAISE EXCEPTION 'AGENT_DELETION_BILLING_HISTORY_MISSING: %', OLD.id;
    END IF;
  END IF;
  next_state := CASE
    WHEN NEW.pool_status IS NOT NULL OR NEW.execution_tier = 'shared' THEN 'exempt'
    WHEN deleting_update THEN prior_state
    WHEN NEW.status IN ('deletion_pending', 'deletion_failed')
      AND NEW.deletion_previous_status = 'stopped' THEN
      CASE WHEN NEW.last_backup_at IS NOT NULL THEN 'backup' ELSE 'not_billable' END
    WHEN NEW.status IN ('running', 'deletion_pending', 'deletion_failed') THEN 'running'
    WHEN NEW.status = 'stopped' AND NEW.last_backup_at IS NOT NULL THEN 'backup'
    ELSE 'not_billable'
  END;
  next_rate := CASE WHEN deleting_update THEN prior_rate
    ELSE CASE next_state WHEN 'running' THEN COALESCE(
      (SELECT funding.hourly_rate FROM agent_compute_funding funding
       WHERE funding.organization_id = NEW.organization_id AND funding.agent_id = NEW.id
         AND funding.settled_at IS NULL), 0.010000)
      WHEN 'backup' THEN 0.002500 ELSE 0.000000 END END;
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.execution_tier, NEW.last_backup_at, NEW.pool_status, NEW.deletion_previous_status)
      IS DISTINCT FROM ROW(OLD.status, OLD.execution_tier, OLD.last_backup_at, OLD.pool_status, OLD.deletion_previous_status) THEN
    SELECT GREATEST(clock_timestamp(),
      COALESCE(MAX(effective_at) + interval '1 microsecond', clock_timestamp()))
      INTO next_effective_at FROM compute_billing_rate_segments
      WHERE organization_id = NEW.organization_id AND workload_kind = 'agent'
        AND workload_id = NEW.id;
    INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at, lifecycle_status)
    VALUES (NEW.organization_id, 'agent', NEW.id, NEW.lifecycle_revision,
      next_state, next_rate, next_effective_at, NEW.status);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_compute_billing_rate_segment_append ON agent_sandboxes;
CREATE TRIGGER agent_compute_billing_rate_segment_append
  AFTER INSERT OR UPDATE OF status, execution_tier, last_backup_at, pool_status, deletion_previous_status
  ON agent_sandboxes FOR EACH ROW
  EXECUTE FUNCTION append_agent_compute_billing_rate_segment();

CREATE OR REPLACE FUNCTION append_container_compute_billing_rate_segment() RETURNS trigger AS $$
DECLARE next_state text;
DECLARE next_daily_rate numeric(16,6);
DECLARE prior_state text;
DECLARE prior_rate numeric(16,6);
DECLARE next_effective_at timestamptz;
BEGIN
  IF NEW.status = 'deleting' AND TG_OP = 'UPDATE' THEN
    SELECT billing_state, rate_per_hour INTO prior_state, prior_rate
      FROM compute_billing_rate_segments
      WHERE organization_id = OLD.organization_id AND workload_kind = 'container'
        AND workload_id = OLD.id
      ORDER BY effective_at DESC, id DESC LIMIT 1;
    IF prior_state IS NULL THEN
      RAISE EXCEPTION 'CONTAINER_DELETION_BILLING_HISTORY_MISSING: %', OLD.id;
    END IF;
  END IF;
  next_state := CASE WHEN NEW.status = 'deleting' AND TG_OP = 'UPDATE' THEN prior_state
    WHEN NEW.status IN ('running', 'deleting') THEN 'running' ELSE 'not_billable' END;
  next_daily_rate := CASE WHEN next_state = 'running' THEN ROUND((
    0.67::numeric * GREATEST(NEW.desired_count, 1)
    * CASE WHEN NEW.cpu > 1024 THEN NEW.cpu::numeric / 1024 ELSE 1 END
    * CASE WHEN NEW.memory > 2048 THEN sqrt(NEW.memory::numeric / 2048) ELSE 1 END
  ), 2) ELSE 0 END;
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.desired_count, NEW.cpu, NEW.memory)
      IS DISTINCT FROM ROW(OLD.status, OLD.desired_count, OLD.cpu, OLD.memory) THEN
    SELECT GREATEST(clock_timestamp(),
      COALESCE(MAX(effective_at) + interval '1 microsecond', clock_timestamp()))
      INTO next_effective_at FROM compute_billing_rate_segments
      WHERE organization_id = NEW.organization_id AND workload_kind = 'container'
        AND workload_id = NEW.id;
    INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at, lifecycle_status)
    VALUES (NEW.organization_id, 'container', NEW.id, NEW.lifecycle_revision,
      next_state, CASE WHEN NEW.status = 'deleting' AND TG_OP = 'UPDATE'
        THEN prior_rate ELSE next_daily_rate / 24 END, next_effective_at, NEW.status);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS container_compute_billing_rate_segment_append ON containers;
CREATE TRIGGER container_compute_billing_rate_segment_append
  AFTER INSERT OR UPDATE OF status, desired_count, cpu, memory
  ON containers FOR EACH ROW
  EXECUTE FUNCTION append_container_compute_billing_rate_segment();

UPDATE agent_sandboxes a
SET billing_status = a.deletion_previous_billing_status,
    shutdown_warning_sent_at = a.deletion_previous_shutdown_warning_sent_at,
    scheduled_shutdown_at = a.deletion_previous_scheduled_shutdown_at
WHERE a.status IN ('deletion_pending', 'deletion_failed') AND a.billing_status = 'suspended'
  AND a.deletion_previous_billing_status IN ('active', 'warning', 'shutdown_pending')
  AND a.pool_status IS NULL AND a.execution_tier <> 'shared' AND a.deleted_at IS NULL
  AND (a.deletion_previous_status = 'running'
    OR (a.deletion_previous_status = 'stopped' AND a.last_backup_at IS NOT NULL))
  AND NOT EXISTS (
    SELECT 1 FROM agent_compute_funding funding
    JOIN compute_billing_rate_segments stopped
      ON stopped.organization_id = funding.organization_id
     AND stopped.workload_kind = 'agent' AND stopped.workload_id = funding.agent_id
     AND stopped.effective_at = funding.settled_through
     AND stopped.billing_state = 'not_billable' AND stopped.rate_per_hour = 0
    JOIN LATERAL (
      SELECT billing_state, rate_per_hour, effective_at
      FROM compute_billing_rate_segments current_segment
      WHERE current_segment.organization_id = funding.organization_id
        AND current_segment.workload_kind = 'agent'
        AND current_segment.workload_id = funding.agent_id
      ORDER BY effective_at DESC, id DESC LIMIT 1
    ) current_rate ON current_rate.billing_state = 'not_billable'
      AND current_rate.rate_per_hour = 0 AND current_rate.effective_at >= stopped.effective_at
    WHERE funding.organization_id = a.organization_id AND funding.agent_id = a.id
      AND funding.settled_at IS NOT NULL AND funding.provider_stopped_at IS NOT NULL
      AND funding.provider_stop_receipt IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM compute_billing_rate_segments later
        WHERE later.organization_id = a.organization_id AND later.workload_kind = 'agent'
          AND later.workload_id = a.id AND later.effective_at > stopped.effective_at
          AND later.rate_per_hour > 0
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM agent_compute_stop_intents proof
    WHERE proof.organization_id = a.organization_id AND proof.agent_id = a.id
      AND proof.provider_confirmed_at >= a.deletion_started_at
      AND proof.lifecycle_revision <= a.lifecycle_revision
  );

INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at, lifecycle_status)
SELECT a.organization_id, 'agent', a.id, a.lifecycle_revision,
  CASE WHEN a.deletion_previous_status = 'stopped' THEN 'backup' ELSE 'running' END,
  CASE WHEN a.deletion_previous_status = 'stopped' THEN 0.002500 ELSE COALESCE(active_funding.hourly_rate, 0.010000) END,
  GREATEST(clock_timestamp(), latest.effective_at + interval '1 microsecond'), a.status
FROM agent_sandboxes a
JOIN LATERAL (
  SELECT billing_state, rate_per_hour, effective_at FROM compute_billing_rate_segments s
  WHERE s.organization_id = a.organization_id AND s.workload_kind = 'agent' AND s.workload_id = a.id
  ORDER BY effective_at DESC, id DESC LIMIT 1
) latest ON true
LEFT JOIN agent_compute_funding active_funding
  ON active_funding.organization_id = a.organization_id AND active_funding.agent_id = a.id
  AND active_funding.settled_at IS NULL
WHERE a.status IN ('deletion_pending', 'deletion_failed')
  AND a.pool_status IS NULL AND a.execution_tier <> 'shared' AND a.deleted_at IS NULL
  AND a.billing_status IN ('active', 'warning', 'shutdown_pending')
  AND (a.deletion_previous_status IS DISTINCT FROM 'stopped' OR a.last_backup_at IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM agent_compute_funding funding
    JOIN compute_billing_rate_segments stopped
      ON stopped.organization_id = funding.organization_id
     AND stopped.workload_kind = 'agent' AND stopped.workload_id = funding.agent_id
     AND stopped.effective_at = funding.settled_through
     AND stopped.billing_state = 'not_billable' AND stopped.rate_per_hour = 0
    JOIN LATERAL (
      SELECT billing_state, rate_per_hour, effective_at
      FROM compute_billing_rate_segments current_segment
      WHERE current_segment.organization_id = funding.organization_id
        AND current_segment.workload_kind = 'agent'
        AND current_segment.workload_id = funding.agent_id
      ORDER BY effective_at DESC, id DESC LIMIT 1
    ) current_rate ON current_rate.billing_state = 'not_billable'
      AND current_rate.rate_per_hour = 0 AND current_rate.effective_at >= stopped.effective_at
    WHERE funding.organization_id = a.organization_id AND funding.agent_id = a.id
      AND funding.settled_at IS NOT NULL AND funding.provider_stopped_at IS NOT NULL
      AND funding.provider_stop_receipt IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM compute_billing_rate_segments later
        WHERE later.organization_id = a.organization_id AND later.workload_kind = 'agent'
          AND later.workload_id = a.id AND later.effective_at > stopped.effective_at
          AND later.rate_per_hour > 0
      )
  )
  AND (latest.billing_state IS DISTINCT FROM
    CASE WHEN a.deletion_previous_status = 'stopped' THEN 'backup' ELSE 'running' END
    OR latest.rate_per_hour IS DISTINCT FROM
    CASE WHEN a.deletion_previous_status = 'stopped' THEN 0.002500 ELSE COALESCE(active_funding.hourly_rate, 0.010000) END);

WITH history AS (
  SELECT c.id, c.organization_id, c.lifecycle_revision,
    latest.id AS latest_id, latest.billing_state, latest.rate_per_hour,
    to_jsonb(latest)->>'lifecycle_status' AS lifecycle_status,
    previous.billing_state AS previous_state,
    previous.rate_per_hour AS previous_rate,
    latest.lifecycle_revision AS latest_revision,
    previous.lifecycle_revision AS previous_revision,
    EXISTS (
      SELECT 1 FROM container_compute_stop_intents proof
      JOIN compute_billing_rate_segments fence
        ON fence.organization_id = proof.organization_id
       AND fence.workload_kind = 'container' AND fence.workload_id = proof.container_id
       AND fence.lifecycle_revision = proof.lifecycle_revision
       AND fence.effective_at = proof.provider_confirmed_at
       AND fence.billing_state = 'not_billable' AND fence.rate_per_hour = 0
      WHERE proof.organization_id = c.organization_id AND proof.container_id = c.id
        AND proof.provider_confirmed_at IS NOT NULL
        AND c.lifecycle_revision BETWEEN proof.lifecycle_revision AND proof.lifecycle_revision + 2
        AND NOT EXISTS (
          SELECT 1 FROM compute_billing_rate_segments later
          WHERE later.organization_id = c.organization_id AND later.workload_kind = 'container'
            AND later.workload_id = c.id AND later.effective_at > fence.effective_at
            AND later.rate_per_hour > 0
        )
    ) AS stopped_proof
  FROM containers c
  LEFT JOIN LATERAL (
    SELECT * FROM compute_billing_rate_segments r
    WHERE r.organization_id = c.organization_id AND r.workload_kind = 'container'
      AND r.workload_id = c.id ORDER BY effective_at DESC, id DESC LIMIT 1
  ) latest ON true
  LEFT JOIN LATERAL (
    SELECT * FROM compute_billing_rate_segments r
    WHERE r.organization_id = c.organization_id AND r.workload_kind = 'container'
      AND r.workload_id = c.id AND (r.effective_at, r.id) < (latest.effective_at, latest.id)
    ORDER BY effective_at DESC, id DESC LIMIT 1
  ) previous ON true
  WHERE c.status = 'deleting'
), recovery AS (
  SELECT *, CASE
    WHEN lifecycle_status = 'deleting' OR billing_state = 'running' OR stopped_proof THEN billing_state
    WHEN billing_state = 'not_billable' AND previous_state = 'running'
      AND latest_revision = previous_revision + 1 THEN 'running'
    ELSE NULL END AS recovered_state,
    CASE WHEN lifecycle_status = 'deleting' OR billing_state = 'running' OR stopped_proof THEN rate_per_hour
      WHEN billing_state = 'not_billable' AND previous_state = 'running'
        AND latest_revision = previous_revision + 1 THEN previous_rate
      ELSE NULL END AS recovered_rate
  FROM history
)
INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at, lifecycle_status)
SELECT r.organization_id, 'container', r.id, r.lifecycle_revision,
  r.recovered_state, r.recovered_rate,
  GREATEST(clock_timestamp(), latest.effective_at + interval '1 microsecond'), 'deleting'
FROM recovery r JOIN compute_billing_rate_segments latest ON latest.id = r.latest_id
WHERE r.lifecycle_status IS NULL;


-- Correct only future metering for a running, funded subject; settled usage remains immutable.
INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at, lifecycle_status)
SELECT a.organization_id, 'agent', a.id, a.lifecycle_revision,
  'running', funding.hourly_rate,
  GREATEST(clock_timestamp(), latest.effective_at + interval '1 microsecond'), a.status
FROM agent_sandboxes a
JOIN agent_compute_funding funding
  ON funding.organization_id = a.organization_id AND funding.agent_id = a.id
  AND funding.settled_at IS NULL AND funding.host_lease_confirmed_at IS NOT NULL
JOIN LATERAL (
  SELECT billing_state, rate_per_hour, effective_at FROM compute_billing_rate_segments s
  WHERE s.organization_id = a.organization_id AND s.workload_kind = 'agent' AND s.workload_id = a.id
  ORDER BY effective_at DESC, id DESC LIMIT 1
) latest ON true
WHERE a.status = 'running' AND a.pool_status IS NULL AND a.execution_tier <> 'shared'
  AND a.deleted_at IS NULL AND latest.billing_state = 'running'
  AND latest.rate_per_hour IS DISTINCT FROM funding.hourly_rate;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('2d80f8ac079388bfe05404a72abebae730cbe95d1b09331fe87efb98df8be1c0', 1796083200025);
-- apply 0399_prepared_stop_backup
-- Existing stop intents may retain a legacy full backup without adopting v2 catalog metadata.
ALTER TABLE "agent_compute_stop_intents"
  ADD COLUMN IF NOT EXISTS "prepared_backup" jsonb;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_compute_stop_intents_prepared_backup_object' AND conrelid = 'agent_compute_stop_intents'::regclass) THEN
    ALTER TABLE "agent_compute_stop_intents"
      ADD CONSTRAINT "agent_compute_stop_intents_prepared_backup_object"
      CHECK ("prepared_backup" IS NULL OR jsonb_typeof("prepared_backup") = 'object');
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('31ec81cc296abc6b7715c4ed730e0a58c7b86c765248b8ddb83ebfc812b43d35', 1796083200026);
-- apply 0400_app_billing_catalog
CREATE TABLE IF NOT EXISTS "app_billing_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"external_account_key" text NOT NULL,
	"eligibility_principal_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_accounts_key_check" CHECK (length(btrim("app_billing_accounts"."external_account_key")) BETWEEN 1 AND 200)
);
;
CREATE TABLE IF NOT EXISTS "app_billing_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "app_billing_members_role_check" CHECK ("app_billing_members"."role" IN ('administrator','member'))
);
;
CREATE TABLE IF NOT EXISTS "app_billing_plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"product_family_key" text NOT NULL,
	"plan_key" text NOT NULL,
	"revision" integer NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"interval" text NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"minimum_quantity" integer DEFAULT 1 NOT NULL,
	"maximum_quantity" integer NOT NULL,
	"trial_days" integer DEFAULT 7 NOT NULL,
	"trial_allowance_usd" numeric(16, 6) DEFAULT '0.000000' NOT NULL,
	"paid_allowance_usd" numeric(16, 6) DEFAULT '0.000000' NOT NULL,
	"expired_access" text NOT NULL,
	"entitlements" jsonb NOT NULL,
	"stripe_price_id" text NOT NULL,
	"stripe_product_id" text NOT NULL,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_plan_revisions_access_check" CHECK ("app_billing_plan_revisions"."expired_access" IN ('read_only','denied')),
	CONSTRAINT "app_billing_plan_revisions_policy_check" CHECK ("app_billing_plan_revisions"."revision" > 0 AND "app_billing_plan_revisions"."amount_cents" > 0 AND "app_billing_plan_revisions"."currency" ~ '^[a-z]{3}$' AND "app_billing_plan_revisions"."interval" IN ('day','week','month','year') AND "app_billing_plan_revisions"."interval_count" > 0 AND "app_billing_plan_revisions"."minimum_quantity" > 0 AND "app_billing_plan_revisions"."maximum_quantity" >= "app_billing_plan_revisions"."minimum_quantity" AND "app_billing_plan_revisions"."trial_days" = 7 AND "app_billing_plan_revisions"."trial_allowance_usd" >= 0 AND "app_billing_plan_revisions"."paid_allowance_usd" >= 0),
	CONSTRAINT "app_billing_plan_revisions_identity_check" CHECK ("app_billing_plan_revisions"."stripe_price_id" ~ '^price_[A-Za-z0-9]+$' AND "app_billing_plan_revisions"."stripe_product_id" ~ '^prod_[A-Za-z0-9]+$' AND length(btrim("app_billing_plan_revisions"."product_family_key")) BETWEEN 1 AND 100 AND length(btrim("app_billing_plan_revisions"."plan_key")) BETWEEN 1 AND 100)
);
;
CREATE TABLE IF NOT EXISTS "billing_merchants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider_account_key" text NOT NULL,
	"livemode" boolean NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_merchants_provider_check" CHECK ("billing_merchants"."provider_account_key" = 'platform' OR "billing_merchants"."provider_account_key" ~ '^acct_[A-Za-z0-9]+$')
);
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('ba310676d6afa18ab0eabbcf5be11feedbaf504c1d189d46c910841eda7c7b49', 1796083200027);
-- apply 0401_app_billing_scope_records
CREATE TABLE IF NOT EXISTS "app_billing_customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"command_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_customers_customer_check" CHECK ("app_billing_customers"."stripe_customer_id" ~ '^cus_[A-Za-z0-9]+$')
);
;
CREATE TABLE IF NOT EXISTS "app_billing_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"product_family_key" text NOT NULL,
	"fenced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
;
CREATE TABLE IF NOT EXISTS "app_billing_seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "app_billing_seats_subject_check" CHECK (length(btrim("app_billing_seats"."subject")) BETWEEN 1 AND 200 AND length(btrim("app_billing_seats"."idempotency_key")) BETWEEN 8 AND 128)
);
;
CREATE TABLE IF NOT EXISTS "app_subscription_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"subscription_revision" bigint NOT NULL,
	"kind" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_subscription_outbox_revision_check" CHECK ("app_subscription_outbox"."subscription_revision" > 0)
);
;
CREATE TABLE IF NOT EXISTS "app_subscription_paid_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"merchant_key" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_invoice_id" text NOT NULL,
	"stripe_price_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"provider_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_subscription_paid_periods_source_check" CHECK ("app_subscription_paid_periods"."stripe_invoice_id" ~ '^in_[A-Za-z0-9]+$' AND "app_subscription_paid_periods"."stripe_price_id" ~ '^price_[A-Za-z0-9]+$' AND "app_subscription_paid_periods"."quantity" > 0 AND "app_subscription_paid_periods"."period_end" > "app_subscription_paid_periods"."period_start" AND "app_subscription_paid_periods"."provider_digest" ~ '^[0-9a-f]{64}$')
);
;
CREATE TABLE IF NOT EXISTS "app_subscription_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"eligibility_principal_id" uuid NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"command_id" uuid NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_subscription_trials_duration_check" CHECK (extract(epoch FROM "app_subscription_trials"."ends_at" - "app_subscription_trials"."starts_at") = 604800)
);
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('221a0da492f034d97290e95bb58372a90249c5ccbd307c28ca5b84569bdae69c', 1796083200028);
-- apply 0402_app_billing_registration_constraints
CREATE UNIQUE INDEX "app_billing_accounts_app_key_idx" ON "app_billing_accounts" USING btree ("app_id","external_account_key");
;
CREATE UNIQUE INDEX "app_billing_accounts_id_app_idx" ON "app_billing_accounts" USING btree ("id","app_id");
;
CREATE UNIQUE INDEX "app_billing_customers_binding_idx" ON "app_billing_customers" USING btree ("billing_account_id","merchant_id");
;
CREATE UNIQUE INDEX "app_billing_customers_provider_idx" ON "app_billing_customers" USING btree ("merchant_id","stripe_customer_id");
;
CREATE UNIQUE INDEX "app_billing_members_member_idx" ON "app_billing_members" USING btree ("billing_account_id","user_id");
;
CREATE UNIQUE INDEX "app_billing_plan_revisions_key_idx" ON "app_billing_plan_revisions" USING btree ("app_id","product_family_key","plan_key","revision");
;
CREATE UNIQUE INDEX "app_billing_plan_revisions_scope_idx" ON "app_billing_plan_revisions" USING btree ("id","app_id","merchant_id","product_family_key");
;
CREATE UNIQUE INDEX "app_billing_scopes_id_app_mode_idx" ON "app_billing_scopes" USING btree ("id","app_id","livemode");
;
CREATE UNIQUE INDEX "app_billing_scopes_family_idx" ON "app_billing_scopes" USING btree ("billing_account_id","product_family_key","livemode");
;
CREATE UNIQUE INDEX "app_billing_scopes_id_org_idx" ON "app_billing_scopes" USING btree ("id","organization_id");
;
CREATE UNIQUE INDEX "app_billing_scopes_identity_idx" ON "app_billing_scopes" USING btree ("id","app_id","merchant_id","product_family_key");
;
CREATE UNIQUE INDEX "app_billing_seats_active_subject_idx" ON "app_billing_seats" USING btree ("billing_scope_id","subject") WHERE "app_billing_seats"."revoked_at" IS NULL;
;
CREATE UNIQUE INDEX "app_billing_seats_operation_idx" ON "app_billing_seats" USING btree ("billing_scope_id","idempotency_key");
;
CREATE UNIQUE INDEX "app_subscription_outbox_transition_idx" ON "app_subscription_outbox" USING btree ("subscription_id","subscription_revision","kind");
;
CREATE UNIQUE INDEX "app_subscription_paid_periods_invoice_idx" ON "app_subscription_paid_periods" USING btree ("merchant_key","livemode","stripe_invoice_id");
;
CREATE UNIQUE INDEX "app_subscription_trials_eligibility_idx" ON "app_subscription_trials" USING btree ("app_id","eligibility_principal_id","livemode");
;
CREATE UNIQUE INDEX "app_subscription_trials_command_idx" ON "app_subscription_trials" USING btree ("command_id");
;
CREATE UNIQUE INDEX "billing_merchants_id_mode_idx" ON "billing_merchants" USING btree ("id","livemode");
;
CREATE UNIQUE INDEX "billing_merchants_account_mode_idx" ON "billing_merchants" USING btree ("provider_account_key","livemode");
;
ALTER TABLE "app_billing_accounts" ADD CONSTRAINT "app_billing_accounts_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_accounts" ADD CONSTRAINT "app_billing_accounts_eligibility_principal_id_users_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_customers" ADD CONSTRAINT "app_billing_customers_billing_account_id_app_billing_accounts_id_fk" FOREIGN KEY ("billing_account_id") REFERENCES "app_billing_accounts"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_customers" ADD CONSTRAINT "app_billing_customers_merchant_id_billing_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "billing_merchants"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_members" ADD CONSTRAINT "app_billing_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_members" ADD CONSTRAINT "app_billing_members_account_fk" FOREIGN KEY ("billing_account_id","app_id") REFERENCES "app_billing_accounts"("id","app_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_plan_revisions" ADD CONSTRAINT "app_billing_plan_revisions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_plan_revisions" ADD CONSTRAINT "app_billing_plan_revisions_merchant_id_billing_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "billing_merchants"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_merchant_id_billing_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "billing_merchants"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_merchant_mode_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_scopes" ADD CONSTRAINT "app_billing_scopes_account_fk" FOREIGN KEY ("billing_account_id","app_id") REFERENCES "app_billing_accounts"("id","app_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_seats" ADD CONSTRAINT "app_billing_seats_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_subscription_outbox" ADD CONSTRAINT "app_subscription_outbox_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_subscription_paid_periods" ADD CONSTRAINT "app_subscription_paid_periods_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_subscription_paid_periods" ADD CONSTRAINT "app_subscription_paid_periods_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_eligibility_principal_id_users_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_scope_mode_fk" FOREIGN KEY ("billing_scope_id","app_id","livemode") REFERENCES "app_billing_scopes"("id","app_id","livemode") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_merchants" ADD CONSTRAINT "billing_merchants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE restrict ON UPDATE no action;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('f5e2b4c961862b7d81198915e5037ded03b77be732903be418b6912a51ca5c52', 1796083200029);
-- apply 0403_subscription_app_scope_columns
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "plan_revision_id" uuid;
;
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "trial_start" timestamp with time zone;
;
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "trial_end" timestamp with time zone;
;
ALTER TABLE "billing_subscription_revisions" ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;
;
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "plan_revision_id" uuid;
;
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "trial_start" timestamp with time zone;
;
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "trial_end" timestamp with time zone;
;
ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "target_quantity" integer DEFAULT 1 NOT NULL;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN IF NOT EXISTS "target_plan_revision_id" uuid;
;
ALTER TABLE "billing_subscription_event_receipts" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "billing_subscription_event_receipts" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
ALTER TABLE "billing_subscription_incidents" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "billing_subscription_incidents" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
ALTER TABLE "subscription_billing_fences" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "subscription_billing_fences" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;
;
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "access" text DEFAULT 'granted' NOT NULL;
;
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "features" jsonb DEFAULT '[]'::jsonb NOT NULL;
;
ALTER TABLE "organization_entitlements" ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;
;
ALTER TABLE "subscription_allowance_periods" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "subscription_allowance_periods" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
ALTER TABLE "subscription_allowance_periods" ADD COLUMN IF NOT EXISTS "grant_source" text DEFAULT 'paid_invoice' NOT NULL;
;
ALTER TABLE "subscription_allowance_periods" ADD COLUMN IF NOT EXISTS "trial_claim_id" uuid;
;
ALTER TABLE "subscription_allowance_transactions" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "subscription_allowance_transactions" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
ALTER TABLE "subscription_allowance_transactions" ADD COLUMN IF NOT EXISTS "trial_claim_id" uuid;
;
ALTER TABLE "billing_funding_allocations" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "billing_funding_allocations" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
ALTER TABLE "billing_funding_reservations" ADD COLUMN IF NOT EXISTS "billing_scope_id" uuid;
;
ALTER TABLE "billing_funding_reservations" ADD COLUMN IF NOT EXISTS "merchant_key" text DEFAULT 'platform' NOT NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('ccecd631206893dcec7d3eb41dc50a2acf0ef908e80dd4daae5635f47e9ffbcc', 1796083200030);
-- apply 0404_subscription_app_scope_constraints
ALTER TABLE "organization_entitlements" DROP CONSTRAINT IF EXISTS "organization_entitlements_pkey";
;
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_pkey" PRIMARY KEY ("id");
;
ALTER TABLE "billing_subscription_revisions" DROP CONSTRAINT IF EXISTS "billing_subscription_revisions_status_check";
;
ALTER TABLE "billing_subscription_revisions" DROP CONSTRAINT IF EXISTS "billing_subscription_revisions_plan_check";
;
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT IF EXISTS "billing_subscriptions_status_check";
;
ALTER TABLE "billing_subscriptions" DROP CONSTRAINT IF EXISTS "billing_subscriptions_plan_check";
;
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT IF EXISTS "billing_subscription_commands_intent_check";
;
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT IF EXISTS "billing_subscription_commands_status_shape_check";
;
ALTER TABLE "organization_entitlements" DROP CONSTRAINT IF EXISTS "organization_entitlements_plan_state_check";
;
ALTER TABLE "subscription_allowance_periods" DROP CONSTRAINT IF EXISTS "subscription_allowance_periods_invoice_id_check";
;
ALTER TABLE "subscription_allowance_periods" DROP CONSTRAINT IF EXISTS "subscription_allowance_periods_plan_catalog_check";
;
DROP INDEX IF EXISTS "billing_subscription_revisions_provider_event_idx";
;
DROP INDEX IF EXISTS "billing_subscriptions_stripe_subscription_idx";
;
DROP INDEX IF EXISTS "billing_subscriptions_stripe_item_idx";
;
DROP INDEX IF EXISTS "billing_subscriptions_live_org_idx";
;
DROP INDEX IF EXISTS "billing_subscription_commands_org_idempotency_idx";
;
DROP INDEX IF EXISTS "billing_subscription_commands_provider_idempotency_idx";
;
DROP INDEX IF EXISTS "billing_subscription_commands_live_checkout_org_idx";
;
DROP INDEX IF EXISTS "billing_subscription_event_receipts_event_idx";
;
DROP INDEX IF EXISTS "subscription_billing_fences_provider_event_idx";
;
DROP INDEX IF EXISTS "subscription_allowance_periods_invoice_idx";
;
DROP INDEX IF EXISTS "subscription_allowance_transactions_source_invoice_idx";
;
ALTER TABLE "subscription_allowance_periods" ALTER COLUMN "stripe_invoice_id" DROP NOT NULL;
;
ALTER TABLE "billing_subscription_revisions" ADD CONSTRAINT "billing_subscription_revisions_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscription_revisions" ADD CONSTRAINT "billing_subscription_revisions_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscription_event_receipts" ADD CONSTRAINT "billing_subscription_event_receipts_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscription_incidents" ADD CONSTRAINT "billing_subscription_incidents_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "subscription_billing_fences" ADD CONSTRAINT "subscription_billing_fences_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "subscription_allowance_periods" ADD CONSTRAINT "subscription_allowance_periods_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "subscription_allowance_transactions" ADD CONSTRAINT "subscription_allowance_transactions_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_funding_allocations" ADD CONSTRAINT "billing_funding_allocations_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_funding_reservations" ADD CONSTRAINT "billing_funding_reservations_billing_scope_id_organization_id_app_billing_scopes_id_organization_id_fk" FOREIGN KEY ("billing_scope_id","organization_id") REFERENCES "app_billing_scopes"("id","organization_id") ON DELETE restrict ON UPDATE no action;
;
CREATE UNIQUE INDEX "billing_subscriptions_live_scope_idx" ON "billing_subscriptions" USING btree ("billing_scope_id") WHERE "billing_subscriptions"."billing_scope_id" IS NOT NULL AND "billing_subscriptions"."status" IN ('pending','incomplete','trialing','active','grace','past_due','unpaid','paused');
;
CREATE UNIQUE INDEX "billing_subscription_commands_scope_idempotency_idx" ON "billing_subscription_commands" USING btree ("billing_scope_id","idempotency_key") WHERE "billing_subscription_commands"."billing_scope_id" IS NOT NULL;
;
CREATE UNIQUE INDEX "billing_subscription_commands_live_scope_idx" ON "billing_subscription_commands" USING btree ("billing_scope_id") WHERE "billing_subscription_commands"."billing_scope_id" IS NOT NULL AND "billing_subscription_commands"."kind" = 'checkout' AND "billing_subscription_commands"."status" IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED');
;
CREATE UNIQUE INDEX "organization_entitlements_legacy_org_idx" ON "organization_entitlements" USING btree ("organization_id") WHERE "organization_entitlements"."billing_scope_id" IS NULL;
;
CREATE UNIQUE INDEX "organization_entitlements_scope_idx" ON "organization_entitlements" USING btree ("billing_scope_id") WHERE "organization_entitlements"."billing_scope_id" IS NOT NULL;
;
CREATE UNIQUE INDEX "billing_subscription_revisions_provider_event_idx" ON "billing_subscription_revisions" USING btree ("merchant_key","provider","provider_environment","provider_event_id") WHERE "billing_subscription_revisions"."provider_event_id" IS NOT NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('cf9f311784a9f2a98c8337d27b0db2760a453088ca14bf77188552f0b9746bb4', 1796083200031);
-- apply 0405_subscription_app_scope_guards
CREATE UNIQUE INDEX "billing_subscriptions_stripe_subscription_idx" ON "billing_subscriptions" USING btree ("merchant_key","provider","provider_environment","stripe_subscription_id");
;
CREATE UNIQUE INDEX "billing_subscriptions_stripe_item_idx" ON "billing_subscriptions" USING btree ("merchant_key","provider","provider_environment","stripe_subscription_item_id");
;
CREATE UNIQUE INDEX "billing_subscriptions_live_org_idx" ON "billing_subscriptions" USING btree ("organization_id") WHERE "billing_subscriptions"."billing_scope_id" IS NULL AND "billing_subscriptions"."status" IN ('pending','incomplete','active','grace','past_due','unpaid');
;
CREATE UNIQUE INDEX "billing_subscription_commands_org_idempotency_idx" ON "billing_subscription_commands" USING btree ("organization_id","idempotency_key") WHERE "billing_subscription_commands"."billing_scope_id" IS NULL;
;
CREATE UNIQUE INDEX "billing_subscription_commands_provider_idempotency_idx" ON "billing_subscription_commands" USING btree ("merchant_key","provider_idempotency_key");
;
CREATE UNIQUE INDEX "billing_subscription_commands_live_checkout_org_idx" ON "billing_subscription_commands" USING btree ("organization_id") WHERE "billing_subscription_commands"."billing_scope_id" IS NULL AND "billing_subscription_commands"."kind" = 'checkout' AND "billing_subscription_commands"."status" IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED');
;
CREATE UNIQUE INDEX "billing_subscription_event_receipts_event_idx" ON "billing_subscription_event_receipts" USING btree ("merchant_key","livemode","provider_event_id");
;
CREATE UNIQUE INDEX "subscription_billing_fences_provider_event_idx" ON "subscription_billing_fences" USING btree ("merchant_key","provider_event_id") WHERE "subscription_billing_fences"."provider_event_id" IS NOT NULL;
;
CREATE UNIQUE INDEX "subscription_allowance_periods_invoice_idx" ON "subscription_allowance_periods" USING btree ("merchant_key","provider","provider_environment","stripe_invoice_id");
;
CREATE UNIQUE INDEX "subscription_allowance_transactions_source_invoice_idx" ON "subscription_allowance_transactions" USING btree ("merchant_key","source_invoice_id") WHERE "subscription_allowance_transactions"."source_invoice_id" IS NOT NULL;
;
ALTER TABLE "billing_subscription_revisions" ADD CONSTRAINT "billing_subscription_revisions_app_shape" CHECK (("billing_subscription_revisions"."billing_scope_id" IS NULL AND "billing_subscription_revisions"."plan_revision_id" IS NULL AND "billing_subscription_revisions"."merchant_key" = 'platform' AND "billing_subscription_revisions"."trial_start" IS NULL AND "billing_subscription_revisions"."trial_end" IS NULL AND "billing_subscription_revisions"."status" NOT IN ('trialing','paused')) OR ("billing_subscription_revisions"."billing_scope_id" IS NOT NULL AND "billing_subscription_revisions"."plan_revision_id" IS NOT NULL AND "billing_subscription_revisions"."quantity" > 0 AND (("billing_subscription_revisions"."trial_start" IS NULL AND "billing_subscription_revisions"."trial_end" IS NULL AND "billing_subscription_revisions"."status" <> 'trialing') OR ("billing_subscription_revisions"."trial_start" IS NOT NULL AND "billing_subscription_revisions"."trial_end" IS NOT NULL AND extract(epoch FROM "billing_subscription_revisions"."trial_end" - "billing_subscription_revisions"."trial_start") BETWEEN 1 AND 604800))));
;
ALTER TABLE "billing_subscription_revisions" ADD CONSTRAINT "billing_subscription_revisions_status_check" CHECK ("billing_subscription_revisions"."status" IN ('pending','incomplete','trialing','paused','active','grace','past_due','unpaid','canceled','incomplete_expired'));
;
ALTER TABLE "billing_subscription_revisions" ADD CONSTRAINT "billing_subscription_revisions_plan_check" CHECK (("billing_subscription_revisions"."billing_scope_id" IS NOT NULL OR "billing_subscription_revisions"."plan_key" IN ('plus_monthly','pro_monthly')) AND ("billing_subscription_revisions"."pending_plan_key" IS NULL OR "billing_subscription_revisions"."billing_scope_id" IS NOT NULL OR "billing_subscription_revisions"."pending_plan_key" IN ('plus_monthly','pro_monthly')) AND ("billing_subscription_revisions"."pending_plan_key" IS NULL OR "billing_subscription_revisions"."pending_plan_key" <> "billing_subscription_revisions"."plan_key") AND length(btrim("billing_subscription_revisions"."catalog_version")) > 0);
;
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_app_shape" CHECK (("billing_subscriptions"."billing_scope_id" IS NULL AND "billing_subscriptions"."plan_revision_id" IS NULL AND "billing_subscriptions"."merchant_key" = 'platform' AND "billing_subscriptions"."trial_start" IS NULL AND "billing_subscriptions"."trial_end" IS NULL AND "billing_subscriptions"."status" NOT IN ('trialing','paused')) OR ("billing_subscriptions"."billing_scope_id" IS NOT NULL AND "billing_subscriptions"."plan_revision_id" IS NOT NULL AND "billing_subscriptions"."quantity" > 0 AND (("billing_subscriptions"."trial_start" IS NULL AND "billing_subscriptions"."trial_end" IS NULL AND "billing_subscriptions"."status" <> 'trialing') OR ("billing_subscriptions"."trial_start" IS NOT NULL AND "billing_subscriptions"."trial_end" IS NOT NULL AND extract(epoch FROM "billing_subscriptions"."trial_end" - "billing_subscriptions"."trial_start") BETWEEN 1 AND 604800))));
;
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_status_check" CHECK ("billing_subscriptions"."status" IN ('pending','incomplete','trialing','paused','active','grace','past_due','unpaid','canceled','incomplete_expired'));
;
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_plan_check" CHECK (("billing_subscriptions"."billing_scope_id" IS NOT NULL OR "billing_subscriptions"."plan_key" IN ('plus_monthly','pro_monthly')) AND ("billing_subscriptions"."pending_plan_key" IS NULL OR "billing_subscriptions"."billing_scope_id" IS NOT NULL OR "billing_subscriptions"."pending_plan_key" IN ('plus_monthly','pro_monthly')) AND length(btrim("billing_subscriptions"."catalog_version")) > 0);
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_intent_check" CHECK (true) NOT VALID;
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_status_shape_check" CHECK (true) NOT VALID;
;
ALTER TABLE "organization_entitlements" ADD CONSTRAINT "organization_entitlements_plan_state_check" CHECK (true) NOT VALID;
;
ALTER TABLE "subscription_allowance_periods" ADD CONSTRAINT "subscription_allowance_periods_invoice_id_check" CHECK (true) NOT VALID;
;
ALTER TABLE "subscription_allowance_periods" ADD CONSTRAINT "subscription_allowance_periods_plan_catalog_check" CHECK (("subscription_allowance_periods"."billing_scope_id" IS NOT NULL OR "subscription_allowance_periods"."plan_key" IN ('plus_monthly','pro_monthly')) AND length(btrim("subscription_allowance_periods"."catalog_version")) > 0);
;
CREATE FUNCTION validate_app_billing_registration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s record; p record; c record;
BEGIN
  IF TG_TABLE_NAME = 'app_billing_plan_revisions' THEN
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND OLD.published_at IS NOT NULL AND (to_jsonb(OLD) - 'retired_at') IS DISTINCT FROM (to_jsonb(NEW) - 'retired_at')) THEN
      RAISE EXCEPTION 'Published billing plan revisions are immutable';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM apps a JOIN billing_merchants m ON m.organization_id = a.organization_id WHERE a.id = NEW.app_id AND m.id = NEW.merchant_id) THEN RAISE EXCEPTION 'Billing plan merchant does not own app'; END IF;
  ELSIF TG_TABLE_NAME = 'app_billing_accounts' THEN
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (OLD.app_id,OLD.external_account_key,OLD.eligibility_principal_id) IS DISTINCT FROM (NEW.app_id,NEW.external_account_key,NEW.eligibility_principal_id)) THEN RAISE EXCEPTION 'Billing account eligibility identity is immutable'; END IF;
  ELSIF TG_TABLE_NAME = 'app_billing_scopes' THEN
    IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'fenced_at') IS DISTINCT FROM (to_jsonb(NEW) - 'fenced_at')) THEN RAISE EXCEPTION 'Billing scope identity is immutable'; END IF;
    IF NOT EXISTS (SELECT 1 FROM apps a JOIN billing_merchants m ON m.organization_id = a.organization_id JOIN app_billing_accounts b ON b.app_id = a.id WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id AND m.id = NEW.merchant_id AND b.id = NEW.billing_account_id) THEN RAISE EXCEPTION 'Billing scope owner mismatch'; END IF;
  ELSIF TG_TABLE_NAME = 'app_subscription_trials' THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Trial eligibility cannot be reset'; END IF;
    SELECT sc.*, ba.eligibility_principal_id INTO s FROM app_billing_scopes sc JOIN app_billing_accounts ba ON ba.id = sc.billing_account_id WHERE sc.id = NEW.billing_scope_id;
    SELECT * INTO p FROM app_billing_plan_revisions WHERE id = NEW.plan_revision_id;
    SELECT * INTO c FROM billing_subscription_commands WHERE id = NEW.command_id;
    IF s.id IS NULL OR p.id IS NULL OR c.id IS NULL OR s.app_id <> NEW.app_id OR s.eligibility_principal_id <> NEW.eligibility_principal_id OR (p.app_id,p.merchant_id,p.product_family_key) IS DISTINCT FROM (s.app_id,s.merchant_id,s.product_family_key) OR c.billing_scope_id IS DISTINCT FROM s.id OR c.target_plan_revision_id IS DISTINCT FROM p.id OR c.kind <> 'checkout' THEN RAISE EXCEPTION 'Trial eligibility source mismatch'; END IF;
  ELSIF TG_TABLE_NAME = 'app_billing_customers' THEN
    IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Provider customer binding is immutable'; END IF;
    IF NOT EXISTS (SELECT 1 FROM billing_subscription_commands cmd JOIN app_billing_scopes sc ON sc.id = cmd.billing_scope_id WHERE cmd.id = NEW.command_id AND sc.billing_account_id = NEW.billing_account_id AND sc.merchant_id = NEW.merchant_id AND cmd.status = 'OUTCOME_UNKNOWN') THEN RAISE EXCEPTION 'Customer binding requires its durable provider command'; END IF;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_plans_authority BEFORE INSERT OR UPDATE OR DELETE ON app_billing_plan_revisions FOR EACH ROW EXECUTE FUNCTION validate_app_billing_registration();
;
CREATE TRIGGER app_billing_accounts_authority BEFORE INSERT OR UPDATE OR DELETE ON app_billing_accounts FOR EACH ROW EXECUTE FUNCTION validate_app_billing_registration();
;
CREATE TRIGGER app_billing_scopes_authority BEFORE INSERT OR UPDATE OR DELETE ON app_billing_scopes FOR EACH ROW EXECUTE FUNCTION validate_app_billing_registration();
;
CREATE TRIGGER app_subscription_trials_authority BEFORE INSERT OR UPDATE OR DELETE ON app_subscription_trials FOR EACH ROW EXECUTE FUNCTION validate_app_billing_registration();
;
CREATE TRIGGER app_billing_customers_authority BEFORE INSERT OR UPDATE OR DELETE ON app_billing_customers FOR EACH ROW EXECUTE FUNCTION validate_app_billing_registration();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('f5e9c3e2ea759500553d7c6e7b7cef46bf805f8d5669812d9d9e4dc620eeb5bb', 1796083200032);
-- apply 0406_subscription_app_source_guards
CREATE FUNCTION validate_subscription_app_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d jsonb := to_jsonb(NEW); sc record; m record; p record; sub record; parent_scope uuid; parent_org uuid; source_id uuid; trial record;
BEGIN
  IF TG_TABLE_NAME = 'billing_merchants' AND TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'enabled') IS DISTINCT FROM (d - 'enabled') THEN RAISE EXCEPTION 'Billing merchant identity is immutable'; END IF;
  IF TG_TABLE_NAME = 'billing_subscription_commands' AND TG_OP = 'UPDATE' AND ((to_jsonb(OLD)->>'target_plan_revision_id') IS DISTINCT FROM (d->>'target_plan_revision_id') OR (to_jsonb(OLD)->>'target_quantity') IS DISTINCT FROM (d->>'target_quantity')) THEN RAISE EXCEPTION 'App command target is immutable'; END IF;
  IF TG_TABLE_NAME = 'app_subscription_paid_periods' AND TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Settled paid period evidence is immutable'; END IF;
  IF TG_TABLE_NAME = 'app_subscription_outbox' AND TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'delivered_at') IS DISTINCT FROM (d - 'delivered_at') THEN RAISE EXCEPTION 'Subscription delivery identity is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD)->>'billing_scope_id') IS DISTINCT FROM (d->>'billing_scope_id') THEN RAISE EXCEPTION 'Billing scope cannot change'; END IF;
  IF d->>'billing_scope_id' IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = (d->>'billing_scope_id')::uuid;
    SELECT * INTO m FROM billing_merchants WHERE id = sc.merchant_id;
    IF sc.id IS NULL OR m.id IS NULL OR (d ? 'organization_id' AND sc.organization_id <> (d->>'organization_id')::uuid) OR (d ? 'merchant_key' AND m.provider_account_key <> d->>'merchant_key') OR (d ? 'provider_environment' AND d->>'provider_environment' <> CASE WHEN m.livemode THEN 'live' ELSE 'test' END) OR (d ? 'livemode' AND m.livemode <> (d->>'livemode')::boolean) THEN RAISE EXCEPTION 'Billing merchant, environment or owner mismatch'; END IF;
    IF d->>'plan_revision_id' IS NOT NULL OR d->>'target_plan_revision_id' IS NOT NULL THEN
      SELECT * INTO p FROM app_billing_plan_revisions WHERE id = COALESCE(d->>'plan_revision_id',d->>'target_plan_revision_id')::uuid;
      IF p.id IS NULL OR (p.app_id,p.merchant_id,p.product_family_key) IS DISTINCT FROM (sc.app_id,sc.merchant_id,sc.product_family_key) THEN RAISE EXCEPTION 'Billing plan belongs to another scope'; END IF;
      IF d ? 'plan_key' AND d->>'plan_key' <> p.plan_key THEN RAISE EXCEPTION 'Billing plan key mismatch'; END IF;
    END IF;
    IF d ? 'stripe_customer_id' AND NOT EXISTS (SELECT 1 FROM app_billing_customers c WHERE c.billing_account_id = sc.billing_account_id AND c.merchant_id = sc.merchant_id AND c.stripe_customer_id = d->>'stripe_customer_id') THEN RAISE EXCEPTION 'Billing customer authority mismatch'; END IF;
    IF TG_TABLE_NAME = 'organization_entitlements' AND (d->>'entitlement_effective')::boolean AND (sc.fenced_at IS NOT NULL OR NOT m.enabled OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = sc.organization_id AND (NOT o.is_active OR o.account_lifecycle_state <> 'active' OR o.paid_work_fenced_at IS NOT NULL)) OR NOT EXISTS (SELECT 1 FROM apps a JOIN app_billing_accounts b ON b.app_id = a.id WHERE a.id = sc.app_id AND a.is_active AND a.is_approved AND a.review_status = 'approved' AND b.id = sc.billing_account_id AND b.deleted_at IS NULL)) THEN RAISE EXCEPTION 'App subscription activation is fenced'; END IF;
  END IF;
  source_id := COALESCE(d->>'subscription_id',d->>'source_subscription_id',d->>'result_subscription_id')::uuid;
  IF source_id IS NOT NULL THEN
    SELECT * INTO sub FROM billing_subscriptions WHERE id = source_id;
    IF sub.id IS NULL OR sub.billing_scope_id IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR (d ? 'organization_id' AND sub.organization_id <> (d->>'organization_id')::uuid) THEN RAISE EXCEPTION 'Subscription child source scope mismatch'; END IF;
    IF TG_TABLE_NAME = 'organization_entitlements' AND (d->>'source_subscription_revision')::bigint <> sub.lifecycle_revision THEN RAISE EXCEPTION 'Entitlement source revision is stale'; END IF;
  END IF;
  IF d->>'allowance_period_id' IS NOT NULL THEN
    SELECT billing_scope_id,organization_id INTO parent_scope,parent_org FROM subscription_allowance_periods WHERE id = (d->>'allowance_period_id')::uuid;
    IF parent_scope IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR parent_org IS DISTINCT FROM (d->>'organization_id')::uuid THEN RAISE EXCEPTION 'Allowance child scope mismatch'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'billing_funding_allocations' THEN
    SELECT billing_scope_id,organization_id INTO parent_scope,parent_org FROM billing_funding_reservations WHERE id = (d->>'reservation_id')::uuid;
    IF parent_scope IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR parent_org IS DISTINCT FROM (d->>'organization_id')::uuid THEN RAISE EXCEPTION 'Funding child scope mismatch'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'subscription_allowance_periods' AND d->>'grant_source' = 'trial_claim' THEN
    SELECT * INTO trial FROM app_subscription_trials WHERE id = (d->>'trial_claim_id')::uuid;
    IF trial.id IS NULL OR trial.billing_scope_id IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR trial.starts_at <> (d->>'period_start')::timestamptz OR trial.ends_at <> (d->>'period_end')::timestamptz THEN RAISE EXCEPTION 'Trial allowance source mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
;
DO $$ DECLARE tab text; BEGIN FOREACH tab IN ARRAY ARRAY['organization_subscription_authorities','billing_merchants','billing_subscriptions','billing_subscription_revisions','billing_subscription_commands','billing_subscription_event_receipts','billing_subscription_incidents','subscription_billing_fences','organization_entitlements','subscription_allowance_periods','subscription_allowance_transactions','billing_funding_reservations','billing_funding_allocations','app_subscription_paid_periods','app_subscription_outbox'] LOOP EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION validate_subscription_app_source()',tab || '_app_source',tab); END LOOP; END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('f730efc7397ed9dc9f5539431f9baf8b2373c282a487dc3d44ffb30271780e22', 1796083200033);
-- apply 0407_app_delegations
CREATE TABLE "app_client_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"owner_organization_id" uuid NOT NULL,
	"billing_environment" text NOT NULL,
	"secret_hashes" jsonb NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"allowed_scopes" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_client_registrations_id_app_idx" UNIQUE("id","app_id"),
	CONSTRAINT "app_client_registrations_billing_environment_check" CHECK ("app_client_registrations"."billing_environment" IN ('test', 'live')),
	CONSTRAINT "app_client_registrations_revision_check" CHECK ("app_client_registrations"."revision" > 0)
);
;
CREATE TABLE "app_delegations" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"authorization_code_hash" text NOT NULL,
	"client_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"organization_id" uuid,
	"registration_revision" integer NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_delegations_authorization_code_hash_unique" UNIQUE("authorization_code_hash"),
	CONSTRAINT "app_delegations_digest_check" CHECK ("app_delegations"."token_hash" ~ '^[0-9a-f]{64}$' AND "app_delegations"."authorization_code_hash" ~ '^[0-9a-f]{64}$')
);
;
ALTER TABLE "app_client_registrations" ADD CONSTRAINT "app_client_registrations_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
;
ALTER TABLE "app_client_registrations" ADD CONSTRAINT "app_client_registrations_owner_organization_id_organizations_id_fk" FOREIGN KEY ("owner_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
;
ALTER TABLE "app_delegations" ADD CONSTRAINT "app_delegations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
;
ALTER TABLE "app_delegations" ADD CONSTRAINT "app_delegations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
;
ALTER TABLE "app_delegations" ADD CONSTRAINT "app_delegations_client_app_fk" FOREIGN KEY ("client_id","app_id") REFERENCES "public"."app_client_registrations"("id","app_id") ON DELETE cascade ON UPDATE no action;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('06b9db815d41708a749250f7d2420cd1962cb9b5bbd253a8ebdcf91493e8335d', 1796083200034);
-- apply 0408_app_billing_command_intents
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT "billing_subscription_commands_intent_check";
;
DROP INDEX "billing_subscription_commands_org_idempotency_idx";
;
DROP INDEX "billing_subscription_commands_live_checkout_org_idx";
;
DROP INDEX "billing_subscription_commands_live_scope_idx";
;
ALTER TABLE "app_billing_accounts" ADD COLUMN "external_reference" text;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN "app_id" uuid;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN "livemode" boolean;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN "merchant_id" uuid;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN "client_registration_id" uuid;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN "request_payload" jsonb;
;
ALTER TABLE "billing_subscription_commands" ADD COLUMN "provider_result" jsonb;
;
UPDATE billing_subscription_commands c SET app_id = s.app_id, livemode = s.livemode, merchant_id = s.merchant_id FROM app_billing_scopes s WHERE c.billing_scope_id = s.id;
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_commands_scope_app_mode_fk" FOREIGN KEY ("billing_scope_id","app_id","livemode") REFERENCES "app_billing_scopes"("id","app_id","livemode") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_commands_merchant_mode_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_commands_registration_app_fk" FOREIGN KEY ("client_registration_id","app_id") REFERENCES "app_client_registrations"("id","app_id") ON DELETE restrict ON UPDATE no action;
;
CREATE UNIQUE INDEX "billing_commands_admin_idempotency_idx" ON "billing_subscription_commands" USING btree ("app_id","livemode","idempotency_key") WHERE "billing_subscription_commands"."billing_scope_id" IS NULL AND "billing_subscription_commands"."app_id" IS NOT NULL;
;
CREATE UNIQUE INDEX "billing_subscription_commands_org_idempotency_idx" ON "billing_subscription_commands" USING btree ("organization_id","idempotency_key") WHERE "billing_subscription_commands"."billing_scope_id" IS NULL AND "billing_subscription_commands"."app_id" IS NULL;
;
CREATE UNIQUE INDEX "billing_subscription_commands_live_checkout_org_idx" ON "billing_subscription_commands" USING btree ("organization_id") WHERE "billing_subscription_commands"."billing_scope_id" IS NULL AND "billing_subscription_commands"."app_id" IS NULL AND "billing_subscription_commands"."kind" = 'checkout' AND "billing_subscription_commands"."status" IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED');
;
CREATE UNIQUE INDEX "billing_subscription_commands_live_scope_idx" ON "billing_subscription_commands" USING btree ("billing_scope_id") WHERE "billing_subscription_commands"."billing_scope_id" IS NOT NULL AND "billing_subscription_commands"."kind" IN ('checkout','upgrade','downgrade','cancel','resume') AND "billing_subscription_commands"."status" IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED');
;
ALTER TABLE "app_billing_accounts" ADD CONSTRAINT "app_billing_accounts_external_reference_check" CHECK ("app_billing_accounts"."external_reference" IS NULL OR length(btrim("app_billing_accounts"."external_reference")) BETWEEN 1 AND 200);
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_commands_app_identity_check" CHECK (("billing_subscription_commands"."app_id" IS NULL AND "billing_subscription_commands"."livemode" IS NULL AND "billing_subscription_commands"."merchant_id" IS NULL AND "billing_subscription_commands"."client_registration_id" IS NULL AND "billing_subscription_commands"."request_payload" IS NULL AND "billing_subscription_commands"."provider_result" IS NULL AND "billing_subscription_commands"."billing_scope_id" IS NULL) OR ("billing_subscription_commands"."app_id" IS NOT NULL AND "billing_subscription_commands"."livemode" IS NOT NULL AND ("billing_subscription_commands"."billing_scope_id" IS NULL OR "billing_subscription_commands"."merchant_id" IS NOT NULL)));
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_intent_check" CHECK (true) NOT VALID;
;
ALTER TABLE billing_subscription_commands DROP CONSTRAINT IF EXISTS "billing_subscription_commands_schedule_predecessor_check";
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT "billing_subscription_commands_schedule_predecessor_check" CHECK (app_id IS NOT NULL OR (("billing_subscription_commands"."schedule_predecessor_command_id" IS NULL OR ("billing_subscription_commands"."kind" IN ('cancel','resume') AND "billing_subscription_commands"."schedule_predecessor_command_id" <> "billing_subscription_commands"."id")) AND ("billing_subscription_commands"."kind" <> 'resume' OR ("billing_subscription_commands"."cancellation_dispatch_state" IS NULL AND "billing_subscription_commands"."status" <> 'APPLIED') OR "billing_subscription_commands"."schedule_predecessor_command_id" IS NOT NULL)));
;
ALTER TABLE billing_subscription_commands DROP CONSTRAINT IF EXISTS "billing_subscription_commands_cancellation_result_check";
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT "billing_subscription_commands_cancellation_result_check" CHECK (true) NOT VALID;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('01e123bd4d5a80bfee9b09d0c3987dbce2ddd9b0a40af536b6d678524da3c226', 1796083200035);
-- apply 0409_app_billing_command_guards
CREATE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND (NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER billing_commands_app_intent BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION validate_app_billing_command_intent();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('6b1f264275ad84306fa17ce7b34fc917e97b9e3bb077c467e54e1d28ba405d9c', 1796083200036);
-- apply 0410_app_billing_update_quotes
CREATE TABLE "app_billing_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"subscription_revision" bigint NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"provider_preview" jsonb NOT NULL,
	"digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_by_command_id" uuid,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "app_billing_quotes_shape_check" CHECK ("app_billing_quotes"."subscription_revision" > 0 AND "app_billing_quotes"."quantity" > 0 AND "app_billing_quotes"."digest" ~ '^[0-9a-f]{64}$' AND "app_billing_quotes"."expires_at" > "app_billing_quotes"."created_at" AND ("app_billing_quotes"."consumed_by_command_id" IS NULL) = ("app_billing_quotes"."consumed_at" IS NULL))
);
;
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_subscription_id_billing_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "billing_subscriptions"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_consumed_by_command_id_billing_subscription_commands_id_fk" FOREIGN KEY ("consumed_by_command_id") REFERENCES "billing_subscription_commands"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_scope_fk" FOREIGN KEY ("billing_scope_id","app_id","livemode") REFERENCES "app_billing_scopes"("id","app_id","livemode") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_merchant_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
;
CREATE INDEX "app_billing_quotes_scope_created_idx" ON "app_billing_quotes" USING btree ("billing_scope_id","created_at");
;
CREATE FUNCTION validate_app_billing_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; subscription record; plan record; command record;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - ARRAY['consumed_by_command_id','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['consumed_by_command_id','consumed_at']) THEN RAISE EXCEPTION 'Billing quote identity is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.consumed_by_command_id IS NOT NULL AND ROW(NEW.consumed_by_command_id,NEW.consumed_at) IS DISTINCT FROM ROW(OLD.consumed_by_command_id,OLD.consumed_at) THEN RAISE EXCEPTION 'Billing quote already consumed'; END IF;
  SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
  SELECT * INTO subscription FROM billing_subscriptions WHERE id = NEW.subscription_id;
  SELECT * INTO plan FROM app_billing_plan_revisions WHERE id = NEW.plan_revision_id;
  IF (sc.app_id,sc.merchant_id,sc.livemode) IS DISTINCT FROM (NEW.app_id,NEW.merchant_id,NEW.livemode) OR subscription.billing_scope_id IS DISTINCT FROM sc.id OR (plan.app_id,plan.merchant_id,plan.product_family_key) IS DISTINCT FROM (sc.app_id,sc.merchant_id,sc.product_family_key) THEN RAISE EXCEPTION 'Billing quote authority mismatch'; END IF;
  IF NEW.quantity NOT BETWEEN plan.minimum_quantity AND plan.maximum_quantity OR NEW.subscription_revision <> subscription.lifecycle_revision THEN RAISE EXCEPTION 'Billing quote source revision or quantity invalid'; END IF;
  IF TG_OP = 'INSERT' AND (NEW.consumed_by_command_id IS NOT NULL OR NEW.expires_at <= clock_timestamp()) THEN RAISE EXCEPTION 'New billing quote must be live and unconsumed'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.consumed_by_command_id IS NULL AND NEW.consumed_by_command_id IS NOT NULL THEN
    SELECT * INTO command FROM billing_subscription_commands WHERE id = NEW.consumed_by_command_id;
    IF NEW.expires_at <= clock_timestamp() OR NEW.consumed_at > clock_timestamp() OR (command.billing_scope_id,command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_revision_id,command.target_quantity) IS DISTINCT FROM (NEW.billing_scope_id,NEW.actor_user_id,NEW.subscription_id,NEW.subscription_revision,NEW.plan_revision_id,NEW.quantity) OR NOT COALESCE(command.request_payload->>'action' = 'update' AND command.request_payload->>'quoteId' = NEW.id::text,false) THEN RAISE EXCEPTION 'Billing quote consumption requires exact unexpired command'; END IF;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_quotes_source BEFORE INSERT OR UPDATE ON app_billing_quotes FOR EACH ROW EXECUTE FUNCTION validate_app_billing_quote();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('548c79f790f9f07720ee129d63312098ce6b64444d57b3bda9e88ca2a3527f92', 1796083200037);
-- apply 0411_app_billing_merchant_identity
ALTER TABLE "billing_merchants" ADD COLUMN "stripe_account_id" text;
;
ALTER TABLE "billing_merchants" ADD COLUMN "connection_revision" bigint DEFAULT 1 NOT NULL;
;
ALTER TABLE "billing_merchants" ADD COLUMN "disconnected_at" timestamp with time zone;
;
DROP TRIGGER billing_merchants_app_source ON billing_merchants;
;
UPDATE billing_merchants SET stripe_account_id = provider_account_key WHERE provider_account_key <> 'platform';
;
CREATE UNIQUE INDEX "billing_merchants_actual_account_mode_idx" ON "billing_merchants" USING btree ("stripe_account_id","livemode") WHERE "billing_merchants"."stripe_account_id" IS NOT NULL;
;
ALTER TABLE "billing_merchants" ADD CONSTRAINT "billing_merchants_connection_check" CHECK ("billing_merchants"."connection_revision" > 0 AND ("billing_merchants"."stripe_account_id" IS NULL OR "billing_merchants"."stripe_account_id" ~ '^acct_[A-Za-z0-9]+$') AND ("billing_merchants"."provider_account_key" = 'platform' OR "billing_merchants"."stripe_account_id" IS NULL OR "billing_merchants"."provider_account_key" = "billing_merchants"."stripe_account_id") AND ("billing_merchants"."disconnected_at" IS NULL OR NOT "billing_merchants"."enabled"));
;
CREATE FUNCTION validate_app_billing_merchant_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - ARRAY['enabled','connection_revision','disconnected_at','stripe_account_id']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['enabled','connection_revision','disconnected_at','stripe_account_id']) OR (OLD.stripe_account_id IS NOT NULL AND OLD.stripe_account_id IS DISTINCT FROM NEW.stripe_account_id) THEN RAISE EXCEPTION 'Billing merchant identity is immutable'; END IF;
    NEW.connection_revision := OLD.connection_revision + 1;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER billing_merchants_connection_authority BEFORE INSERT OR UPDATE ON billing_merchants FOR EACH ROW EXECUTE FUNCTION validate_app_billing_merchant_connection();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('e2dbe92e99c2469c73f82e2535bbd27048e6eac1db2b552d599674fd4e26e63f', 1796083200038);
-- apply 0412_app_billing_provider_verifications
CREATE TABLE "app_billing_catalog_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"provider_account_id" text NOT NULL,
	"object_digest" text NOT NULL,
	"input_digest" text NOT NULL,
	"api_version" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan_revision_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "app_catalog_verifications_proof_check" CHECK ("app_billing_catalog_verifications"."provider_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "app_billing_catalog_verifications"."object_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_catalog_verifications"."input_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_catalog_verifications"."api_version" = '2024-11-20.acacia')
);
;
CREATE TABLE "app_billing_merchant_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"provider_account_id" text NOT NULL,
	"object_digest" text NOT NULL,
	"input_digest" text NOT NULL,
	"api_version" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "app_merchant_verifications_proof_check" CHECK ("app_billing_merchant_verifications"."provider_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "app_billing_merchant_verifications"."object_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_merchant_verifications"."input_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_merchant_verifications"."api_version" = '2024-11-20.acacia')
);
;
ALTER TABLE "app_billing_catalog_verifications" ADD CONSTRAINT "app_billing_catalog_verifications_plan_revision_id_app_billing_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "app_billing_plan_revisions"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_catalog_verifications" ADD CONSTRAINT "app_catalog_verifications_merchant_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_merchant_verifications" ADD CONSTRAINT "app_merchant_verifications_merchant_fk" FOREIGN KEY ("merchant_id","livemode") REFERENCES "billing_merchants"("id","livemode") ON DELETE restrict ON UPDATE no action;
;
CREATE INDEX "app_catalog_verifications_recent_idx" ON "app_billing_catalog_verifications" USING btree ("plan_revision_id","created_at");
;
CREATE INDEX "app_merchant_verifications_recent_idx" ON "app_billing_merchant_verifications" USING btree ("merchant_id","created_at");
;
CREATE FUNCTION validate_app_billing_verification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE merchant record; plan record;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Billing verification observations are immutable'; END IF;
  SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
  IF (merchant.stripe_account_id,merchant.livemode) IS DISTINCT FROM (NEW.provider_account_id,NEW.livemode) THEN RAISE EXCEPTION 'Billing verification merchant mismatch'; END IF;
  IF TG_TABLE_NAME = 'app_billing_merchant_verifications' AND NEW.value->>'accountId' IS DISTINCT FROM NEW.provider_account_id THEN RAISE EXCEPTION 'Billing verification account mismatch'; END IF;
  IF TG_TABLE_NAME = 'app_billing_catalog_verifications' THEN
    SELECT * INTO plan FROM app_billing_plan_revisions WHERE id = NEW.plan_revision_id;
    IF plan.merchant_id IS DISTINCT FROM NEW.merchant_id OR (NEW.value->>'planRevisionId',NEW.value->>'priceId',NEW.value->>'productId') IS DISTINCT FROM (plan.id::text,plan.stripe_price_id,plan.stripe_product_id) THEN RAISE EXCEPTION 'Billing verification plan mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_merchant_verifications_immutable BEFORE INSERT OR UPDATE OR DELETE ON app_billing_merchant_verifications FOR EACH ROW EXECUTE FUNCTION validate_app_billing_verification();
;
CREATE TRIGGER app_billing_catalog_verifications_immutable BEFORE INSERT OR UPDATE OR DELETE ON app_billing_catalog_verifications FOR EACH ROW EXECUTE FUNCTION validate_app_billing_verification();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('3fb6ac8d4b2c46b414124dba8aaaa75fccdc0805ea1dfa5f8e8931e68d157d1e', 1796083200039);
-- apply 0413_app_billing_notification_endpoints
CREATE TABLE IF NOT EXISTS app_billing_notification_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 app_id uuid NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 livemode boolean NOT NULL,
 endpoint_url text NOT NULL,
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,
 active_key_id uuid, active_secret text,
 pending_key_id uuid, pending_secret text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT app_billing_notification_endpoints_shape_check CHECK (
 revision>0 AND (active_key_id IS NULL)=(active_secret IS NULL) AND
 (pending_key_id IS NULL)=(pending_secret IS NULL) AND (NOT enabled OR active_key_id IS NOT NULL))
);
;
CREATE UNIQUE INDEX IF NOT EXISTS app_billing_notification_endpoints_app_mode_idx ON app_billing_notification_endpoints(app_id,livemode);
;
CREATE OR REPLACE FUNCTION guard_app_notification_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM apps a WHERE a.id=NEW.app_id AND a.organization_id=NEW.organization_id) THEN
  RAISE EXCEPTION 'Notification endpoint organization must own application';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.id,OLD.app_id,OLD.organization_id,OLD.livemode) IS DISTINCT FROM (NEW.id,NEW.app_id,NEW.organization_id,NEW.livemode) THEN
  RAISE EXCEPTION 'Notification endpoint identity is immutable';
 END IF;
 IF NEW.active_secret IS NOT NULL AND NEW.active_secret NOT LIKE 'enc:v1:%' OR NEW.pending_secret IS NOT NULL AND NEW.pending_secret NOT LIKE 'enc:v1:%' THEN
  RAISE EXCEPTION 'Notification signing keys require encrypted storage';
 END IF;
 RETURN NEW;
END $$;
;
DROP TRIGGER IF EXISTS app_notification_endpoint_guard ON app_billing_notification_endpoints;
;
CREATE TRIGGER app_notification_endpoint_guard BEFORE INSERT OR UPDATE ON app_billing_notification_endpoints FOR EACH ROW EXECUTE FUNCTION guard_app_notification_endpoint();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('0584f7df935b6c74a712cbcca41f0d49a227e06ba8912b0bfd9f2589341c0d52', 1796083200040);
-- apply 0414_app_subscription_outbox_delivery
ALTER TABLE app_subscription_outbox
 ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'pending',
 ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS lease_token uuid,
 ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
 ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS error_code text,
 ADD COLUMN IF NOT EXISTS endpoint_revision integer;
;
DROP TRIGGER IF EXISTS app_subscription_outbox_app_source ON app_subscription_outbox;
;
UPDATE app_subscription_outbox SET state='delivered' WHERE delivered_at IS NOT NULL AND state='pending';
;
ALTER TABLE app_subscription_outbox ADD CONSTRAINT app_subscription_outbox_delivery_check CHECK (
 attempts>=0 AND (lease_token IS NULL)=(lease_expires_at IS NULL) AND
 (state='processing')=(lease_token IS NOT NULL) AND (state='delivered')=(delivered_at IS NOT NULL) AND
 state IN ('pending','processing','delivered','terminal'));
;
CREATE INDEX IF NOT EXISTS app_subscription_outbox_due_idx ON app_subscription_outbox(next_attempt_at,created_at) WHERE state IN ('pending','processing');
;
CREATE OR REPLACE FUNCTION guard_app_subscription_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND (OLD.id,OLD.billing_scope_id,OLD.subscription_id,OLD.subscription_revision,OLD.kind,OLD.created_at) IS DISTINCT FROM (NEW.id,NEW.billing_scope_id,NEW.subscription_id,NEW.subscription_revision,NEW.kind,NEW.created_at) THEN RAISE EXCEPTION 'Subscription delivery identity is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM billing_subscription_revisions r WHERE r.subscription_id=NEW.subscription_id AND r.revision=NEW.subscription_revision AND r.billing_scope_id=NEW.billing_scope_id) THEN RAISE EXCEPTION 'Subscription delivery source revision mismatch'; END IF;
 IF NEW.kind <> 'app.subscription.updated' THEN RAISE EXCEPTION 'Unsupported app subscription delivery kind'; END IF;
 IF TG_OP='UPDATE' AND OLD.state='delivered' AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Delivered subscription hint is terminal'; END IF;
 RETURN NEW;
END $$;
;
CREATE TRIGGER app_subscription_outbox_delivery_authority BEFORE INSERT OR UPDATE ON app_subscription_outbox FOR EACH ROW EXECUTE FUNCTION guard_app_subscription_delivery();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('82ccb0f31eec97ee58bb280877140d3c40034c41c38730dcca09323ad05ff157', 1796083200041);
-- apply 0415_app_billing_webhook_recovery
ALTER TABLE webhook_events
 ADD COLUMN IF NOT EXISTS app_billing_trigger jsonb,
 ADD COLUMN IF NOT EXISTS app_billing_completed_at timestamptz,
 ADD COLUMN IF NOT EXISTS app_billing_next_attempt_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS app_billing_error_code text;
;
CREATE INDEX IF NOT EXISTS webhook_events_app_billing_due_idx ON webhook_events(app_billing_next_attempt_at) WHERE app_billing_trigger IS NOT NULL AND app_billing_completed_at IS NULL;
;
ALTER TABLE app_billing_scopes
 ADD COLUMN IF NOT EXISTS command_reconcile_after timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS reconcile_after timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN IF NOT EXISTS reconcile_lease_token uuid,
 ADD COLUMN IF NOT EXISTS reconcile_lease_expires_at timestamptz,
 ADD COLUMN IF NOT EXISTS reconcile_error_code text;
;
ALTER TABLE app_billing_scopes ADD CONSTRAINT app_billing_scopes_reconcile_lease_check CHECK ((reconcile_lease_token IS NULL)=(reconcile_lease_expires_at IS NULL));
;
CREATE INDEX IF NOT EXISTS app_billing_scopes_reconcile_due_idx ON app_billing_scopes(reconcile_after);
;
CREATE OR REPLACE FUNCTION guard_app_billing_scope_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (to_jsonb(OLD)-ARRAY['fenced_at','command_reconcile_after','reconcile_after','reconcile_lease_token','reconcile_lease_expires_at','reconcile_error_code']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['fenced_at','command_reconcile_after','reconcile_after','reconcile_lease_token','reconcile_lease_expires_at','reconcile_error_code'])) THEN RAISE EXCEPTION 'Billing scope identity is immutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM apps a JOIN billing_merchants m ON m.organization_id=a.organization_id JOIN app_billing_accounts b ON b.app_id=a.id WHERE a.id=NEW.app_id AND a.organization_id=NEW.organization_id AND m.id=NEW.merchant_id AND m.livemode=NEW.livemode AND b.id=NEW.billing_account_id) THEN RAISE EXCEPTION 'Billing scope owner or mode mismatch'; END IF;
 RETURN NEW;
END $$;
;
DROP TRIGGER IF EXISTS app_billing_scopes_authority ON app_billing_scopes;
;
CREATE TRIGGER app_billing_scopes_authority BEFORE INSERT OR UPDATE OR DELETE ON app_billing_scopes FOR EACH ROW EXECUTE FUNCTION guard_app_billing_scope_reconciliation();
;
CREATE INDEX IF NOT EXISTS app_billing_scopes_command_reconcile_due_idx ON app_billing_scopes(command_reconcile_after);
;
CREATE OR REPLACE FUNCTION guard_app_billing_webhook_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.app_billing_trigger IS NOT NULL AND OLD.app_billing_completed_at IS NULL THEN RAISE EXCEPTION 'Incomplete app billing trigger requires durable recovery'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.app_billing_trigger IS NOT NULL AND (OLD.event_id,OLD.provider,OLD.payload_hash,OLD.app_billing_trigger) IS DISTINCT FROM (NEW.event_id,NEW.provider,NEW.payload_hash,NEW.app_billing_trigger) THEN RAISE EXCEPTION 'Signed app billing trigger identity is immutable'; END IF;
 IF TG_OP='UPDATE' AND OLD.app_billing_completed_at IS NOT NULL AND OLD.app_billing_completed_at IS DISTINCT FROM NEW.app_billing_completed_at THEN RAISE EXCEPTION 'Completed app billing trigger is terminal'; END IF;
 IF NEW.app_billing_trigger IS NOT NULL AND (NEW.provider<>'stripe' OR NEW.app_billing_trigger->'event'->>'payloadDigest' IS DISTINCT FROM NEW.payload_hash OR NEW.event_id IS DISTINCT FROM 'stripe:'||(NEW.app_billing_trigger->>'merchantKey')||':'||(CASE WHEN (NEW.app_billing_trigger->'event'->>'livemode')::boolean THEN 'live' ELSE 'test' END)||':'||(NEW.app_billing_trigger->'event'->>'eventId')) THEN RAISE EXCEPTION 'Signed app billing trigger envelope mismatch'; END IF;
 RETURN NEW;
END $$;
;
CREATE TRIGGER webhook_events_app_billing_authority BEFORE INSERT OR UPDATE OR DELETE ON webhook_events FOR EACH ROW EXECUTE FUNCTION guard_app_billing_webhook_trigger();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('4df5ec101acebdfdb6e289f8d19c91ae2446d7d196b0ee863aee0aa66075d5eb', 1796083200042);
-- apply 0416_app_billing_checkout_expiry
CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('2fad33d59cfecffb28ea660a2e9c5376dfa123f722b5df42269f88749617e440', 1796083200043);
-- apply 0417_app_billing_membership_authority
ALTER TABLE app_billing_members ADD COLUMN livemode boolean;
;
DROP INDEX app_billing_members_member_idx;
;
CREATE UNIQUE INDEX app_billing_members_member_idx ON app_billing_members(billing_account_id,user_id) WHERE livemode IS NULL;
;
CREATE UNIQUE INDEX app_billing_members_environment_idx ON app_billing_members(billing_account_id,user_id,livemode) WHERE livemode IS NOT NULL;
;
CREATE TABLE app_billing_membership_states (
  billing_account_id uuid NOT NULL, app_id uuid NOT NULL, livemode boolean NOT NULL, revision bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (billing_account_id,livemode),
  CONSTRAINT app_billing_membership_states_account_fk FOREIGN KEY (billing_account_id,app_id) REFERENCES app_billing_accounts(id,app_id) ON DELETE RESTRICT,
  CONSTRAINT app_billing_membership_states_revision_check CHECK (revision >= 0)
);
;
CREATE TABLE app_billing_membership_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), app_id uuid NOT NULL, billing_account_id uuid NOT NULL, livemode boolean NOT NULL,
  client_registration_id uuid NOT NULL REFERENCES app_client_registrations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL, request_digest text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_billing_membership_operations_account_fk FOREIGN KEY (billing_account_id,app_id) REFERENCES app_billing_accounts(id,app_id) ON DELETE RESTRICT,
  CONSTRAINT app_billing_membership_operations_digest_check CHECK (request_digest ~ '^[0-9a-f]{64}$' AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$')
);
;
CREATE UNIQUE INDEX app_billing_membership_operations_key_idx ON app_billing_membership_operations(billing_account_id,livemode,idempotency_key);
;
CREATE FUNCTION validate_app_billing_membership_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app_client_registrations c WHERE c.id=NEW.client_registration_id AND c.app_id=NEW.app_id AND (c.billing_environment='live')=NEW.livemode) THEN RAISE EXCEPTION 'Membership operation registration scope mismatch'; END IF;
  IF NOT COALESCE(NEW.result->>'appId'=NEW.app_id::text AND NEW.result->>'billingAccountId'=NEW.billing_account_id::text AND NEW.result->>'environment'=CASE WHEN NEW.livemode THEN 'live' ELSE 'test' END,false) THEN RAISE EXCEPTION 'Membership result scope mismatch'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_membership_operations_scope BEFORE INSERT ON app_billing_membership_operations FOR EACH ROW EXECUTE FUNCTION validate_app_billing_membership_operation();
;
CREATE TRIGGER app_billing_membership_operations_immutable BEFORE UPDATE OR DELETE ON app_billing_membership_operations FOR EACH ROW EXECUTE FUNCTION reject_subscription_append_only_mutation();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('a47f52c42a9084e1b21baeba21e86fc54cce934a8899a4fac8cf72ceefd1ace2', 1796083200044);
-- apply 0418_app_billing_seat_mutations
CREATE TABLE IF NOT EXISTS "app_billing_seat_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"billing_scope_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_seat_mutations_identity_check" CHECK ("app_billing_seat_mutations"."idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' AND "app_billing_seat_mutations"."request_digest" ~ '^[0-9a-f]{64}$')
);
;
ALTER TABLE "app_billing_seat_mutations" ADD CONSTRAINT "app_billing_seat_mutations_billing_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("billing_scope_id") REFERENCES "public"."app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
;
CREATE UNIQUE INDEX IF NOT EXISTS "app_billing_seat_mutations_operation_idx" ON "app_billing_seat_mutations" USING btree ("billing_scope_id","idempotency_key");
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('760a9f0faca27ee67108572593cb56b5f881592025cf0b3921fb982be1ff4667', 1796083200045);
-- apply 0419_app_billing_application_slots
CREATE TABLE IF NOT EXISTS app_billing_application_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slot_key text NOT NULL,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  merchant_id uuid NOT NULL REFERENCES billing_merchants(id) ON DELETE RESTRICT,
  livemode boolean NOT NULL, product_family_key text NOT NULL, manifest_digest text NOT NULL,
  disabled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_billing_application_slots_shape CHECK (slot_key ~ '^[a-z][a-z0-9_-]{0,99}$' AND length(btrim(product_family_key)) BETWEEN 1 AND 100 AND manifest_digest ~ '^[0-9a-f]{64}$')
);
;
CREATE UNIQUE INDEX IF NOT EXISTS app_billing_application_slots_active_idx ON app_billing_application_slots(slot_key,livemode) WHERE disabled_at IS NULL;
;
CREATE UNIQUE INDEX IF NOT EXISTS app_billing_application_slots_manifest_idx ON app_billing_application_slots(manifest_digest);
;
CREATE OR REPLACE FUNCTION validate_app_billing_application_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Application slot history is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND ((to_jsonb(NEW) - 'disabled_at') IS DISTINCT FROM (to_jsonb(OLD) - 'disabled_at') OR OLD.disabled_at IS NOT NULL OR NEW.disabled_at IS NULL) THEN RAISE EXCEPTION 'Application slots can only be disabled once'; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a JOIN billing_merchants m ON m.organization_id = a.organization_id WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id AND m.id = NEW.merchant_id AND m.livemode = NEW.livemode) THEN RAISE EXCEPTION 'Application slot owner or merchant environment mismatch'; END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM app_billing_plan_revisions p WHERE p.app_id = NEW.app_id AND p.merchant_id = NEW.merchant_id AND p.product_family_key = NEW.product_family_key AND p.published_at IS NOT NULL AND p.retired_at IS NULL AND p.trial_days = 7) THEN RAISE EXCEPTION 'Application slot requires a published seven-day trial catalog'; END IF;
  RETURN NEW;
END $$;
;
DROP TRIGGER IF EXISTS app_billing_application_slots_authority ON app_billing_application_slots;
CREATE TRIGGER app_billing_application_slots_authority BEFORE INSERT OR UPDATE OR DELETE ON app_billing_application_slots FOR EACH ROW EXECUTE FUNCTION validate_app_billing_application_slot();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('20dc5cc640769b22235b72c04231ecef0534f27fc19720a113325dd055f6be4d', 1796083200046);
-- apply 0420_app_billing_import_commands
ALTER TABLE billing_subscription_commands DROP CONSTRAINT IF EXISTS "billing_subscription_commands_intent_check";
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT "billing_subscription_commands_intent_check" CHECK (true) NOT VALID;
;
ALTER TABLE billing_subscription_commands DROP CONSTRAINT IF EXISTS "billing_subscription_commands_status_shape_check";
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT "billing_subscription_commands_status_shape_check" CHECK (true) NOT VALID;
;
DROP INDEX IF EXISTS billing_subscription_commands_live_scope_idx;
;
CREATE UNIQUE INDEX billing_subscription_commands_live_scope_idx ON billing_subscription_commands(billing_scope_id) WHERE billing_scope_id IS NOT NULL AND kind IN ('checkout','upgrade','downgrade','cancel','resume','import') AND status IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED');
;
CREATE UNIQUE INDEX IF NOT EXISTS billing_subscription_import_source_idx ON billing_subscription_commands(app_id,livemode,(request_payload->'manifest'->>'sourceSystem'),(request_payload->'manifest'->>'sourceRecordId')) WHERE kind = 'import';
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('b845d46d9b89fc86770fb94c5688402c5986cea7218ba0abec6502dfaf9b4fb4', 1796083200047);
-- apply 0421_app_billing_import_guards
CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSIF NEW.kind = 'import' THEN
      IF NOT COALESCE(payload->>'domain' = 'operator' AND payload->>'action' = 'import' AND payload->>'manifestDigest' = NEW.request_digest AND payload->'manifest'->>'scopeId' = NEW.billing_scope_id::text AND payload->'manifest'->>'planRevisionId' = NEW.target_plan_revision_id::text AND payload->'manifest'->>'principalUserId' = NEW.requested_by_user_id::text AND (payload->'manifest'->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'Invalid operator import intent'; END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
;
CREATE OR REPLACE FUNCTION validate_importable_app_trial() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; p record; cmd record;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Trial eligibility cannot be reset'; END IF;
  SELECT s.*,b.eligibility_principal_id INTO sc FROM app_billing_scopes s JOIN app_billing_accounts b ON b.id=s.billing_account_id WHERE s.id=NEW.billing_scope_id;
  SELECT * INTO p FROM app_billing_plan_revisions WHERE id=NEW.plan_revision_id;
  SELECT * INTO cmd FROM billing_subscription_commands WHERE id=NEW.command_id;
  IF sc.id IS NULL OR p.id IS NULL OR cmd.id IS NULL OR (NEW.app_id,NEW.eligibility_principal_id,NEW.livemode) IS DISTINCT FROM (sc.app_id,sc.eligibility_principal_id,sc.livemode) OR (p.app_id,p.merchant_id,p.product_family_key) IS DISTINCT FROM (sc.app_id,sc.merchant_id,sc.product_family_key) OR cmd.billing_scope_id IS DISTINCT FROM sc.id OR (cmd.kind='checkout' AND cmd.target_plan_revision_id IS DISTINCT FROM p.id) OR (cmd.kind='import' AND cmd.request_payload->'manifest'->'trial'->>'planRevisionId' IS DISTINCT FROM p.id::text) OR cmd.kind NOT IN ('checkout','import') THEN RAISE EXCEPTION 'Trial eligibility source mismatch'; END IF;
  IF cmd.kind='import' AND NOT COALESCE(cmd.status='OUTCOME_UNKNOWN' AND cmd.request_payload->>'domain'='operator' AND (cmd.request_payload->'manifest'->'trial'->>'startsAt')::timestamptz=NEW.starts_at AND (cmd.request_payload->'manifest'->'trial'->>'endsAt')::timestamptz=NEW.ends_at AND NEW.starts_at<=clock_timestamp(),false) THEN RAISE EXCEPTION 'Imported trial must preserve reviewed original bounds'; END IF;
  RETURN NEW;
END $$;
;
DROP TRIGGER IF EXISTS app_subscription_trials_authority ON app_subscription_trials;
CREATE TRIGGER app_subscription_trials_authority BEFORE INSERT OR UPDATE OR DELETE ON app_subscription_trials FOR EACH ROW EXECUTE FUNCTION validate_importable_app_trial();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('d3a59ebef0930e7effdf472ef1f22dabfd16f4349abf0774950958250edbe650', 1796083200048);
-- apply 0422_app_billing_import_allowance
ALTER TABLE subscription_allowance_transactions DROP CONSTRAINT IF EXISTS "subscription_allowance_transactions_kind_check";
;
ALTER TABLE subscription_allowance_transactions ADD CONSTRAINT "subscription_allowance_transactions_kind_check" CHECK ("kind" IN ('grant','reserve','finalize','release','expired_refund','expire','clawback','grant_adjustment','close','import_consumed'));
;
ALTER TABLE subscription_allowance_transactions DROP CONSTRAINT IF EXISTS "subscription_allowance_transactions_reservation_shape_check";
;
ALTER TABLE subscription_allowance_transactions ADD CONSTRAINT "subscription_allowance_transactions_reservation_shape_check" CHECK (("kind" IN ('reserve','finalize','release','expired_refund') AND "funding_allocation_id" IS NOT NULL) OR ("kind" IN ('grant','expire','clawback','grant_adjustment','close','import_consumed') AND "funding_allocation_id" IS NULL));
;
ALTER TABLE subscription_allowance_transactions DROP CONSTRAINT IF EXISTS "subscription_allowance_transactions_snapshot_transition_check";
;
ALTER TABLE subscription_allowance_transactions ADD CONSTRAINT "subscription_allowance_transactions_snapshot_transition_check" CHECK (("kind" = 'grant' AND "available_before" = 0 AND "available_after" = "amount" AND "reserved_before" = "reserved_after" AND "settled_before" = "settled_after" AND "expired_before" = "expired_after" AND "clawed_back_before" = "clawed_back_after") OR ("kind" = 'grant_adjustment' AND "available_after" = "available_before" + "amount" AND "reserved_before" = "reserved_after" AND "settled_before" = "settled_after" AND "expired_before" = "expired_after" AND "clawed_back_before" = "clawed_back_after") OR ("kind" = 'reserve' AND "available_after" = "available_before" - "amount" AND "reserved_after" = "reserved_before" + "amount" AND "settled_before" = "settled_after" AND "expired_before" = "expired_after" AND "clawed_back_before" = "clawed_back_after") OR ("kind" = 'finalize' AND "available_before" = "available_after" AND "reserved_after" = "reserved_before" - "amount" AND "settled_after" = "settled_before" + "amount" AND "expired_before" = "expired_after" AND "clawed_back_before" = "clawed_back_after") OR ("kind" = 'release' AND "available_after" = "available_before" + "amount" AND "reserved_after" = "reserved_before" - "amount" AND "settled_before" = "settled_after" AND "expired_before" = "expired_after" AND "clawed_back_before" = "clawed_back_after") OR ("kind" = 'expired_refund' AND "available_before" = "available_after" AND "reserved_after" = "reserved_before" - "amount" AND "settled_before" = "settled_after" AND "expired_after" = "expired_before" + "amount" AND "clawed_back_before" = "clawed_back_after") OR ("kind" = 'expire' AND "available_after" = "available_before" - "amount" AND "expired_after" = "expired_before" + "amount" AND "reserved_before" = "reserved_after" AND "settled_before" = "settled_after" AND "clawed_back_before" = "clawed_back_after") OR ("kind" = 'clawback' AND "available_after" = "available_before" - "amount" AND "clawed_back_after" = "clawed_back_before" + "amount" AND "reserved_before" = "reserved_after" AND "settled_before" = "settled_after" AND "expired_before" = "expired_after") OR ("kind" = 'import_consumed' AND "available_after" = "available_before" - "amount" AND "settled_after" = "settled_before" + "amount" AND "reserved_before" = "reserved_after" AND "expired_before" = "expired_after" AND "clawed_back_before" = "clawed_back_after") OR ("kind" = 'close' AND "available_before" = 0 AND "available_after" = 0 AND "reserved_before" = 0 AND "reserved_after" = 0 AND "settled_before" = "settled_after" AND "expired_before" = "expired_after" AND "clawed_back_before" = "clawed_back_after"));
;
CREATE OR REPLACE FUNCTION validate_imported_allowance_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cmd record; p record;
BEGIN
  IF NEW.kind <> 'import_consumed' THEN RETURN NEW; END IF;
  SELECT * INTO cmd FROM billing_subscription_commands WHERE id=(NEW.metadata->>'importCommandId')::uuid;
  SELECT * INTO p FROM subscription_allowance_periods WHERE id=NEW.allowance_period_id;
  IF NOT COALESCE(cmd.kind='import' AND cmd.status='APPLIED' AND cmd.request_payload->>'domain'='operator' AND cmd.billing_scope_id=NEW.billing_scope_id AND cmd.organization_id=NEW.organization_id AND cmd.merchant_key=NEW.merchant_key AND cmd.result_subscription_id=p.subscription_id AND cmd.request_digest=NEW.request_digest AND NEW.sequence=2 AND NEW.available_before=p.granted_amount AND NEW.available_after=(cmd.request_payload->'manifest'->'allowance'->>'availableUsd')::numeric AND NEW.available_after=p.available_amount AND NEW.settled_after=p.settled_amount AND NEW.settled_before=0 AND NEW.reserved_before=0 AND NEW.expired_before=0 AND NEW.clawed_back_before=0,false) THEN RAISE EXCEPTION 'Imported allowance consumption lost its reviewed source'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER subscription_allowance_import_source BEFORE INSERT ON subscription_allowance_transactions FOR EACH ROW EXECUTE FUNCTION validate_imported_allowance_consumption();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('9d5240f6742953d2cf8d674250f07db413835fcd7c6770d1e41803db8290b29b', 1796083200049);
-- apply 0423_app_billing_payment_expiry
CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSIF NEW.kind = 'import' THEN
      IF NOT COALESCE(payload->>'domain' = 'operator' AND payload->>'action' = 'import' AND payload->>'manifestDigest' = NEW.request_digest AND payload->'manifest'->>'scopeId' = NEW.billing_scope_id::text AND payload->'manifest'->>'planRevisionId' = NEW.target_plan_revision_id::text AND payload->'manifest'->>'principalUserId' = NEW.requested_by_user_id::text AND (payload->'manifest'->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'Invalid operator import intent'; END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL) AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_PAYMENT_EXPIRED' AND NEW.request_payload->>'domain' = 'buyer' AND NEW.request_payload->>'action' = 'update' AND NEW.provider_result->>'kind' = 'payment' AND NEW.provider_result->>'invoiceId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('06141d9e664e9742e743519707b8613cfcc19b9c28c2c9a6585324facbf8f9ac', 1796083200050);
-- apply 0424_app_billing_administrators
ALTER TABLE app_billing_membership_operations ALTER COLUMN client_registration_id DROP NOT NULL;
;
ALTER TABLE app_billing_membership_operations ADD COLUMN IF NOT EXISTS operation_kind text NOT NULL DEFAULT 'member_sync', ADD COLUMN IF NOT EXISTS actor_user_id uuid;
;
ALTER TABLE app_billing_membership_operations ADD CONSTRAINT app_billing_membership_operations_actor_user_id_users_id_fk FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;
;
ALTER TABLE app_billing_membership_operations ADD CONSTRAINT app_billing_membership_operations_authority_check CHECK ((operation_kind='member_sync' AND client_registration_id IS NOT NULL AND actor_user_id IS NULL) OR (operation_kind='administrator_change' AND actor_user_id IS NOT NULL));
;
CREATE OR REPLACE FUNCTION validate_app_billing_membership_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.client_registration_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_client_registrations c WHERE c.id=NEW.client_registration_id AND c.app_id=NEW.app_id AND (c.billing_environment='live')=NEW.livemode) THEN RAISE EXCEPTION 'Membership operation registration scope mismatch'; END IF;
  IF NOT COALESCE(NEW.result->>'appId'=NEW.app_id::text AND NEW.result->>'billingAccountId'=NEW.billing_account_id::text AND NEW.result->>'environment'=CASE WHEN NEW.livemode THEN 'live' ELSE 'test' END,false) THEN RAISE EXCEPTION 'Membership result scope mismatch'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('1033a777fde10e368b248df58f0c54ead5dc99fbc00055ae6bec54e1f8bb6ddc', 1796083200051);
-- apply 0425_app_billing_sales_fence
-- Merchant sales restrictions do not revoke existing subscription access.
-- App, account, organization, source-revision and ownership fences remain authoritative.
CREATE OR REPLACE FUNCTION validate_subscription_app_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d jsonb := to_jsonb(NEW); sc record; m record; p record; sub record; parent_scope uuid; parent_org uuid; source_id uuid; trial record;
BEGIN
  IF TG_TABLE_NAME = 'billing_merchants' AND TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'enabled') IS DISTINCT FROM (d - 'enabled') THEN RAISE EXCEPTION 'Billing merchant identity is immutable'; END IF;
  IF TG_TABLE_NAME = 'billing_subscription_commands' AND TG_OP = 'UPDATE' AND ((to_jsonb(OLD)->>'target_plan_revision_id') IS DISTINCT FROM (d->>'target_plan_revision_id') OR (to_jsonb(OLD)->>'target_quantity') IS DISTINCT FROM (d->>'target_quantity')) THEN RAISE EXCEPTION 'App command target is immutable'; END IF;
  IF TG_TABLE_NAME = 'app_subscription_paid_periods' AND TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Settled paid period evidence is immutable'; END IF;
  IF TG_TABLE_NAME = 'app_subscription_outbox' AND TG_OP = 'UPDATE' AND (to_jsonb(OLD) - 'delivered_at') IS DISTINCT FROM (d - 'delivered_at') THEN RAISE EXCEPTION 'Subscription delivery identity is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD)->>'billing_scope_id') IS DISTINCT FROM (d->>'billing_scope_id') THEN RAISE EXCEPTION 'Billing scope cannot change'; END IF;
  IF d->>'billing_scope_id' IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = (d->>'billing_scope_id')::uuid;
    SELECT * INTO m FROM billing_merchants WHERE id = sc.merchant_id;
    IF sc.id IS NULL OR m.id IS NULL OR (d ? 'organization_id' AND sc.organization_id <> (d->>'organization_id')::uuid) OR (d ? 'merchant_key' AND m.provider_account_key <> d->>'merchant_key') OR (d ? 'provider_environment' AND d->>'provider_environment' <> CASE WHEN m.livemode THEN 'live' ELSE 'test' END) OR (d ? 'livemode' AND m.livemode <> (d->>'livemode')::boolean) THEN RAISE EXCEPTION 'Billing merchant, environment or owner mismatch'; END IF;
    IF d->>'plan_revision_id' IS NOT NULL OR d->>'target_plan_revision_id' IS NOT NULL THEN
      SELECT * INTO p FROM app_billing_plan_revisions WHERE id = COALESCE(d->>'plan_revision_id',d->>'target_plan_revision_id')::uuid;
      IF p.id IS NULL OR (p.app_id,p.merchant_id,p.product_family_key) IS DISTINCT FROM (sc.app_id,sc.merchant_id,sc.product_family_key) THEN RAISE EXCEPTION 'Billing plan belongs to another scope'; END IF;
      IF d ? 'plan_key' AND d->>'plan_key' <> p.plan_key THEN RAISE EXCEPTION 'Billing plan key mismatch'; END IF;
    END IF;
    IF d ? 'stripe_customer_id' AND NOT EXISTS (SELECT 1 FROM app_billing_customers c WHERE c.billing_account_id = sc.billing_account_id AND c.merchant_id = sc.merchant_id AND c.stripe_customer_id = d->>'stripe_customer_id') THEN RAISE EXCEPTION 'Billing customer authority mismatch'; END IF;
    IF TG_TABLE_NAME = 'organization_entitlements' AND (d->>'entitlement_effective')::boolean AND (sc.fenced_at IS NOT NULL OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = sc.organization_id AND (NOT o.is_active OR o.account_lifecycle_state <> 'active' OR o.paid_work_fenced_at IS NOT NULL)) OR NOT EXISTS (SELECT 1 FROM apps a JOIN app_billing_accounts b ON b.app_id = a.id WHERE a.id = sc.app_id AND a.is_active AND a.is_approved AND a.review_status = 'approved' AND b.id = sc.billing_account_id AND b.deleted_at IS NULL)) THEN RAISE EXCEPTION 'App subscription activation is fenced'; END IF;
  END IF;
  source_id := COALESCE(d->>'subscription_id',d->>'source_subscription_id',d->>'result_subscription_id')::uuid;
  IF source_id IS NOT NULL THEN
    SELECT * INTO sub FROM billing_subscriptions WHERE id = source_id;
    IF sub.id IS NULL OR sub.billing_scope_id IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR (d ? 'organization_id' AND sub.organization_id <> (d->>'organization_id')::uuid) THEN RAISE EXCEPTION 'Subscription child source scope mismatch'; END IF;
    IF TG_TABLE_NAME = 'organization_entitlements' AND (d->>'source_subscription_revision')::bigint <> sub.lifecycle_revision THEN RAISE EXCEPTION 'Entitlement source revision is stale'; END IF;
  END IF;
  IF d->>'allowance_period_id' IS NOT NULL THEN
    SELECT billing_scope_id,organization_id INTO parent_scope,parent_org FROM subscription_allowance_periods WHERE id = (d->>'allowance_period_id')::uuid;
    IF parent_scope IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR parent_org IS DISTINCT FROM (d->>'organization_id')::uuid THEN RAISE EXCEPTION 'Allowance child scope mismatch'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'billing_funding_allocations' THEN
    SELECT billing_scope_id,organization_id INTO parent_scope,parent_org FROM billing_funding_reservations WHERE id = (d->>'reservation_id')::uuid;
    IF parent_scope IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR parent_org IS DISTINCT FROM (d->>'organization_id')::uuid THEN RAISE EXCEPTION 'Funding child scope mismatch'; END IF;
  END IF;
  IF TG_TABLE_NAME = 'subscription_allowance_periods' AND d->>'grant_source' = 'trial_claim' THEN
    SELECT * INTO trial FROM app_subscription_trials WHERE id = (d->>'trial_claim_id')::uuid;
    IF trial.id IS NULL OR trial.billing_scope_id IS DISTINCT FROM (d->>'billing_scope_id')::uuid OR trial.starts_at <> (d->>'period_start')::timestamptz OR trial.ends_at <> (d->>'period_end')::timestamptz THEN RAISE EXCEPTION 'Trial allowance source mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('08c7ffa9e98a2154a40f5a359386503b96ba1db21141a46aef5a9ff47bc7bf5c', 1796083200052);
-- apply 0426_app_billing_refund_commands
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT IF EXISTS "billing_subscription_commands_intent_check";
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_intent_check" CHECK (true) NOT VALID;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('e6b239fcd78827b18e753a24b1a7c4ecbdc1ed1445eb7244075dcee3a3f5f515', 1796083200053);
-- apply 0427_app_billing_return_destination
ALTER TABLE "app_client_registrations" ADD COLUMN IF NOT EXISTS "billing_return_url" text;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('501a47128c9ac92c2d85015b763cee7b2f6a6606645037a8312d01ae1419aa9f', 1796083200054);
-- apply 0428_billing_identity_anchors
-- Retained financial identities do not grant live account authority.
CREATE TABLE IF NOT EXISTS "billing_eligibility_principals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
;
CREATE TABLE IF NOT EXISTS "billing_identity_subjects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"live_user_id" uuid,
	"eligibility_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_identity_subjects_actor_identity_check" CHECK ("billing_identity_subjects"."live_user_id" IS NULL OR "billing_identity_subjects"."live_user_id" = "billing_identity_subjects"."id")
);
;
ALTER TABLE "billing_identity_subjects" ADD CONSTRAINT "billing_identity_subjects_live_user_id_users_id_fk" FOREIGN KEY ("live_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
;
ALTER TABLE "billing_identity_subjects" ADD CONSTRAINT "billing_identity_subjects_eligibility_principal_id_billing_eligibility_principals_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "public"."billing_eligibility_principals"("id") ON DELETE restrict ON UPDATE no action;
;
CREATE UNIQUE INDEX IF NOT EXISTS "billing_identity_subjects_live_user_idx" ON "billing_identity_subjects" USING btree ("live_user_id");
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('bd4ecf3719fa42ade67ace51cfae47e231bc513e3f3bf338b760cedb3d62d8f0', 1796083200055);
-- apply 0429_billing_identity_backfill
-- Preserve existing financial actor UUIDs; only their link to an operational user is erasable.
CREATE OR REPLACE FUNCTION ensure_billing_identity_subject(subject_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE principal_id uuid;
BEGIN
  PERFORM id FROM users WHERE id=subject_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing identity requires an existing user'; END IF;
  SELECT eligibility_principal_id INTO principal_id FROM billing_identity_subjects WHERE id=subject_id AND live_user_id=subject_id;
  IF FOUND THEN RETURN principal_id; END IF;
  IF EXISTS(SELECT 1 FROM billing_identity_subjects WHERE id=subject_id) THEN RAISE EXCEPTION 'Erased billing actor cannot be reassigned'; END IF;
  INSERT INTO billing_eligibility_principals(id) VALUES(subject_id) ON CONFLICT DO NOTHING;
  INSERT INTO billing_identity_subjects(id,live_user_id,eligibility_principal_id) VALUES(subject_id,subject_id,subject_id) ON CONFLICT DO NOTHING;
  SELECT eligibility_principal_id INTO STRICT principal_id FROM billing_identity_subjects WHERE id=subject_id;
  RETURN principal_id;
END $$;
;
CREATE OR REPLACE FUNCTION preserve_billing_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='billing_identity_subjects' AND TG_OP='UPDATE' THEN
    IF (to_jsonb(OLD)-'live_user_id') IS NOT DISTINCT FROM (to_jsonb(NEW)-'live_user_id')
      AND OLD.live_user_id IS NOT NULL AND NEW.live_user_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.live_user_id)
    THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Billing identity provenance is immutable';
END $$;
;
CREATE TRIGGER billing_identity_subjects_immutable BEFORE UPDATE OR DELETE ON billing_identity_subjects FOR EACH ROW EXECUTE FUNCTION preserve_billing_identity();
;
CREATE TRIGGER billing_eligibility_principals_immutable BEFORE UPDATE OR DELETE ON billing_eligibility_principals FOR EACH ROW EXECUTE FUNCTION preserve_billing_identity();
;
CREATE OR REPLACE FUNCTION anchor_billing_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject_id uuid;
BEGIN
  subject_id := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
  IF subject_id IS NULL THEN RETURN NEW; END IF;
  IF TG_ARGV[1]='eligibility' AND EXISTS(SELECT 1 FROM billing_eligibility_principals WHERE id=subject_id) THEN RETURN NEW; END IF;
  PERFORM ensure_billing_identity_subject(subject_id);
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_accounts_identity BEFORE INSERT ON app_billing_accounts FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('eligibility_principal_id','eligibility');
;
CREATE TRIGGER app_subscription_trials_identity BEFORE INSERT ON app_subscription_trials FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('eligibility_principal_id','eligibility');
;
CREATE TRIGGER billing_subscription_commands_identity BEFORE INSERT ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('requested_by_user_id','actor');
;
CREATE TRIGGER app_billing_membership_operations_identity BEFORE INSERT ON app_billing_membership_operations FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('actor_user_id','actor');
;
CREATE TRIGGER app_billing_quotes_identity BEFORE INSERT ON app_billing_quotes FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('actor_user_id','actor');
;
-- Install insert guards before scanning existing rows so concurrent financial writes cannot miss anchoring.
DO $$
DECLARE subject_id uuid;
BEGIN
  FOR subject_id IN
    SELECT eligibility_principal_id FROM app_billing_accounts
    UNION SELECT eligibility_principal_id FROM app_subscription_trials
    UNION SELECT requested_by_user_id FROM billing_subscription_commands
    UNION SELECT actor_user_id FROM app_billing_membership_operations WHERE actor_user_id IS NOT NULL
    UNION SELECT actor_user_id FROM app_billing_quotes
    ORDER BY 1
  LOOP PERFORM ensure_billing_identity_subject(subject_id); END LOOP;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('958e1061d675c135746f3a03afbc1ccd079f8cb6b0056a683049dcb31428dae7', 1796083200056);
-- apply 0430_billing_identity_references
-- Backfilled anchors retain actor and eligibility UUIDs after personal identity erasure.
ALTER TABLE "app_billing_accounts" DROP CONSTRAINT IF EXISTS "app_billing_accounts_eligibility_principal_id_users_id_fk";
;
ALTER TABLE "app_subscription_trials" DROP CONSTRAINT IF EXISTS "app_subscription_trials_eligibility_principal_id_users_id_fk";
;
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT IF EXISTS "billing_subscription_commands_requested_by_user_id_users_id_fk";
;
-- The applied subscription migration used PostgreSQL's inline-FK name.
ALTER TABLE "billing_subscription_commands" DROP CONSTRAINT IF EXISTS "billing_subscription_commands_requested_by_user_id_fkey";
;
ALTER TABLE "app_billing_quotes" DROP CONSTRAINT IF EXISTS "app_billing_quotes_actor_user_id_users_id_fk";
;
ALTER TABLE "app_billing_membership_operations" DROP CONSTRAINT IF EXISTS "app_billing_membership_operations_actor_user_id_users_id_fk";
;
ALTER TABLE "app_billing_accounts" ADD CONSTRAINT "app_billing_accounts_eligibility_principal_id_billing_eligibility_principals_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "public"."billing_eligibility_principals"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_subscription_trials" ADD CONSTRAINT "app_subscription_trials_eligibility_principal_id_billing_eligibility_principals_id_fk" FOREIGN KEY ("eligibility_principal_id") REFERENCES "public"."billing_eligibility_principals"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "billing_subscription_commands" ADD CONSTRAINT "billing_subscription_commands_requested_by_user_id_billing_identity_subjects_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."billing_identity_subjects"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_quotes" ADD CONSTRAINT "app_billing_quotes_actor_user_id_billing_identity_subjects_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."billing_identity_subjects"("id") ON DELETE restrict ON UPDATE no action;
;
ALTER TABLE "app_billing_membership_operations" ADD CONSTRAINT "app_billing_membership_operations_actor_user_id_billing_identity_subjects_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."billing_identity_subjects"("id") ON DELETE restrict ON UPDATE no action;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('faa11fb1235d12f741c92d0b26ad57377371070b45cc0c3938ffcba17fc25052', 1796083200057);
-- apply 0431_app_billing_deletion_dispositions
CREATE TABLE IF NOT EXISTS "app_billing_deletion_dispositions" (
	"request_id" uuid NOT NULL,
	"scope_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"lifecycle_revision" bigint NOT NULL,
	"phase_receipt_id" uuid NOT NULL,
	"phase_generation" bigint NOT NULL,
	"merchant_id" uuid NOT NULL,
	"provider_account_key" text NOT NULL,
	"livemode" boolean NOT NULL,
	"disposition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_deletion_dispositions_request_id_scope_id_pk" PRIMARY KEY("request_id","scope_id"),
	CONSTRAINT "app_billing_deletion_dispositions_shape" CHECK ("app_billing_deletion_dispositions"."request_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_deletion_dispositions"."lifecycle_revision">0 AND "app_billing_deletion_dispositions"."phase_generation">0 AND "app_billing_deletion_dispositions"."disposition" IN ('retain_shared','close'))
);
;
ALTER TABLE "app_billing_deletion_dispositions" ADD CONSTRAINT "app_billing_deletion_dispositions_scope_id_app_billing_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."app_billing_scopes"("id") ON DELETE restrict ON UPDATE no action;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('2ae606606bc1a19679b609685472540acc138583200d2639752cf0a170078017', 1796083200058);
-- apply 0432_app_billing_deletion_disposition_guards
-- A scope decision is not provider-completion or physical-erasure evidence.
-- These guards complement the repository transaction; writers must acquire its canonical owner/scope/user/request/phase locks.
CREATE OR REPLACE FUNCTION guard_app_billing_deletion_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p record; sc record; merchant record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Billing deletion disposition history is immutable'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(OLD)-ARRAY['disposition','phase_generation','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['disposition','phase_generation','updated_at']) OR NEW.phase_generation<OLD.phase_generation OR (OLD.disposition='close' AND NEW.disposition<>'close')) THEN RAISE EXCEPTION 'Billing deletion disposition cannot reopen or change identity'; END IF;
  SELECT * INTO r FROM account_deletion_requests WHERE id=NEW.request_id;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=NEW.phase_receipt_id AND request_id=NEW.request_id;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=NEW.scope_id;
  SELECT * INTO merchant FROM billing_merchants WHERE id=sc.merchant_id;
  IF r.id IS NULL OR p.id IS NULL OR sc.id IS NULL OR merchant.id IS NULL OR r.status<>'processing' OR r.irreversible_at IS NULL OR r.request_digest IS DISTINCT FROM NEW.request_digest OR r.lifecycle_revision IS DISTINCT FROM NEW.lifecycle_revision OR p.phase<>'stripe' OR p.lease_generation IS DISTINCT FROM NEW.phase_generation OR p.status NOT IN ('leased','calling','reconciling') OR p.lease_expires_at IS NULL OR NOT isfinite(p.lease_expires_at) OR (p.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Billing disposition requires current canonical deletion phase'; END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision) THEN RAISE EXCEPTION 'Billing disposition requires irreversible canonical subject'; END IF;
  IF (NEW.merchant_id,NEW.provider_account_key,NEW.livemode) IS DISTINCT FROM (sc.merchant_id,merchant.provider_account_key,sc.livemode) THEN RAISE EXCEPTION 'Billing deletion merchant scope mismatch'; END IF;
  IF r.organization_id IS DISTINCT FROM sc.organization_id AND NOT EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id=r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode)) THEN RAISE EXCEPTION 'Billing deletion subject does not administer scope'; END IF;
  IF NEW.disposition='close' AND sc.fenced_at IS NULL THEN RAISE EXCEPTION 'Closing billing scope must be fenced'; END IF;
  IF NEW.disposition='close' AND r.organization_id IS DISTINCT FROM sc.organization_id AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.scope_id AND d.disposition='close') AND EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp())) THEN RAISE EXCEPTION 'Surviving administrator requires shared retention'; END IF;
  IF NEW.disposition='retain_shared' AND (r.organization_id=sc.organization_id OR NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN RAISE EXCEPTION 'Shared retention requires a current surviving administrator'; END IF;
  IF NEW.disposition='retain_shared' AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.scope_id AND d.disposition='close') THEN RAISE EXCEPTION 'Closing billing scope cannot reopen'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_deletion_disposition_guard BEFORE INSERT OR UPDATE OR DELETE ON app_billing_deletion_dispositions FOR EACH ROW EXECUTE FUNCTION guard_app_billing_deletion_disposition();
;
CREATE OR REPLACE FUNCTION guard_closed_app_billing_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fenced_at IS NULL AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=OLD.id AND d.disposition='close') THEN RAISE EXCEPTION 'Canonical deletion closed scope cannot reopen'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_deletion_scope_fence BEFORE UPDATE ON app_billing_scopes FOR EACH ROW EXECUTE FUNCTION guard_closed_app_billing_scope();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('48579712d9b5ec23eb8f42810093672fc2326664122ed22028d687e0963174e6', 1796083200059);
-- apply 0433_app_billing_customer_closures
CREATE TABLE IF NOT EXISTS "app_billing_customer_closures" (
	"customer_binding_id" uuid PRIMARY KEY NOT NULL,
	"billing_account_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"merchant_id" uuid NOT NULL,
	"provider_account_key" text NOT NULL,
	"stripe_account_id" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"initiating_request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"lifecycle_revision" bigint NOT NULL,
	"phase_receipt_id" uuid NOT NULL,
	"phase_generation" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_billing_customer_closures_shape" CHECK ("app_billing_customer_closures"."request_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_customer_closures"."lifecycle_revision">0 AND "app_billing_customer_closures"."phase_generation">0 AND "app_billing_customer_closures"."stripe_account_id" ~ '^acct_[A-Za-z0-9]+$' AND "app_billing_customer_closures"."stripe_customer_id" ~ '^cus_[A-Za-z0-9]+$')
);
;
ALTER TABLE "app_billing_customer_closures" ADD CONSTRAINT "app_billing_customer_closures_customer_binding_id_app_billing_customers_id_fk" FOREIGN KEY ("customer_binding_id") REFERENCES "public"."app_billing_customers"("id") ON DELETE restrict ON UPDATE no action;
;
CREATE UNIQUE INDEX IF NOT EXISTS "app_billing_customer_closures_account_merchant_idx" ON "app_billing_customer_closures" USING btree ("billing_account_id","merchant_id");
;
CREATE UNIQUE INDEX IF NOT EXISTS "app_billing_customer_closures_provider_idx" ON "app_billing_customer_closures" USING btree ("stripe_account_id","livemode","stripe_customer_id");
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('a81f86abcfbaf9953ce5ecc807c3c6ca53f67ab5d7b630dec57839ecf3194026', 1796083200060);
-- apply 0434_app_billing_customer_closure_guards
CREATE OR REPLACE FUNCTION require_app_billing_customer_closure(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b record; r record; p record; owner_id uuid; subject_id uuid;
BEGIN
  SELECT c.*,a.app_id,x.organization_id,m.stripe_account_id,m.provider_account_key,m.livemode INTO b FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id JOIN apps x ON x.id=a.app_id JOIN billing_merchants m ON m.id=c.merchant_id AND m.organization_id=x.organization_id WHERE c.id=p_binding_id;
  SELECT d.organization_id,d.user_id INTO owner_id,subject_id FROM account_deletion_requests d WHERE d.id=p_request_id;
  IF b.id IS NULL OR owner_id IS NULL THEN RAISE EXCEPTION 'Customer closure source is unavailable'; END IF;
  PERFORM 1 FROM organizations o WHERE o.id IN (owner_id,b.organization_id) ORDER BY o.id FOR UPDATE;
  PERFORM 1 FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id ORDER BY s.id FOR UPDATE;
  PERFORM 1 FROM app_billing_accounts a WHERE a.id=b.billing_account_id FOR UPDATE;
  PERFORM 1 FROM app_billing_customers c WHERE c.id=p_binding_id FOR UPDATE;
  PERFORM 1 FROM users u WHERE u.id=subject_id FOR UPDATE;
  SELECT * INTO r FROM account_deletion_requests d WHERE d.id=p_request_id FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts d WHERE d.id=p_phase_id AND d.request_id=p_request_id FOR SHARE;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM owner_id OR r.user_id IS DISTINCT FROM subject_id OR p.id IS NULL OR r.status IS DISTINCT FROM 'processing' OR r.irreversible_at IS NULL OR r.request_digest IS DISTINCT FROM p_request_digest OR r.lifecycle_revision IS DISTINCT FROM p_lifecycle_revision OR p.phase IS DISTINCT FROM 'stripe' OR p.lease_generation IS DISTINCT FROM p_phase_generation OR p.status IS NULL OR p.status NOT IN ('leased','calling','reconciling') OR p.lease_expires_at IS NULL OR NOT isfinite(p.lease_expires_at) OR (p.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Customer closure requires current canonical deletion phase'; END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision) THEN RAISE EXCEPTION 'Customer closure requires irreversible canonical subject'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id) THEN RAISE EXCEPTION 'Customer closure requires a sharing scope'; END IF;
  IF EXISTS(SELECT 1 FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id AND (s.app_id IS DISTINCT FROM b.app_id OR s.organization_id IS DISTINCT FROM b.organization_id OR s.livemode IS DISTINCT FROM b.livemode OR s.fenced_at IS NULL OR NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=s.id AND d.request_id=r.id AND d.disposition='close' AND d.request_digest=r.request_digest AND d.lifecycle_revision=r.lifecycle_revision AND d.phase_receipt_id=p.id AND d.phase_generation<=p.lease_generation AND d.merchant_id=b.merchant_id AND d.provider_account_key=b.provider_account_key AND d.livemode=b.livemode))) THEN RAISE EXCEPTION 'Every sharing scope requires a canonical close decision for this request'; END IF;
END $$;
;
CREATE OR REPLACE FUNCTION guard_app_billing_customer_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Customer closure identity is immutable'; END IF;
  PERFORM require_app_billing_customer_closure(NEW.customer_binding_id,NEW.initiating_request_id,NEW.request_digest,NEW.lifecycle_revision,NEW.phase_receipt_id,NEW.phase_generation);
  SELECT c.*,a.app_id,m.provider_account_key,m.stripe_account_id,m.livemode INTO b FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id JOIN billing_merchants m ON m.id=c.merchant_id WHERE c.id=NEW.customer_binding_id;
  IF (NEW.billing_account_id,NEW.app_id,NEW.merchant_id,NEW.provider_account_key,NEW.stripe_account_id,NEW.livemode,NEW.stripe_customer_id) IS DISTINCT FROM (b.billing_account_id,b.app_id,b.merchant_id,b.provider_account_key,b.stripe_account_id,b.livemode,b.stripe_customer_id) THEN RAISE EXCEPTION 'Customer closure provider identity mismatch'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_customer_closure_guard BEFORE INSERT OR UPDATE OR DELETE ON app_billing_customer_closures FOR EACH ROW EXECUTE FUNCTION guard_app_billing_customer_closure();
;
CREATE OR REPLACE FUNCTION guard_closing_app_billing_customer_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
  SELECT a.organization_id INTO owner_id FROM apps a JOIN app_billing_accounts b ON b.app_id=a.id WHERE b.id=NEW.billing_account_id;
  PERFORM 1 FROM organizations o WHERE o.id=owner_id FOR UPDATE;
  PERFORM 1 FROM app_billing_accounts b WHERE b.id=NEW.billing_account_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app_billing_customer_closures c WHERE c.billing_account_id=NEW.billing_account_id AND c.merchant_id=NEW.merchant_id) THEN RAISE EXCEPTION 'Closed billing customer cannot admit a scope or reuse its binding'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_closing_customer_scope_admission BEFORE INSERT ON app_billing_scopes FOR EACH ROW EXECUTE FUNCTION guard_closing_app_billing_customer_admission();
;
CREATE TRIGGER app_billing_closing_customer_binding_admission BEFORE INSERT ON app_billing_customers FOR EACH ROW EXECUTE FUNCTION guard_closing_app_billing_customer_admission();
;
CREATE TRIGGER app_billing_customer_closure_truncate_guard BEFORE TRUNCATE ON app_billing_customer_closures FOR EACH STATEMENT EXECUTE FUNCTION guard_app_billing_customer_closure();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('33521c1b2e196e82914ec1408485224bad108e34af6310e0120f44bcdc6979df', 1796083200061);
-- apply 0435_app_billing_resume_payment_progress
CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload; old_resume jsonb; new_resume jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.provider_result ? 'resume' THEN
    new_resume := NEW.provider_result->'resume';
    IF NOT COALESCE(
      NEW.provider_result->>'kind' = 'checkout'
      AND NEW.provider_result->>'mode' = 'setup'
      AND payload->>'domain' = 'buyer' AND payload->>'action' = 'checkout'
      AND NEW.provider_result->>'subscriptionId' IS NOT NULL
      AND jsonb_typeof(new_resume) = 'object'
      AND new_resume ?& ARRAY['notBefore','previousInvoiceId','invoiceId','action']
      AND (new_resume - ARRAY['notBefore','previousInvoiceId','invoiceId','action']) = '{}'::jsonb
      AND jsonb_typeof(new_resume->'notBefore') = 'string'
      AND jsonb_typeof(new_resume->'previousInvoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'invoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'action') IN ('object','null'), false)
    THEN RAISE EXCEPTION 'Invalid setup resume payment progress'; END IF;
    IF NOT isfinite((new_resume->>'notBefore')::timestamptz)
      OR (new_resume->>'notBefore')::timestamptz < NEW.provider_started_at
      OR NEW.provider_started_at IS NULL
    THEN RAISE EXCEPTION 'Resume payment cannot precede command dispatch'; END IF;
    IF new_resume->>'previousInvoiceId' = '' THEN RAISE EXCEPTION 'Previous invoice must be a nonempty handle'; END IF;
    IF new_resume->>'invoiceId' IS NOT NULL AND
      (length(new_resume->>'invoiceId') = 0 OR new_resume->>'invoiceId' = new_resume->>'previousInvoiceId')
    THEN RAISE EXCEPTION 'Resume payment requires a new exact invoice'; END IF;
    IF new_resume->'action' <> 'null'::jsonb THEN
      IF NOT COALESCE(
      new_resume->'action'->>'kind' = 'payment'
      AND new_resume->'action'->>'invoiceId' = new_resume->>'invoiceId'
      AND new_resume->'action'->>'customerId' = NEW.provider_result->>'customerId'
      AND new_resume->'action'->>'subscriptionId' = NEW.provider_result->>'subscriptionId'
      AND jsonb_typeof(new_resume->'action'->'url') = 'string'
      AND jsonb_typeof(new_resume->'action'->'expiresAt') = 'string'
      AND ((new_resume->'action') - ARRAY['kind','invoiceId','customerId','subscriptionId','url','expiresAt']) = '{}'::jsonb, false)
      THEN RAISE EXCEPTION 'Resume payment action must match its original invoice'; END IF;
      IF NOT isfinite((new_resume->'action'->>'expiresAt')::timestamptz)
      THEN RAISE EXCEPTION 'Resume payment expiration must be finite'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result ? 'resume' THEN
    old_resume := OLD.provider_result->'resume';
    new_resume := NEW.provider_result->'resume';
    IF new_resume IS NULL
      OR (old_resume - ARRAY['invoiceId','action']) IS DISTINCT FROM (new_resume - ARRAY['invoiceId','action'])
      OR (old_resume->>'invoiceId' IS NOT NULL AND old_resume->'invoiceId' IS DISTINCT FROM new_resume->'invoiceId')
      OR (old_resume->'action' <> 'null'::jsonb AND old_resume->'action' IS DISTINCT FROM new_resume->'action')
    THEN RAISE EXCEPTION 'Resume payment progress is immutable once observed'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSIF NEW.kind = 'import' THEN
      IF NOT COALESCE(payload->>'domain' = 'operator' AND payload->>'action' = 'import' AND payload->>'manifestDigest' = NEW.request_digest AND payload->'manifest'->>'scopeId' = NEW.billing_scope_id::text AND payload->'manifest'->>'planRevisionId' = NEW.target_plan_revision_id::text AND payload->'manifest'->>'principalUserId' = NEW.requested_by_user_id::text AND (payload->'manifest'->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'Invalid operator import intent'; END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL) AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_PAYMENT_EXPIRED' AND NEW.request_payload->>'domain' = 'buyer' AND NEW.request_payload->>'action' = 'update' AND NEW.provider_result->>'kind' = 'payment' AND NEW.provider_result->>'invoiceId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('8994d1c044dc204a6ddffffad85241ba11399e5accd76853034240eff65122b8', 1796083200062);
-- apply 0436_app_billing_paid_resume_progress
CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload; old_resume jsonb; new_resume jsonb;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.provider_result ? 'resume' THEN
    new_resume := NEW.provider_result->'resume';
    IF NOT COALESCE(
      NEW.provider_result->>'kind' = 'checkout'
      AND NEW.provider_result->>'mode' = 'setup'
      AND payload->>'domain' = 'buyer' AND payload->>'action' = 'checkout'
      AND NEW.provider_result->>'subscriptionId' IS NOT NULL
      AND jsonb_typeof(new_resume) = 'object'
      AND new_resume ?& ARRAY['notBefore','previousInvoiceId','invoiceId','action']
      AND (new_resume - ARRAY['notBefore','previousInvoiceId','invoiceId','action','invoicePaid']) = '{}'::jsonb
      AND jsonb_typeof(new_resume->'notBefore') = 'string'
      AND jsonb_typeof(new_resume->'previousInvoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'invoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'action') IN ('object','null')
      AND (NOT (new_resume ? 'invoicePaid') OR (new_resume->'invoicePaid' = 'true'::jsonb AND new_resume->>'invoiceId' IS NOT NULL)), false)
    THEN RAISE EXCEPTION 'Invalid setup resume payment progress'; END IF;
    IF NOT isfinite((new_resume->>'notBefore')::timestamptz)
      OR (new_resume->>'notBefore')::timestamptz < NEW.provider_started_at
      OR NEW.provider_started_at IS NULL
    THEN RAISE EXCEPTION 'Resume payment cannot precede command dispatch'; END IF;
    IF new_resume->>'previousInvoiceId' = '' THEN RAISE EXCEPTION 'Previous invoice must be a nonempty handle'; END IF;
    IF new_resume->>'invoiceId' IS NOT NULL AND
      (length(new_resume->>'invoiceId') = 0 OR new_resume->>'invoiceId' = new_resume->>'previousInvoiceId')
    THEN RAISE EXCEPTION 'Resume payment requires a new exact invoice'; END IF;
    IF new_resume->'action' <> 'null'::jsonb THEN
      IF NOT COALESCE(
      new_resume->'action'->>'kind' = 'payment'
      AND new_resume->'action'->>'invoiceId' = new_resume->>'invoiceId'
      AND new_resume->'action'->>'customerId' = NEW.provider_result->>'customerId'
      AND new_resume->'action'->>'subscriptionId' = NEW.provider_result->>'subscriptionId'
      AND jsonb_typeof(new_resume->'action'->'url') = 'string'
      AND jsonb_typeof(new_resume->'action'->'expiresAt') = 'string'
      AND ((new_resume->'action') - ARRAY['kind','invoiceId','customerId','subscriptionId','url','expiresAt']) = '{}'::jsonb, false)
      THEN RAISE EXCEPTION 'Resume payment action must match its original invoice'; END IF;
      IF NOT isfinite((new_resume->'action'->>'expiresAt')::timestamptz)
      THEN RAISE EXCEPTION 'Resume payment expiration must be finite'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result ? 'resume' THEN
    old_resume := OLD.provider_result->'resume';
    new_resume := NEW.provider_result->'resume';
    IF new_resume IS NULL
      OR (old_resume - ARRAY['invoiceId','action','invoicePaid']) IS DISTINCT FROM (new_resume - ARRAY['invoiceId','action','invoicePaid'])
      OR (old_resume->>'invoiceId' IS NOT NULL AND old_resume->'invoiceId' IS DISTINCT FROM new_resume->'invoiceId')
      OR (old_resume->'action' <> 'null'::jsonb AND old_resume->'action' IS DISTINCT FROM new_resume->'action')
      OR (old_resume ? 'invoicePaid' AND old_resume->'invoicePaid' IS DISTINCT FROM new_resume->'invoicePaid')
    THEN RAISE EXCEPTION 'Resume payment progress is immutable once observed'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSIF NEW.kind = 'import' THEN
      IF NOT COALESCE(payload->>'domain' = 'operator' AND payload->>'action' = 'import' AND payload->>'manifestDigest' = NEW.request_digest AND payload->'manifest'->>'scopeId' = NEW.billing_scope_id::text AND payload->'manifest'->>'planRevisionId' = NEW.target_plan_revision_id::text AND payload->'manifest'->>'principalUserId' = NEW.requested_by_user_id::text AND (payload->'manifest'->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'Invalid operator import intent'; END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL) AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_PAYMENT_EXPIRED' AND NEW.request_payload->>'domain' = 'buyer' AND NEW.request_payload->>'action' = 'update' AND NEW.provider_result->>'kind' = 'payment' AND NEW.provider_result->>'invoiceId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('4c7bc8332b4e494aeff27d0ceed4b1778e3f8c95f0f19b5e4e9f10cd28c62451', 1796083200063);
-- apply 0437_app_billing_deletion_checkout
CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload; old_resume jsonb; new_resume jsonb; cleanup_source record; cleanup_request record; cleanup_phase record;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.provider_result ? 'resume' THEN
    new_resume := NEW.provider_result->'resume';
    IF NOT COALESCE(
      NEW.provider_result->>'kind' = 'checkout'
      AND NEW.provider_result->>'mode' = 'setup'
      AND payload->>'domain' = 'buyer' AND payload->>'action' = 'checkout'
      AND NEW.provider_result->>'subscriptionId' IS NOT NULL
      AND jsonb_typeof(new_resume) = 'object'
      AND new_resume ?& ARRAY['notBefore','previousInvoiceId','invoiceId','action']
      AND (new_resume - ARRAY['notBefore','previousInvoiceId','invoiceId','action','invoicePaid']) = '{}'::jsonb
      AND jsonb_typeof(new_resume->'notBefore') = 'string'
      AND jsonb_typeof(new_resume->'previousInvoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'invoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'action') IN ('object','null')
      AND (NOT (new_resume ? 'invoicePaid') OR (new_resume->'invoicePaid' = 'true'::jsonb AND new_resume->>'invoiceId' IS NOT NULL)), false)
    THEN RAISE EXCEPTION 'Invalid setup resume payment progress'; END IF;
    IF NOT isfinite((new_resume->>'notBefore')::timestamptz)
      OR (new_resume->>'notBefore')::timestamptz < NEW.provider_started_at
      OR NEW.provider_started_at IS NULL
    THEN RAISE EXCEPTION 'Resume payment cannot precede command dispatch'; END IF;
    IF new_resume->>'previousInvoiceId' = '' THEN RAISE EXCEPTION 'Previous invoice must be a nonempty handle'; END IF;
    IF new_resume->>'invoiceId' IS NOT NULL AND
      (length(new_resume->>'invoiceId') = 0 OR new_resume->>'invoiceId' = new_resume->>'previousInvoiceId')
    THEN RAISE EXCEPTION 'Resume payment requires a new exact invoice'; END IF;
    IF new_resume->'action' <> 'null'::jsonb THEN
      IF NOT COALESCE(
      new_resume->'action'->>'kind' = 'payment'
      AND new_resume->'action'->>'invoiceId' = new_resume->>'invoiceId'
      AND new_resume->'action'->>'customerId' = NEW.provider_result->>'customerId'
      AND new_resume->'action'->>'subscriptionId' = NEW.provider_result->>'subscriptionId'
      AND jsonb_typeof(new_resume->'action'->'url') = 'string'
      AND jsonb_typeof(new_resume->'action'->'expiresAt') = 'string'
      AND ((new_resume->'action') - ARRAY['kind','invoiceId','customerId','subscriptionId','url','expiresAt']) = '{}'::jsonb, false)
      THEN RAISE EXCEPTION 'Resume payment action must match its original invoice'; END IF;
      IF NOT isfinite((new_resume->'action'->>'expiresAt')::timestamptz)
      THEN RAISE EXCEPTION 'Resume payment expiration must be finite'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result ? 'resume' THEN
    old_resume := OLD.provider_result->'resume';
    new_resume := NEW.provider_result->'resume';
    IF new_resume IS NULL
      OR (old_resume - ARRAY['invoiceId','action','invoicePaid']) IS DISTINCT FROM (new_resume - ARRAY['invoiceId','action','invoicePaid'])
      OR (old_resume->>'invoiceId' IS NOT NULL AND old_resume->'invoiceId' IS DISTINCT FROM new_resume->'invoiceId')
      OR (old_resume->'action' <> 'null'::jsonb AND old_resume->'action' IS DISTINCT FROM new_resume->'action')
      OR (old_resume ? 'invoicePaid' AND old_resume->'invoicePaid' IS DISTINCT FROM new_resume->'invoicePaid')
    THEN RAISE EXCEPTION 'Resume payment progress is immutable once observed'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSIF NEW.kind = 'import' THEN
      IF NOT COALESCE(payload->>'domain' = 'operator' AND payload->>'action' = 'import' AND payload->>'manifestDigest' = NEW.request_digest AND payload->'manifest'->>'scopeId' = NEW.billing_scope_id::text AND payload->'manifest'->>'planRevisionId' = NEW.target_plan_revision_id::text AND payload->'manifest'->>'principalUserId' = NEW.requested_by_user_id::text AND (payload->'manifest'->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'Invalid operator import intent'; END IF;
    ELSIF payload->>'domain' = 'account_deletion' THEN
      SELECT * INTO cleanup_source FROM billing_subscription_commands WHERE id=(payload->>'sourceCommandId')::uuid;
      SELECT * INTO cleanup_request FROM account_deletion_requests WHERE id=(payload->>'requestId')::uuid;
      IF NOT COALESCE(NEW.kind='expire_checkout' AND payload->>'action'='expire_checkout'
        AND cleanup_source.request_payload->>'domain'='buyer' AND cleanup_source.request_payload->>'action'='checkout'
        AND cleanup_source.provider_result->>'kind'='checkout' AND cleanup_source.provider_started_at IS NOT NULL
        AND (NEW.billing_scope_id,NEW.app_id,NEW.organization_id,NEW.merchant_id,NEW.livemode,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision) IS NOT DISTINCT FROM (cleanup_source.billing_scope_id,cleanup_source.app_id,cleanup_source.organization_id,cleanup_source.merchant_id,cleanup_source.livemode,cleanup_source.requested_by_user_id,cleanup_source.subscription_id,cleanup_source.expected_subscription_revision)
        AND NEW.idempotency_key='deletion-expire:'||cleanup_source.id::text
        AND NEW.provider_idempotency_key='app-deletion-expire:'||cleanup_source.id::text
        AND (payload->>'checkoutSessionId',payload->>'customerId',payload->>'mode',payload->>'planRevisionId') IS NOT DISTINCT FROM (cleanup_source.provider_result->>'checkoutSessionId',cleanup_source.provider_result->>'customerId',cleanup_source.provider_result->>'mode',cleanup_source.target_plan_revision_id::text)
        AND ((payload->>'subscriptionId') IS NOT DISTINCT FROM (cleanup_source.provider_result->>'subscriptionId') OR (TG_OP='UPDATE' AND payload->>'mode'='subscription' AND payload->'subscriptionId'='null'::jsonb))
        AND cleanup_request.user_id=NEW.requested_by_user_id AND cleanup_request.request_digest=payload->>'requestDigest'
        AND cleanup_request.lifecycle_revision=(payload->>'lifecycleRevision')::bigint, false)
      THEN RAISE EXCEPTION 'Cleanup requires immutable original purchaser Checkout intent'; END IF;
      IF TG_OP='INSERT' THEN
        SELECT * INTO cleanup_phase FROM account_deletion_phase_receipts WHERE id=(payload->>'phaseReceiptId')::uuid AND request_id=cleanup_request.id;
        IF cleanup_request.status IS DISTINCT FROM 'processing' OR cleanup_request.irreversible_at IS NULL OR cleanup_phase.id IS NULL OR cleanup_phase.phase IS DISTINCT FROM 'stripe' OR cleanup_phase.lease_generation IS DISTINCT FROM (payload->>'initiatingPhaseGeneration')::bigint OR cleanup_phase.status IS NULL OR cleanup_phase.status NOT IN ('leased','calling','reconciling') OR cleanup_phase.lease_expires_at IS NULL OR NOT isfinite(cleanup_phase.lease_expires_at) OR (cleanup_phase.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp()
        THEN RAISE EXCEPTION 'Cleanup preparation requires current canonical deletion phase'; END IF;
        IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=cleanup_request.organization_id WHERE u.id=cleanup_request.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=cleanup_request.id AND u.account_lifecycle_revision=cleanup_request.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=cleanup_request.id AND o.account_lifecycle_revision=cleanup_request.lifecycle_revision)
        THEN RAISE EXCEPTION 'Cleanup preparation requires irreversible purchaser'; END IF;
      END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL) AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_PAYMENT_EXPIRED' AND NEW.request_payload->>'domain' = 'buyer' AND NEW.request_payload->>'action' = 'update' AND NEW.provider_result->>'kind' = 'payment' AND NEW.provider_result->>'invoiceId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('e94507f3274b7f9009b3ae65405bed256736ff29ea93e4572d44382fb410f570', 1796083200064);
-- apply 0438_app_billing_applied_revision
-- Pin the actual applied revision atomically; legacy rows remain unresolved until exact evidence is unique.
ALTER TABLE billing_subscription_commands ADD COLUMN IF NOT EXISTS result_subscription_revision bigint;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_commands_result_revision_fk FOREIGN KEY (result_subscription_id,organization_id,result_subscription_revision) REFERENCES billing_subscription_revisions(subscription_id,organization_id,revision) ON DELETE RESTRICT;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_commands_result_revision_check CHECK (result_subscription_revision IS NULL OR (status='APPLIED' AND result_subscription_id IS NOT NULL AND result_subscription_revision>0));
;
CREATE OR REPLACE FUNCTION guard_app_billing_applied_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_scope_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.result_subscription_revision IS NOT NULL AND ROW(NEW.result_subscription_id,NEW.result_subscription_revision,NEW.provider_response_digest) IS DISTINCT FROM ROW(OLD.result_subscription_id,OLD.result_subscription_revision,OLD.provider_response_digest) THEN RAISE EXCEPTION 'Applied billing revision is immutable'; END IF;
  IF NEW.result_subscription_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM billing_subscription_revisions r WHERE r.subscription_id=NEW.result_subscription_id AND r.organization_id=NEW.organization_id AND r.revision=NEW.result_subscription_revision AND r.provider_object_digest=NEW.provider_response_digest) THEN RAISE EXCEPTION 'Applied billing revision requires exact provider evidence'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_applied_revision_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_applied_revision();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('26a9b38fd0e6a4f6e01f0516381e34a2c6429fa320dfc834efdb30186735a774', 1796083200065);
-- apply 0439_app_billing_completed_checkout
-- A scope decision is not provider-completion or physical-erasure evidence.
-- These guards complement the repository transaction; writers must acquire its canonical owner/scope/user/request/phase locks.
CREATE OR REPLACE FUNCTION guard_app_billing_deletion_disposition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p record; sc record; merchant record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Billing deletion disposition history is immutable'; END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(OLD)-ARRAY['disposition','phase_generation','updated_at']) IS DISTINCT FROM (to_jsonb(NEW)-ARRAY['disposition','phase_generation','updated_at']) OR NEW.phase_generation<OLD.phase_generation OR (OLD.disposition='close' AND NEW.disposition<>'close')) THEN RAISE EXCEPTION 'Billing deletion disposition cannot reopen or change identity'; END IF;
  SELECT * INTO r FROM account_deletion_requests WHERE id=NEW.request_id;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=NEW.phase_receipt_id AND request_id=NEW.request_id FOR SHARE;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=NEW.scope_id;
  SELECT * INTO merchant FROM billing_merchants WHERE id=sc.merchant_id;
  IF r.id IS NULL OR p.id IS NULL OR sc.id IS NULL OR merchant.id IS NULL OR r.status<>'processing' OR r.irreversible_at IS NULL OR r.request_digest IS DISTINCT FROM NEW.request_digest OR r.lifecycle_revision IS DISTINCT FROM NEW.lifecycle_revision OR p.phase<>'stripe' OR p.lease_generation IS DISTINCT FROM NEW.phase_generation OR p.status NOT IN ('leased','calling','reconciling') OR p.lease_expires_at IS NULL OR NOT isfinite(p.lease_expires_at) OR (p.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Billing disposition requires current canonical deletion phase'; END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision) THEN RAISE EXCEPTION 'Billing disposition requires irreversible canonical subject'; END IF;
  IF (NEW.merchant_id,NEW.provider_account_key,NEW.livemode) IS DISTINCT FROM (sc.merchant_id,merchant.provider_account_key,sc.livemode) THEN RAISE EXCEPTION 'Billing deletion merchant scope mismatch'; END IF;
  IF r.organization_id IS DISTINCT FROM sc.organization_id AND NOT EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id=r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode)) AND NOT ((NEW.disposition='retain_shared' AND EXISTS(SELECT 1 FROM billing_subscription_commands c WHERE c.billing_scope_id=sc.id AND c.requested_by_user_id=r.user_id AND c.request_payload->>'domain'='buyer')) OR (NEW.disposition='close' AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions prior WHERE prior.request_id=NEW.request_id AND prior.scope_id=NEW.scope_id AND prior.disposition='close'))) THEN RAISE EXCEPTION 'Billing deletion subject does not administer scope'; END IF;
  IF NEW.disposition='close' AND sc.fenced_at IS NULL THEN RAISE EXCEPTION 'Closing billing scope must be fenced'; END IF;
  IF NEW.disposition='close' AND r.organization_id IS DISTINCT FROM sc.organization_id AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.scope_id AND d.disposition='close') AND EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp())) THEN RAISE EXCEPTION 'Surviving administrator requires shared retention'; END IF;
  IF NEW.disposition='retain_shared' AND (r.organization_id=sc.organization_id OR NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN RAISE EXCEPTION 'Shared retention requires a current surviving administrator'; END IF;
  IF NEW.disposition='retain_shared' AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.scope_id AND d.disposition='close') THEN RAISE EXCEPTION 'Closing billing scope cannot reopen'; END IF;
  RETURN NEW;
END $$;
;
CREATE OR REPLACE FUNCTION guard_app_billing_deletion_phase_completion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase='stripe' AND NEW.status='completed' AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.request_id=NEW.request_id AND d.disposition='close') THEN RAISE EXCEPTION 'Closing app billing scope requires provider cleanup before phase completion'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_deletion_phase_completion_guard BEFORE INSERT OR UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION guard_app_billing_deletion_phase_completion();
;
CREATE OR REPLACE FUNCTION guard_app_billing_completed_checkout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; r record; d record;
BEGIN
  IF NEW.provider_result->>'kind' IS DISTINCT FROM 'completed_checkout' THEN RETURN NEW; END IF;
  SELECT * INTO source FROM billing_subscription_commands WHERE id=(NEW.request_payload->>'sourceCommandId')::uuid;
  SELECT * INTO r FROM account_deletion_requests WHERE id=(NEW.request_payload->>'requestId')::uuid;
  SELECT * INTO d FROM app_billing_deletion_dispositions WHERE request_id=r.id AND scope_id=NEW.billing_scope_id;
  IF NOT COALESCE(NEW.request_payload->>'domain'='account_deletion' AND NEW.kind='expire_checkout' AND NEW.status='SUCCEEDED' AND source.status='APPLIED' AND source.result_subscription_revision IS NOT NULL AND source.result_subscription_id::text=NEW.provider_result->>'subscriptionId' AND source.result_subscription_revision::text=NEW.provider_result->>'subscriptionRevision' AND NEW.provider_result->>'checkoutSessionId'=source.provider_result->>'checkoutSessionId' AND source.applied_at IS NOT NULL AND d.scope_id IS NOT NULL AND d.phase_receipt_id::text=NEW.request_payload->>'phaseReceiptId' AND d.request_digest=NEW.request_payload->>'requestDigest',false) THEN RAISE EXCEPTION 'Completed cleanup requires canonical applied Checkout and disposition'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_completed_checkout_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_completed_checkout();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('6a222c0163b9e62f5b6bd0b7849e344ab41f9a554977ee6c05ec747eec39243f', 1796083200066);
-- apply 0440_app_billing_deletion_cancellation
CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload; old_resume jsonb; new_resume jsonb; cleanup_source record; cleanup_request record; cleanup_phase record;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.provider_result ? 'resume' THEN
    new_resume := NEW.provider_result->'resume';
    IF NOT COALESCE(
      NEW.provider_result->>'kind' = 'checkout'
      AND NEW.provider_result->>'mode' = 'setup'
      AND payload->>'domain' = 'buyer' AND payload->>'action' = 'checkout'
      AND NEW.provider_result->>'subscriptionId' IS NOT NULL
      AND jsonb_typeof(new_resume) = 'object'
      AND new_resume ?& ARRAY['notBefore','previousInvoiceId','invoiceId','action']
      AND (new_resume - ARRAY['notBefore','previousInvoiceId','invoiceId','action','invoicePaid']) = '{}'::jsonb
      AND jsonb_typeof(new_resume->'notBefore') = 'string'
      AND jsonb_typeof(new_resume->'previousInvoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'invoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'action') IN ('object','null')
      AND (NOT (new_resume ? 'invoicePaid') OR (new_resume->'invoicePaid' = 'true'::jsonb AND new_resume->>'invoiceId' IS NOT NULL)), false)
    THEN RAISE EXCEPTION 'Invalid setup resume payment progress'; END IF;
    IF NOT isfinite((new_resume->>'notBefore')::timestamptz)
      OR (new_resume->>'notBefore')::timestamptz < NEW.provider_started_at
      OR NEW.provider_started_at IS NULL
    THEN RAISE EXCEPTION 'Resume payment cannot precede command dispatch'; END IF;
    IF new_resume->>'previousInvoiceId' = '' THEN RAISE EXCEPTION 'Previous invoice must be a nonempty handle'; END IF;
    IF new_resume->>'invoiceId' IS NOT NULL AND
      (length(new_resume->>'invoiceId') = 0 OR new_resume->>'invoiceId' = new_resume->>'previousInvoiceId')
    THEN RAISE EXCEPTION 'Resume payment requires a new exact invoice'; END IF;
    IF new_resume->'action' <> 'null'::jsonb THEN
      IF NOT COALESCE(
      new_resume->'action'->>'kind' = 'payment'
      AND new_resume->'action'->>'invoiceId' = new_resume->>'invoiceId'
      AND new_resume->'action'->>'customerId' = NEW.provider_result->>'customerId'
      AND new_resume->'action'->>'subscriptionId' = NEW.provider_result->>'subscriptionId'
      AND jsonb_typeof(new_resume->'action'->'url') = 'string'
      AND jsonb_typeof(new_resume->'action'->'expiresAt') = 'string'
      AND ((new_resume->'action') - ARRAY['kind','invoiceId','customerId','subscriptionId','url','expiresAt']) = '{}'::jsonb, false)
      THEN RAISE EXCEPTION 'Resume payment action must match its original invoice'; END IF;
      IF NOT isfinite((new_resume->'action'->>'expiresAt')::timestamptz)
      THEN RAISE EXCEPTION 'Resume payment expiration must be finite'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result ? 'resume' THEN
    old_resume := OLD.provider_result->'resume';
    new_resume := NEW.provider_result->'resume';
    IF new_resume IS NULL
      OR (old_resume - ARRAY['invoiceId','action','invoicePaid']) IS DISTINCT FROM (new_resume - ARRAY['invoiceId','action','invoicePaid'])
      OR (old_resume->>'invoiceId' IS NOT NULL AND old_resume->'invoiceId' IS DISTINCT FROM new_resume->'invoiceId')
      OR (old_resume->'action' <> 'null'::jsonb AND old_resume->'action' IS DISTINCT FROM new_resume->'action')
      OR (old_resume ? 'invoicePaid' AND old_resume->'invoicePaid' IS DISTINCT FROM new_resume->'invoicePaid')
    THEN RAISE EXCEPTION 'Resume payment progress is immutable once observed'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSIF NEW.kind = 'import' THEN
      IF NOT COALESCE(payload->>'domain' = 'operator' AND payload->>'action' = 'import' AND payload->>'manifestDigest' = NEW.request_digest AND payload->'manifest'->>'scopeId' = NEW.billing_scope_id::text AND payload->'manifest'->>'planRevisionId' = NEW.target_plan_revision_id::text AND payload->'manifest'->>'principalUserId' = NEW.requested_by_user_id::text AND (payload->'manifest'->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'Invalid operator import intent'; END IF;
    ELSIF payload->>'domain' = 'account_deletion' AND payload->>'action' = 'cancel' THEN
      SELECT * INTO cleanup_request FROM account_deletion_requests WHERE id=(payload->>'requestId')::uuid;
      SELECT * INTO cleanup_phase FROM account_deletion_phase_receipts WHERE id=(payload->>'phaseReceiptId')::uuid AND request_id=cleanup_request.id;
      IF NOT COALESCE(NEW.kind='cancel' AND payload->>'timing'='immediate'
        AND cleanup_request.user_id=NEW.requested_by_user_id AND cleanup_request.request_digest=payload->>'requestDigest'
        AND cleanup_request.lifecycle_revision=(payload->>'lifecycleRevision')::bigint
        AND NEW.idempotency_key='deletion-cancel:'||cleanup_request.id::text||':'||NEW.subscription_id::text
        AND NEW.provider_idempotency_key='app-'||NEW.idempotency_key
        AND EXISTS(SELECT 1 FROM billing_subscriptions s WHERE s.id=NEW.subscription_id AND s.billing_scope_id=NEW.billing_scope_id
          AND s.id::text=payload->>'localSubscriptionId' AND s.stripe_subscription_id=payload->>'subscriptionId'
          AND s.stripe_customer_id=payload->>'customerId' AND s.plan_revision_id::text=payload->>'planRevisionId')
        AND merchant.stripe_account_id=payload->>'providerAccountId'
        AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.billing_scope_id AND d.request_id=cleanup_request.id
          AND d.disposition='close' AND d.request_digest=cleanup_request.request_digest AND d.lifecycle_revision=cleanup_request.lifecycle_revision
          AND d.phase_receipt_id=cleanup_phase.id AND d.merchant_id=NEW.merchant_id AND d.livemode=NEW.livemode)
        AND sc.fenced_at IS NOT NULL,false)
      THEN RAISE EXCEPTION 'Cancellation requires immutable selected closed-scope subscription intent'; END IF;
      IF TG_OP='INSERT' AND (cleanup_request.status IS DISTINCT FROM 'processing' OR cleanup_request.irreversible_at IS NULL
        OR cleanup_phase.phase IS DISTINCT FROM 'stripe' OR cleanup_phase.lease_generation IS DISTINCT FROM (payload->>'initiatingPhaseGeneration')::bigint
        OR cleanup_phase.status IS NULL OR cleanup_phase.status NOT IN ('leased','calling','reconciling') OR cleanup_phase.lease_expires_at IS NULL
        OR NOT isfinite(cleanup_phase.lease_expires_at) OR (cleanup_phase.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp())
      THEN RAISE EXCEPTION 'Cancellation preparation requires current canonical deletion phase'; END IF;
      IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=cleanup_request.organization_id
        WHERE u.id=cleanup_request.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=cleanup_request.id
        AND u.account_lifecycle_revision=cleanup_request.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible'
        AND o.account_deletion_request_id=cleanup_request.id AND o.account_lifecycle_revision=cleanup_request.lifecycle_revision)
      THEN RAISE EXCEPTION 'Cancellation preparation requires irreversible canonical subject'; END IF;
      IF NEW.status='APPLIED' AND NOT EXISTS(SELECT 1 FROM billing_subscription_revisions r WHERE r.subscription_id=NEW.result_subscription_id
        AND r.revision=NEW.result_subscription_revision AND r.status='canceled' AND r.provider_object_digest=NEW.provider_response_digest)
      THEN RAISE EXCEPTION 'Cancellation completion requires exact canceled revision evidence'; END IF;
    ELSIF payload->>'domain' = 'account_deletion' THEN
      SELECT * INTO cleanup_source FROM billing_subscription_commands WHERE id=(payload->>'sourceCommandId')::uuid;
      SELECT * INTO cleanup_request FROM account_deletion_requests WHERE id=(payload->>'requestId')::uuid;
      IF NOT COALESCE(NEW.kind='expire_checkout' AND payload->>'action'='expire_checkout'
        AND cleanup_source.request_payload->>'domain'='buyer' AND cleanup_source.request_payload->>'action'='checkout'
        AND cleanup_source.provider_result->>'kind'='checkout' AND cleanup_source.provider_started_at IS NOT NULL
        AND (NEW.billing_scope_id,NEW.app_id,NEW.organization_id,NEW.merchant_id,NEW.livemode,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision) IS NOT DISTINCT FROM (cleanup_source.billing_scope_id,cleanup_source.app_id,cleanup_source.organization_id,cleanup_source.merchant_id,cleanup_source.livemode,cleanup_source.requested_by_user_id,cleanup_source.subscription_id,cleanup_source.expected_subscription_revision)
        AND NEW.idempotency_key='deletion-expire:'||cleanup_source.id::text
        AND NEW.provider_idempotency_key='app-deletion-expire:'||cleanup_source.id::text
        AND (payload->>'checkoutSessionId',payload->>'customerId',payload->>'mode',payload->>'planRevisionId') IS NOT DISTINCT FROM (cleanup_source.provider_result->>'checkoutSessionId',cleanup_source.provider_result->>'customerId',cleanup_source.provider_result->>'mode',cleanup_source.target_plan_revision_id::text)
        AND ((payload->>'subscriptionId') IS NOT DISTINCT FROM (cleanup_source.provider_result->>'subscriptionId') OR (TG_OP='UPDATE' AND payload->>'mode'='subscription' AND payload->'subscriptionId'='null'::jsonb))
        AND cleanup_request.user_id=NEW.requested_by_user_id AND cleanup_request.request_digest=payload->>'requestDigest'
        AND cleanup_request.lifecycle_revision=(payload->>'lifecycleRevision')::bigint, false)
      THEN RAISE EXCEPTION 'Cleanup requires immutable original purchaser Checkout intent'; END IF;
      IF TG_OP='INSERT' THEN
        SELECT * INTO cleanup_phase FROM account_deletion_phase_receipts WHERE id=(payload->>'phaseReceiptId')::uuid AND request_id=cleanup_request.id;
        IF cleanup_request.status IS DISTINCT FROM 'processing' OR cleanup_request.irreversible_at IS NULL OR cleanup_phase.id IS NULL OR cleanup_phase.phase IS DISTINCT FROM 'stripe' OR cleanup_phase.lease_generation IS DISTINCT FROM (payload->>'initiatingPhaseGeneration')::bigint OR cleanup_phase.status IS NULL OR cleanup_phase.status NOT IN ('leased','calling','reconciling') OR cleanup_phase.lease_expires_at IS NULL OR NOT isfinite(cleanup_phase.lease_expires_at) OR (cleanup_phase.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp()
        THEN RAISE EXCEPTION 'Cleanup preparation requires current canonical deletion phase'; END IF;
        IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=cleanup_request.organization_id WHERE u.id=cleanup_request.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=cleanup_request.id AND u.account_lifecycle_revision=cleanup_request.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=cleanup_request.id AND o.account_lifecycle_revision=cleanup_request.lifecycle_revision)
        THEN RAISE EXCEPTION 'Cleanup preparation requires irreversible purchaser'; END IF;
      END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL) AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_PAYMENT_EXPIRED' AND NEW.request_payload->>'domain' = 'buyer' AND NEW.request_payload->>'action' = 'update' AND NEW.provider_result->>'kind' = 'payment' AND NEW.provider_result->>'invoiceId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('c66306ec91306cd8d3cb56c2e3e6955755ed997f98265c474abc81afda8b1d1a', 1796083200067);
-- apply 0441_billing_owner_subjects
CREATE TABLE billing_organization_subjects (
  id uuid PRIMARY KEY,
  live_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_organization_subjects_identity CHECK(live_organization_id IS NULL OR live_organization_id=id)
);
;
CREATE UNIQUE INDEX billing_organization_subjects_live_idx ON billing_organization_subjects(live_organization_id);
;
CREATE TABLE billing_app_subjects (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES billing_organization_subjects(id) ON DELETE RESTRICT,
  live_app_id uuid REFERENCES apps(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_app_subjects_owner_key UNIQUE(id,organization_id),
  CONSTRAINT billing_app_subjects_identity CHECK(live_app_id IS NULL OR live_app_id=id)
);
;
CREATE UNIQUE INDEX billing_app_subjects_live_idx ON billing_app_subjects(live_app_id);
;
CREATE TABLE billing_registration_subjects (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  live_registration_id uuid REFERENCES app_client_registrations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_registration_subjects_id_app_key UNIQUE(id,app_id),
  CONSTRAINT billing_registration_subjects_app_owner_fk FOREIGN KEY(app_id,organization_id) REFERENCES billing_app_subjects(id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT billing_registration_subjects_identity CHECK(live_registration_id IS NULL OR live_registration_id=id)
);
;
CREATE UNIQUE INDEX billing_registration_subjects_live_idx ON billing_registration_subjects(live_registration_id);
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('3a037af208381db6d75f51f5f82b36b706c047bdaaf42b3f939bdcc1b091b296', 1796083200068);
-- apply 0442_billing_owner_subject_guards
CREATE OR REPLACE FUNCTION guard_billing_owner_subject() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  live_column text;
  owner_id uuid;
  parent_app_id uuid;
  operational_id uuid;
  old_data jsonb;
  new_data jsonb;
BEGIN
  IF TG_OP IN ('DELETE','TRUNCATE') THEN
    RAISE EXCEPTION 'Billing ownership history cannot be removed';
  END IF;
  live_column := CASE TG_TABLE_NAME
    WHEN 'billing_organization_subjects' THEN 'live_organization_id'
    WHEN 'billing_app_subjects' THEN 'live_app_id'
    WHEN 'billing_registration_subjects' THEN 'live_registration_id'
    ELSE NULL END;
  IF live_column IS NULL THEN RAISE EXCEPTION 'Unsupported billing ownership table'; END IF;
  new_data := to_jsonb(NEW);
  IF TG_OP='UPDATE' THEN
    old_data := to_jsonb(OLD);
    IF old_data=new_data THEN RETURN NEW; END IF;
    IF old_data-live_column <> new_data-live_column
      OR old_data->>live_column IS NULL OR new_data->>live_column IS NOT NULL THEN
      RAISE EXCEPTION 'Billing ownership history is immutable';
    END IF;
    IF TG_TABLE_NAME='billing_organization_subjects' THEN
      SELECT id INTO operational_id FROM organizations WHERE id=OLD.id;
    ELSIF TG_TABLE_NAME='billing_app_subjects' THEN
      SELECT id INTO operational_id FROM apps WHERE id=OLD.id;
    ELSE
      SELECT id INTO operational_id FROM app_client_registrations WHERE id=OLD.id;
    END IF;
    IF operational_id IS NOT NULL THEN RAISE EXCEPTION 'Live billing ownership cannot detach'; END IF;
    RETURN NEW;
  END IF;
  IF (new_data->>live_column)::uuid IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'Billing ownership requires its original live identity';
  END IF;
  owner_id := CASE WHEN TG_TABLE_NAME='billing_organization_subjects' THEN NEW.id
    ELSE (new_data->>'organization_id')::uuid END;
  PERFORM id FROM organizations WHERE id=owner_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing owner organization is unavailable'; END IF;
  IF TG_TABLE_NAME<>'billing_organization_subjects' THEN
    PERFORM id FROM billing_organization_subjects WHERE id=owner_id AND live_organization_id=owner_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Erased billing owner cannot acquire new history'; END IF;
    parent_app_id := CASE WHEN TG_TABLE_NAME='billing_app_subjects' THEN NEW.id
      ELSE (new_data->>'app_id')::uuid END;
    PERFORM id FROM apps WHERE id=parent_app_id AND organization_id=owner_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Billing app ownership does not match'; END IF;
    IF TG_TABLE_NAME='billing_registration_subjects' THEN
      PERFORM id FROM billing_app_subjects WHERE id=parent_app_id AND live_app_id=parent_app_id AND organization_id=owner_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Erased billing app cannot acquire new history'; END IF;
      PERFORM id FROM app_client_registrations WHERE id=NEW.id
        AND app_id=parent_app_id AND owner_organization_id=owner_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Billing registration ownership does not match'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER billing_organization_subjects_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_organization_subjects FOR EACH ROW EXECUTE FUNCTION guard_billing_owner_subject();
;
CREATE TRIGGER billing_organization_subjects_truncate_guard BEFORE TRUNCATE ON billing_organization_subjects FOR EACH STATEMENT EXECUTE FUNCTION guard_billing_owner_subject();
;
CREATE TRIGGER billing_app_subjects_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_app_subjects FOR EACH ROW EXECUTE FUNCTION guard_billing_owner_subject();
;
CREATE TRIGGER billing_app_subjects_truncate_guard BEFORE TRUNCATE ON billing_app_subjects FOR EACH STATEMENT EXECUTE FUNCTION guard_billing_owner_subject();
;
CREATE TRIGGER billing_registration_subjects_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_registration_subjects FOR EACH ROW EXECUTE FUNCTION guard_billing_owner_subject();
;
CREATE TRIGGER billing_registration_subjects_truncate_guard BEFORE TRUNCATE ON billing_registration_subjects FOR EACH STATEMENT EXECUTE FUNCTION guard_billing_owner_subject();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('33417e1e2705dbe1ecb845a9272f713fe6812b0ef623d30fcd57ec4baf567b27', 1796083200069);
-- apply 0443_billing_owner_subject_creation
CREATE OR REPLACE FUNCTION ensure_billing_organization_subject(subject_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM organizations WHERE id=subject_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing owner organization is unavailable'; END IF;
  INSERT INTO billing_organization_subjects(id,live_organization_id)
    VALUES(subject_id,subject_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM billing_organization_subjects WHERE id=subject_id AND live_organization_id=subject_id)
    THEN RAISE EXCEPTION 'Erased billing owner cannot acquire new history'; END IF;
  RETURN subject_id;
END $$;
;
CREATE OR REPLACE FUNCTION ensure_billing_app_subject(subject_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE owner_id uuid;
BEGIN
  SELECT organization_id INTO owner_id FROM apps WHERE id=subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing app is unavailable'; END IF;
  PERFORM ensure_billing_organization_subject(owner_id);
  PERFORM id FROM apps WHERE id=subject_id AND organization_id=owner_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing app ownership changed'; END IF;
  INSERT INTO billing_app_subjects(id,organization_id,live_app_id)
    VALUES(subject_id,owner_id,subject_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM billing_app_subjects WHERE id=subject_id AND live_app_id=subject_id AND organization_id=owner_id)
    THEN RAISE EXCEPTION 'Erased or transferred billing app cannot acquire new history'; END IF;
  RETURN subject_id;
END $$;
;
CREATE OR REPLACE FUNCTION ensure_billing_registration_subject(subject_id uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE owner_id uuid; parent_app_id uuid;
BEGIN
  SELECT app_id,owner_organization_id INTO parent_app_id,owner_id FROM app_client_registrations WHERE id=subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing registration is unavailable'; END IF;
  PERFORM ensure_billing_app_subject(parent_app_id);
  PERFORM id FROM app_client_registrations WHERE id=subject_id AND app_id=parent_app_id AND owner_organization_id=owner_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Billing registration ownership changed'; END IF;
  INSERT INTO billing_registration_subjects(id,app_id,organization_id,live_registration_id)
    VALUES(subject_id,parent_app_id,owner_id,subject_id) ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM billing_registration_subjects WHERE id=subject_id AND live_registration_id=subject_id AND app_id=parent_app_id AND organization_id=owner_id)
    THEN RAISE EXCEPTION 'Erased or transferred billing registration cannot acquire new history'; END IF;
  RETURN subject_id;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('b7d436895d614db2f392d6a48158ec8cc9131a9b536e716b96de470dedf368b7', 1796083200070);
-- apply 0444_billing_owner_source_anchors
CREATE OR REPLACE FUNCTION anchor_billing_owner_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source jsonb; owner_id uuid; parent_app_id uuid; registration_id uuid;
BEGIN
  source := to_jsonb(NEW);
  owner_id := (source->>TG_ARGV[0])::uuid;
  parent_app_id := (source->>TG_ARGV[1])::uuid;
  registration_id := (source->>TG_ARGV[2])::uuid;
  IF owner_id IS NOT NULL THEN PERFORM ensure_billing_organization_subject(owner_id); END IF;
  IF parent_app_id IS NOT NULL THEN
    IF owner_id IS NOT NULL THEN
      PERFORM id FROM apps WHERE id=parent_app_id AND organization_id=owner_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Financial source app ownership does not match'; END IF;
    END IF;
    PERFORM ensure_billing_app_subject(parent_app_id);
    IF owner_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM billing_app_subjects WHERE id=parent_app_id AND organization_id=owner_id)
      THEN RAISE EXCEPTION 'Financial source app ownership does not match'; END IF;
  END IF;
  IF registration_id IS NOT NULL THEN
    IF parent_app_id IS NULL THEN RAISE EXCEPTION 'Financial source registration requires an app'; END IF;
    PERFORM id FROM app_client_registrations WHERE id=registration_id AND app_id=parent_app_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Financial source registration ownership does not match'; END IF;
    PERFORM ensure_billing_registration_subject(registration_id);
    IF parent_app_id IS NULL OR NOT EXISTS(SELECT 1 FROM billing_registration_subjects WHERE id=registration_id AND app_id=parent_app_id)
      THEN RAISE EXCEPTION 'Financial source registration ownership does not match'; END IF;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER billing_merchants_owner BEFORE INSERT ON billing_merchants FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
CREATE TRIGGER app_billing_accounts_owner BEFORE INSERT ON app_billing_accounts FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('','app_id','');
;
CREATE TRIGGER app_billing_plan_revisions_owner BEFORE INSERT ON app_billing_plan_revisions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('','app_id','');
;
CREATE TRIGGER app_billing_scopes_owner BEFORE INSERT ON app_billing_scopes FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','app_id','');
;
CREATE TRIGGER app_subscription_trials_owner BEFORE INSERT ON app_subscription_trials FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('','app_id','');
;
CREATE TRIGGER app_billing_application_slots_owner BEFORE INSERT ON app_billing_application_slots FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','app_id','');
;
CREATE TRIGGER billing_subscription_commands_owner BEFORE INSERT ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','app_id','client_registration_id');
;
CREATE TRIGGER app_billing_membership_operations_owner BEFORE INSERT ON app_billing_membership_operations FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('','app_id','client_registration_id');
;
CREATE TRIGGER billing_subscriptions_owner BEFORE INSERT ON billing_subscriptions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
CREATE TRIGGER billing_subscription_revisions_owner BEFORE INSERT ON billing_subscription_revisions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
CREATE TRIGGER billing_subscription_event_receipts_owner BEFORE INSERT ON billing_subscription_event_receipts FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
CREATE TRIGGER billing_subscription_incidents_owner BEFORE INSERT ON billing_subscription_incidents FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
CREATE TRIGGER subscription_allowance_periods_owner BEFORE INSERT ON subscription_allowance_periods FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
CREATE TRIGGER subscription_allowance_transactions_owner BEFORE INSERT ON subscription_allowance_transactions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
CREATE TRIGGER billing_funding_reservations_owner BEFORE INSERT ON billing_funding_reservations FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
CREATE TRIGGER billing_funding_allocations_owner BEFORE INSERT ON billing_funding_allocations FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
CREATE TRIGGER credit_transactions_owner BEFORE INSERT ON credit_transactions FOR EACH ROW EXECUTE FUNCTION anchor_billing_owner_source('organization_id','','');
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('a57b29a5336722611330d276d61d001c21ddb151b19203058fa218d1539a40b6', 1796083200071);
-- apply 0445_billing_owner_subject_backfill
DO $$
DECLARE subject_id uuid;
BEGIN
  FOR subject_id IN
    SELECT organization_id FROM billing_merchants
    UNION SELECT organization_id FROM app_billing_scopes
    UNION SELECT organization_id FROM app_billing_application_slots
    UNION SELECT organization_id FROM billing_subscription_commands
    UNION SELECT organization_id FROM billing_subscriptions
    UNION SELECT organization_id FROM billing_subscription_revisions
    UNION SELECT organization_id FROM billing_subscription_event_receipts
    UNION SELECT organization_id FROM billing_subscription_incidents
    UNION SELECT organization_id FROM subscription_allowance_periods
    UNION SELECT organization_id FROM subscription_allowance_transactions
    UNION SELECT organization_id FROM billing_funding_reservations
    UNION SELECT organization_id FROM billing_funding_allocations
    UNION SELECT organization_id FROM credit_transactions
    ORDER BY 1
  LOOP
    IF subject_id IS NOT NULL THEN PERFORM ensure_billing_organization_subject(subject_id); END IF;
  END LOOP;
  FOR subject_id IN
    SELECT app_id FROM app_billing_accounts
    UNION SELECT app_id FROM app_billing_plan_revisions
    UNION SELECT app_id FROM app_billing_scopes
    UNION SELECT app_id FROM app_subscription_trials
    UNION SELECT app_id FROM app_billing_application_slots
    UNION SELECT app_id FROM billing_subscription_commands
    UNION SELECT app_id FROM app_billing_membership_operations
    ORDER BY 1
  LOOP
    IF subject_id IS NOT NULL THEN PERFORM ensure_billing_app_subject(subject_id); END IF;
  END LOOP;
  FOR subject_id IN
    SELECT client_registration_id FROM billing_subscription_commands
    UNION SELECT client_registration_id FROM app_billing_membership_operations
    ORDER BY 1
  LOOP
    IF subject_id IS NOT NULL THEN PERFORM ensure_billing_registration_subject(subject_id); END IF;
  END LOOP;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('a9b91a0ad8ff689a1d5295eb678165dd48df5be3dde6c521af18ed1a289e1ac7', 1796083200072);
-- apply 0446_billing_financial_history_retention
CREATE OR REPLACE FUNCTION reject_subscription_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('f3b52add7a897a9b77f5d74b16ff8534d4fe716588e51118df733425142805a9', 1796083200073);
-- apply 0447_app_billing_customer_terminal_obligations
CREATE OR REPLACE FUNCTION require_app_billing_customer_terminal_obligations(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE binding record;
BEGIN
  PERFORM require_app_billing_customer_closure(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation);
  SELECT * INTO STRICT binding FROM app_billing_customers WHERE id=p_binding_id;
  IF NOT EXISTS(SELECT 1 FROM app_billing_customer_closures c WHERE c.customer_binding_id=p_binding_id
    AND c.billing_account_id=binding.billing_account_id AND c.merchant_id=binding.merchant_id
    AND c.stripe_customer_id=binding.stripe_customer_id)
    THEN RAISE EXCEPTION 'Customer deletion requires retained closure identity'; END IF;
  PERFORM b.id FROM billing_subscriptions b JOIN app_billing_scopes s ON s.id=b.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY b.id FOR UPDATE OF b;
  PERFORM c.id FROM billing_subscription_commands c JOIN app_billing_scopes s ON s.id=c.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY c.id FOR UPDATE OF c;
  PERFORM r.id FROM billing_funding_reservations r JOIN app_billing_scopes s ON s.id=r.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY r.id FOR UPDATE OF r;
  PERFORM require_app_billing_customer_closure(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation);
  IF EXISTS(SELECT 1 FROM billing_subscriptions b JOIN app_billing_scopes s ON s.id=b.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id
    AND (b.status IS DISTINCT FROM 'canceled' OR b.stripe_customer_id IS DISTINCT FROM binding.stripe_customer_id))
    THEN RAISE EXCEPTION 'Customer deletion has unresolved subscription obligations'; END IF;
  IF EXISTS(SELECT 1 FROM billing_subscription_commands c JOIN app_billing_scopes s ON s.id=c.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id
    AND NOT COALESCE(c.status IN ('APPLIED','FAILED','SUPERSEDED') OR
      (c.status='SUCCEEDED' AND c.request_payload->>'domain'='account_deletion' AND c.request_payload->>'action'='expire_checkout'),false))
    THEN RAISE EXCEPTION 'Customer deletion has unresolved provider commands'; END IF;
  IF EXISTS(SELECT 1 FROM billing_funding_reservations r JOIN app_billing_scopes s ON s.id=r.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id AND r.status NOT IN ('finalized','canceled'))
    THEN RAISE EXCEPTION 'Customer deletion has unsettled usage reservations'; END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('22e225654e00d3c5aabb2baae097d77f34c9324d1e8367aca79ae8ba970e4d1f', 1796083200074);
-- apply 0448_app_billing_customer_command_shape
ALTER TABLE billing_subscription_commands DROP CONSTRAINT billing_subscription_commands_intent_check;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_subscription_commands_intent_check CHECK (("kind" IN ('checkout','import') AND "subscription_id" IS NULL AND "expected_subscription_revision" IS NULL AND "target_plan_key" IS NOT NULL AND ("billing_scope_id" IS NOT NULL AND "target_plan_revision_id" IS NOT NULL OR "target_plan_key" IN ('plus_monthly','pro_monthly'))) OR ("kind" IN ('upgrade','downgrade') AND "subscription_id" IS NOT NULL AND "expected_subscription_revision" > 0 AND "target_plan_key" IS NOT NULL AND ("billing_scope_id" IS NOT NULL AND "target_plan_revision_id" IS NOT NULL OR "target_plan_key" IN ('plus_monthly','pro_monthly'))) OR ("kind" IN ('cancel','resume') AND "subscription_id" IS NOT NULL AND "expected_subscription_revision" > 0 AND "target_plan_key" IS NULL) OR ("app_id" IS NOT NULL AND "kind" IN ('portal','expire_checkout') AND "target_plan_key" IS NULL AND "target_plan_revision_id" IS NULL AND (("subscription_id" IS NULL AND "expected_subscription_revision" IS NULL) OR ("subscription_id" IS NOT NULL AND "expected_subscription_revision" > 0))) OR ("app_id" IS NOT NULL AND "billing_scope_id" IS NOT NULL AND "kind" = 'delete_customer' AND "subscription_id" IS NULL AND "expected_subscription_revision" IS NULL AND "target_plan_key" IS NULL AND "target_plan_revision_id" IS NULL) OR ("app_id" IS NOT NULL AND "billing_scope_id" IS NULL AND "kind" IN ('merchant_create','merchant_adopt','merchant_platform','merchant_onboarding','plan_create','plan_adopt','refund') AND "subscription_id" IS NULL AND "expected_subscription_revision" IS NULL AND "target_plan_key" IS NULL AND "target_plan_revision_id" IS NULL));
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('9513f6a3660ee49f4243cad53e0861edda8e263df6a3065154fe2f023f8e5af6', 1796083200075);
-- apply 0449_app_billing_terminal_buyer_commands
CREATE OR REPLACE FUNCTION require_app_billing_customer_terminal_obligations(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE binding record;
BEGIN
  PERFORM require_app_billing_customer_closure(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation);
  SELECT * INTO STRICT binding FROM app_billing_customers WHERE id=p_binding_id;
  IF NOT EXISTS(SELECT 1 FROM app_billing_customer_closures c WHERE c.customer_binding_id=p_binding_id
    AND c.billing_account_id=binding.billing_account_id AND c.merchant_id=binding.merchant_id
    AND c.stripe_customer_id=binding.stripe_customer_id)
    THEN RAISE EXCEPTION 'Customer deletion requires retained closure identity'; END IF;
  PERFORM b.id FROM billing_subscriptions b JOIN app_billing_scopes s ON s.id=b.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY b.id FOR UPDATE OF b;
  PERFORM c.id FROM billing_subscription_commands c JOIN app_billing_scopes s ON s.id=c.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY c.id FOR UPDATE OF c;
  PERFORM r.id FROM billing_funding_reservations r JOIN app_billing_scopes s ON s.id=r.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY r.id FOR UPDATE OF r;
  PERFORM require_app_billing_customer_closure(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation);
  IF EXISTS(SELECT 1 FROM billing_subscriptions b JOIN app_billing_scopes s ON s.id=b.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id
    AND (b.status IS DISTINCT FROM 'canceled' OR b.stripe_customer_id IS DISTINCT FROM binding.stripe_customer_id))
    THEN RAISE EXCEPTION 'Customer deletion has unresolved subscription obligations'; END IF;
  IF EXISTS(SELECT 1 FROM billing_subscription_commands c JOIN app_billing_scopes s ON s.id=c.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id
    AND NOT COALESCE(c.status IN ('APPLIED','FAILED','SUPERSEDED') OR
      (c.status='SUCCEEDED' AND (
        (c.request_payload->>'domain'='account_deletion' AND c.request_payload->>'action'='expire_checkout') OR
        (c.request_payload->>'domain'='buyer' AND (
          (c.kind='portal' AND c.request_payload->>'action'='portal' AND c.provider_result->>'kind'='portal') OR
          (c.kind='expire_checkout' AND c.request_payload->>'action'='expire_checkout' AND c.provider_result->>'kind'='expired_checkout'))))),false))
    THEN RAISE EXCEPTION 'Customer deletion has unresolved provider commands'; END IF;
  IF EXISTS(SELECT 1 FROM billing_funding_reservations r JOIN app_billing_scopes s ON s.id=r.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id AND r.status NOT IN ('finalized','canceled'))
    THEN RAISE EXCEPTION 'Customer deletion has unsettled usage reservations'; END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('f92e8af6c82c932d10fbd8ee69623e7695e379f4fc308db11c0d51a9b8c7be22', 1796083200076);
-- apply 0450_app_billing_customer_command_identity
CREATE OR REPLACE FUNCTION validate_app_billing_customer_deletion_intent(command billing_subscription_commands) RETURNS void LANGUAGE plpgsql AS $$
DECLARE closure app_billing_customer_closures%ROWTYPE; request account_deletion_requests%ROWTYPE; scope app_billing_scopes%ROWTYPE; payload jsonb := command.request_payload;
BEGIN
  SELECT * INTO closure FROM app_billing_customer_closures WHERE customer_binding_id=(payload->>'customerBindingId')::uuid;
  SELECT * INTO request FROM account_deletion_requests WHERE id=(payload->>'requestId')::uuid;
  SELECT * INTO scope FROM app_billing_scopes WHERE id=command.billing_scope_id;
  IF NOT COALESCE(command.kind='delete_customer' AND payload->>'domain'='account_deletion'
    AND payload->>'action'='delete_customer' AND payload->>'version'='1'
    AND closure.customer_binding_id IS NOT NULL AND request.id IS NOT NULL AND scope.id IS NOT NULL
    AND command.app_id=closure.app_id AND command.merchant_id=closure.merchant_id AND command.livemode=closure.livemode
    AND command.merchant_key=closure.provider_account_key AND command.organization_id=scope.organization_id
    AND scope.billing_account_id=closure.billing_account_id AND scope.merchant_id=closure.merchant_id
    AND scope.app_id=closure.app_id AND scope.livemode=closure.livemode
    AND command.requested_by_user_id=request.user_id
    AND payload->>'requestDigest'=request.request_digest AND (payload->>'lifecycleRevision')::bigint=request.lifecycle_revision
    AND payload->>'closureRequestId'=closure.initiating_request_id::text AND payload->>'closureRequestDigest'=closure.request_digest
    AND payload->>'billingAccountId'=closure.billing_account_id::text
    AND payload->>'customerId'=closure.stripe_customer_id AND payload->>'providerAccountId'=closure.stripe_account_id
    AND command.idempotency_key='deletion-customer:'||closure.customer_binding_id::text
    AND command.provider_idempotency_key='app-'||command.idempotency_key
    AND command.subscription_id IS NULL AND command.expected_subscription_revision IS NULL
    AND command.target_plan_key IS NULL AND command.target_plan_revision_id IS NULL
    AND command.client_registration_id IS NULL,false)
  THEN RAISE EXCEPTION 'Customer deletion requires immutable original closure intent'; END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('bfd9d6bc556ce26fb1ada18a3ccf05f44435fd53eee789116a4992179ea0c795', 1796083200077);
-- apply 0451_app_billing_customer_execution_lease
CREATE OR REPLACE FUNCTION require_app_billing_customer_terminal_obligations(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint, p_command_id uuid, p_lease_token uuid, p_execution_generation bigint, p_state_revision bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE binding record; executing billing_subscription_commands%ROWTYPE;
BEGIN
  PERFORM require_app_billing_customer_closure(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation);
  SELECT * INTO STRICT binding FROM app_billing_customers WHERE id=p_binding_id;
  IF NOT EXISTS(SELECT 1 FROM app_billing_customer_closures c WHERE c.customer_binding_id=p_binding_id
    AND c.billing_account_id=binding.billing_account_id AND c.merchant_id=binding.merchant_id
    AND c.stripe_customer_id=binding.stripe_customer_id)
    THEN RAISE EXCEPTION 'Customer deletion requires retained closure identity'; END IF;
  PERFORM b.id FROM billing_subscriptions b JOIN app_billing_scopes s ON s.id=b.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY b.id FOR UPDATE OF b;
  PERFORM c.id FROM billing_subscription_commands c JOIN app_billing_scopes s ON s.id=c.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY c.id FOR UPDATE OF c;
  PERFORM r.id FROM billing_funding_reservations r JOIN app_billing_scopes s ON s.id=r.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id ORDER BY r.id FOR UPDATE OF r;
  PERFORM require_app_billing_customer_closure(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation);
  IF p_command_id IS NOT NULL THEN
    SELECT * INTO executing FROM billing_subscription_commands WHERE id=p_command_id;
    PERFORM validate_app_billing_customer_deletion_intent(executing);
    IF NOT COALESCE(executing.status='OUTCOME_UNKNOWN'
      AND executing.request_payload->>'customerBindingId'=p_binding_id::text
      AND executing.lease_token=p_lease_token AND executing.execution_generation=p_execution_generation
      AND executing.state_revision=p_state_revision AND executing.lease_expires_at IS NOT NULL
      AND isfinite(executing.lease_expires_at) AND executing.lease_expires_at>clock_timestamp(),false)
    THEN RAISE EXCEPTION 'Customer deletion requires its exact current execution lease'; END IF;
  ELSIF p_lease_token IS NOT NULL OR p_execution_generation IS NOT NULL OR p_state_revision IS NOT NULL THEN
    RAISE EXCEPTION 'Customer deletion lease cannot omit its command';
  END IF;
  IF EXISTS(SELECT 1 FROM billing_subscriptions b JOIN app_billing_scopes s ON s.id=b.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id
    AND (b.status IS DISTINCT FROM 'canceled' OR b.stripe_customer_id IS DISTINCT FROM binding.stripe_customer_id))
    THEN RAISE EXCEPTION 'Customer deletion has unresolved subscription obligations'; END IF;
  IF EXISTS(SELECT 1 FROM billing_subscription_commands c JOIN app_billing_scopes s ON s.id=c.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id
    AND (p_command_id IS NULL OR c.id<>p_command_id)
    AND NOT COALESCE(c.status IN ('APPLIED','FAILED','SUPERSEDED') OR
      (c.status='SUCCEEDED' AND (
        (c.kind='delete_customer' AND c.request_payload->>'domain'='account_deletion'
          AND c.request_payload->>'action'='delete_customer' AND c.provider_result->>'kind'='deleted_customer'
          AND c.provider_result->>'customerBindingId'=binding.id::text) OR
        (c.request_payload->>'domain'='account_deletion' AND c.request_payload->>'action'='expire_checkout') OR
        (c.request_payload->>'domain'='buyer' AND (
          (c.kind='portal' AND c.request_payload->>'action'='portal' AND c.provider_result->>'kind'='portal') OR
          (c.kind='expire_checkout' AND c.request_payload->>'action'='expire_checkout' AND c.provider_result->>'kind'='expired_checkout'))))),false))
    THEN RAISE EXCEPTION 'Customer deletion has unresolved provider commands'; END IF;
  IF EXISTS(SELECT 1 FROM billing_funding_reservations r JOIN app_billing_scopes s ON s.id=r.billing_scope_id
    WHERE s.billing_account_id=binding.billing_account_id AND s.merchant_id=binding.merchant_id AND r.status NOT IN ('finalized','canceled'))
    THEN RAISE EXCEPTION 'Customer deletion has unsettled usage reservations'; END IF;
END $$;
;
CREATE OR REPLACE FUNCTION require_app_billing_customer_terminal_obligations(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM require_app_billing_customer_terminal_obligations(p_binding_id,p_request_id,p_request_digest,p_lifecycle_revision,p_phase_id,p_phase_generation,NULL,NULL,NULL,NULL);
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('08246b8197762c4e60dd5bfbdade4504506cc3601d63a184ab7a432b67054920', 1796083200078);
-- apply 0452_app_billing_customer_completion_guard
CREATE OR REPLACE FUNCTION validate_app_billing_customer_deletion_transition(command billing_subscription_commands, previous billing_subscription_commands) RETURNS void LANGUAGE plpgsql AS $$
DECLARE payload jsonb := command.request_payload; result jsonb := command.provider_result; observation jsonb; authority jsonb;
BEGIN
  IF previous.id IS NULL THEN
    IF command.status IS DISTINCT FROM 'PREPARED' OR result IS NOT NULL THEN
      RAISE EXCEPTION 'Customer deletion must start with prepared durable intent';
    END IF;
    PERFORM require_app_billing_customer_terminal_obligations((payload->>'customerBindingId')::uuid,(payload->>'requestId')::uuid,payload->>'requestDigest',(payload->>'lifecycleRevision')::bigint,(payload->>'phaseReceiptId')::uuid,(payload->>'initiatingPhaseGeneration')::bigint);
    RETURN;
  END IF;
  IF previous.status='SUCCEEDED' THEN
    IF command IS DISTINCT FROM previous THEN RAISE EXCEPTION 'Customer deletion completion is immutable'; END IF;
    RETURN;
  END IF;
  IF command.status NOT IN ('PREPARED','OUTCOME_UNKNOWN','SUCCEEDED') THEN
    RAISE EXCEPTION 'Customer deletion remains pending until exact tombstone proof';
  END IF;
  IF command.status<>'SUCCEEDED' THEN
    IF result IS NOT NULL THEN RAISE EXCEPTION 'Customer deletion result requires terminal proof'; END IF;
    RETURN;
  END IF;
  observation := result->'observation'; authority := result->'completionAuthority';
  IF NOT COALESCE(previous.status='OUTCOME_UNKNOWN' AND result->>'kind'='deleted_customer'
    AND result->>'customerBindingId'=payload->>'customerBindingId'
    AND observation->'value'->>'status'='deleted' AND observation->'value'->>'customerId'=payload->>'customerId'
    AND observation->>'merchantId'=command.merchant_id::text
    AND observation->>'providerAccountId'=payload->>'providerAccountId'
    AND (observation->>'livemode')::boolean=command.livemode
    AND observation->>'apiVersion'='2024-11-20.acacia'
    AND observation->>'digest'=command.provider_response_digest
    AND observation->>'inputDigest' ~ '^[0-9a-f]{64}$'
    AND isfinite((observation->>'observedAt')::timestamptz)
    AND (observation->>'observedAt')::timestamptz>=previous.provider_started_at
    AND (observation->>'observedAt')::timestamptz<=clock_timestamp()
    AND command.lease_token IS NULL AND command.lease_expires_at IS NULL
    AND command.execution_generation=previous.execution_generation,false)
  THEN RAISE EXCEPTION 'Customer deletion requires exact retained tombstone evidence'; END IF;
  PERFORM require_app_billing_customer_terminal_obligations((payload->>'customerBindingId')::uuid,(authority->>'requestId')::uuid,authority->>'requestDigest',(authority->>'lifecycleRevision')::bigint,(authority->>'phaseReceiptId')::uuid,(authority->>'phaseGeneration')::bigint,previous.id,previous.lease_token,previous.execution_generation,previous.state_revision);
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('fe804e2124cd799c9ae22280155299902ac0e120fccd8d01a36d8be922396a8b', 1796083200079);
-- apply 0453_app_billing_customer_command_guard
CREATE OR REPLACE FUNCTION validate_app_billing_command_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc record; registration record; merchant record; payload jsonb := NEW.request_payload; old_resume jsonb; new_resume jsonb; cleanup_source record; cleanup_request record; cleanup_phase record;
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.app_id,NEW.livemode,NEW.merchant_id,NEW.client_registration_id,NEW.request_payload) IS DISTINCT FROM ROW(OLD.app_id,OLD.livemode,OLD.merchant_id,OLD.client_registration_id,OLD.request_payload) THEN RAISE EXCEPTION 'App billing command intent is immutable'; END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result IS NOT NULL AND OLD.provider_result IS DISTINCT FROM NEW.provider_result THEN
    IF NEW.provider_result IS NULL OR (OLD.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) IS DISTINCT FROM (NEW.provider_result - ARRAY['subscriptionId','subscriptionRevision','resume']) OR (OLD.provider_result->>'subscriptionId' IS NOT NULL AND (OLD.provider_result->>'subscriptionId') IS DISTINCT FROM (NEW.provider_result->>'subscriptionId')) OR (OLD.provider_result->>'subscriptionRevision' IS NOT NULL AND (OLD.provider_result->>'subscriptionRevision') IS DISTINCT FROM (NEW.provider_result->>'subscriptionRevision')) OR OLD.provider_result->>'kind' NOT IN ('checkout','completed') THEN RAISE EXCEPTION 'App billing provider result handles are immutable'; END IF;
  END IF;
  IF NEW.provider_result ? 'resume' THEN
    new_resume := NEW.provider_result->'resume';
    IF NOT COALESCE(
      NEW.provider_result->>'kind' = 'checkout'
      AND NEW.provider_result->>'mode' = 'setup'
      AND payload->>'domain' = 'buyer' AND payload->>'action' = 'checkout'
      AND NEW.provider_result->>'subscriptionId' IS NOT NULL
      AND jsonb_typeof(new_resume) = 'object'
      AND new_resume ?& ARRAY['notBefore','previousInvoiceId','invoiceId','action']
      AND (new_resume - ARRAY['notBefore','previousInvoiceId','invoiceId','action','invoicePaid']) = '{}'::jsonb
      AND jsonb_typeof(new_resume->'notBefore') = 'string'
      AND jsonb_typeof(new_resume->'previousInvoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'invoiceId') IN ('string','null')
      AND jsonb_typeof(new_resume->'action') IN ('object','null')
      AND (NOT (new_resume ? 'invoicePaid') OR (new_resume->'invoicePaid' = 'true'::jsonb AND new_resume->>'invoiceId' IS NOT NULL)), false)
    THEN RAISE EXCEPTION 'Invalid setup resume payment progress'; END IF;
    IF NOT isfinite((new_resume->>'notBefore')::timestamptz)
      OR (new_resume->>'notBefore')::timestamptz < NEW.provider_started_at
      OR NEW.provider_started_at IS NULL
    THEN RAISE EXCEPTION 'Resume payment cannot precede command dispatch'; END IF;
    IF new_resume->>'previousInvoiceId' = '' THEN RAISE EXCEPTION 'Previous invoice must be a nonempty handle'; END IF;
    IF new_resume->>'invoiceId' IS NOT NULL AND
      (length(new_resume->>'invoiceId') = 0 OR new_resume->>'invoiceId' = new_resume->>'previousInvoiceId')
    THEN RAISE EXCEPTION 'Resume payment requires a new exact invoice'; END IF;
    IF new_resume->'action' <> 'null'::jsonb THEN
      IF NOT COALESCE(
      new_resume->'action'->>'kind' = 'payment'
      AND new_resume->'action'->>'invoiceId' = new_resume->>'invoiceId'
      AND new_resume->'action'->>'customerId' = NEW.provider_result->>'customerId'
      AND new_resume->'action'->>'subscriptionId' = NEW.provider_result->>'subscriptionId'
      AND jsonb_typeof(new_resume->'action'->'url') = 'string'
      AND jsonb_typeof(new_resume->'action'->'expiresAt') = 'string'
      AND ((new_resume->'action') - ARRAY['kind','invoiceId','customerId','subscriptionId','url','expiresAt']) = '{}'::jsonb, false)
      THEN RAISE EXCEPTION 'Resume payment action must match its original invoice'; END IF;
      IF NOT isfinite((new_resume->'action'->>'expiresAt')::timestamptz)
      THEN RAISE EXCEPTION 'Resume payment expiration must be finite'; END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_result ? 'resume' THEN
    old_resume := OLD.provider_result->'resume';
    new_resume := NEW.provider_result->'resume';
    IF new_resume IS NULL
      OR (old_resume - ARRAY['invoiceId','action','invoicePaid']) IS DISTINCT FROM (new_resume - ARRAY['invoiceId','action','invoicePaid'])
      OR (old_resume->>'invoiceId' IS NOT NULL AND old_resume->'invoiceId' IS DISTINCT FROM new_resume->'invoiceId')
      OR (old_resume->'action' <> 'null'::jsonb AND old_resume->'action' IS DISTINCT FROM new_resume->'action')
      OR (old_resume ? 'invoicePaid' AND old_resume->'invoicePaid' IS DISTINCT FROM new_resume->'invoicePaid')
    THEN RAISE EXCEPTION 'Resume payment progress is immutable once observed'; END IF;
  END IF;
  IF NEW.app_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = NEW.app_id AND a.organization_id = NEW.organization_id) THEN RAISE EXCEPTION 'App billing command owner mismatch'; END IF;
  IF NEW.billing_scope_id IS NOT NULL THEN
    SELECT * INTO sc FROM app_billing_scopes WHERE id = NEW.billing_scope_id;
    IF (NEW.app_id,NEW.livemode,NEW.merchant_id) IS DISTINCT FROM (sc.app_id,sc.livemode,sc.merchant_id) THEN RAISE EXCEPTION 'App billing command scope mismatch'; END IF;
  END IF;
  IF NEW.merchant_id IS NOT NULL THEN
    SELECT * INTO merchant FROM billing_merchants WHERE id = NEW.merchant_id;
    IF (NEW.organization_id,NEW.livemode,NEW.merchant_key) IS DISTINCT FROM (merchant.organization_id,merchant.livemode,merchant.provider_account_key) THEN RAISE EXCEPTION 'App billing command merchant mismatch'; END IF;
  END IF;
  IF NEW.client_registration_id IS NOT NULL THEN
    SELECT * INTO registration FROM app_client_registrations WHERE id = NEW.client_registration_id;
    IF (NEW.app_id,NEW.organization_id,NEW.livemode) IS DISTINCT FROM (registration.app_id,registration.owner_organization_id,registration.billing_environment = 'live') THEN RAISE EXCEPTION 'App billing command registration mismatch'; END IF;
  END IF;
  IF TG_OP = 'INSERT' AND payload IS NULL THEN RAISE EXCEPTION 'New app billing commands require complete durable intent'; END IF;
  IF payload IS NOT NULL THEN
    IF NOT COALESCE(jsonb_typeof(payload) = 'object' AND payload->>'version' = '1',false) THEN RAISE EXCEPTION 'Invalid app billing command payload'; END IF;
    IF NEW.billing_scope_id IS NULL THEN
      IF NOT COALESCE(payload->>'domain' = 'admin' AND payload->>'action' = NEW.kind AND payload->>'clientRegistrationId' = NEW.client_registration_id::text,false) THEN RAISE EXCEPTION 'Invalid app administrator intent'; END IF;
    ELSIF NEW.kind = 'import' THEN
      IF NOT COALESCE(payload->>'domain' = 'operator' AND payload->>'action' = 'import' AND payload->>'manifestDigest' = NEW.request_digest AND payload->'manifest'->>'scopeId' = NEW.billing_scope_id::text AND payload->'manifest'->>'planRevisionId' = NEW.target_plan_revision_id::text AND payload->'manifest'->>'principalUserId' = NEW.requested_by_user_id::text AND (payload->'manifest'->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'Invalid operator import intent'; END IF;
    ELSIF payload->>'domain' = 'account_deletion' AND payload->>'action' = 'delete_customer' THEN
      PERFORM validate_app_billing_customer_deletion_intent(NEW);
      PERFORM validate_app_billing_customer_deletion_transition(NEW,CASE WHEN TG_OP='UPDATE' THEN OLD ELSE NULL END);
    ELSIF payload->>'domain' = 'account_deletion' AND payload->>'action' = 'cancel' THEN
      SELECT * INTO cleanup_request FROM account_deletion_requests WHERE id=(payload->>'requestId')::uuid;
      SELECT * INTO cleanup_phase FROM account_deletion_phase_receipts WHERE id=(payload->>'phaseReceiptId')::uuid AND request_id=cleanup_request.id;
      IF NOT COALESCE(NEW.kind='cancel' AND payload->>'timing'='immediate'
        AND cleanup_request.user_id=NEW.requested_by_user_id AND cleanup_request.request_digest=payload->>'requestDigest'
        AND cleanup_request.lifecycle_revision=(payload->>'lifecycleRevision')::bigint
        AND NEW.idempotency_key='deletion-cancel:'||cleanup_request.id::text||':'||NEW.subscription_id::text
        AND NEW.provider_idempotency_key='app-'||NEW.idempotency_key
        AND EXISTS(SELECT 1 FROM billing_subscriptions s WHERE s.id=NEW.subscription_id AND s.billing_scope_id=NEW.billing_scope_id
          AND s.id::text=payload->>'localSubscriptionId' AND s.stripe_subscription_id=payload->>'subscriptionId'
          AND s.stripe_customer_id=payload->>'customerId' AND s.plan_revision_id::text=payload->>'planRevisionId')
        AND merchant.stripe_account_id=payload->>'providerAccountId'
        AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=NEW.billing_scope_id AND d.request_id=cleanup_request.id
          AND d.disposition='close' AND d.request_digest=cleanup_request.request_digest AND d.lifecycle_revision=cleanup_request.lifecycle_revision
          AND d.phase_receipt_id=cleanup_phase.id AND d.merchant_id=NEW.merchant_id AND d.livemode=NEW.livemode)
        AND sc.fenced_at IS NOT NULL,false)
      THEN RAISE EXCEPTION 'Cancellation requires immutable selected closed-scope subscription intent'; END IF;
      IF TG_OP='INSERT' AND (cleanup_request.status IS DISTINCT FROM 'processing' OR cleanup_request.irreversible_at IS NULL
        OR cleanup_phase.phase IS DISTINCT FROM 'stripe' OR cleanup_phase.lease_generation IS DISTINCT FROM (payload->>'initiatingPhaseGeneration')::bigint
        OR cleanup_phase.status IS NULL OR cleanup_phase.status NOT IN ('leased','calling','reconciling') OR cleanup_phase.lease_expires_at IS NULL
        OR NOT isfinite(cleanup_phase.lease_expires_at) OR (cleanup_phase.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp())
      THEN RAISE EXCEPTION 'Cancellation preparation requires current canonical deletion phase'; END IF;
      IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=cleanup_request.organization_id
        WHERE u.id=cleanup_request.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=cleanup_request.id
        AND u.account_lifecycle_revision=cleanup_request.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible'
        AND o.account_deletion_request_id=cleanup_request.id AND o.account_lifecycle_revision=cleanup_request.lifecycle_revision)
      THEN RAISE EXCEPTION 'Cancellation preparation requires irreversible canonical subject'; END IF;
      IF NEW.status='APPLIED' AND NOT EXISTS(SELECT 1 FROM billing_subscription_revisions r WHERE r.subscription_id=NEW.result_subscription_id
        AND r.revision=NEW.result_subscription_revision AND r.status='canceled' AND r.provider_object_digest=NEW.provider_response_digest)
      THEN RAISE EXCEPTION 'Cancellation completion requires exact canceled revision evidence'; END IF;
    ELSIF payload->>'domain' = 'account_deletion' THEN
      SELECT * INTO cleanup_source FROM billing_subscription_commands WHERE id=(payload->>'sourceCommandId')::uuid;
      SELECT * INTO cleanup_request FROM account_deletion_requests WHERE id=(payload->>'requestId')::uuid;
      IF NOT COALESCE(NEW.kind='expire_checkout' AND payload->>'action'='expire_checkout'
        AND cleanup_source.request_payload->>'domain'='buyer' AND cleanup_source.request_payload->>'action'='checkout'
        AND cleanup_source.provider_result->>'kind'='checkout' AND cleanup_source.provider_started_at IS NOT NULL
        AND (NEW.billing_scope_id,NEW.app_id,NEW.organization_id,NEW.merchant_id,NEW.livemode,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision) IS NOT DISTINCT FROM (cleanup_source.billing_scope_id,cleanup_source.app_id,cleanup_source.organization_id,cleanup_source.merchant_id,cleanup_source.livemode,cleanup_source.requested_by_user_id,cleanup_source.subscription_id,cleanup_source.expected_subscription_revision)
        AND NEW.idempotency_key='deletion-expire:'||cleanup_source.id::text
        AND NEW.provider_idempotency_key='app-deletion-expire:'||cleanup_source.id::text
        AND (payload->>'checkoutSessionId',payload->>'customerId',payload->>'mode',payload->>'planRevisionId') IS NOT DISTINCT FROM (cleanup_source.provider_result->>'checkoutSessionId',cleanup_source.provider_result->>'customerId',cleanup_source.provider_result->>'mode',cleanup_source.target_plan_revision_id::text)
        AND ((payload->>'subscriptionId') IS NOT DISTINCT FROM (cleanup_source.provider_result->>'subscriptionId') OR (TG_OP='UPDATE' AND payload->>'mode'='subscription' AND payload->'subscriptionId'='null'::jsonb))
        AND cleanup_request.user_id=NEW.requested_by_user_id AND cleanup_request.request_digest=payload->>'requestDigest'
        AND cleanup_request.lifecycle_revision=(payload->>'lifecycleRevision')::bigint, false)
      THEN RAISE EXCEPTION 'Cleanup requires immutable original purchaser Checkout intent'; END IF;
      IF TG_OP='INSERT' THEN
        SELECT * INTO cleanup_phase FROM account_deletion_phase_receipts WHERE id=(payload->>'phaseReceiptId')::uuid AND request_id=cleanup_request.id;
        IF cleanup_request.status IS DISTINCT FROM 'processing' OR cleanup_request.irreversible_at IS NULL OR cleanup_phase.id IS NULL OR cleanup_phase.phase IS DISTINCT FROM 'stripe' OR cleanup_phase.lease_generation IS DISTINCT FROM (payload->>'initiatingPhaseGeneration')::bigint OR cleanup_phase.status IS NULL OR cleanup_phase.status NOT IN ('leased','calling','reconciling') OR cleanup_phase.lease_expires_at IS NULL OR NOT isfinite(cleanup_phase.lease_expires_at) OR (cleanup_phase.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp()
        THEN RAISE EXCEPTION 'Cleanup preparation requires current canonical deletion phase'; END IF;
        IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=cleanup_request.organization_id WHERE u.id=cleanup_request.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=cleanup_request.id AND u.account_lifecycle_revision=cleanup_request.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=cleanup_request.id AND o.account_lifecycle_revision=cleanup_request.lifecycle_revision)
        THEN RAISE EXCEPTION 'Cleanup preparation requires irreversible purchaser'; END IF;
      END IF;
    ELSE
      IF NOT COALESCE(payload->>'domain' = 'buyer' AND ((payload->>'action' = 'trial' AND NEW.kind = 'checkout') OR (payload->>'action' = 'checkout' AND NEW.kind IN ('checkout','upgrade')) OR (payload->>'action' = 'update' AND NEW.kind IN ('upgrade','downgrade')) OR (payload->>'action' = NEW.kind AND NEW.kind IN ('cancel','portal','expire_checkout'))),false) THEN RAISE EXCEPTION 'Invalid app purchaser intent'; END IF;
      IF payload->>'action' IN ('trial','checkout','update') AND NOT COALESCE(payload->>'planRevisionId' = NEW.target_plan_revision_id::text AND (payload->>'quantity')::integer = NEW.target_quantity,false) THEN RAISE EXCEPTION 'App billing command target payload mismatch'; END IF;
      IF payload->>'action' IN ('checkout','update') AND (payload->>'billingConsent') IS DISTINCT FROM 'accepted' THEN RAISE EXCEPTION 'App billing payment consent is required'; END IF;
    END IF;
  END IF;
  IF NEW.provider_result IS NOT NULL AND ((NEW.status NOT IN ('OUTCOME_UNKNOWN','SUCCEEDED','APPLIED') AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_CHECKOUT_EXPIRED' AND NEW.request_payload->>'action' = 'checkout' AND NEW.provider_result->>'kind' = 'checkout' AND NEW.provider_result->>'checkoutSessionId' IS NOT NULL) AND NOT (NEW.status = 'FAILED' AND NEW.error_code = 'APP_BILLING_PAYMENT_EXPIRED' AND NEW.request_payload->>'domain' = 'buyer' AND NEW.request_payload->>'action' = 'update' AND NEW.provider_result->>'kind' = 'payment' AND NEW.provider_result->>'invoiceId' IS NOT NULL)) OR jsonb_typeof(NEW.provider_result) <> 'object') THEN RAISE EXCEPTION 'Provider result requires started durable command'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('71539f9f42b15c324653e42f24bb3597a271df314f1589b6009c982e8ff39a67', 1796083200080);
-- apply 0454_app_billing_refund_observations
CREATE TABLE IF NOT EXISTS app_billing_refund_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_sequence bigserial NOT NULL CONSTRAINT app_billing_refund_observations_sequence_unique UNIQUE,
  command_id uuid NOT NULL CONSTRAINT app_billing_refund_observations_command_fk REFERENCES billing_subscription_commands(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  request_digest text NOT NULL,
  lifecycle_revision bigint NOT NULL,
  phase_receipt_id uuid NOT NULL,
  phase_generation bigint NOT NULL,
  command_revision bigint NOT NULL,
  execution_generation bigint NOT NULL,
  observation jsonb NOT NULL,
  discovery jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
;
CREATE INDEX IF NOT EXISTS app_billing_refund_observations_command_idx ON app_billing_refund_observations(command_id,observation_sequence);
;
CREATE OR REPLACE FUNCTION app_billing_refund_canonical_json(value jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN SELECT '{'||COALESCE(string_agg(to_jsonb(key)::text||':'||app_billing_refund_canonical_json(v),',' ORDER BY key COLLATE "C"),'')||'}' INTO result FROM jsonb_each(value) AS x(key,v);
    WHEN 'array' THEN SELECT '['||COALESCE(string_agg(app_billing_refund_canonical_json(v),',' ORDER BY n),'')||']' INTO result FROM jsonb_array_elements(value) WITH ORDINALITY AS x(v,n);
    ELSE result := value::text;
  END CASE;
  RETURN result;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('ddbbf94b485a132721ec02186b50ad99a358363e6945c25d0542a95bf582c61d', 1796083200081);
-- apply 0455_app_billing_refund_recovery_authority
CREATE OR REPLACE FUNCTION require_app_billing_refund_recovery(p_command uuid,p_request uuid,p_digest text,p_revision bigint,p_phase uuid,p_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c billing_subscription_commands%ROWTYPE; r record; p record; s record; source jsonb; owner uuid; subject uuid;
BEGIN
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command;
  SELECT organization_id,user_id INTO owner,subject FROM account_deletion_requests WHERE id=p_request;
  source := c.request_payload->'source';
  IF NOT COALESCE(c.kind='refund' AND c.billing_scope_id IS NULL AND c.request_payload->>'domain'='admin' AND c.request_payload->>'action'='refund'
    AND c.app_id IS NOT NULL AND c.client_registration_id IS NOT NULL AND c.merchant_id IS NOT NULL
    AND owner IS NOT NULL AND subject IS NOT NULL,false) THEN RAISE EXCEPTION 'Refund recovery requires an original authorized admin command'; END IF;
  PERFORM 1 FROM organizations WHERE id IN(owner,c.organization_id) ORDER BY id FOR UPDATE;
  PERFORM x.id FROM app_billing_scopes x JOIN app_subscription_paid_periods t ON t.billing_scope_id=x.id WHERE t.id=(source->>'paidPeriodId')::uuid FOR UPDATE OF x;
  PERFORM a.id FROM app_billing_accounts a JOIN app_billing_scopes x ON x.billing_account_id=a.id JOIN app_subscription_paid_periods t ON t.billing_scope_id=x.id WHERE t.id=(source->>'paidPeriodId')::uuid FOR UPDATE OF a;
  PERFORM binding.id FROM app_billing_customers binding JOIN app_billing_scopes x ON x.billing_account_id=binding.billing_account_id AND x.merchant_id=binding.merchant_id JOIN app_subscription_paid_periods t ON t.billing_scope_id=x.id WHERE t.id=(source->>'paidPeriodId')::uuid FOR UPDATE OF binding;
  PERFORM 1 FROM users WHERE id=subject FOR UPDATE;
  SELECT * INTO r FROM account_deletion_requests WHERE id=p_request FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=p_phase AND request_id=p_request FOR SHARE;
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command FOR UPDATE;
  IF NOT COALESCE(r.status='processing' AND r.irreversible_at IS NOT NULL AND r.request_digest=p_digest AND r.lifecycle_revision=p_revision
    AND r.organization_id=owner AND r.user_id=subject AND p.phase='stripe' AND p.lease_generation=p_generation
    AND p.status IN('leased','calling','reconciling') AND isfinite(p.lease_expires_at) AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp(),false)
    OR NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=owner WHERE u.id=subject AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=p_request AND u.account_lifecycle_revision=p_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=p_request AND o.account_lifecycle_revision=p_revision)
    THEN RAISE EXCEPTION 'Refund recovery requires current canonical irreversible authority'; END IF;
  SELECT t.*,x.app_id,x.organization_id,x.billing_account_id,x.merchant_id,x.product_family_key,m.provider_account_key,m.stripe_account_id,
    b.stripe_subscription_id,b.stripe_customer_id,b.billing_scope_id AS subscription_scope,b.provider_environment,b.organization_id AS subscription_organization,b.merchant_key AS subscription_merchant,
    plan.id AS historical_plan,plan.app_id AS plan_app,plan.merchant_id AS plan_merchant,plan.product_family_key AS plan_family,plan.stripe_price_id AS plan_price,to_jsonb(plan) AS plan_record
    INTO s FROM app_subscription_paid_periods t JOIN app_billing_scopes x ON x.id=t.billing_scope_id JOIN billing_merchants m ON m.id=x.merchant_id AND m.organization_id=x.organization_id AND m.livemode=x.livemode
    JOIN billing_subscriptions b ON b.id=t.subscription_id JOIN app_billing_plan_revisions plan ON plan.id=t.plan_revision_id
    WHERE t.id=(source->>'paidPeriodId')::uuid FOR SHARE OF t,m,b,plan;
  IF NOT COALESCE(s.app_id=c.app_id AND s.organization_id=c.organization_id AND s.merchant_id=c.merchant_id AND s.livemode=c.livemode
    AND s.subscription_scope=s.billing_scope_id AND s.subscription_organization=c.organization_id AND s.subscription_merchant=s.provider_account_key AND s.merchant_key=s.provider_account_key AND c.merchant_key=s.provider_account_key
    AND s.provider_environment=CASE WHEN c.livemode THEN 'live' ELSE 'test' END
    AND s.plan_app=c.app_id AND s.plan_merchant=c.merchant_id AND s.plan_family=s.product_family_key AND s.plan_price=s.stripe_price_id
    AND source->'scope'=jsonb_build_object('scopeId',s.billing_scope_id,'appId',s.app_id,'billingAccountId',s.billing_account_id)
    AND source->'merchant'=jsonb_build_object('merchantId',s.merchant_id,'kind',CASE WHEN s.provider_account_key='platform' THEN 'platform' ELSE 'connected' END,'stripeAccountId',s.stripe_account_id,'livemode',s.livemode)
    AND source->'invoice'->>'invoiceId'=s.stripe_invoice_id AND source->'invoice'->>'customerId'=s.stripe_customer_id AND source->'invoice'->>'subscriptionId'=s.stripe_subscription_id
    AND source->'invoice'->'plan'=jsonb_build_object('planRevisionId',s.historical_plan,'priceId',s.plan_price,'productId',s.plan_record->>'stripe_product_id','amountCents',s.plan_record->'amount_cents','currency',s.plan_record->>'currency','interval',s.plan_record->>'interval','intervalCount',s.plan_record->'interval_count','minimumQuantity',s.plan_record->'minimum_quantity','maximumQuantity',s.plan_record->'maximum_quantity','trialDays',s.plan_record->'trial_days')
    AND c.request_payload->>'clientRegistrationId'=c.client_registration_id::text AND c.request_payload->>'accessPolicy'='preserve'
    AND (c.request_payload->>'amountCents')::bigint>0,false) THEN RAISE EXCEPTION 'Refund recovery original payment binding mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_customers customer WHERE customer.billing_account_id=s.billing_account_id AND customer.merchant_id=s.merchant_id AND customer.stripe_customer_id=s.stripe_customer_id) THEN RAISE EXCEPTION 'Refund recovery requires its original bound customer'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d JOIN app_billing_scopes x ON x.id=d.scope_id WHERE d.scope_id=s.billing_scope_id AND x.fenced_at IS NOT NULL AND d.request_id=p_request AND d.request_digest=p_digest AND d.lifecycle_revision=p_revision AND d.phase_receipt_id=p_phase AND d.phase_generation<=p_generation AND d.disposition='close' AND d.merchant_id=s.merchant_id AND d.provider_account_key=s.provider_account_key AND d.livemode=s.livemode) THEN RAISE EXCEPTION 'Refund recovery requires the exact canonical closed payment scope'; END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('43b9cf20da524b01a0472234a06f3f1250d020bb2a87416281263a13d1a9ea15', 1796083200082);
-- apply 0456_app_billing_refund_observation_guards
CREATE OR REPLACE FUNCTION guard_app_billing_refund_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c billing_subscription_commands%ROWTYPE; o jsonb; v jsonb; expected jsonb; result jsonb;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Refund observations are immutable'; END IF;
  PERFORM require_app_billing_refund_recovery(NEW.command_id,NEW.request_id,NEW.request_digest,NEW.lifecycle_revision,NEW.phase_receipt_id,NEW.phase_generation);
  SELECT * INTO c FROM billing_subscription_commands WHERE id=NEW.command_id;
  o:=NEW.observation; v:=o->'value';
  expected:=jsonb_build_object('operation','retrieveRefund','scope',c.request_payload->'source'->'scope','input',(c.request_payload->'source'->'invoice')||jsonb_build_object('refundId',v->>'refundId'));
  result:=jsonb_build_object('kind','refund','refundId',v->>'refundId','chargeId',v->>'chargeId','amountCents',v->'amountCents','currency',v->>'currency');
  IF NOT COALESCE(c.status IN('OUTCOME_UNKNOWN','SUCCEEDED') AND c.provider_started_at IS NOT NULL
    AND c.state_revision=NEW.command_revision AND c.execution_generation=NEW.execution_generation
    AND (c.lease_expires_at IS NULL OR (isfinite(c.lease_expires_at) AND c.lease_expires_at<=clock_timestamp()))
    AND o->>'merchantId'=c.merchant_id::text AND o->>'providerAccountId'=c.request_payload->'source'->'merchant'->>'stripeAccountId'
    AND o->'livemode'=to_jsonb(c.livemode) AND o->>'apiVersion'='2024-11-20.acacia'
    AND o->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(v),'UTF8')),'hex')
    AND o->>'inputDigest'=encode(sha256(convert_to(app_billing_refund_canonical_json(expected),'UTF8')),'hex')
    AND isfinite((o->>'observedAt')::timestamptz) AND (o->>'observedAt')::timestamptz>=c.provider_started_at AND (o->>'observedAt')::timestamptz<=clock_timestamp()
    AND v->>'refundId' ~ '^re_[A-Za-z0-9]+$' AND v->>'chargeId' ~ '^ch_[A-Za-z0-9]+$'
    AND jsonb_typeof(v->'amountCents')='number' AND (v->>'amountCents')::bigint=(c.request_payload->>'amountCents')::bigint
    AND v->>'currency'=c.request_payload->'source'->'invoice'->'plan'->>'currency'
    AND v ? 'status' AND (v->'status'='null'::jsonb OR v->>'status' IN('pending','requires_action','succeeded','failed','canceled'))
    AND (c.status<>'SUCCEEDED' OR (c.provider_result=result AND NEW.discovery IS NULL))
    AND (c.status<>'OUTCOME_UNKNOWN' OR (NEW.discovery->'value'=jsonb_build_object('status','found','object',v)
      AND NEW.discovery->>'inputDigest'=c.request_digest AND NEW.discovery->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(NEW.discovery->'value'),'UTF8')),'hex')
      AND NEW.discovery->>'merchantId'=o->>'merchantId' AND NEW.discovery->>'providerAccountId'=o->>'providerAccountId' AND NEW.discovery->'livemode'=o->'livemode'
      AND NEW.discovery->>'apiVersion'=o->>'apiVersion' AND isfinite((NEW.discovery->>'observedAt')::timestamptz)
      AND (NEW.discovery->>'observedAt')::timestamptz>=c.provider_started_at AND (NEW.discovery->>'observedAt')::timestamptz<=(o->>'observedAt')::timestamptz)),false)
    THEN RAISE EXCEPTION 'Refund observation does not match original command and provider evidence'; END IF;
  NEW.created_at:=clock_timestamp();
  NEW.observation_sequence:=nextval(pg_get_serial_sequence('app_billing_refund_observations','observation_sequence'));
  IF c.status='OUTCOME_UNKNOWN' THEN
    UPDATE billing_subscription_commands SET status='SUCCEEDED',provider_result=result,provider_response_digest=o->>'digest',completed_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL,state_revision=state_revision+1,updated_at=clock_timestamp() WHERE id=c.id;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_refund_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON app_billing_refund_observations FOR EACH ROW EXECUTE FUNCTION guard_app_billing_refund_observation();
;
CREATE TRIGGER app_billing_refund_observation_truncate_guard BEFORE TRUNCATE ON app_billing_refund_observations FOR EACH STATEMENT EXECUTE FUNCTION guard_app_billing_refund_observation();
;
CREATE OR REPLACE FUNCTION supersede_app_billing_refund_for_deletion(p_command uuid,p_request uuid,p_digest text,p_revision bigint,p_phase uuid,p_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c billing_subscription_commands%ROWTYPE;
BEGIN
  PERFORM require_app_billing_refund_recovery(p_command,p_request,p_digest,p_revision,p_phase,p_generation);
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command;
  IF NOT COALESCE(c.status='PREPARED' AND c.execution_generation=0 AND c.provider_started_at IS NULL AND c.provider_result IS NULL AND c.provider_response_digest IS NULL AND c.lease_token IS NULL AND c.lease_expires_at IS NULL,false)
    THEN RAISE EXCEPTION 'Only never-dispatched refunds may be superseded'; END IF;
  UPDATE billing_subscription_commands SET status='SUPERSEDED',error_code='APP_BILLING_ACCOUNT_DELETION_SUPERSEDED',completed_at=clock_timestamp(),state_revision=state_revision+1,updated_at=clock_timestamp() WHERE id=c.id;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('ac700b9e376b36191a9df9121f7edf76a5d5ec4621d108d391a19cfb96b24ae3', 1796083200083);
-- apply 0457_app_billing_customer_retention
-- Retention permits no provider write and is not deletion phase completion evidence.
CREATE OR REPLACE FUNCTION require_app_billing_customer_retention(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b record; current_binding record; r record; p record; owner_id uuid; subject_id uuid; user_ids uuid[];
BEGIN
  SELECT c.*,a.app_id,x.organization_id,m.stripe_account_id,m.provider_account_key,m.livemode INTO b
    FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id
    JOIN apps x ON x.id=a.app_id JOIN billing_merchants m ON m.id=c.merchant_id AND m.organization_id=x.organization_id WHERE c.id=p_binding_id;
  SELECT d.organization_id,d.user_id INTO owner_id,subject_id FROM account_deletion_requests d WHERE d.id=p_request_id;
  IF b.id IS NULL OR owner_id IS NULL OR subject_id IS NULL THEN RAISE EXCEPTION 'Customer retention source is unavailable'; END IF;
  PERFORM o.id FROM organizations o WHERE o.id IN (owner_id,b.organization_id) ORDER BY o.id FOR UPDATE;
  PERFORM x.id FROM apps x WHERE x.id=b.app_id FOR UPDATE;
  PERFORM s.id FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id ORDER BY s.id FOR UPDATE;
  PERFORM a.id FROM app_billing_accounts a WHERE a.id=b.billing_account_id FOR UPDATE;
  PERFORM c.id FROM app_billing_customers c WHERE c.id=p_binding_id FOR UPDATE;
  SELECT array_agg(q.id ORDER BY q.id) INTO user_ids FROM (
    SELECT subject_id AS id UNION SELECT m.user_id FROM app_billing_members m WHERE m.billing_account_id=b.billing_account_id
  ) q;
  PERFORM u.id FROM users u WHERE u.id=ANY(user_ids) ORDER BY u.id FOR UPDATE;
  PERFORM m.id FROM app_billing_members m WHERE m.billing_account_id=b.billing_account_id ORDER BY m.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=b.billing_account_id AND NOT(m.user_id=ANY(user_ids))) THEN RAISE EXCEPTION 'Customer retention membership changed; retry'; END IF;
  SELECT * INTO r FROM account_deletion_requests d WHERE d.id=p_request_id FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts d WHERE d.id=p_phase_id AND d.request_id=p_request_id FOR SHARE;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM owner_id OR r.user_id IS DISTINCT FROM subject_id OR p.id IS NULL OR r.status IS DISTINCT FROM 'processing' OR r.irreversible_at IS NULL OR r.request_digest IS DISTINCT FROM p_request_digest OR r.lifecycle_revision IS DISTINCT FROM p_lifecycle_revision OR p.phase IS DISTINCT FROM 'stripe' OR p.lease_generation IS DISTINCT FROM p_phase_generation OR p.status IS NULL OR p.status NOT IN ('leased','calling','reconciling') OR p.lease_expires_at IS NULL OR NOT isfinite(p.lease_expires_at) OR (p.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Customer retention requires current canonical deletion phase'; END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision) THEN RAISE EXCEPTION 'Customer retention requires irreversible canonical subject'; END IF;
  SELECT c.*,a.app_id,x.organization_id,m.stripe_account_id,m.provider_account_key,m.livemode INTO current_binding
    FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id
    JOIN apps x ON x.id=a.app_id JOIN billing_merchants m ON m.id=c.merchant_id AND m.organization_id=x.organization_id WHERE c.id=p_binding_id;
  IF current_binding.id IS NULL OR to_jsonb(current_binding) IS DISTINCT FROM to_jsonb(b) OR b.stripe_account_id IS NULL THEN RAISE EXCEPTION 'Customer retention binding changed; retry'; END IF;
  IF r.organization_id=b.organization_id OR EXISTS(SELECT 1 FROM app_billing_customer_closures c WHERE c.customer_binding_id=p_binding_id) THEN RAISE EXCEPTION 'Closing developer or customer cannot be retained'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_scopes s JOIN app_billing_deletion_dispositions d ON d.scope_id=s.id WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id AND d.request_id=r.id AND d.disposition='retain_shared') THEN RAISE EXCEPTION 'Customer retention requires a retained sharing scope'; END IF;
  IF EXISTS(SELECT 1 FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id AND (
    s.app_id IS DISTINCT FROM b.app_id OR s.organization_id IS DISTINCT FROM b.organization_id OR s.livemode IS DISTINCT FROM b.livemode OR
    NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=s.id AND d.request_id=r.id AND d.request_digest=r.request_digest AND d.lifecycle_revision=r.lifecycle_revision AND d.phase_receipt_id=p.id AND d.phase_generation<=p.lease_generation AND d.merchant_id=b.merchant_id AND d.provider_account_key=b.provider_account_key AND d.livemode=b.livemode AND (
      (d.disposition='close' AND s.fenced_at IS NOT NULL) OR
      (d.disposition='retain_shared' AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions prior WHERE prior.scope_id=s.id AND prior.disposition='close'))
    ))
  )) THEN RAISE EXCEPTION 'Every sharing scope requires its current canonical retention or close decision'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=b.billing_account_id AND m.app_id=b.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=b.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (isfinite(u.expires_at) AND (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN RAISE EXCEPTION 'Customer retention requires a current surviving administrator'; END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('c77d2bd97a1c87a975a9d7bc1c8478fcd2cd6ca5d71c3888cb430b38856e74ec', 1796083200084);
-- apply 0458_app_billing_refund_actor_recovery
-- Original refund actors may settle historical intent without closing another account.
CREATE OR REPLACE FUNCTION require_app_billing_refund_recovery(p_command uuid,p_request uuid,p_digest text,p_revision bigint,p_phase uuid,p_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c billing_subscription_commands%ROWTYPE; r record; p record; s record; source jsonb; owner uuid; subject uuid;
BEGIN
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command;
  SELECT organization_id,user_id INTO owner,subject FROM account_deletion_requests WHERE id=p_request;
  source := c.request_payload->'source';
  IF NOT COALESCE(c.kind='refund' AND c.billing_scope_id IS NULL AND c.request_payload->>'domain'='admin' AND c.request_payload->>'action'='refund'
    AND c.app_id IS NOT NULL AND c.client_registration_id IS NOT NULL AND c.merchant_id IS NOT NULL
    AND owner IS NOT NULL AND subject IS NOT NULL,false) THEN RAISE EXCEPTION 'Refund recovery requires an original authorized admin command'; END IF;
  PERFORM 1 FROM organizations WHERE id IN(owner,c.organization_id) ORDER BY id FOR UPDATE;
  PERFORM x.id FROM app_billing_scopes x JOIN app_subscription_paid_periods t ON t.billing_scope_id=x.id WHERE t.id=(source->>'paidPeriodId')::uuid FOR UPDATE OF x;
  PERFORM a.id FROM app_billing_accounts a JOIN app_billing_scopes x ON x.billing_account_id=a.id JOIN app_subscription_paid_periods t ON t.billing_scope_id=x.id WHERE t.id=(source->>'paidPeriodId')::uuid FOR UPDATE OF a;
  PERFORM binding.id FROM app_billing_customers binding JOIN app_billing_scopes x ON x.billing_account_id=binding.billing_account_id AND x.merchant_id=binding.merchant_id JOIN app_subscription_paid_periods t ON t.billing_scope_id=x.id WHERE t.id=(source->>'paidPeriodId')::uuid FOR UPDATE OF binding;
  PERFORM 1 FROM users WHERE id=subject FOR UPDATE;
  SELECT * INTO r FROM account_deletion_requests WHERE id=p_request FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=p_phase AND request_id=p_request FOR SHARE;
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command FOR UPDATE;
  IF NOT COALESCE(r.status='processing' AND r.irreversible_at IS NOT NULL AND r.request_digest=p_digest AND r.lifecycle_revision=p_revision
    AND r.organization_id=owner AND r.user_id=subject AND p.phase='stripe' AND p.lease_generation=p_generation
    AND p.status IN('leased','calling','reconciling') AND isfinite(p.lease_expires_at) AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp(),false)
    OR NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=owner WHERE u.id=subject AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=p_request AND u.account_lifecycle_revision=p_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=p_request AND o.account_lifecycle_revision=p_revision)
    THEN RAISE EXCEPTION 'Refund recovery requires current canonical irreversible authority'; END IF;
  SELECT t.*,x.app_id,x.organization_id,x.billing_account_id,x.merchant_id,x.product_family_key,m.provider_account_key,m.stripe_account_id,
    b.stripe_subscription_id,b.stripe_customer_id,b.billing_scope_id AS subscription_scope,b.provider_environment,b.organization_id AS subscription_organization,b.merchant_key AS subscription_merchant,
    plan.id AS historical_plan,plan.app_id AS plan_app,plan.merchant_id AS plan_merchant,plan.product_family_key AS plan_family,plan.stripe_price_id AS plan_price,to_jsonb(plan) AS plan_record
    INTO s FROM app_subscription_paid_periods t JOIN app_billing_scopes x ON x.id=t.billing_scope_id JOIN billing_merchants m ON m.id=x.merchant_id AND m.organization_id=x.organization_id AND m.livemode=x.livemode
    JOIN billing_subscriptions b ON b.id=t.subscription_id JOIN app_billing_plan_revisions plan ON plan.id=t.plan_revision_id
    WHERE t.id=(source->>'paidPeriodId')::uuid FOR SHARE OF t,m,b,plan;
  IF NOT COALESCE(s.app_id=c.app_id AND s.organization_id=c.organization_id AND s.merchant_id=c.merchant_id AND s.livemode=c.livemode
    AND s.subscription_scope=s.billing_scope_id AND s.subscription_organization=c.organization_id AND s.subscription_merchant=s.provider_account_key AND s.merchant_key=s.provider_account_key AND c.merchant_key=s.provider_account_key
    AND s.provider_environment=CASE WHEN c.livemode THEN 'live' ELSE 'test' END
    AND s.plan_app=c.app_id AND s.plan_merchant=c.merchant_id AND s.plan_family=s.product_family_key AND s.plan_price=s.stripe_price_id
    AND source->'scope'=jsonb_build_object('scopeId',s.billing_scope_id,'appId',s.app_id,'billingAccountId',s.billing_account_id)
    AND source->'merchant'=jsonb_build_object('merchantId',s.merchant_id,'kind',CASE WHEN s.provider_account_key='platform' THEN 'platform' ELSE 'connected' END,'stripeAccountId',s.stripe_account_id,'livemode',s.livemode)
    AND source->'invoice'->>'invoiceId'=s.stripe_invoice_id AND source->'invoice'->>'customerId'=s.stripe_customer_id AND source->'invoice'->>'subscriptionId'=s.stripe_subscription_id
    AND source->'invoice'->'plan'=jsonb_build_object('planRevisionId',s.historical_plan,'priceId',s.plan_price,'productId',s.plan_record->>'stripe_product_id','amountCents',s.plan_record->'amount_cents','currency',s.plan_record->>'currency','interval',s.plan_record->>'interval','intervalCount',s.plan_record->'interval_count','minimumQuantity',s.plan_record->'minimum_quantity','maximumQuantity',s.plan_record->'maximum_quantity','trialDays',s.plan_record->'trial_days')
    AND c.request_payload->>'clientRegistrationId'=c.client_registration_id::text AND c.request_payload->>'accessPolicy'='preserve'
    AND (c.request_payload->>'amountCents')::bigint>0,false) THEN RAISE EXCEPTION 'Refund recovery original payment binding mismatch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_customers customer WHERE customer.billing_account_id=s.billing_account_id AND customer.merchant_id=s.merchant_id AND customer.stripe_customer_id=s.stripe_customer_id) THEN RAISE EXCEPTION 'Refund recovery requires its original bound customer'; END IF;
  IF c.requested_by_user_id IS DISTINCT FROM subject AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d JOIN app_billing_scopes x ON x.id=d.scope_id WHERE d.scope_id=s.billing_scope_id AND x.fenced_at IS NOT NULL AND d.request_id=p_request AND d.request_digest=p_digest AND d.lifecycle_revision=p_revision AND d.phase_receipt_id=p_phase AND d.phase_generation<=p_generation AND d.disposition='close' AND d.merchant_id=s.merchant_id AND d.provider_account_key=s.provider_account_key AND d.livemode=s.livemode) THEN RAISE EXCEPTION 'Refund recovery requires the original actor or exact canonical closed payment scope'; END IF;
END $$;
;
CREATE OR REPLACE FUNCTION supersede_app_billing_refund_for_deletion(p_command uuid,p_request uuid,p_digest text,p_revision bigint,p_phase uuid,p_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE c billing_subscription_commands%ROWTYPE;
BEGIN
  PERFORM require_app_billing_refund_recovery(p_command,p_request,p_digest,p_revision,p_phase,p_generation);
  SELECT * INTO c FROM billing_subscription_commands WHERE id=p_command;
  IF NOT EXISTS(SELECT 1 FROM account_deletion_requests r WHERE r.id=p_request AND r.user_id=c.requested_by_user_id) THEN RAISE EXCEPTION 'Only the original refund actor may supersede unstarted intent'; END IF;
  IF NOT COALESCE(c.status='PREPARED' AND c.execution_generation=0 AND c.provider_started_at IS NULL AND c.provider_result IS NULL AND c.provider_response_digest IS NULL AND c.lease_token IS NULL AND c.lease_expires_at IS NULL,false)
    THEN RAISE EXCEPTION 'Only never-dispatched refunds may be superseded'; END IF;
  UPDATE billing_subscription_commands SET status='SUPERSEDED',error_code='APP_BILLING_ACCOUNT_DELETION_SUPERSEDED',completed_at=clock_timestamp(),state_revision=state_revision+1,updated_at=clock_timestamp() WHERE id=c.id;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('14a21f9be8d3ded3b1f6e2eeff9a15340fb0e20d4842a9a7d4f94d97726135c4', 1796083200085);
-- apply 0459_app_billing_observed_customer_retention
-- Sharing-only scopes are observed without granting billing disposition authority.
CREATE OR REPLACE FUNCTION require_app_billing_customer_retention(p_binding_id uuid, p_request_id uuid, p_request_digest text, p_lifecycle_revision bigint, p_phase_id uuid, p_phase_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b record; current_binding record; r record; p record; owner_id uuid; subject_id uuid; user_ids uuid[];
BEGIN
  SELECT c.*,a.app_id,x.organization_id,m.stripe_account_id,m.provider_account_key,m.livemode INTO b
    FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id
    JOIN apps x ON x.id=a.app_id JOIN billing_merchants m ON m.id=c.merchant_id AND m.organization_id=x.organization_id WHERE c.id=p_binding_id;
  SELECT d.organization_id,d.user_id INTO owner_id,subject_id FROM account_deletion_requests d WHERE d.id=p_request_id;
  IF b.id IS NULL OR owner_id IS NULL OR subject_id IS NULL THEN RAISE EXCEPTION 'Customer retention source is unavailable'; END IF;
  PERFORM o.id FROM organizations o WHERE o.id IN (owner_id,b.organization_id) ORDER BY o.id FOR UPDATE;
  PERFORM x.id FROM apps x WHERE x.id=b.app_id FOR UPDATE;
  PERFORM s.id FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id ORDER BY s.id FOR UPDATE;
  PERFORM a.id FROM app_billing_accounts a WHERE a.id=b.billing_account_id FOR UPDATE;
  PERFORM c.id FROM app_billing_customers c WHERE c.id=p_binding_id FOR UPDATE;
  SELECT array_agg(q.id ORDER BY q.id) INTO user_ids FROM (
    SELECT subject_id AS id UNION SELECT m.user_id FROM app_billing_members m WHERE m.billing_account_id=b.billing_account_id
  ) q;
  PERFORM u.id FROM users u WHERE u.id=ANY(user_ids) ORDER BY u.id FOR UPDATE;
  PERFORM m.id FROM app_billing_members m WHERE m.billing_account_id=b.billing_account_id ORDER BY m.id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=b.billing_account_id AND NOT(m.user_id=ANY(user_ids))) THEN RAISE EXCEPTION 'Customer retention membership changed; retry'; END IF;
  SELECT * INTO r FROM account_deletion_requests d WHERE d.id=p_request_id FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts d WHERE d.id=p_phase_id AND d.request_id=p_request_id FOR SHARE;
  IF r.id IS NULL OR r.organization_id IS DISTINCT FROM owner_id OR r.user_id IS DISTINCT FROM subject_id OR p.id IS NULL OR r.status IS DISTINCT FROM 'processing' OR r.irreversible_at IS NULL OR r.request_digest IS DISTINCT FROM p_request_digest OR r.lifecycle_revision IS DISTINCT FROM p_lifecycle_revision OR p.phase IS DISTINCT FROM 'stripe' OR p.lease_generation IS DISTINCT FROM p_phase_generation OR p.status IS NULL OR p.status NOT IN ('leased','calling','reconciling') OR p.lease_expires_at IS NULL OR NOT isfinite(p.lease_expires_at) OR (p.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Customer retention requires current canonical deletion phase'; END IF;
  IF NOT EXISTS(SELECT 1 FROM users u JOIN organizations o ON o.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND o.account_lifecycle_state='deletion_irreversible' AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision) THEN RAISE EXCEPTION 'Customer retention requires irreversible canonical subject'; END IF;
  SELECT c.*,a.app_id,x.organization_id,m.stripe_account_id,m.provider_account_key,m.livemode INTO current_binding
    FROM app_billing_customers c JOIN app_billing_accounts a ON a.id=c.billing_account_id
    JOIN apps x ON x.id=a.app_id JOIN billing_merchants m ON m.id=c.merchant_id AND m.organization_id=x.organization_id WHERE c.id=p_binding_id;
  IF current_binding.id IS NULL OR to_jsonb(current_binding) IS DISTINCT FROM to_jsonb(b) OR b.stripe_account_id IS NULL THEN RAISE EXCEPTION 'Customer retention binding changed; retry'; END IF;
  IF r.organization_id=b.organization_id OR EXISTS(SELECT 1 FROM app_billing_customer_closures c WHERE c.customer_binding_id=p_binding_id) THEN RAISE EXCEPTION 'Closing developer or customer cannot be retained'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_scopes s JOIN app_billing_deletion_dispositions d ON d.scope_id=s.id WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id AND d.request_id=r.id AND d.disposition='retain_shared') THEN RAISE EXCEPTION 'Customer retention requires a retained sharing scope'; END IF;
  IF EXISTS(SELECT 1 FROM app_billing_scopes s WHERE s.billing_account_id=b.billing_account_id AND s.merchant_id=b.merchant_id AND (
    s.app_id IS DISTINCT FROM b.app_id OR s.organization_id IS DISTINCT FROM b.organization_id OR s.livemode IS DISTINCT FROM b.livemode OR
    ((EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=s.billing_account_id AND m.app_id=s.app_id AND m.user_id=r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=s.livemode))
      OR EXISTS(SELECT 1 FROM billing_subscription_commands c WHERE c.billing_scope_id=s.id AND c.requested_by_user_id=r.user_id AND c.request_payload->>'domain'='buyer')
      OR EXISTS(SELECT 1 FROM app_billing_deletion_dispositions own WHERE own.scope_id=s.id AND own.request_id=r.id))
    AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=s.id AND d.request_id=r.id AND d.request_digest=r.request_digest AND d.lifecycle_revision=r.lifecycle_revision AND d.phase_receipt_id=p.id AND d.phase_generation<=p.lease_generation AND d.merchant_id=b.merchant_id AND d.provider_account_key=b.provider_account_key AND d.livemode=b.livemode AND (
      (d.disposition='close' AND s.fenced_at IS NOT NULL) OR
      (d.disposition='retain_shared' AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions prior WHERE prior.scope_id=s.id AND prior.disposition='close'))
    )))
  )) THEN RAISE EXCEPTION 'Every administered or historical scope requires its current canonical retention or close decision'; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=b.billing_account_id AND m.app_id=b.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=b.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (isfinite(u.expires_at) AND (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN RAISE EXCEPTION 'Customer retention requires a current surviving administrator'; END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('3be1a3a5c460ba6b536a0b6cfac16317416100080309fa171ee30a4827dfa0ce', 1796083200086);
-- apply 0460_app_billing_refund_phase_obligations
-- Refund recovery evidence is required in addition to the existing scope completion guard.
CREATE OR REPLACE FUNCTION app_billing_deletion_refund_inventory(p_request uuid) RETURNS TABLE(command_id uuid) LANGUAGE sql STABLE AS $$
  SELECT c.id FROM billing_subscription_commands c CROSS JOIN account_deletion_requests r
  WHERE r.id=p_request AND (c.app_id IS NOT NULL OR c.request_payload->>'domain'='admin')
    AND (c.kind='refund' OR c.request_payload->>'action'='refund') AND (
      c.organization_id=r.organization_id OR c.requested_by_user_id=r.user_id OR
      EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.request_id=r.id AND d.disposition='close' AND (
        d.scope_id=c.billing_scope_id OR d.scope_id::text=c.request_payload->'source'->'scope'->>'scopeId' OR
        EXISTS(SELECT 1 FROM app_subscription_paid_periods paid WHERE paid.billing_scope_id=d.scope_id AND paid.id::text=c.request_payload->'source'->>'paidPeriodId')
      ))
    ) ORDER BY c.id;
$$;
;
CREATE OR REPLACE FUNCTION app_billing_refund_is_terminal(p_command uuid,p_request uuid,p_digest text,p_revision bigint,p_phase uuid,p_generation bigint) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(c.kind='refund' AND c.request_payload->>'domain'='admin' AND c.request_payload->>'action'='refund' AND (
    (c.status='SUPERSEDED' AND c.execution_generation=0 AND c.provider_started_at IS NULL AND c.provider_result IS NULL AND c.provider_response_digest IS NULL AND c.lease_token IS NULL AND c.lease_expires_at IS NULL AND c.completed_at IS NOT NULL) OR
    (c.status='SUCCEEDED' AND c.provider_started_at IS NOT NULL AND (c.lease_expires_at IS NULL OR (isfinite(c.lease_expires_at) AND c.lease_expires_at<=clock_timestamp()))
      AND o.request_id=p_request AND o.request_digest=p_digest AND o.lifecycle_revision=p_revision AND o.phase_receipt_id=p_phase AND o.phase_generation=p_generation
      AND o.execution_generation=c.execution_generation AND c.state_revision=o.command_revision+CASE WHEN o.discovery IS NULL THEN 0 ELSE 1 END
      AND o.observation->'value'->>'status' IN('succeeded','failed','canceled')
      AND c.provider_result=jsonb_build_object('kind','refund','refundId',o.observation->'value'->>'refundId','chargeId',o.observation->'value'->>'chargeId','amountCents',o.observation->'value'->'amountCents','currency',o.observation->'value'->>'currency')
      AND (o.discovery IS NULL OR c.provider_response_digest=o.observation->>'digest'))
  ),false)
  FROM billing_subscription_commands c LEFT JOIN LATERAL (
    SELECT evidence.* FROM app_billing_refund_observations evidence WHERE evidence.command_id=c.id ORDER BY evidence.observation_sequence DESC LIMIT 1
  ) o ON true WHERE c.id=p_command;
$$;
;
CREATE OR REPLACE FUNCTION guard_app_billing_refund_phase_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  IF NEW.phase IS DISTINCT FROM 'stripe' OR NEW.status IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Stripe completion requires an existing leased phase'; END IF;
  SELECT * INTO r FROM account_deletion_requests WHERE id=OLD.request_id;
  IF NOT COALESCE(OLD.phase='stripe' AND NEW.request_id=OLD.request_id AND NEW.lease_generation=OLD.lease_generation
    AND OLD.status IN('leased','calling','reconciling') AND isfinite(OLD.lease_expires_at) AND (OLD.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND r.status='processing' AND r.irreversible_at IS NOT NULL AND EXISTS(
      SELECT 1 FROM users u JOIN organizations org ON org.id=r.organization_id WHERE u.id=r.user_id
        AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision
        AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=r.id AND org.account_lifecycle_revision=r.lifecycle_revision
    ),false) THEN RAISE EXCEPTION 'Refund completion requires current canonical deletion authority'; END IF;
  IF EXISTS(SELECT 1 FROM app_billing_deletion_refund_inventory(r.id) inventory WHERE NOT COALESCE(
    app_billing_refund_is_terminal(inventory.command_id,r.id,r.request_digest,r.lifecycle_revision,OLD.id,OLD.lease_generation),false
  )) THEN RAISE EXCEPTION 'Unsettled app refund prevents Stripe phase completion'; END IF;
  IF (OLD.lease_expires_at AT TIME ZONE 'UTC')<=clock_timestamp() THEN RAISE EXCEPTION 'Refund completion lease expired during validation'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_refund_phase_completion_guard BEFORE INSERT OR UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION guard_app_billing_refund_phase_completion();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('421dcd110b7ec3730b99cef0d2aed69c9f23db4e6f35028d68f304bc0ef7afc2', 1796083200087);
-- apply 0461_app_billing_completion_owner_locks
-- Completion acquires the same owner-first lock order as billing admission and recovery.
CREATE OR REPLACE FUNCTION app_billing_deletion_completion_accounts(p_request uuid) RETURNS TABLE(account_id uuid) LANGUAGE sql STABLE AS $$
  WITH r AS (SELECT * FROM account_deletion_requests WHERE id=p_request), commands AS (
    SELECT c.* FROM billing_subscription_commands c CROSS JOIN r WHERE c.app_id IS NOT NULL AND (
      c.organization_id=r.organization_id OR c.requested_by_user_id=r.user_id OR
      c.request_payload->>'requestId'=r.id::text OR c.id IN(SELECT command_id FROM app_billing_deletion_refund_inventory(r.id))
    )
  )
  SELECT a.id FROM app_billing_accounts a JOIN apps app ON app.id=a.app_id CROSS JOIN r WHERE app.organization_id=r.organization_id
  UNION SELECT m.billing_account_id FROM app_billing_members m CROSS JOIN r WHERE m.user_id=r.user_id AND m.revoked_at IS NULL
  UNION SELECT a.id FROM app_billing_accounts a JOIN billing_identity_subjects identity ON identity.eligibility_principal_id=a.eligibility_principal_id CROSS JOIN r WHERE identity.id=r.user_id OR identity.live_user_id=r.user_id
  UNION SELECT s.billing_account_id FROM app_billing_scopes s JOIN commands c ON s.id=c.billing_scope_id OR s.id::text=c.request_payload->'source'->'scope'->>'scopeId'
  UNION SELECT s.billing_account_id FROM app_billing_scopes s JOIN app_subscription_paid_periods paid ON paid.billing_scope_id=s.id JOIN commands c ON paid.id::text=c.request_payload->'source'->>'paidPeriodId'
  UNION SELECT s.billing_account_id FROM app_billing_scopes s JOIN billing_subscriptions sub ON sub.billing_scope_id=s.id JOIN commands c ON c.result_subscription_id=sub.id
  UNION SELECT a.id FROM app_billing_accounts a JOIN commands c ON a.id::text=c.request_payload->>'billingAccountId' OR a.id::text=c.request_payload->'source'->'scope'->>'billingAccountId'
  UNION SELECT customer.billing_account_id FROM app_billing_customers customer JOIN commands c ON customer.id::text=c.request_payload->>'customerBindingId'
  UNION SELECT s.billing_account_id FROM app_billing_scopes s JOIN app_billing_deletion_dispositions decision ON decision.scope_id=s.id WHERE decision.request_id=p_request
  UNION SELECT customer.billing_account_id FROM app_billing_customers customer JOIN app_billing_customer_closures closure ON closure.customer_binding_id=customer.id WHERE closure.initiating_request_id=p_request;
$$;
;
CREATE OR REPLACE FUNCTION app_billing_deletion_completion_apps(p_request uuid) RETURNS TABLE(app_id uuid) LANGUAGE sql STABLE AS $$
  SELECT a.app_id FROM app_billing_accounts a JOIN app_billing_deletion_completion_accounts(p_request) inventory ON inventory.account_id=a.id
  UNION SELECT app.id FROM apps app JOIN account_deletion_requests r ON r.organization_id=app.organization_id WHERE r.id=p_request
  UNION SELECT c.app_id FROM billing_subscription_commands c JOIN account_deletion_requests r ON r.id=p_request WHERE c.app_id IS NOT NULL AND (c.organization_id=r.organization_id OR c.requested_by_user_id=r.user_id OR c.request_payload->>'requestId'=r.id::text);
$$;
;
CREATE OR REPLACE FUNCTION lock_app_billing_deletion_completion(p_request uuid,p_phase uuid,p_generation bigint) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE observed record; current_request record; current_phase record; accounts uuid[]; applications uuid[]; owners uuid[]; actors uuid[]; refreshed uuid[];
BEGIN
  SELECT * INTO observed FROM account_deletion_requests WHERE id=p_request;
  IF observed.id IS NULL OR observed.user_id IS NULL OR observed.organization_id IS NULL OR observed.status IS DISTINCT FROM 'processing' THEN RETURN false; END IF;
  SELECT COALESCE(array_agg(account_id ORDER BY account_id),'{}'::uuid[]) INTO accounts FROM app_billing_deletion_completion_accounts(p_request);
  SELECT COALESCE(array_agg(app_id ORDER BY app_id),'{}'::uuid[]) INTO applications FROM app_billing_deletion_completion_apps(p_request);
  SELECT array_agg(id ORDER BY id) INTO owners FROM (SELECT observed.organization_id AS id UNION SELECT organization_id FROM apps WHERE id=ANY(applications)) owner_set;
  PERFORM id FROM organizations WHERE id=ANY(owners) ORDER BY id FOR UPDATE;
  PERFORM id FROM apps WHERE id=ANY(applications) ORDER BY id FOR UPDATE;
  PERFORM id FROM app_billing_scopes WHERE billing_account_id=ANY(accounts) ORDER BY id FOR UPDATE;
  PERFORM id FROM app_billing_accounts WHERE id=ANY(accounts) ORDER BY id FOR UPDATE;
  PERFORM id FROM app_billing_customers WHERE billing_account_id=ANY(accounts) ORDER BY id FOR UPDATE;
  SELECT array_agg(id ORDER BY id) INTO actors FROM (SELECT observed.user_id AS id UNION SELECT user_id FROM app_billing_members WHERE billing_account_id=ANY(accounts) AND role='administrator') actor_set;
  PERFORM id FROM users WHERE id=ANY(actors) ORDER BY id FOR UPDATE;
  PERFORM id FROM app_billing_members WHERE billing_account_id=ANY(accounts) ORDER BY id FOR UPDATE;
  SELECT COALESCE(array_agg(account_id ORDER BY account_id),'{}'::uuid[]) INTO refreshed FROM app_billing_deletion_completion_accounts(p_request);
  IF refreshed IS DISTINCT FROM accounts THEN RAISE EXCEPTION 'Billing completion account inventory changed; retry from owners' USING ERRCODE='40001'; END IF;
  SELECT COALESCE(array_agg(app_id ORDER BY app_id),'{}'::uuid[]) INTO refreshed FROM app_billing_deletion_completion_apps(p_request);
  IF refreshed IS DISTINCT FROM applications OR EXISTS(SELECT 1 FROM apps WHERE id=ANY(applications) AND NOT(organization_id=ANY(owners))) OR EXISTS(SELECT 1 FROM app_billing_members WHERE billing_account_id=ANY(accounts) AND role='administrator' AND NOT(user_id=ANY(actors))) THEN RAISE EXCEPTION 'Billing completion owner inventory changed; retry from owners' USING ERRCODE='40001'; END IF;
  SELECT * INTO current_request FROM account_deletion_requests WHERE id=p_request FOR UPDATE;
  SELECT * INTO current_phase FROM account_deletion_phase_receipts WHERE id=p_phase AND request_id=p_request FOR UPDATE;
  RETURN COALESCE(current_request.user_id=observed.user_id AND current_request.organization_id=observed.organization_id AND current_request.request_digest=observed.request_digest AND current_request.lifecycle_revision=observed.lifecycle_revision
    AND current_request.status='processing' AND current_request.irreversible_at IS NOT NULL AND current_phase.phase='stripe' AND current_phase.lease_generation=p_generation
    AND current_phase.status IN('leased','calling','reconciling') AND isfinite(current_phase.lease_expires_at) AND (current_phase.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND EXISTS(SELECT 1 FROM users u JOIN organizations org ON org.id=current_request.organization_id WHERE u.id=current_request.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=current_request.id AND u.account_lifecycle_revision=current_request.lifecycle_revision AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=current_request.id AND org.account_lifecycle_revision=current_request.lifecycle_revision),false);
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('fec25a7d53ee79138766e24df9d34378fc483c6478a5f37958820419dfb97777', 1796083200088);
-- apply 0462_app_billing_completion_scope_decisions
-- Completion revalidates required scope decisions without giving observers billing authority.
CREATE OR REPLACE FUNCTION guard_app_billing_completion_scope_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; scope record; decision record; merchant record;
BEGIN
  IF NEW.phase IS DISTINCT FROM 'stripe' OR NEW.status IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;
  SELECT * INTO r FROM account_deletion_requests WHERE id=NEW.request_id;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Billing completion requires canonical request'; END IF;
  FOR scope IN
    SELECT s.* FROM app_billing_scopes s
    JOIN app_billing_deletion_completion_accounts(r.id) inventory ON inventory.account_id=s.billing_account_id
    WHERE s.organization_id=r.organization_id
      OR EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=s.billing_account_id AND m.app_id=s.app_id AND m.user_id=r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=s.livemode))
      OR EXISTS(SELECT 1 FROM billing_subscription_commands c WHERE c.billing_scope_id=s.id AND c.requested_by_user_id=r.user_id AND c.request_payload->>'domain'='buyer')
      OR EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=s.id AND d.request_id=r.id)
    ORDER BY s.id
  LOOP
    SELECT * INTO decision FROM app_billing_deletion_dispositions WHERE request_id=r.id AND scope_id=scope.id;
    SELECT * INTO merchant FROM billing_merchants WHERE id=scope.merchant_id;
    IF decision.scope_id IS NULL OR merchant.id IS NULL OR decision.request_digest IS DISTINCT FROM r.request_digest OR decision.lifecycle_revision IS DISTINCT FROM r.lifecycle_revision OR decision.phase_receipt_id IS DISTINCT FROM NEW.id OR decision.phase_generation>NEW.lease_generation OR decision.merchant_id IS DISTINCT FROM scope.merchant_id OR decision.provider_account_key IS DISTINCT FROM merchant.provider_account_key OR decision.livemode IS DISTINCT FROM scope.livemode THEN
      RAISE EXCEPTION 'Billing completion requires every canonical scope decision';
    END IF;
    IF decision.disposition='close' THEN
      IF scope.fenced_at IS NULL THEN RAISE EXCEPTION 'Billing completion cannot accept an unfenced close decision'; END IF;
      -- The existing provider-completion guard still rejects close until full terminal proof is available.
    ELSIF decision.disposition='retain_shared' THEN
      IF scope.organization_id=r.organization_id OR EXISTS(SELECT 1 FROM app_billing_deletion_dispositions prior WHERE prior.scope_id=scope.id AND prior.disposition='close') THEN RAISE EXCEPTION 'Billing completion cannot retain a closing scope'; END IF;
      IF NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=scope.billing_account_id AND m.app_id=scope.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=scope.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (isfinite(u.expires_at) AND (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN
        RAISE EXCEPTION 'Billing completion requires an eligible surviving administrator';
      END IF;
    ELSE
      RAISE EXCEPTION 'Billing completion has an unsupported scope decision';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_completion_scope_decisions_guard BEFORE INSERT OR UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION guard_app_billing_completion_scope_decisions();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('237bb7f731432c310c79582fcde3c6bdf5d448402977952e269881f8620c240c', 1796083200089);
-- apply 0463_app_billing_completion_validations
CREATE TABLE "app_billing_completion_validations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"request_digest" text NOT NULL,
	"lifecycle_revision" bigint NOT NULL,
	"phase_receipt_id" uuid NOT NULL,
	"phase_generation" bigint NOT NULL,
	"provider_receipt_digest" text NOT NULL,
	"validation_xid" "xid8" NOT NULL,
	"inventory_digest" text NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "app_billing_completion_validations_digest_check" CHECK ("app_billing_completion_validations"."request_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_completion_validations"."provider_receipt_digest" ~ '^[0-9a-f]{64}$' AND "app_billing_completion_validations"."inventory_digest" ~ '^[0-9a-f]{64}$')
);
;
CREATE UNIQUE INDEX "app_billing_completion_validations_phase_xid_idx" ON "app_billing_completion_validations" USING btree ("phase_receipt_id","validation_xid");
;
CREATE INDEX "app_billing_completion_validations_completed_xid_idx" ON "app_billing_completion_validations" USING btree ("validation_xid") WHERE "app_billing_completion_validations"."completed_at" IS NOT NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('3318e82c26e6dbbb0eb6c09f3da7df7e850711492050c3c6233dd5f7116cf56b', 1796083200090);
-- apply 0464_app_billing_completion_inventory
-- Snapshot identities and values are database-derived; live profile/provider data is hashed, never copied into retained evidence.
CREATE OR REPLACE FUNCTION app_billing_completion_commands(p_request uuid) RETURNS TABLE(command_id uuid) LANGUAGE sql STABLE AS $$
  WITH r AS (SELECT * FROM account_deletion_requests WHERE id=p_request), scopes AS (
    SELECT s.id FROM app_billing_scopes s JOIN app_billing_deletion_completion_accounts(p_request) a ON a.account_id=s.billing_account_id
  )
  SELECT c.id FROM billing_subscription_commands c CROSS JOIN r WHERE c.organization_id=r.organization_id OR c.requested_by_user_id=r.user_id OR c.request_payload->>'requestId'=r.id::text
    OR c.billing_scope_id IN(SELECT id FROM scopes) OR c.request_payload->'source'->'scope'->>'scopeId' IN(SELECT id::text FROM scopes)
    OR c.request_payload->'source'->>'paidPeriodId' IN(SELECT id::text FROM app_subscription_paid_periods WHERE billing_scope_id IN(SELECT id FROM scopes))
    OR c.id IN(SELECT command_id FROM app_billing_deletion_refund_inventory(p_request));
$$;
;
CREATE OR REPLACE FUNCTION app_billing_completion_inventory(p_request uuid) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  WITH request AS (SELECT * FROM account_deletion_requests WHERE id=p_request),
  accounts AS (SELECT account_id FROM app_billing_deletion_completion_accounts(p_request)),
  applications AS (SELECT x.* FROM apps x JOIN app_billing_deletion_completion_apps(p_request) a ON a.app_id=x.id),
  scopes AS (SELECT s.* FROM app_billing_scopes s JOIN accounts a ON a.account_id=s.billing_account_id),
  commands AS (SELECT c.* FROM billing_subscription_commands c JOIN app_billing_completion_commands(p_request) i ON i.command_id=c.id),
  subscriptions AS (SELECT s.* FROM billing_subscriptions s WHERE s.billing_scope_id IN(SELECT id FROM scopes) OR s.organization_id IN(SELECT organization_id FROM request) OR s.id IN(SELECT result_subscription_id FROM commands)),
  inventory AS (
    SELECT 'account_deletion_requests' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM account_deletion_requests t WHERE t.id=p_request
    UNION ALL
    SELECT 'organizations' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM organizations t WHERE t.id IN(SELECT organization_id FROM applications UNION SELECT organization_id FROM request UNION SELECT organization_id FROM commands)
    UNION ALL
    SELECT 'apps' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM apps t WHERE t.id IN(SELECT id FROM applications)
    UNION ALL
    SELECT 'app_billing_accounts' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_accounts t WHERE t.id IN(SELECT account_id FROM accounts)
    UNION ALL
    SELECT 'app_billing_scopes' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_scopes t WHERE t.id IN(SELECT id FROM scopes)
    UNION ALL
    SELECT 'app_billing_customers' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_customers t WHERE t.billing_account_id IN(SELECT account_id FROM accounts)
    UNION ALL
    SELECT 'app_billing_members' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_members t WHERE t.billing_account_id IN(SELECT account_id FROM accounts)
    UNION ALL
    SELECT 'users' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM users t WHERE t.id IN(SELECT user_id FROM request UNION SELECT user_id FROM app_billing_members WHERE billing_account_id IN(SELECT account_id FROM accounts) AND role='administrator')
    UNION ALL
    SELECT 'billing_merchants' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_merchants t WHERE t.id IN(SELECT merchant_id FROM scopes UNION SELECT merchant_id FROM commands) OR t.organization_id IN(SELECT organization_id FROM request)
    UNION ALL
    SELECT 'app_billing_plan_revisions' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_plan_revisions t WHERE t.app_id IN(SELECT id FROM applications)
    UNION ALL
    SELECT 'billing_subscriptions' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_subscriptions t WHERE t.id IN(SELECT id FROM subscriptions)
    UNION ALL
    SELECT 'billing_subscription_revisions' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_subscription_revisions t WHERE t.subscription_id IN(SELECT id FROM subscriptions)
    UNION ALL
    SELECT 'billing_subscription_commands' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_subscription_commands t WHERE t.id IN(SELECT id FROM commands)
    UNION ALL
    SELECT 'billing_funding_reservations' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM billing_funding_reservations t WHERE t.billing_scope_id IN(SELECT id FROM scopes) OR t.organization_id IN(SELECT organization_id FROM request)
    UNION ALL
    SELECT 'app_subscription_trials' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_subscription_trials t WHERE t.billing_scope_id IN(SELECT id FROM scopes)
    UNION ALL
    SELECT 'app_subscription_paid_periods' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_subscription_paid_periods t WHERE t.billing_scope_id IN(SELECT id FROM scopes)
    UNION ALL
    SELECT 'app_billing_deletion_dispositions' AS relation,t.request_id::text||':'||t.scope_id::text::text AS identity,to_jsonb(t) AS value FROM app_billing_deletion_dispositions t WHERE t.request_id=p_request OR t.scope_id IN(SELECT id FROM scopes)
    UNION ALL
    SELECT 'app_billing_customer_closures' AS relation,t.customer_binding_id::text AS identity,to_jsonb(t) AS value FROM app_billing_customer_closures t WHERE t.initiating_request_id=p_request OR t.billing_account_id IN(SELECT account_id FROM accounts)
    UNION ALL
    SELECT 'app_billing_refund_observations' AS relation,t.id::text AS identity,to_jsonb(t) AS value FROM app_billing_refund_observations t WHERE t.request_id=p_request OR t.command_id IN(SELECT id FROM commands)
  ) SELECT COALESCE(jsonb_agg(jsonb_build_object('relation',relation,'identity',identity,'value',value) ORDER BY relation,identity),'[]'::jsonb) FROM inventory;
$$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('2e72d94470a5b2365e2ea07bcef37d670e67c455e89b254a84a85d2b0fe08f4d', 1796083200091);
-- apply 0465_app_billing_completion_validation_locks
-- Validation locks only its captured inventory; newly discovered owners force an outer retry.
CREATE OR REPLACE FUNCTION lock_app_billing_completion_validation(p_request uuid,p_phase uuid,p_generation bigint) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE initial jsonb; refreshed jsonb; tab text; keys text[]; r record; p record;
BEGIN
  initial:=app_billing_completion_inventory(p_request);
  FOREACH tab IN ARRAY ARRAY['organizations','apps','app_billing_scopes','app_billing_accounts','app_billing_customers','users','app_billing_members','account_deletion_requests'] LOOP
    SELECT COALESCE(array_agg(item->>'identity' ORDER BY item->>'identity'),'{}'::text[]) INTO keys FROM jsonb_array_elements(initial) item WHERE item->>'relation'=tab;
    EXECUTE format('SELECT id FROM %I WHERE id::text=ANY($1) ORDER BY id FOR UPDATE',tab) USING keys;
  END LOOP;
  SELECT * INTO r FROM account_deletion_requests WHERE id=p_request;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=p_phase AND request_id=p_request FOR UPDATE;
  FOREACH tab IN ARRAY ARRAY['billing_merchants','app_billing_plan_revisions','billing_subscriptions','billing_subscription_commands','billing_funding_reservations'] LOOP
    SELECT COALESCE(array_agg(item->>'identity' ORDER BY item->>'identity'),'{}'::text[]) INTO keys FROM jsonb_array_elements(initial) item WHERE item->>'relation'=tab;
    EXECUTE format('SELECT id FROM %I WHERE id::text=ANY($1) ORDER BY id FOR UPDATE',tab) USING keys;
  END LOOP;
  refreshed:=app_billing_completion_inventory(p_request);
  IF (SELECT jsonb_agg(item- 'value' ORDER BY item->>'relation',item->>'identity') FROM jsonb_array_elements(initial) item) IS DISTINCT FROM (SELECT jsonb_agg(item- 'value' ORDER BY item->>'relation',item->>'identity') FROM jsonb_array_elements(refreshed) item) THEN RAISE EXCEPTION 'Billing validation obligation inventory changed; retry from owners' USING ERRCODE='40001'; END IF;
  RETURN COALESCE(r.status='processing' AND r.irreversible_at IS NOT NULL AND p.phase='stripe' AND p.lease_generation=p_generation
    AND p.status IN('leased','calling','reconciling') AND isfinite(p.lease_expires_at) AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND EXISTS(SELECT 1 FROM users u JOIN organizations org ON org.id=r.organization_id WHERE u.id=r.user_id AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=r.id AND org.account_lifecycle_revision=r.lifecycle_revision),false);
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('3a6dcf9c560b4178b0ebaad58f03fde0aed68e4ffce9e46b8e485c89f9076097', 1796083200092);
-- apply 0466_app_billing_completion_validation_guards
-- Evidence is useful only when validation and the exact phase completion commit together.
CREATE OR REPLACE FUNCTION guard_app_billing_completion_validation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p record;
BEGIN
  IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Billing completion evidence is immutable'; END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.completed_at IS NOT NULL OR NEW.completed_at IS NULL OR (to_jsonb(NEW)-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'completed_at') OR OLD.validation_xid IS DISTINCT FROM pg_current_xact_id() OR NOT EXISTS(SELECT 1 FROM account_deletion_phase_receipts phase WHERE phase.id=OLD.phase_receipt_id AND phase.request_id=OLD.request_id AND phase.lease_generation=OLD.phase_generation AND phase.phase='stripe' AND phase.status='completed' AND phase.provider_receipt_digest=OLD.provider_receipt_digest) THEN RAISE EXCEPTION 'Billing completion linkage requires its atomic phase transition'; END IF;
    NEW.completed_at:=clock_timestamp(); RETURN NEW;
  END IF;
  IF NEW.completed_at IS NOT NULL THEN RAISE EXCEPTION 'Billing validation cannot fabricate a completion'; END IF;
  IF NOT lock_app_billing_completion_validation(NEW.request_id,NEW.phase_receipt_id,NEW.phase_generation) THEN RAISE EXCEPTION 'Billing validation requires current deletion authority'; END IF;
  SELECT * INTO STRICT r FROM account_deletion_requests WHERE id=NEW.request_id;
  SELECT * INTO STRICT p FROM account_deletion_phase_receipts WHERE id=NEW.phase_receipt_id;
  NEW.request_digest:=r.request_digest; NEW.lifecycle_revision:=r.lifecycle_revision; NEW.phase_generation:=p.lease_generation;
  NEW.validation_xid:=pg_current_xact_id(); NEW.validated_at:=clock_timestamp();
  NEW.inventory_digest:=encode(sha256(convert_to(app_billing_completion_inventory(r.id)::text,'UTF8')),'hex');
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_completion_validation_guard BEFORE INSERT OR UPDATE OR DELETE ON app_billing_completion_validations FOR EACH ROW EXECUTE FUNCTION guard_app_billing_completion_validation();
;
CREATE TRIGGER app_billing_completion_validation_truncate_guard BEFORE TRUNCATE ON app_billing_completion_validations FOR EACH STATEMENT EXECUTE FUNCTION guard_app_billing_completion_validation();
;
CREATE OR REPLACE FUNCTION record_app_billing_completion_validation(p_request uuid,p_phase uuid,p_generation bigint,p_provider_digest text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE evidence_id uuid;
BEGIN
  IF NOT lock_app_billing_completion_validation(p_request,p_phase,p_generation) THEN RETURN NULL; END IF;
  INSERT INTO app_billing_completion_validations(request_id,phase_receipt_id,phase_generation,provider_receipt_digest) VALUES(p_request,p_phase,p_generation,p_provider_digest) RETURNING id INTO evidence_id;
  RETURN evidence_id;
END $$;
;
CREATE OR REPLACE FUNCTION guard_app_billing_validated_phase_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence record; r record;
BEGIN
  IF NEW.phase IS DISTINCT FROM 'stripe' OR NEW.status IS DISTINCT FROM 'completed' THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN RAISE EXCEPTION 'Stripe completion requires an existing phase and same-transaction billing validation'; END IF;
  SELECT * INTO evidence FROM app_billing_completion_validations WHERE phase_receipt_id=OLD.id AND validation_xid=pg_current_xact_id();
  SELECT * INTO r FROM account_deletion_requests WHERE id=OLD.request_id;
  IF evidence.id IS NULL OR evidence.completed_at IS NOT NULL OR evidence.request_id IS DISTINCT FROM OLD.request_id OR NEW.request_id IS DISTINCT FROM OLD.request_id OR evidence.phase_generation IS DISTINCT FROM OLD.lease_generation OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation OR evidence.provider_receipt_digest IS DISTINCT FROM NEW.provider_receipt_digest OR evidence.request_digest IS DISTINCT FROM r.request_digest OR evidence.lifecycle_revision IS DISTINCT FROM r.lifecycle_revision THEN RAISE EXCEPTION 'Stripe completion requires exact same-transaction billing validation'; END IF;
  IF evidence.inventory_digest IS DISTINCT FROM encode(sha256(convert_to(app_billing_completion_inventory(r.id)::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'Billing obligations changed after validation'; END IF;
  IF NOT COALESCE(OLD.phase='stripe' AND OLD.status IN('leased','calling','reconciling') AND isfinite(OLD.lease_expires_at) AND (OLD.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp(),false) THEN RAISE EXCEPTION 'Billing completion lease expired after validation'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER zz_app_billing_validated_phase_completion_guard BEFORE INSERT OR UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION guard_app_billing_validated_phase_completion();
;
CREATE OR REPLACE FUNCTION retain_app_billing_phase_completion_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase='stripe' AND NEW.status='completed' AND OLD.status IS DISTINCT FROM 'completed' THEN
    UPDATE app_billing_completion_validations SET completed_at=clock_timestamp() WHERE phase_receipt_id=NEW.id AND validation_xid=pg_current_xact_id();
    IF NOT FOUND THEN RAISE EXCEPTION 'Billing phase completion linkage is missing'; END IF;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_phase_completion_link AFTER UPDATE ON account_deletion_phase_receipts FOR EACH ROW EXECUTE FUNCTION retain_app_billing_phase_completion_link();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('b514dd819906fd63faa34b395ffc6fe8e2962e06f6cb4b143a4047f19eec1e6d', 1796083200093);
-- apply 0467_app_billing_completion_commit_validation
-- The phase guard and deferred check share scope authority and survivor policy.
CREATE OR REPLACE FUNCTION require_app_billing_completion_scope_decisions(p_request uuid,p_phase uuid,p_generation bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r record; scope record; decision record; merchant record;
BEGIN
  SELECT * INTO r FROM account_deletion_requests WHERE id=p_request;
  IF r.id IS NULL THEN RAISE EXCEPTION 'Billing completion requires canonical request'; END IF;
  FOR scope IN
    SELECT s.* FROM app_billing_scopes s
    JOIN app_billing_deletion_completion_accounts(r.id) inventory ON inventory.account_id=s.billing_account_id
    WHERE s.organization_id=r.organization_id
      OR EXISTS(SELECT 1 FROM app_billing_members m WHERE m.billing_account_id=s.billing_account_id AND m.app_id=s.app_id AND m.user_id=r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=s.livemode))
      OR EXISTS(SELECT 1 FROM billing_subscription_commands c WHERE c.billing_scope_id=s.id AND c.requested_by_user_id=r.user_id AND c.request_payload->>'domain'='buyer')
      OR EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=s.id AND d.request_id=r.id)
    ORDER BY s.id
  LOOP
    SELECT * INTO decision FROM app_billing_deletion_dispositions WHERE request_id=r.id AND scope_id=scope.id;
    SELECT * INTO merchant FROM billing_merchants WHERE id=scope.merchant_id;
    IF decision.scope_id IS NULL OR merchant.id IS NULL OR decision.request_digest IS DISTINCT FROM r.request_digest OR decision.lifecycle_revision IS DISTINCT FROM r.lifecycle_revision OR decision.phase_receipt_id IS DISTINCT FROM p_phase OR decision.phase_generation>p_generation OR decision.merchant_id IS DISTINCT FROM scope.merchant_id OR decision.provider_account_key IS DISTINCT FROM merchant.provider_account_key OR decision.livemode IS DISTINCT FROM scope.livemode THEN
      RAISE EXCEPTION 'Billing completion requires every canonical scope decision';
    END IF;
    IF decision.disposition='close' THEN
      IF scope.fenced_at IS NULL THEN RAISE EXCEPTION 'Billing completion cannot accept an unfenced close decision'; END IF;
      -- The existing provider-completion guard still rejects close until full terminal proof is available.
    ELSIF decision.disposition='retain_shared' THEN
      IF scope.organization_id=r.organization_id OR EXISTS(SELECT 1 FROM app_billing_deletion_dispositions prior WHERE prior.scope_id=scope.id AND prior.disposition='close') THEN RAISE EXCEPTION 'Billing completion cannot retain a closing scope'; END IF;
      IF NOT EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=scope.billing_account_id AND m.app_id=scope.app_id AND m.user_id<>r.user_id AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=scope.livemode) AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL AND (u.expires_at IS NULL OR (isfinite(u.expires_at) AND (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))) THEN
        RAISE EXCEPTION 'Billing completion requires an eligible surviving administrator';
      END IF;
    ELSE
      RAISE EXCEPTION 'Billing completion has an unsupported scope decision';
    END IF;
  END LOOP;
  RETURN;
END $$;
;
CREATE OR REPLACE FUNCTION guard_app_billing_completion_scope_decisions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.phase='stripe' AND NEW.status='completed' THEN PERFORM require_app_billing_completion_scope_decisions(NEW.request_id,NEW.id,NEW.lease_generation); END IF;
  RETURN NEW;
END $$;
;
CREATE OR REPLACE FUNCTION require_app_billing_completion_link(p_evidence uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE evidence record;
BEGIN
  SELECT * INTO STRICT evidence FROM app_billing_completion_validations WHERE id=p_evidence;
  IF evidence.completed_at IS NULL OR evidence.validation_xid IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'Billing completion requires current atomic linkage'; END IF;
  IF NOT EXISTS(SELECT 1 FROM account_deletion_phase_receipts p WHERE p.id=evidence.phase_receipt_id AND p.request_id=evidence.request_id AND p.phase='stripe' AND p.status='completed' AND p.lease_generation=evidence.phase_generation AND p.provider_receipt_digest=evidence.provider_receipt_digest) THEN RAISE EXCEPTION 'Billing phase changed before commit'; END IF;
  IF evidence.inventory_digest IS DISTINCT FROM encode(sha256(convert_to(app_billing_completion_inventory(evidence.request_id)::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'Billing obligations changed before commit'; END IF;
  PERFORM require_app_billing_completion_scope_decisions(evidence.request_id,evidence.phase_receipt_id,evidence.phase_generation);
END $$;
;
CREATE OR REPLACE FUNCTION validate_app_billing_completion_commit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM require_app_billing_completion_link(NEW.id);
  RETURN NEW;
END $$;
;
CREATE CONSTRAINT TRIGGER app_billing_completion_commit_guard AFTER UPDATE ON app_billing_completion_validations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.completed_at IS NOT NULL) EXECUTE FUNCTION validate_app_billing_completion_commit();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('c99e971fa8dcd7028128714e502fadf85333d32c197a0fccf38b66faefe3ee25', 1796083200094);
-- apply 0468_app_billing_completion_mutation_fence
-- Post-completion writes cannot invalidate evidence even if deferred constraints were forced early.
CREATE OR REPLACE FUNCTION fence_app_billing_completed_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence record;
BEGIN
  FOR evidence IN SELECT id FROM app_billing_completion_validations WHERE validation_xid=pg_current_xact_id() AND completed_at IS NOT NULL LOOP
    PERFORM require_app_billing_completion_link(evidence.id);
  END LOOP;
  RETURN NULL;
END $$;
;
DO $$ DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['account_deletion_requests','account_deletion_phase_receipts','organizations','apps','app_billing_accounts','app_billing_scopes','app_billing_customers','app_billing_members','users','billing_merchants','app_billing_plan_revisions','billing_subscriptions','billing_subscription_revisions','billing_subscription_commands','billing_funding_reservations','app_subscription_trials','app_subscription_paid_periods','app_billing_deletion_dispositions','app_billing_customer_closures','app_billing_refund_observations','billing_identity_subjects'] LOOP
    EXECUTE format('CREATE TRIGGER zz_billing_completion_mutation_fence AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION fence_app_billing_completed_transaction()',tab);
    EXECUTE format('CREATE TRIGGER zz_billing_completion_truncate_fence AFTER TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION fence_app_billing_completed_transaction()',tab);
  END LOOP;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('c0d4fa1235d1b2d09ba2106abd885aaf8f898b071bd381127884c4853daa1e17', 1796083200095);
-- apply 0469_app_billing_customer_receipt_digests
-- A retained customer tombstone proves its exact original binding and recomputed provider request/value digests.
CREATE OR REPLACE FUNCTION app_billing_customer_deletion_receipt_valid(command billing_subscription_commands) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE payload jsonb:=command.request_payload; result jsonb:=command.provider_result; observation jsonb:=result->'observation'; valid boolean;
BEGIN
  SELECT command.kind='delete_customer' AND command.status='SUCCEEDED'
    AND payload->>'version'='1' AND payload->>'domain'='account_deletion' AND payload->>'action'='delete_customer'
    AND command.app_id=cl.app_id AND command.merchant_id=cl.merchant_id AND command.merchant_key=cl.provider_account_key AND command.livemode=cl.livemode
    AND command.organization_id=s.organization_id AND s.organization_id=m.organization_id AND s.app_id=cl.app_id AND s.billing_account_id=cl.billing_account_id AND s.merchant_id=cl.merchant_id AND s.livemode=cl.livemode
    AND a.app_id=cl.app_id AND b.billing_account_id=cl.billing_account_id AND b.merchant_id=cl.merchant_id AND b.stripe_customer_id=cl.stripe_customer_id
    AND m.provider_account_key=cl.provider_account_key AND m.stripe_account_id=cl.stripe_account_id AND m.livemode=cl.livemode
    AND payload->>'closureRequestId'=cl.initiating_request_id::text AND payload->>'closureRequestDigest'=cl.request_digest
    AND payload->>'billingAccountId'=cl.billing_account_id::text AND payload->>'customerId'=cl.stripe_customer_id AND payload->>'providerAccountId'=cl.stripe_account_id
    AND command.idempotency_key='deletion-customer:'||cl.customer_binding_id::text AND command.provider_idempotency_key='app-'||command.idempotency_key
    AND command.request_digest=encode(sha256(convert_to(app_billing_refund_canonical_json(payload),'UTF8')),'hex')
    AND result->>'kind'='deleted_customer' AND result->>'customerBindingId'=cl.customer_binding_id::text
    AND observation->'value'=jsonb_build_object('customerId',cl.stripe_customer_id,'status','deleted')
    AND observation->>'merchantId'=cl.merchant_id::text AND observation->>'providerAccountId'=cl.stripe_account_id AND observation->'livemode'=to_jsonb(cl.livemode) AND observation->>'apiVersion'='2024-11-20.acacia'
    AND observation->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(observation->'value'),'UTF8')),'hex') AND observation->>'digest'=command.provider_response_digest
    AND observation->>'inputDigest'=encode(sha256(convert_to(app_billing_refund_canonical_json(jsonb_build_object('operation','inspectBoundCustomer','scope',jsonb_build_object('scopeId',s.id,'appId',cl.app_id,'billingAccountId',cl.billing_account_id),'customerId',cl.stripe_customer_id)),'UTF8')),'hex')
    AND command.execution_generation>0 AND command.lease_token IS NULL AND command.lease_expires_at IS NULL AND command.error_code IS NULL
    AND command.subscription_id IS NULL AND command.expected_subscription_revision IS NULL AND command.target_plan_key IS NULL AND command.target_plan_revision_id IS NULL AND command.client_registration_id IS NULL
    AND command.result_subscription_id IS NULL AND command.result_subscription_revision IS NULL AND command.applied_at IS NULL
    AND isfinite(command.provider_started_at) AND isfinite(command.completed_at) AND isfinite((observation->>'observedAt')::timestamptz)
    AND command.provider_started_at>=(cl.created_at) AND (observation->>'observedAt')::timestamptz>=command.provider_started_at AND (observation->>'observedAt')::timestamptz<=command.completed_at AND command.completed_at<=clock_timestamp()
  INTO valid
  FROM app_billing_customer_closures cl JOIN app_billing_customers b ON b.id=cl.customer_binding_id
    JOIN app_billing_accounts a ON a.id=b.billing_account_id JOIN app_billing_scopes s ON s.id=command.billing_scope_id JOIN billing_merchants m ON m.id=cl.merchant_id
  WHERE cl.customer_binding_id::text=payload->>'customerBindingId';
  RETURN COALESCE(valid,false);
END $$;
;
CREATE OR REPLACE FUNCTION guard_app_billing_customer_receipt_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='SUCCEEDED' AND (NEW.kind='delete_customer' OR NEW.provider_result->>'kind'='deleted_customer') AND NOT app_billing_customer_deletion_receipt_valid(NEW) THEN RAISE EXCEPTION 'Customer deletion requires exact retained tombstone evidence'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_customer_receipt_digest_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_customer_receipt_digest();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('8bdfdeb589fa39acd128c768119610ab90f886017384c895327c7b58376c8655', 1796083200096);
-- apply 0470_app_billing_cancellation_evidence
-- Retain the actual canceled observation in the original command, without fabricating historical evidence.
CREATE OR REPLACE FUNCTION guard_app_billing_cancellation_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb; o jsonb; v jsonb; r record; p record; sc record; merchant record; revision record;
BEGIN
  e:=NEW.provider_result->'cancellationEvidence';
  IF e IS NOT NULL AND NOT COALESCE(NEW.kind='cancel' AND NEW.request_payload->>'domain'='account_deletion' AND NEW.request_payload->>'action'='cancel' AND NEW.status='APPLIED',false)
    THEN RAISE EXCEPTION 'Cancellation evidence requires its original applied deletion command'; END IF;
  IF NEW.request_payload->>'domain' IS DISTINCT FROM 'account_deletion' OR NEW.request_payload->>'action' IS DISTINCT FROM 'cancel' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.provider_result->'cancellationEvidence' IS NOT NULL
    AND OLD.provider_result->'cancellationEvidence' IS DISTINCT FROM e THEN RAISE EXCEPTION 'Cancellation evidence is immutable'; END IF;
  IF NEW.status IS DISTINCT FROM 'APPLIED' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status='APPLIED' THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Cancellation evidence requires an existing execution lease'; END IF;
  o:=e->'observation'; v:=o->'value';
  SELECT * INTO r FROM account_deletion_requests WHERE id=(NEW.request_payload->>'requestId')::uuid FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id=(NEW.request_payload->>'phaseReceiptId')::uuid AND request_id=r.id FOR SHARE;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=NEW.billing_scope_id;
  SELECT * INTO merchant FROM billing_merchants WHERE id=NEW.merchant_id;
  SELECT * INTO revision FROM billing_subscription_revisions rev WHERE rev.subscription_id=NEW.result_subscription_id AND rev.revision=NEW.result_subscription_revision;
  IF NOT COALESCE(
    OLD.status='OUTCOME_UNKNOWN' AND OLD.provider_result IS NULL AND OLD.provider_started_at IS NOT NULL
    AND OLD.lease_token IS NOT NULL AND isfinite(OLD.lease_expires_at) AND OLD.lease_expires_at>clock_timestamp()
    AND e->>'commandId'=OLD.id::text AND (e->>'commandRevision')::bigint=OLD.state_revision
    AND (e->>'executionGeneration')::bigint=OLD.execution_generation AND OLD.execution_generation>0
    AND e->>'leaseToken'=OLD.lease_token::text AND NEW.execution_generation=OLD.execution_generation
    AND NEW.state_revision=OLD.state_revision+1 AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
    AND NEW.provider_started_at=OLD.provider_started_at AND NEW.error_code IS NULL
    AND NEW.request_digest=encode(sha256(convert_to(app_billing_refund_canonical_json(NEW.request_payload),'UTF8')),'hex')
    AND r.status='processing' AND r.irreversible_at IS NOT NULL AND r.request_digest=NEW.request_payload->>'requestDigest'
    AND r.user_id=NEW.requested_by_user_id AND r.lifecycle_revision=(NEW.request_payload->>'lifecycleRevision')::bigint
    AND p.phase='stripe' AND p.status IN('leased','calling','reconciling') AND p.lease_generation=(e->>'phaseGeneration')::bigint
    AND p.lease_generation>=(NEW.request_payload->>'initiatingPhaseGeneration')::bigint
    AND isfinite(p.lease_expires_at) AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND EXISTS(SELECT 1 FROM users u JOIN organizations org ON org.id=r.organization_id WHERE u.id=r.user_id
      AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision
      AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=r.id AND org.account_lifecycle_revision=r.lifecycle_revision)
    AND EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=sc.id AND d.request_id=r.id AND d.disposition='close'
      AND d.request_digest=r.request_digest AND d.lifecycle_revision=r.lifecycle_revision AND d.phase_receipt_id=p.id AND d.phase_generation=p.lease_generation
      AND d.merchant_id=NEW.merchant_id AND d.provider_account_key=NEW.merchant_key AND d.livemode=NEW.livemode)
    AND sc.fenced_at IS NOT NULL AND sc.app_id=NEW.app_id AND sc.organization_id=NEW.organization_id AND sc.merchant_id=NEW.merchant_id AND sc.livemode=NEW.livemode
    AND o->>'merchantId'=NEW.merchant_id::text AND o->>'providerAccountId'=merchant.stripe_account_id
    AND merchant.stripe_account_id=NEW.request_payload->>'providerAccountId' AND merchant.provider_account_key=NEW.merchant_key
    AND o->'livemode'=to_jsonb(NEW.livemode) AND o->>'apiVersion'='2024-11-20.acacia'
    AND o->>'inputDigest'=NEW.request_digest AND o->>'digest'=NEW.provider_response_digest
    AND o->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(v),'UTF8')),'hex')
    AND isfinite((o->>'observedAt')::timestamptz) AND (o->>'observedAt')::timestamptz>=OLD.provider_started_at
    AND (o->>'observedAt')::timestamptz<=NEW.completed_at AND isfinite(NEW.completed_at) AND NEW.completed_at<=clock_timestamp()
    AND NEW.applied_at=NEW.completed_at AND v->>'status'='canceled' AND v->'pendingUpdate'='false'::jsonb
    AND NEW.provider_result->>'kind'='completed' AND NEW.request_payload->>'timing'='immediate'
    AND NEW.result_subscription_id=NEW.subscription_id AND NEW.subscription_id::text=NEW.request_payload->>'localSubscriptionId'
    AND NEW.provider_result->>'subscriptionId'=NEW.result_subscription_id::text AND (NEW.provider_result->>'subscriptionRevision')::bigint=NEW.result_subscription_revision
    AND revision.organization_id=NEW.organization_id AND revision.billing_scope_id=NEW.billing_scope_id AND revision.merchant_key=NEW.merchant_key
    AND revision.provider_environment=CASE WHEN NEW.livemode THEN 'live' ELSE 'test' END AND revision.status='canceled'
    AND revision.provider_object_digest=NEW.provider_response_digest
    AND revision.stripe_subscription_id=v->>'subscriptionId' AND v->>'subscriptionId'=NEW.request_payload->>'subscriptionId'
    AND revision.stripe_customer_id=v->>'customerId' AND v->>'customerId'=NEW.request_payload->>'customerId'
    AND revision.stripe_subscription_item_id=v->>'itemId' AND revision.quantity=(v->>'quantity')::integer
    AND revision.current_period_start=to_timestamp((v->>'currentPeriodStart')::double precision)
    AND revision.current_period_end=to_timestamp((v->>'currentPeriodEnd')::double precision)
    AND revision.cancel_at_period_end=(v->>'cancelAtPeriodEnd')::boolean
    AND EXISTS(SELECT 1 FROM app_billing_plan_revisions plan WHERE plan.id=NEW.target_plan_revision_id AND plan.id::text=NEW.request_payload->>'planRevisionId'
      AND plan.app_id=NEW.app_id AND plan.merchant_id=NEW.merchant_id AND plan.stripe_price_id=v->>'priceId' AND plan.stripe_product_id=v->>'productId')
    AND EXISTS(SELECT 1 FROM billing_subscriptions sub WHERE sub.id=NEW.subscription_id AND sub.billing_scope_id=NEW.billing_scope_id
      AND sub.lifecycle_revision=NEW.result_subscription_revision AND sub.status='canceled' AND sub.provider_object_digest=NEW.provider_response_digest),false)
    THEN RAISE EXCEPTION 'Cancellation requires exact retained observation, source revision and current execution authority'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_cancellation_evidence_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_cancellation_evidence();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('d29df89bd144f188350ce23b7c279dc637865e4a795a4dfae37fea45030219b9', 1796083200097);
-- apply 0471_app_billing_checkout_cleanup_receipts
-- Recompute retained Checkout read evidence against its original source and immutable provider input.
CREATE OR REPLACE FUNCTION app_billing_checkout_cleanup_receipt_valid(command billing_subscription_commands) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE payload jsonb:=command.request_payload; result jsonb:=command.provider_result; e jsonb:=result->'checkoutEvidence'; o jsonb:=e->'observation'; v jsonb:=o->'value'; source record; sc record; merchant record; plan record; expected jsonb; input jsonb;
BEGIN
  SELECT * INTO source FROM billing_subscription_commands WHERE id::text=payload->>'sourceCommandId';
  SELECT * INTO sc FROM app_billing_scopes WHERE id=command.billing_scope_id;
  SELECT * INTO merchant FROM billing_merchants WHERE id=command.merchant_id;
  input:=jsonb_build_object('sessionId',payload->>'checkoutSessionId','customerId',payload->>'customerId','mode',payload->>'mode');
  IF payload->>'mode'='setup' THEN
    SELECT * INTO plan FROM app_billing_plan_revisions WHERE id::text=payload->>'planRevisionId';
    IF plan.id IS NULL OR plan.app_id IS DISTINCT FROM command.app_id OR plan.merchant_id IS DISTINCT FROM command.merchant_id THEN RETURN false; END IF;
    input:=input||jsonb_build_object('subscriptionId',payload->>'subscriptionId','plan',jsonb_build_object('planRevisionId',plan.id,'priceId',plan.stripe_price_id,'productId',plan.stripe_product_id,'amountCents',plan.amount_cents,'currency',plan.currency,'interval',plan.interval,'intervalCount',plan.interval_count,'minimumQuantity',plan.minimum_quantity,'maximumQuantity',plan.maximum_quantity,'trialDays',plan.trial_days));
  END IF;
  expected:=jsonb_build_object('operation',CASE WHEN payload->>'mode'='setup' THEN 'readPaymentMethodCheckout' ELSE 'readCheckout' END,
    'scope',jsonb_build_object('scopeId',sc.id,'appId',sc.app_id,'billingAccountId',sc.billing_account_id),'input',input);
  RETURN COALESCE(command.kind='expire_checkout' AND command.status='SUCCEEDED' AND payload->>'version'='1'
    AND payload->>'domain'='account_deletion' AND payload->>'action'='expire_checkout' AND payload->>'mode' IN('setup','subscription')
    AND command.request_digest=encode(sha256(convert_to(app_billing_refund_canonical_json(payload),'UTF8')),'hex')
    AND source.id IS NOT NULL AND source.request_payload->>'domain'='buyer' AND source.request_payload->>'action'='checkout' AND source.provider_result->>'kind'='checkout'
    AND (command.billing_scope_id,command.app_id,command.organization_id,command.merchant_id,command.merchant_key,command.livemode,command.requested_by_user_id)
      IS NOT DISTINCT FROM (source.billing_scope_id,source.app_id,source.organization_id,source.merchant_id,source.merchant_key,source.livemode,source.requested_by_user_id)
    AND sc.app_id=command.app_id AND sc.organization_id=command.organization_id AND sc.merchant_id=command.merchant_id AND sc.livemode=command.livemode
    AND merchant.organization_id=command.organization_id AND merchant.provider_account_key=command.merchant_key AND merchant.livemode=command.livemode
    AND payload->>'checkoutSessionId'=source.provider_result->>'checkoutSessionId' AND payload->>'customerId'=source.provider_result->>'customerId'
    AND payload->>'mode'=source.provider_result->>'mode' AND (payload->>'planRevisionId') IS NOT DISTINCT FROM source.target_plan_revision_id::text
    AND ((payload->'subscriptionId') IS NOT DISTINCT FROM (source.provider_result->'subscriptionId') OR (payload->>'mode'='subscription' AND payload->'subscriptionId'='null'::jsonb))
    AND command.idempotency_key='deletion-expire:'||source.id::text AND command.provider_idempotency_key='app-'||command.idempotency_key
    AND e->>'commandId'=command.id::text AND e->>'sourceCommandId'=source.id::text
    AND (e->>'sourceRevision')::bigint<=source.state_revision AND (e->>'sourceRevision')::bigint>0
    AND (e->>'commandRevision')::bigint+1=command.state_revision AND (e->>'executionGeneration')::bigint=command.execution_generation
    AND command.execution_generation>0 AND (e->>'leaseToken')::uuid IS NOT NULL AND (e->>'phaseGeneration')::bigint>0
    AND command.lease_token IS NULL AND command.lease_expires_at IS NULL AND command.error_code IS NULL
    AND result->>'checkoutSessionId'=payload->>'checkoutSessionId' AND v->>'sessionId'=payload->>'checkoutSessionId'
    AND v->>'customerId'=payload->>'customerId' AND v->>'mode'=payload->>'mode'
    AND v ?& ARRAY['mode','sessionId','customerId','subscriptionId','status','url','expiresAt']
    AND jsonb_typeof(v->'url') IN('string','null') AND jsonb_typeof(v->'expiresAt')='number'
    AND (CASE WHEN payload->>'mode'='setup' THEN v ? 'setupIntentId' AND v->>'subscriptionId'=payload->>'subscriptionId' AND jsonb_typeof(v->'setupIntentId') IN('string','null')
      ELSE v ?& ARRAY['invoiceId','paymentStatus'] AND jsonb_typeof(v->'invoiceId') IN('string','null') AND v->>'paymentStatus' IN('paid','unpaid','no_payment_required') END)
    AND o->>'merchantId'=merchant.id::text AND o->>'providerAccountId'=merchant.stripe_account_id
    AND o->'livemode'=to_jsonb(command.livemode) AND o->>'apiVersion'='2024-11-20.acacia'
    AND o->>'digest'=command.provider_response_digest AND o->>'digest'=encode(sha256(convert_to(app_billing_refund_canonical_json(v),'UTF8')),'hex')
    AND o->>'inputDigest'=encode(sha256(convert_to(app_billing_refund_canonical_json(expected),'UTF8')),'hex')
    AND isfinite(command.provider_started_at) AND isfinite(command.completed_at) AND isfinite((o->>'observedAt')::timestamptz)
    AND (o->>'observedAt')::timestamptz>=command.provider_started_at AND (o->>'observedAt')::timestamptz<=command.completed_at AND command.completed_at<=clock_timestamp()
    AND command.result_subscription_id IS NULL AND command.result_subscription_revision IS NULL AND command.applied_at IS NULL
    AND ((result->>'kind'='expired_checkout' AND v->>'status'='expired' AND source.status='FAILED' AND source.error_code='APP_BILLING_CHECKOUT_EXPIRED')
      OR (result->>'kind'='completed_checkout' AND v->>'status'='complete' AND source.status='APPLIED' AND source.applied_at IS NOT NULL
        AND result->>'subscriptionId'=source.result_subscription_id::text AND (result->>'subscriptionRevision')::bigint=source.result_subscription_revision
        AND EXISTS(SELECT 1 FROM billing_subscription_revisions rev WHERE rev.subscription_id=source.result_subscription_id AND rev.revision=source.result_subscription_revision
          AND rev.organization_id=command.organization_id AND rev.billing_scope_id=command.billing_scope_id AND rev.merchant_key=command.merchant_key
          AND rev.provider_environment=CASE WHEN command.livemode THEN 'live' ELSE 'test' END AND rev.provider_object_digest=source.provider_response_digest
          AND rev.stripe_subscription_id=v->>'subscriptionId' AND rev.stripe_customer_id=v->>'customerId'))),false);
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('052bf0263b10f36f05f47f0476bca21dc2e61a444fdd99457dcd7460e9acc6ef', 1796083200098);
-- apply 0472_app_billing_checkout_cleanup_evidence
-- Only the existing execution and canonical deletion phase may accept a new retained Checkout observation.
CREATE OR REPLACE FUNCTION guard_app_billing_checkout_cleanup_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e jsonb:=NEW.provider_result->'checkoutEvidence'; r record; p record; source record; sc record; decision record;
BEGIN
  IF e IS NOT NULL AND NOT COALESCE(NEW.kind='expire_checkout' AND NEW.request_payload->>'domain'='account_deletion' AND NEW.request_payload->>'action'='expire_checkout' AND NEW.status='SUCCEEDED',false)
    THEN RAISE EXCEPTION 'Checkout evidence requires its original succeeded cleanup command'; END IF;
  IF NEW.request_payload->>'domain' IS DISTINCT FROM 'account_deletion' OR NEW.request_payload->>'action' IS DISTINCT FROM 'expire_checkout' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.status='SUCCEEDED' THEN
    IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Checkout cleanup completion is immutable'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM 'SUCCEEDED' THEN RETURN NEW; END IF;
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'Checkout evidence requires an existing execution lease'; END IF;
  SELECT * INTO source FROM billing_subscription_commands WHERE id::text=NEW.request_payload->>'sourceCommandId';
  SELECT * INTO r FROM account_deletion_requests WHERE id::text=NEW.request_payload->>'requestId' FOR SHARE;
  SELECT * INTO p FROM account_deletion_phase_receipts WHERE id::text=NEW.request_payload->>'phaseReceiptId' AND request_id=r.id FOR SHARE;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=NEW.billing_scope_id;
  IF NOT COALESCE(OLD.status='OUTCOME_UNKNOWN' AND OLD.provider_result IS NULL
    AND OLD.lease_token IS NOT NULL AND isfinite(OLD.lease_expires_at) AND OLD.lease_expires_at>clock_timestamp()
    AND e->>'leaseToken'=OLD.lease_token::text AND (e->>'commandRevision')::bigint=OLD.state_revision
    AND (e->>'executionGeneration')::bigint=OLD.execution_generation AND NEW.execution_generation=OLD.execution_generation
    AND (e->>'sourceRevision')::bigint=source.state_revision AND NEW.provider_started_at=OLD.provider_started_at
    AND app_billing_checkout_cleanup_receipt_valid(NEW)
    AND r.user_id=source.requested_by_user_id AND r.status='processing' AND r.irreversible_at IS NOT NULL
    AND r.request_digest=NEW.request_payload->>'requestDigest' AND r.lifecycle_revision=(NEW.request_payload->>'lifecycleRevision')::bigint
    AND p.phase='stripe' AND p.status IN('leased','calling','reconciling') AND p.lease_generation=(e->>'phaseGeneration')::bigint
    AND p.lease_generation>=(NEW.request_payload->>'initiatingPhaseGeneration')::bigint
    AND isfinite(p.lease_expires_at) AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()
    AND EXISTS(SELECT 1 FROM users u JOIN organizations org ON org.id=r.organization_id WHERE u.id=r.user_id
      AND u.account_lifecycle_state='deletion_irreversible' AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision
      AND org.account_lifecycle_state='deletion_irreversible' AND org.account_deletion_request_id=r.id AND org.account_lifecycle_revision=r.lifecycle_revision),false)
    THEN RAISE EXCEPTION 'Checkout cleanup requires retained observation and current source execution authority'; END IF;
  IF NEW.provider_result->>'kind'='completed_checkout' THEN
    SELECT * INTO decision FROM app_billing_deletion_dispositions WHERE request_id=r.id AND scope_id=sc.id;
    IF NOT COALESCE(decision.request_digest=r.request_digest AND decision.lifecycle_revision=r.lifecycle_revision
      AND decision.phase_receipt_id=p.id AND decision.phase_generation=p.lease_generation AND decision.merchant_id=NEW.merchant_id
      AND decision.provider_account_key=NEW.merchant_key AND decision.livemode=NEW.livemode
      AND ((decision.disposition='close' AND sc.fenced_at IS NOT NULL) OR (decision.disposition='retain_shared' AND sc.organization_id<>r.organization_id
        AND NOT EXISTS(SELECT 1 FROM app_billing_deletion_dispositions d WHERE d.scope_id=sc.id AND d.disposition='close')
        AND EXISTS(SELECT 1 FROM app_billing_members m JOIN users u ON u.id=m.user_id WHERE m.billing_account_id=sc.billing_account_id AND m.app_id=sc.app_id
          AND m.role='administrator' AND m.revoked_at IS NULL AND (m.livemode IS NULL OR m.livemode=sc.livemode) AND u.id<>r.user_id
          AND u.is_active AND u.deleted_at IS NULL AND u.account_lifecycle_state='active' AND u.auth_fenced_at IS NULL
          AND (u.expires_at IS NULL OR (isfinite(u.expires_at) AND (u.expires_at AT TIME ZONE 'UTC')>clock_timestamp()))))),false)
      THEN RAISE EXCEPTION 'Completed Checkout cleanup requires current disposition and survivor proof'; END IF;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER app_billing_checkout_cleanup_evidence_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_app_billing_checkout_cleanup_evidence();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('b58da0b74ff5945321b3b276e490cb732f9da75a5508ad21daf95ca87a787e46', 1796083200099);
-- apply 0473_ai_billing_records_nullable_usage_record
ALTER TABLE "ai_billing_records" ALTER COLUMN "usage_record_id" DROP NOT NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('a23b558b7cf41b8dd42484f15836557bd863720c343226c4444e3b5b63296629', 1796083200100);
-- apply 0474_normalize_legacy_null_phone_verified
-- Migration 0051 projected phone_verified NULL for phoneless identities while
-- canonical users stayed false, so strict projection parity rejected otherwise
-- coherent accounts. Normalize only phoneless NULL rows to false; rows with a
-- phone number or a non-null flag are untouched.
UPDATE "user_identities"
SET "phone_verified" = FALSE, "updated_at" = NOW()
WHERE "phone_number" IS NULL AND "phone_verified" IS NULL;
;
UPDATE "users"
SET "phone_verified" = FALSE, "updated_at" = NOW()
WHERE "phone_number" IS NULL AND "phone_verified" IS NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('5c8eff1d303fc2c79de891891fd30bfd4d92c0a67841f30c76c6e0a7c6ea1b4a', 1796083200101);
-- apply 0478_agent_sandbox_retained_runtime
-- An unpaid stop whose current backup cannot be captured retains the exact
-- stopped container in place instead of removing the only copy of its state.
ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "retained_runtime" jsonb;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_sandboxes_retained_runtime_object' AND conrelid = 'agent_sandboxes'::regclass) THEN
    ALTER TABLE "agent_sandboxes"
      ADD CONSTRAINT "agent_sandboxes_retained_runtime_object"
      CHECK ("retained_runtime" IS NULL OR jsonb_typeof("retained_runtime") = 'object');
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('079d8c6fc55f81633eba73e7fe8584d493dd420ccf291be94f4607fd5fba92e9', 1796083200102);
-- apply 0479_organization_payment_reversal_holds
-- A lost chargeback is a final payment reversal. It places a durable
-- organization hold that fails new paid admission closed until an explicit,
-- audited release.
CREATE TABLE IF NOT EXISTS "organization_payment_reversal_holds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "reason" text NOT NULL,
  "stripe_dispute_id" text NOT NULL,
  "stripe_charge_id" text,
  "stripe_payment_intent_id" text,
  "amount_cents" bigint,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "released_at" timestamp with time zone,
  "released_by" text,
  "release_reason" text,
  CONSTRAINT "organization_payment_reversal_holds_reason_check"
    CHECK ("reason" IN ('chargeback_lost')),
  CONSTRAINT "organization_payment_reversal_holds_release_shape_check"
    CHECK (("released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL)
      OR ("released_at" IS NOT NULL AND "released_by" IS NOT NULL AND "release_reason" IS NOT NULL))
);
;
CREATE UNIQUE INDEX IF NOT EXISTS "organization_payment_reversal_holds_dispute_unique"
  ON "organization_payment_reversal_holds" ("stripe_dispute_id");
;
CREATE INDEX IF NOT EXISTS "organization_payment_reversal_holds_active_idx"
  ON "organization_payment_reversal_holds" ("organization_id")
  WHERE "released_at" IS NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('886e44aebb3fe4fbe37b9d9572ffe4d95f0ecd9a6930feff89a7b0f95196fbaa', 1796083200103);
-- apply 0480_personal_dedicated_fallbacks
-- Durable Dedicated-to-Shared fallback transitions for personal agents. Each
-- withdrawal gets a new generation and a separately scoped Shared journal.
CREATE TABLE IF NOT EXISTS "personal_dedicated_fallbacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "source_agent_id" text NOT NULL,
  "dedicated_agent_id" uuid NOT NULL,
  "generation" integer NOT NULL,
  "state" text NOT NULL,
  "reason" text NOT NULL,
  "stop_intent_id" uuid NOT NULL,
  "journal_room_id" text NOT NULL,
  "activated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "recovered_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "personal_dedicated_fallbacks_state_check"
    CHECK (("state" = 'shared_active' AND "recovered_at" IS NULL)
      OR ("state" = 'recovered' AND "recovered_at" IS NOT NULL)),
  CONSTRAINT "personal_dedicated_fallbacks_reason_check"
    CHECK ("reason" IN ('billing_suspended')),
  CONSTRAINT "personal_dedicated_fallbacks_generation_check"
    CHECK ("generation" >= 1)
);
;
CREATE UNIQUE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_generation_unique"
  ON "personal_dedicated_fallbacks" ("organization_id", "user_id", "source_agent_id", "generation");
;
CREATE UNIQUE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_active_unique"
  ON "personal_dedicated_fallbacks" ("organization_id", "user_id", "source_agent_id")
  WHERE "state" = 'shared_active';
;
CREATE UNIQUE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_journal_unique"
  ON "personal_dedicated_fallbacks" ("journal_room_id");
;
CREATE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_dedicated_idx"
  ON "personal_dedicated_fallbacks" ("dedicated_agent_id");
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('b223456b532223b893da30cb9694844bc4867bf46af4532b3460433480488c6b', 1796083200104);
-- apply 0481_paid_plan_resource_ceilings
-- Paid Plus/Pro entitlements were projected with null resource ceilings, which
-- the quota policy treats as unavailable, so subscribers could not create any
-- resource. The v1 catalog now declares explicit paid ceilings equal to the
-- Free ceilings (the paid-plan floor); republish them onto existing projections
-- so every stored row matches its derivation.
UPDATE "organization_entitlements"
SET
  "cloud_characters_ceiling" = 5,
  "agent_sandboxes_ceiling" = 5,
  "containers_ceiling" = 1,
  "storage_gib_ceiling" = 5,
  "apps_ceiling" = 25,
  "updated_at" = now()
WHERE "billing_scope_id" IS NULL
  AND "plan_key" IN ('plus_monthly', 'pro_monthly')
  AND "catalog_version" = 'v1'
  AND "cloud_characters_ceiling" IS NULL
  AND "agent_sandboxes_ceiling" IS NULL
  AND "containers_ceiling" IS NULL
  AND "storage_gib_ceiling" IS NULL
  AND "apps_ceiling" IS NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('60428cc49ece630b2e23d061be6b3dfb3807bdf3e21a65e22ea5144e6dd62196', 1796083200105);
-- apply 0482_org_storage_subscription_funding
-- Lets allowance-first subscription funding reservations carry native storage charges.
ALTER TABLE "org_storage_put_operations" ADD COLUMN "funding_reservation_id" uuid;
;
ALTER TABLE "org_storage_put_operations"
  ADD CONSTRAINT "org_storage_put_operations_funding_reservation_fkey"
  FOREIGN KEY ("funding_reservation_id", "organization_id")
  REFERENCES "billing_funding_reservations"("id", "organization_id") ON DELETE RESTRICT;
;
CREATE UNIQUE INDEX "org_storage_put_operations_funding_reservation_uidx"
  ON "org_storage_put_operations"("funding_reservation_id")
  WHERE "funding_reservation_id" IS NOT NULL;
;
ALTER TABLE "org_storage_put_operations" DROP CONSTRAINT "org_storage_put_operations_shape_check";
;
ALTER TABLE "org_storage_put_operations" ADD CONSTRAINT "org_storage_put_operations_shape_check" CHECK (
  "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
  AND "request_digest" ~ '^[0-9a-f]{64}$'
  AND "target_content_sha256" ~ '^[0-9a-f]{64}$'
  AND "state" IN ('prepared','reserved','provider_started','reconciling','committed','refunded')
  AND "source_generation" >= 0 AND "target_generation" = "source_generation" + 1
  AND "source_size_bytes" >= 0 AND "target_size_bytes" > 0
  AND "quota_reserved_bytes" = GREATEST("target_size_bytes" - "source_size_bytes", 0)
  AND "price_usd" >= 0
  AND ("credit_transaction_id" IS NULL OR "funding_reservation_id" IS NULL)
  AND ("funding_reservation_id" IS NULL OR "price_usd" > 0)
  AND ("state" IN ('prepared','reconciling','refunded') OR "price_usd" = 0
    OR "credit_transaction_id" IS NOT NULL OR "funding_reservation_id" IS NOT NULL)
  AND (("lease_token" IS NULL) = ("lease_expires_at" IS NULL))
  AND ("state" <> 'reconciling' OR "lease_token" IS NOT NULL)
  AND ("provider_absence_observed_at" IS NULL OR "state" = 'reconciling')
  AND ("state" <> 'committed' OR (
    "result_etag" IS NOT NULL AND "result_uploaded_at" IS NOT NULL
    AND "response_json" IS NOT NULL AND "completed_at" IS NOT NULL
  ))
  AND ("state" <> 'refunded' OR (
    "response_json" IS NOT NULL AND "completed_at" IS NOT NULL
  ))
);
;
ALTER TABLE "org_storage_read_operations" ADD COLUMN "funding_reservation_id" uuid;
;
ALTER TABLE "org_storage_read_operations"
  ADD CONSTRAINT "org_storage_read_operations_funding_reservation_fkey"
  FOREIGN KEY ("funding_reservation_id", "organization_id")
  REFERENCES "billing_funding_reservations"("id", "organization_id") ON DELETE RESTRICT;
;
CREATE UNIQUE INDEX "org_storage_read_operations_funding_reservation_uidx"
  ON "org_storage_read_operations"("funding_reservation_id")
  WHERE "funding_reservation_id" IS NOT NULL;
;
ALTER TABLE "org_storage_read_operations" DROP CONSTRAINT "org_storage_read_operations_shape_check";
;
ALTER TABLE "org_storage_read_operations" ADD CONSTRAINT "org_storage_read_operations_shape_check" CHECK (
  "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
  AND "request_digest" ~ '^[0-9a-f]{64}$'
  AND "renewal_generation" >= 0
  AND (("renewal_root_id" IS NULL AND "renewal_generation" = 0)
    OR ("renewal_root_id" IS NOT NULL AND "renewal_generation" > 0
      AND "method" = 'presign'))
  AND "method" IN ('get','head','list','presign')
  AND "state" IN ('prepared','provider_succeeded','committed','failed')
  AND "price_usd" >= 0 AND "access_count" >= 0
  AND ("state" <> 'prepared' OR (
    "object_generation" IS NULL AND "provider_key" IS NULL
    AND "result_size_bytes" IS NULL AND "result_content_type" IS NULL
    AND "result_etag" IS NULL AND "response_status" IS NULL
    AND "response_json" IS NULL AND "provider_succeeded_at" IS NULL
    AND "completed_at" IS NULL AND "credit_transaction_id" IS NULL
    AND "funding_reservation_id" IS NULL
    AND "last_access_at" IS NULL AND "access_count" = 0
  ))
  AND ("state" = 'prepared' OR ("response_status" IS NOT NULL AND "response_json" IS NOT NULL))
  AND ("state" NOT IN ('provider_succeeded','committed') OR "provider_succeeded_at" IS NOT NULL)
  AND ("state" NOT IN ('committed','failed') OR "completed_at" IS NOT NULL)
  AND ("state" <> 'provider_succeeded' OR (
    "credit_transaction_id" IS NULL AND "funding_reservation_id" IS NULL
    AND "completed_at" IS NULL
  ))
  AND ("state" = 'committed' OR (
    "credit_transaction_id" IS NULL AND "funding_reservation_id" IS NULL
    AND "last_access_at" IS NULL AND "access_count" = 0
  ))
  AND ("state" <> 'committed' OR (
    ("price_usd" = 0 AND "credit_transaction_id" IS NULL AND "funding_reservation_id" IS NULL)
    OR ("price_usd" > 0 AND (
      ("credit_transaction_id" IS NOT NULL AND "funding_reservation_id" IS NULL)
      OR ("credit_transaction_id" IS NULL AND "funding_reservation_id" IS NOT NULL)
    ))
  ))
  AND ("method" = 'list' OR "state" IN ('prepared','failed') OR "object_id" IS NOT NULL)
  AND ("provider_key" IS NULL OR "object_generation" IS NOT NULL)
  AND (("capability_id" IS NULL AND "capability_host" IS NULL
    AND "capability_issued_at" IS NULL AND "capability_expires_at" IS NULL)
    OR ("method" = 'presign' AND "capability_id" IS NOT NULL
      AND "capability_host" IS NOT NULL AND "capability_issued_at" IS NOT NULL
      AND "capability_expires_at" > "capability_issued_at"))
  AND ("capability_revoked_at" IS NULL OR "capability_id" IS NOT NULL)
  AND ("last_access_at" IS NULL OR "access_count" > 0)
);
;
CREATE OR REPLACE FUNCTION "org_storage_read_insert_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'prepared' THEN
    RAISE EXCEPTION 'storage read must start prepared' USING ERRCODE = '23514';
  END IF;
  IF NEW.object_generation IS NOT NULL OR NEW.provider_key IS NOT NULL
      OR NEW.result_size_bytes IS NOT NULL OR NEW.result_content_type IS NOT NULL
      OR NEW.result_etag IS NOT NULL OR NEW.response_status IS NOT NULL
      OR NEW.response_json IS NOT NULL OR NEW.credit_transaction_id IS NOT NULL
      OR NEW.funding_reservation_id IS NOT NULL
      OR NEW.provider_succeeded_at IS NOT NULL OR NEW.completed_at IS NOT NULL
      OR NEW.capability_revoked_at IS NOT NULL OR NEW.last_access_at IS NOT NULL
      OR NEW.access_count <> 0 THEN
    RAISE EXCEPTION 'storage read birth result authority must be empty'
      USING ERRCODE = '23514';
  END IF;
  -- Serialize request creation against tenant reassignment. The user row is
  -- always locked before the read receipt exists, while later settlement only
  -- locks the immutable receipt and organization ledger.
  PERFORM 1 FROM users
    WHERE id = NEW.user_id AND organization_id = NEW.organization_id
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'storage read actor tenant mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.renewal_root_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM org_storage_read_operations root
    WHERE root.id = NEW.renewal_root_id
      AND root.organization_id = NEW.organization_id
      AND root.user_id = NEW.user_id
      AND root.method = 'presign'
      AND root.renewal_root_id IS NULL
      AND root.renewal_generation = 0
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'storage read renewal root mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
;
CREATE OR REPLACE FUNCTION "org_storage_read_operation_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.organization_id, NEW.user_id, NEW.idempotency_key_hash,
      NEW.request_digest, NEW.renewal_root_id, NEW.renewal_generation,
      NEW.method, NEW.price_usd,
      NEW.capability_id, NEW.capability_host, NEW.capability_issued_at,
      NEW.capability_expires_at, NEW.retain_until)
    IS DISTINCT FROM
    ROW(OLD.organization_id, OLD.user_id, OLD.idempotency_key_hash,
      OLD.request_digest, OLD.renewal_root_id, OLD.renewal_generation,
      OLD.method, OLD.price_usd,
      OLD.capability_id, OLD.capability_host, OLD.capability_issued_at,
      OLD.capability_expires_at, OLD.retain_until) THEN
    RAISE EXCEPTION 'storage read request authority is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> NEW.state AND NOT (
    (OLD.state = 'prepared' AND NEW.state IN ('provider_succeeded','failed'))
    OR (OLD.state = 'provider_succeeded' AND NEW.state IN ('committed','failed'))
  ) THEN
    RAISE EXCEPTION 'invalid storage read state transition' USING ERRCODE = '23514';
  END IF;
  IF NEW.credit_transaction_id IS DISTINCT FROM OLD.credit_transaction_id
      AND NOT (OLD.state = 'provider_succeeded' AND NEW.state = 'committed'
        AND NEW.price_usd > 0 AND NEW.credit_transaction_id IS NOT NULL) THEN
    RAISE EXCEPTION 'storage read debit attaches only at paid commit' USING ERRCODE = '23514';
  END IF;
  IF NEW.funding_reservation_id IS DISTINCT FROM OLD.funding_reservation_id
      AND NOT (OLD.state = 'provider_succeeded' AND NEW.state = 'committed'
        AND NEW.price_usd > 0 AND NEW.funding_reservation_id IS NOT NULL) THEN
    RAISE EXCEPTION 'storage read funding attaches only at paid commit' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'prepared' AND ROW(NEW.object_id, NEW.object_generation,
      NEW.provider_key, NEW.result_size_bytes, NEW.result_content_type,
      NEW.result_etag, NEW.provider_succeeded_at)
    IS DISTINCT FROM
    ROW(OLD.object_id, OLD.object_generation, OLD.provider_key,
      OLD.result_size_bytes, OLD.result_content_type, OLD.result_etag,
      OLD.provider_succeeded_at) THEN
    RAISE EXCEPTION 'storage read result authority is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'prepared'
      AND ROW(NEW.response_status, NEW.response_json) IS DISTINCT FROM
        ROW(OLD.response_status, OLD.response_json)
      AND NOT (OLD.state = 'provider_succeeded' AND NEW.state = 'failed'
        AND ((NEW.response_status = 402
          AND NEW.response_json = '{"error":"Insufficient credits"}')
          OR (OLD.method = 'presign' AND NEW.response_status = 409
            AND NEW.response_json IN ('{"error":"Capability expired before settlement"}',
              '{"error":"Capability revoked before settlement"}')))) THEN
    RAISE EXCEPTION 'storage read response authority is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IN ('committed','failed') AND ROW(NEW.response_status,
      NEW.response_json, NEW.credit_transaction_id, NEW.funding_reservation_id,
      NEW.completed_at)
    IS DISTINCT FROM ROW(OLD.response_status, OLD.response_json,
      OLD.credit_transaction_id, OLD.funding_reservation_id, OLD.completed_at) THEN
    RAISE EXCEPTION 'terminal storage read receipt is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.capability_revoked_at IS NOT NULL
      AND NEW.capability_revoked_at IS DISTINCT FROM OLD.capability_revoked_at THEN
    RAISE EXCEPTION 'storage read revocation is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.credit_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM credit_transactions c
    WHERE c.id = NEW.credit_transaction_id
      AND c.organization_id = NEW.organization_id AND c.user_id = NEW.user_id
      AND c.type = 'debit' AND c.amount = -NEW.price_usd AND c.settled_at IS NOT NULL
      AND c.metadata->>'settlement_marker' = 'storage_read_receipt_v2'
      AND c.metadata->>'storage_read_operation_id' = NEW.id::text
      AND c.metadata->>'request_digest' = NEW.request_digest
      AND c.metadata->>'method' = NEW.method
      AND c.metadata->>'price_usd' = NEW.price_usd::text
  ) THEN
    RAISE EXCEPTION 'storage read credit authority mismatch' USING ERRCODE = '23514';
  END IF;
  IF NEW.funding_reservation_id IS NOT NULL
      AND NEW.funding_reservation_id IS DISTINCT FROM OLD.funding_reservation_id
      AND NOT EXISTS (
    SELECT 1 FROM billing_funding_reservations r
    WHERE r.id = NEW.funding_reservation_id
      AND r.organization_id = NEW.organization_id
      AND r.logical_operation_id = 'storage.read:' || NEW.id::text
      AND r.funding_class = 'allowance_eligible'
      AND r.status = 'finalized'
      AND r.requested_amount = NEW.price_usd
  ) THEN
    RAISE EXCEPTION 'storage read funding authority mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('51153c5ea9012af07d3cc7588655d50930dbc1602f55bb321f0067e26328a7fd', 1796083200106);
-- apply 0483_container_billing_funding_reservations
-- Subscription-funded container charges are receipted by their finalized
-- allowance-first funding reservation. Earnings converted under the
-- pay-as-you-go toggle keep their own purchased-credit debit row, so a funded
-- receipt may carry both identifiers.
ALTER TABLE "container_billing_records" ADD COLUMN IF NOT EXISTS "funding_reservation_id" uuid;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='container_billing_records'::regclass AND conname='container_billing_records_funding_reservation_tenant_fk') THEN
    ALTER TABLE "container_billing_records" ADD CONSTRAINT "container_billing_records_funding_reservation_tenant_fk" FOREIGN KEY ("funding_reservation_id","organization_id") REFERENCES "public"."billing_funding_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;
;
CREATE UNIQUE INDEX IF NOT EXISTS "container_billing_records_funding_reservation_idx" ON "container_billing_records" USING btree ("funding_reservation_id") WHERE "container_billing_records"."funding_reservation_id" IS NOT NULL;
;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='container_billing_records'::regclass AND conname='container_billing_records_success_ledger_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%funding_reservation_id%'
  ) THEN
    ALTER TABLE "container_billing_records" DROP CONSTRAINT "container_billing_records_success_ledger_check";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='container_billing_records'::regclass AND conname='container_billing_records_success_ledger_check') THEN
    ALTER TABLE "container_billing_records" ADD CONSTRAINT "container_billing_records_success_ledger_check" CHECK ("container_billing_records"."status" <> 'success' OR "container_billing_records"."credit_transaction_id" IS NOT NULL OR "container_billing_records"."funding_reservation_id" IS NOT NULL);
  END IF;
END $$;
;
CREATE OR REPLACE FUNCTION guard_container_funded_billing_receipt() RETURNS trigger AS $$
BEGIN
  IF NEW.funding_reservation_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status <> 'success' OR NOT EXISTS (
    SELECT 1 FROM billing_funding_reservations r
    WHERE r.id=NEW.funding_reservation_id AND r.organization_id=NEW.organization_id
      AND r.funding_class='allowance_eligible'
      AND r.status='finalized' AND r.uncollected_overage_amount=0
      AND NEW.amount>=(SELECT sum(a.finalized_amount) FROM billing_funding_allocations a
        WHERE a.reservation_id=r.id AND a.organization_id=r.organization_id)
  ) THEN
    RAISE EXCEPTION 'container billing receipt must cover its finalized funding reservation'
      USING ERRCODE='23514', CONSTRAINT='container_billing_records_funding_reservation_guard';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='container_billing_records'::regclass AND tgname='container_billing_records_funding_reservation_guard') THEN
    CREATE TRIGGER container_billing_records_funding_reservation_guard BEFORE INSERT ON container_billing_records
      FOR EACH ROW EXECUTE FUNCTION guard_container_funded_billing_receipt();
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('4978f6562ac73087e3df847c8091a45b0b423cd84f165ca4367953db1b69e082', 1796083200107);
-- apply 0484_agent_billing_funding_reservations
-- Subscription-funded legacy agent charges are receipted by their finalized
-- allowance-first funding reservation instead of a purchased-credit debit row.
ALTER TABLE "agent_billing_records" ADD COLUMN IF NOT EXISTS "funding_reservation_id" uuid;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_funding_reservation_tenant_fk') THEN
    ALTER TABLE "agent_billing_records" ADD CONSTRAINT "agent_billing_records_funding_reservation_tenant_fk" FOREIGN KEY ("funding_reservation_id","organization_id") REFERENCES "public"."billing_funding_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;
;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_billing_records_funding_reservation_idx" ON "agent_billing_records" USING btree ("funding_reservation_id") WHERE "agent_billing_records"."funding_reservation_id" IS NOT NULL;
;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_funding_source_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%funding_reservation_id%'
  ) THEN
    ALTER TABLE "agent_billing_records" DROP CONSTRAINT "agent_billing_records_funding_source_check";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_funding_source_check') THEN
    ALTER TABLE "agent_billing_records" ADD CONSTRAINT "agent_billing_records_funding_source_check" CHECK (num_nonnulls("agent_billing_records"."credit_transaction_id", "agent_billing_records"."compute_funding_id", "agent_billing_records"."funding_reservation_id") = 1);
  END IF;
END $$;
;
CREATE OR REPLACE FUNCTION guard_agent_reserved_billing_receipt() RETURNS trigger AS $$
BEGIN
  IF NEW.funding_reservation_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM billing_funding_reservations r
    WHERE r.id=NEW.funding_reservation_id AND r.organization_id=NEW.organization_id
      AND r.funding_class='allowance_eligible'
      AND r.status='finalized' AND r.uncollected_overage_amount=0
      AND NEW.amount=(SELECT sum(a.finalized_amount) FROM billing_funding_allocations a
        WHERE a.reservation_id=r.id AND a.organization_id=r.organization_id)
  ) THEN
    RAISE EXCEPTION 'agent billing receipt must match its finalized funding reservation'
      USING ERRCODE='23514', CONSTRAINT='agent_billing_records_funding_reservation_guard';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='agent_billing_records'::regclass AND tgname='agent_billing_records_funding_reservation_guard') THEN
    CREATE TRIGGER agent_billing_records_funding_reservation_guard BEFORE INSERT ON agent_billing_records
      FOR EACH ROW EXECUTE FUNCTION guard_agent_reserved_billing_receipt();
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('61c2eea79fd2754e04a3fc9249c5663324fc201a9c313c1d7614635e3587cb90', 1796083200108);
-- apply 0490_personal_dedicated_fallback_entitlement
-- Entitlement-driven Dedicated-to-Shared transitions (#25146). A lapsed paid
-- plan (payment failed past grace, or ended/canceled at period end) withdraws
-- Dedicated access through the same durable interval row as a confirmed
-- unfunded billing stop. Every transition advances a revision fence; the row
-- records the entitlement projection revision it acted on, the preserved
-- runtime's retention deadline, the suspend/resume effects and the receipt of
-- the Shared interval reconciled back into Dedicated.
ALTER TABLE "personal_dedicated_fallbacks" ALTER COLUMN "stop_intent_id" DROP NOT NULL;
;
ALTER TABLE "personal_dedicated_fallbacks"
  ADD COLUMN IF NOT EXISTS "revision" bigint DEFAULT 1 NOT NULL,
  ADD COLUMN IF NOT EXISTS "entitlement_revision" bigint,
  ADD COLUMN IF NOT EXISTS "recovery_entitlement_revision" bigint,
  ADD COLUMN IF NOT EXISTS "retain_until" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "suspend_job_id" uuid,
  ADD COLUMN IF NOT EXISTS "resume_job_id" uuid,
  ADD COLUMN IF NOT EXISTS "recovery_requested_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "reconciled_message_count" integer,
  ADD COLUMN IF NOT EXISTS "reconciled_inserted_count" integer;
;
ALTER TABLE "personal_dedicated_fallbacks" DROP CONSTRAINT IF EXISTS "personal_dedicated_fallbacks_state_check";
;
ALTER TABLE "personal_dedicated_fallbacks" ADD CONSTRAINT "personal_dedicated_fallbacks_state_check"
  CHECK (("state" IN ('fallback_pending', 'shared_active') AND "recovered_at" IS NULL AND "recovery_requested_at" IS NULL)
    OR ("state" = 'recovery_pending' AND "recovered_at" IS NULL AND "recovery_requested_at" IS NOT NULL)
    OR ("state" = 'recovered' AND "recovered_at" IS NOT NULL));
;
ALTER TABLE "personal_dedicated_fallbacks" DROP CONSTRAINT IF EXISTS "personal_dedicated_fallbacks_reason_check";
;
ALTER TABLE "personal_dedicated_fallbacks" ADD CONSTRAINT "personal_dedicated_fallbacks_reason_check"
  CHECK (("reason" = 'billing_suspended' AND "stop_intent_id" IS NOT NULL)
    OR ("reason" IN ('subscription_payment_failed', 'subscription_ended')
      AND "entitlement_revision" IS NOT NULL AND "retain_until" IS NOT NULL));
;
ALTER TABLE "personal_dedicated_fallbacks" DROP CONSTRAINT IF EXISTS "personal_dedicated_fallbacks_revision_check";
;
ALTER TABLE "personal_dedicated_fallbacks" ADD CONSTRAINT "personal_dedicated_fallbacks_revision_check"
  CHECK ("revision" >= 1
    AND ("reconciled_message_count" IS NULL OR "reconciled_message_count" >= 0)
    AND ("reconciled_inserted_count" IS NULL OR "reconciled_inserted_count" >= 0));
;
DROP INDEX IF EXISTS "personal_dedicated_fallbacks_active_unique";
;
CREATE UNIQUE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_open_unique"
  ON "personal_dedicated_fallbacks" ("organization_id", "user_id", "source_agent_id")
  WHERE "state" <> 'recovered';
;
CREATE INDEX IF NOT EXISTS "personal_dedicated_fallbacks_open_dedicated_idx"
  ON "personal_dedicated_fallbacks" ("dedicated_agent_id", "state")
  WHERE "state" <> 'recovered';
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('349d37d5b6e73e71d45b65616de0c9f7d73233e805130bbb2dcba5bdc5362d90', 1796083200113);
-- apply 0491_allowance_advances_balance_revision
-- Platform subscription allowance changes advance the organization balance
-- revision. Worker inference admission fences subscriber funding capacity
-- (purchased credit plus spendable allowance) by this revision, so an
-- allowance grant, reserve, release, or expiry must be observable as newer
-- even when the purchased credit balance itself did not change.
CREATE OR REPLACE FUNCTION advance_organization_revision_for_allowance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE organizations
  SET balance_revision = nextval('organization_balance_revision_seq')
  WHERE id = NEW.organization_id;
  RETURN NULL;
END;
$$;
;
DROP TRIGGER IF EXISTS subscription_allowance_transactions_balance_revision_trigger ON subscription_allowance_transactions;
;
CREATE TRIGGER subscription_allowance_transactions_balance_revision_trigger
AFTER INSERT ON subscription_allowance_transactions
FOR EACH ROW
WHEN (NEW.billing_scope_id IS NULL)
EXECUTE FUNCTION advance_organization_revision_for_allowance();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('5f6bd5a4259f786395a92ab7b0c4e789fbce16ac209c15a3f0e3d9e6d429b84b', 1796083200114);
-- apply 0493_zero_collected_inference_receipts
-- Preserve completed zero-collected funding outcomes without permitting zero-value live holds.
ALTER TABLE "billing_funding_reservations"
  DROP CONSTRAINT "billing_funding_reservations_amount_check";
;
ALTER TABLE "billing_funding_reservations"
  ADD CONSTRAINT "billing_funding_reservations_amount_check"
  CHECK (reserved_amount = requested_amount AND
    (requested_amount > 0 OR (requested_amount = 0 AND status = 'finalized')));
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('5168655751f6645bb327e7cd4af241944bc37ba8aaef06176bdeb76cb533b3b8', 1796083200115);
-- apply 0494_payment_reversal_shortfall_holds
-- #22930 Decision A: a Stripe reversal (refund or dispute clawback) that leaves
-- an unrecovered shortfall places a billing hold carrying that outstanding
-- amount. It clears on dispute reinstatement or once repayment covers it.
-- A lost dispute alone no longer holds an organization that owes nothing.
ALTER TABLE "organization_payment_reversal_holds" ALTER COLUMN "stripe_dispute_id" DROP NOT NULL;
;
ALTER TABLE "organization_payment_reversal_holds" ADD COLUMN IF NOT EXISTS "clawback_transaction_id" uuid REFERENCES "credit_transactions"("id");
;
ALTER TABLE "organization_payment_reversal_holds" ADD COLUMN IF NOT EXISTS "shortfall_usd" numeric(16, 6);
;
ALTER TABLE "organization_payment_reversal_holds" ADD COLUMN IF NOT EXISTS "outstanding_usd" numeric(16, 6);
;
ALTER TABLE "organization_payment_reversal_holds" DROP CONSTRAINT IF EXISTS "organization_payment_reversal_holds_reason_check";
;
ALTER TABLE "organization_payment_reversal_holds" ADD CONSTRAINT "organization_payment_reversal_holds_reason_check"
  CHECK ("reason" IN ('chargeback_lost', 'reversal_shortfall'));
;
ALTER TABLE "organization_payment_reversal_holds" DROP CONSTRAINT IF EXISTS "organization_payment_reversal_holds_source_shape_check";
;
ALTER TABLE "organization_payment_reversal_holds" ADD CONSTRAINT "organization_payment_reversal_holds_source_shape_check"
  CHECK (
    ("reason" = 'chargeback_lost' AND "stripe_dispute_id" IS NOT NULL
      AND "clawback_transaction_id" IS NULL AND "shortfall_usd" IS NULL AND "outstanding_usd" IS NULL)
    OR ("reason" = 'reversal_shortfall' AND "clawback_transaction_id" IS NOT NULL
      AND "shortfall_usd" > 0 AND "outstanding_usd" >= 0 AND "outstanding_usd" <= "shortfall_usd")
  );
;
CREATE UNIQUE INDEX IF NOT EXISTS "organization_payment_reversal_holds_clawback_unique"
  ON "organization_payment_reversal_holds" ("clawback_transaction_id");
;
-- Carry a still-owed lost-dispute shortfall into the new hold before the
-- superseded lost-dispute hold is released, so no unpaid debt is dropped.
INSERT INTO "organization_payment_reversal_holds" (
  "organization_id", "reason", "clawback_transaction_id", "shortfall_usd", "outstanding_usd",
  "stripe_charge_id", "stripe_payment_intent_id", "amount_cents"
)
SELECT
  hold."organization_id", 'reversal_shortfall', clawback."id",
  (clawback."metadata"->>'unrecovered_clawback_usd')::numeric(16, 6),
  (clawback."metadata"->>'unrecovered_clawback_usd')::numeric(16, 6),
  hold."stripe_charge_id", hold."stripe_payment_intent_id", hold."amount_cents"
FROM "organization_payment_reversal_holds" AS hold
JOIN "credit_transactions" AS clawback
  ON clawback."stripe_payment_intent_id" = 'stripe:dispute:' || hold."stripe_dispute_id"
  AND clawback."type" = 'clawback'
  AND clawback."organization_id" = hold."organization_id"
WHERE hold."reason" = 'chargeback_lost'
  AND hold."released_at" IS NULL
  AND clawback."metadata"->>'unrecovered_clawback_usd' ~ '^[0-9]+(\.[0-9]+)?$'
  AND (clawback."metadata"->>'unrecovered_clawback_usd')::numeric(16, 6) > 0
ON CONFLICT DO NOTHING;
;
UPDATE "organization_payment_reversal_holds"
SET "released_at" = now(),
  "released_by" = 'migration:0494_payment_reversal_shortfall_holds',
  "release_reason" = 'Superseded by the ratified reversal-shortfall billing hold (#22930 Decision A)'
WHERE "reason" = 'chargeback_lost' AND "released_at" IS NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('3ccb399c6ec466335f182bfc66200cda61d53454e749afb97da8731b8c1f49e8', 1796083200116);
-- apply 0495_agent_backup_restore_serving_state
-- #20732: the restore coordinator carries a restore past quarantine creation.
-- Each post-create phase records write-once evidence (private roots, sealed
-- candidate, committed generation, previous route, serving ports, signed
-- attestation and probes) so a lost response replays instead of re-executing.
-- The route publication time is the single point after which rollback no
-- longer restores the previous runtime.
ALTER TABLE "agent_backup_restore_operations" ADD COLUMN IF NOT EXISTS "serving_state" jsonb;
;
ALTER TABLE "agent_backup_restore_operations" ADD COLUMN IF NOT EXISTS "route_published_at" timestamp with time zone;
;
ALTER TABLE "agent_backup_restore_operations" DROP CONSTRAINT IF EXISTS "agent_backup_restore_operations_serving_state_check";
;
ALTER TABLE "agent_backup_restore_operations" ADD CONSTRAINT "agent_backup_restore_operations_serving_state_check"
  CHECK ((
    ("serving_state" IS NULL OR jsonb_typeof("serving_state") = 'object')
    AND ("route_published_at" IS NULL
      OR "phase" IN ('published', 'finalized', 'failed_retryable', 'failed_terminal'))
  ) IS TRUE);
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('ac54ef023c15e18243a9d1ec112f0f15d18478e4eca3e6ce4dfa954da0a56363', 1796083200117);
-- apply 0500_retire_creator_monetization
-- #22961 / #23022: creator monetization is retired (owner decision, see #22957).
-- Cloud billing is subscription (Plus/Pro) plus pay-as-you-go; creators no
-- longer accrue earnings and every creator payout rail is closed. The
-- affiliate program continues: affiliate earnings credited after the
-- retirement instant remain payable through the affiliate-only payout path.
--
-- This migration never deletes or rewrites ledger history. It:
--   1. records every user's unpaid creator balance as a frozen, read-only
--      statement row (available + pending at retirement time);
--   2. stops earnings from silently funding hosting (the pay-as-you-go
--      conversion was an automatic payout of the frozen balance);
--   3. disables agent and app creator monetization (inference markup and
--      purchase share) so buyers stop paying a creator surcharge that no
--      longer accrues to anyone.
-- Frozen balances are settled manually by an operator; nothing here pays out.
-- The retirement instant. Affiliate earnings credited after it stay payable
-- through the affiliate-only payout path; everything before it is frozen.
CREATE TABLE IF NOT EXISTS "creator_monetization_retirement" (
  "id" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "retired_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "creator_monetization_retirement_singleton_check" CHECK ("id")
);
;
INSERT INTO "creator_monetization_retirement" ("id", "retired_at")
VALUES (true, now())
ON CONFLICT ("id") DO NOTHING;
;
CREATE TABLE IF NOT EXISTS "creator_earnings_retirement_statements" (
  -- No foreign keys: the liability record must outlive account deletion.
  "user_id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid,
  "status" text DEFAULT 'frozen' NOT NULL,
  "total_earned_usd" numeric(18, 4) NOT NULL,
  "total_redeemed_usd" numeric(18, 4) NOT NULL,
  "total_converted_to_credits_usd" numeric(18, 4) NOT NULL,
  "available_balance_usd" numeric(18, 4) NOT NULL,
  "pending_redemption_usd" numeric(18, 4) NOT NULL,
  "unpaid_balance_usd" numeric(18, 4) NOT NULL,
  "earned_from_apps_usd" numeric(18, 4) NOT NULL,
  "earned_from_agents_usd" numeric(18, 4) NOT NULL,
  "earned_from_mcps_usd" numeric(18, 4) NOT NULL,
  "earned_from_affiliates_usd" numeric(18, 4) NOT NULL,
  "earned_from_revenue_shares_usd" numeric(18, 4) NOT NULL,
  "frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "settled_at" timestamp with time zone,
  "settlement_reference" text,
  CONSTRAINT "creator_earnings_retirement_statements_status_check"
    CHECK (("status" = 'frozen' AND "settled_at" IS NULL AND "settlement_reference" IS NULL)
      OR ("status" = 'settled_manually' AND "settled_at" IS NOT NULL AND "settlement_reference" IS NOT NULL)),
  CONSTRAINT "creator_earnings_retirement_statements_amounts_check"
    CHECK ("available_balance_usd" >= 0 AND "pending_redemption_usd" >= 0
      AND "unpaid_balance_usd" = "available_balance_usd" + "pending_redemption_usd"
      AND "unpaid_balance_usd" > 0)
);
;
CREATE INDEX IF NOT EXISTS "creator_earnings_retirement_statements_org_idx"
  ON "creator_earnings_retirement_statements" ("organization_id");
;
CREATE INDEX IF NOT EXISTS "creator_earnings_retirement_statements_frozen_idx"
  ON "creator_earnings_retirement_statements" ("status")
  WHERE "status" = 'frozen';
;
INSERT INTO "creator_earnings_retirement_statements" (
  "user_id",
  "organization_id",
  "total_earned_usd",
  "total_redeemed_usd",
  "total_converted_to_credits_usd",
  "available_balance_usd",
  "pending_redemption_usd",
  "unpaid_balance_usd",
  "earned_from_apps_usd",
  "earned_from_agents_usd",
  "earned_from_mcps_usd",
  "earned_from_affiliates_usd",
  "earned_from_revenue_shares_usd"
)
SELECT
  earnings."user_id",
  account."organization_id",
  earnings."total_earned",
  earnings."total_redeemed",
  earnings."total_converted_to_credits",
  earnings."available_balance",
  earnings."total_pending",
  earnings."available_balance" + earnings."total_pending",
  earnings."earned_from_miniapps",
  earnings."earned_from_agents",
  earnings."earned_from_mcps",
  earnings."earned_from_affiliates",
  earnings."earned_from_app_owner_shares" + earnings."earned_from_creator_shares"
FROM "redeemable_earnings" AS earnings
JOIN "users" AS account ON account."id" = earnings."user_id"
WHERE earnings."available_balance" + earnings."total_pending" > 0
ON CONFLICT ("user_id") DO NOTHING;
;
UPDATE "organizations"
  SET "pay_as_you_go_from_earnings" = false
  WHERE "pay_as_you_go_from_earnings" = true;
;
ALTER TABLE "organizations" ALTER COLUMN "pay_as_you_go_from_earnings" SET DEFAULT false;
;
UPDATE "user_characters"
  SET "monetization_enabled" = false
  WHERE "monetization_enabled" = true;
;
UPDATE "apps"
  SET "monetization_enabled" = false
  WHERE "monetization_enabled" = true;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('a85f71b3e12437e6404e73030abb0ccd44dfb7bffeaca7fff28c8c24cb4315d0', 1796083200118);
-- apply 0501_agent_funding_retention
-- #22967: frozen/sleeping retention economics (owner decision, see #22957).
-- When funding stops (a provider-confirmed billing stop after credits run out,
-- or a Plus/Pro plan withdrawn past its grace period), the agent's container
-- state is retained for 30 days at no charge. Deletion notices go out 7 days
-- and 1 day before the deadline. At the deadline the container is removed
-- through the existing sleep lifecycle (durable backup, then container
-- removal) and the latest backup is pinned for 90 more days. Paying before the
-- deadline resumes the same agent through the existing resume paths; this
-- table only tracks the retention clock, its notices and its effects.
CREATE TABLE IF NOT EXISTS "agent_funding_retentions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "stop_intent_id" uuid,
  "fallback_id" uuid,
  "state" text DEFAULT 'retained' NOT NULL,
  "suspended_at" timestamp with time zone NOT NULL,
  "delete_after" timestamp with time zone NOT NULL,
  "notice_7d_sent_at" timestamp with time zone,
  "notice_1d_sent_at" timestamp with time zone,
  "sleep_job_id" uuid,
  "container_deleted_at" timestamp with time zone,
  "retained_backup_id" uuid,
  "backup_retain_until" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "closed_reason" text,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_funding_retentions_reason_check"
    CHECK (("reason" = 'credits_exhausted' AND "stop_intent_id" IS NOT NULL AND "fallback_id" IS NULL)
      OR ("reason" = 'subscription_lapsed' AND "fallback_id" IS NOT NULL AND "stop_intent_id" IS NULL)),
  CONSTRAINT "agent_funding_retentions_state_check"
    CHECK (("state" = 'retained' AND "container_deleted_at" IS NULL AND "closed_at" IS NULL)
      OR ("state" = 'container_deletion_pending' AND "sleep_job_id" IS NOT NULL
        AND "container_deleted_at" IS NULL AND "closed_at" IS NULL)
      OR ("state" = 'container_deleted' AND "container_deleted_at" IS NOT NULL
        AND "backup_retain_until" IS NOT NULL AND "closed_at" IS NULL)
      OR ("state" = 'closed' AND "container_deleted_at" IS NULL AND "closed_at" IS NOT NULL
        AND "closed_reason" IN ('funding_restored', 'agent_changed'))),
  CONSTRAINT "agent_funding_retentions_window_check"
    CHECK ("delete_after" > "suspended_at")
);
;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_funding_retentions_open_agent_unique"
  ON "agent_funding_retentions" ("organization_id", "agent_id")
  WHERE "state" IN ('retained', 'container_deletion_pending');
;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_funding_retentions_stop_intent_unique"
  ON "agent_funding_retentions" ("stop_intent_id")
  WHERE "stop_intent_id" IS NOT NULL;
;
CREATE UNIQUE INDEX IF NOT EXISTS "agent_funding_retentions_fallback_unique"
  ON "agent_funding_retentions" ("fallback_id")
  WHERE "fallback_id" IS NOT NULL;
;
CREATE INDEX IF NOT EXISTS "agent_funding_retentions_due_idx"
  ON "agent_funding_retentions" ("state", "delete_after")
  WHERE "state" IN ('retained', 'container_deletion_pending');
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('2797db5e4ed439e1397cf5c4f6f2e52462d0d44c5361c6e177e2966c9650351b', 1796083200119);
-- apply 0502_free_mcp_listings
-- #22961: paid MCP listings are retired with creator monetization. A listing
-- price would now charge buyers for revenue that reaches no creator, so every
-- listing becomes free. The prior price is kept in metadata for audit; usage
-- history is untouched. The proxy and service also refuse to charge or set a
-- price, so a stale row can never bill a buyer.
UPDATE "user_mcps"
  SET "metadata" = "metadata" || jsonb_build_object(
        'retired_paid_listing', jsonb_build_object(
          'pricing_type', "pricing_type"::text,
          'credits_per_request', "credits_per_request",
          'x402_price_usd', "x402_price_usd",
          'x402_enabled', "x402_enabled",
          'retired_at', now()
        )
      ),
      "pricing_type" = 'free',
      "credits_per_request" = 0,
      "x402_price_usd" = 0,
      "x402_enabled" = false,
      "updated_at" = now()
  WHERE "pricing_type" <> 'free'
     OR COALESCE("credits_per_request", 0) <> 0
     OR COALESCE("x402_price_usd", 0) <> 0
     OR "x402_enabled" = true;
;
ALTER TABLE "user_mcps" ALTER COLUMN "pricing_type" SET DEFAULT 'free';
;
ALTER TABLE "user_mcps" ALTER COLUMN "credits_per_request" SET DEFAULT 0;
;
ALTER TABLE "user_mcps" ALTER COLUMN "x402_price_usd" SET DEFAULT 0;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('9cb69363e083bc3898cc04b444b15b545134fcf1ca7a8a0886a289ca6d5ff1ef', 1796083200120);
-- apply 0503_storage_pricing_catalogue_mirror
-- #22956: the owner ratified the current storage prices. They are now owned by
-- STORAGE_PRICING in packages/cloud/shared/src/lib/constants/pricing.ts, which
-- every storage charge reads. The service_pricing rows for the storage service
-- stay as a read-only mirror for operator listings; this migration pins them to
-- the catalogue, records any correction in the audit log, and drops the
-- "finalize during pricing review" marker. No historical receipt is touched.
WITH catalogue("method", "cost", "description") AS (
  VALUES
    ('put', 0.0001::numeric(18,12), 'PUT attachment object (per-request charge; per-byte charge layered on top)'),
    ('put_per_byte', 0.000000001::numeric(18,12), 'PUT per-byte charge'),
    ('get', 0.00005::numeric(18,12), 'GET attachment object'),
    ('head', 0.00005::numeric(18,12), 'HEAD attachment metadata'),
    ('list', 0.00005::numeric(18,12), 'List attachment objects under a prefix'),
    ('presign', 0.00005::numeric(18,12), 'Mint a short-lived signed URL'),
    ('delete', 0::numeric(18,12), 'DELETE attachment object (free)')
), corrected AS (
  SELECT pricing.id, pricing.method, pricing.cost AS old_cost, catalogue.cost AS new_cost
  FROM "service_pricing" AS pricing
  JOIN catalogue ON catalogue.method = pricing.method
  WHERE pricing.service_id = 'storage' AND pricing.cost <> catalogue.cost
), audit AS (
  INSERT INTO "service_pricing_audit" (
    service_pricing_id, service_id, method, old_cost, new_cost,
    change_type, changed_by, reason
  )
  SELECT id, 'storage', method, old_cost, new_cost,
    'migration_reseed', 'migration:0503',
    'Pin storage mirror to the ratified STORAGE_PRICING catalogue (#22956)'
  FROM corrected
  RETURNING 1
)
INSERT INTO "service_pricing" ("service_id", "method", "cost", "metadata", "is_active", "updated_by")
SELECT 'storage', catalogue.method, catalogue.cost,
  jsonb_build_object('description', catalogue.description, 'catalogue', 'STORAGE_PRICING'),
  true, 'migration:0503'
FROM catalogue
ON CONFLICT ("service_id", "method") DO UPDATE SET
  "cost" = EXCLUDED."cost",
  "metadata" = EXCLUDED."metadata",
  "is_active" = true,
  "updated_by" = EXCLUDED."updated_by",
  "updated_at" = now();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('f438af81f8cedab2c2e666670064e6bac957eb88a0059942ea6736c7b7a1928f', 1796083200121);
-- apply 0504_retire_credit_packs
-- #22963: fixed credit packs are retired. Pay-as-you-go top-ups are any
-- whole-cent amount from $5 to $1,000, and UI quick picks ($10/$25/$50/$100)
-- are plain amounts of that checkout with no bonus credit. Pack rows stay for
-- historical checkout orders, ledger rows and receipts; they are only
-- deactivated so no surface can offer or sell them again.
UPDATE "credit_packs"
SET "is_active" = false, "updated_at" = now()
WHERE "is_active" = true;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('c46ac4c217cfb2c77ee70353086395829d12b9ae2a12c27fa905e411ed5f40d0', 1796083200122);
-- apply 0505_api_key_plan_ceilings
-- #22958: API keys are free, and the number of user-created keys is limited
-- per plan (pay-as-you-go 5, Plus 10, Pro 25). Only keys a user creates
-- through the API-key management surface count; system-provisioned
-- credentials (per-member default keys, the API Explorer key, sign-in keys,
-- app keys and agent-sandbox keys) never do.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "user_created" boolean DEFAULT false NOT NULL;
;
-- Backfill: live keys that were not provisioned by the system are treated as
-- user-created. Organizations already above their ceiling keep every key;
-- they can create another only after dropping below it.
UPDATE "api_keys" AS existing
SET "user_created" = true
WHERE existing."deleted_at" IS NULL
  AND existing."user_created" = false
  AND existing."source_app_id" IS NULL
  AND existing."name" NOT LIKE 'agent-sandbox:%'
  AND existing."name" NOT LIKE '% - App API Key'
  AND existing."name" NOT IN (
    'Default API Key',
    'API Explorer Key',
    'SIWE sign-in',
    'SIWS sign-in',
    'Eliza App Default Key'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "apps" WHERE "apps"."api_key_id" = existing."id"
  );
;
CREATE INDEX IF NOT EXISTS "api_keys_user_created_org_idx"
  ON "api_keys" ("organization_id")
  WHERE "user_created" AND "deleted_at" IS NULL;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('c52d71fe26e229dc6eea4f6d56c14f30454f84eaa5403b3312b0556fc1f35f1b', 1796083200123);
-- apply 0506_pii_scrub_markers_inspection_scope
ALTER TABLE "pii_scrub_markers"
  ADD COLUMN IF NOT EXISTS "inspection_scope" text DEFAULT 'declared_candidates' NOT NULL;
;
ALTER TABLE "pii_scrub_markers"
  ADD COLUMN IF NOT EXISTS "candidate_count" integer DEFAULT 0 NOT NULL;
;
ALTER TABLE "pii_scrub_markers"
  DROP CONSTRAINT IF EXISTS "pii_scrub_markers_inspection_scope_check";
;
ALTER TABLE "pii_scrub_markers"
  ADD CONSTRAINT "pii_scrub_markers_inspection_scope_check"
  CHECK ("inspection_scope" IN ('declared_candidates', 'server_discovery'));
;
CREATE UNIQUE INDEX IF NOT EXISTS "pii_scrub_markers_org_key_scope_idx"
  ON "pii_scrub_markers" ("organization_id", "marker_key", "inspection_scope");
;
DROP INDEX IF EXISTS "pii_scrub_markers_org_key_idx";
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('9258ae0c8620eb2f94dbe06a7583d202763110b5b90ac1a3e1a1433961ae88bf', 1796083200124);
-- apply 0507_user_consents
CREATE TABLE IF NOT EXISTS "user_consents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "purpose" text NOT NULL,
  "granted" boolean NOT NULL,
  "policy_version" text NOT NULL,
  "source" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_consents_purpose_check" CHECK ("purpose" IN ('vision_capture'))
);
;
CREATE INDEX IF NOT EXISTS "user_consents_user_purpose_idx"
  ON "user_consents" ("user_id", "organization_id", "purpose", "recorded_at");
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('cc6ec564f61cf3128809bb6285fa5d9112bc11c35fffd6af82a8c13757c08d46', 1796083200125);
-- apply 0508_app_notification_secret_envelope_v2
-- Field encryption writes coordinate-bound secrets as `enc:v2:` envelopes.
-- Accept both encrypted envelope versions; plaintext is still rejected.
CREATE OR REPLACE FUNCTION guard_app_notification_endpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM apps a WHERE a.id=NEW.app_id AND a.organization_id=NEW.organization_id) THEN
  RAISE EXCEPTION 'Notification endpoint organization must own application';
 END IF;
 IF TG_OP='UPDATE' AND (OLD.id,OLD.app_id,OLD.organization_id,OLD.livemode) IS DISTINCT FROM (NEW.id,NEW.app_id,NEW.organization_id,NEW.livemode) THEN
  RAISE EXCEPTION 'Notification endpoint identity is immutable';
 END IF;
 IF NEW.active_secret IS NOT NULL AND NEW.active_secret NOT LIKE 'enc:v1:%' AND NEW.active_secret NOT LIKE 'enc:v2:%'
  OR NEW.pending_secret IS NOT NULL AND NEW.pending_secret NOT LIKE 'enc:v1:%' AND NEW.pending_secret NOT LIKE 'enc:v2:%' THEN
  RAISE EXCEPTION 'Notification signing keys require encrypted storage';
 END IF;
 RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('715a1ec207f33c0310cfd41bb006f772481956d1ad30eb34faa9e87b1fff920c', 1796083200126);
-- already effective in production: 0509_managed_gmail_operation_receipts
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('64d86e3a03e8ea2aed9e5da3ec96d6c1ecf0cb954521136a4124358fce6d6049', 1796083200127);
-- apply 0510_subscription_renewal_review_receipts
-- Retain reviewed renewal terms independently of legacy organization and app command payloads.
CREATE TABLE billing_subscription_renewal_reviews (
 command_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 payload jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT billing_renewal_review_command_tenant_fk FOREIGN KEY(command_id,organization_id)
  REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT billing_renewal_review_payload_check CHECK ((jsonb_typeof(payload)='object'
  AND payload->>'kind'='renewal_estimate' AND payload->>'termsDigest' ~ '^[a-f0-9]{64}$'
  AND payload->>'expectedSubscriptionRevision' ~ '^[1-9][0-9]*$') IS TRUE)
);
;
CREATE INDEX billing_renewal_review_tenant_idx ON billing_subscription_renewal_reviews(organization_id,command_id);
;
CREATE FUNCTION guard_subscription_renewal_review_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command record;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'Reviewed renewal terms are immutable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO command FROM billing_subscription_commands
 WHERE id=NEW.command_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR command.kind <> 'resume' OR command.app_id IS NOT NULL
  OR command.billing_scope_id IS NOT NULL OR command.status <> 'PREPARED'
  OR (NEW.payload->>'subscriptionId') IS DISTINCT FROM command.subscription_id::text
  OR (NEW.payload->>'expectedSubscriptionRevision') IS DISTINCT FROM command.expected_subscription_revision::text
  OR (NEW.payload->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at
 THEN RAISE EXCEPTION 'Reviewed renewal terms require matching prepared organization undo' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER billing_renewal_review_receipt_guard BEFORE INSERT OR UPDATE OR DELETE
 ON billing_subscription_renewal_reviews FOR EACH ROW EXECUTE FUNCTION guard_subscription_renewal_review_receipt();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('ca009777ca9571f7207faa5155ffd2fd150a7fd851036c8147cab3cd857eb3cf', 1796083200128);
-- apply 0511_organization_plan_change_quotes
-- Server-observed upgrade reviews, separate from app-buyer and checkout payloads.
CREATE TABLE organization_plan_change_quotes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 actor_id uuid NOT NULL REFERENCES billing_identity_subjects(id) ON DELETE RESTRICT,
 subscription_id uuid NOT NULL,
 subscription_revision bigint NOT NULL,
 target_plan_key text NOT NULL,
 catalog_version text NOT NULL,
 source_digest text NOT NULL,
 review_digest text NOT NULL,
 review jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_by_command_id uuid,
 consumed_at timestamptz,
 CONSTRAINT organization_plan_quote_source_fk FOREIGN KEY(subscription_id,organization_id)
 REFERENCES billing_subscriptions(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_plan_quote_command_fk FOREIGN KEY(consumed_by_command_id,organization_id)
 REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_plan_quote_shape CHECK(subscription_revision>0
 AND target_plan_key IN ('plus_monthly','pro_monthly')
 AND source_digest ~ '^[a-f0-9]{64}$' AND review_digest ~ '^[a-f0-9]{64}$'
 AND expires_at>created_at AND (consumed_by_command_id IS NULL)=(consumed_at IS NULL))
);
;
CREATE INDEX organization_plan_quote_tenant_idx ON organization_plan_change_quotes(organization_id,created_at);
;
CREATE UNIQUE INDEX organization_plan_quote_consumed_idx ON organization_plan_change_quotes(consumed_by_command_id) WHERE consumed_by_command_id IS NOT NULL;
;
CREATE TRIGGER organization_plan_quote_identity BEFORE INSERT ON organization_plan_change_quotes FOR EACH ROW EXECUTE FUNCTION anchor_billing_identity('actor_id','actor');
;
CREATE FUNCTION guard_organization_plan_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; command record;
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Plan quote audit terms cannot be deleted directly' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['consumed_by_command_id','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_by_command_id','consumed_at']) THEN
  RAISE EXCEPTION 'Plan quote terms are immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.consumed_by_command_id IS NOT NULL AND ROW(NEW.consumed_by_command_id,NEW.consumed_at) IS DISTINCT FROM ROW(OLD.consumed_by_command_id,OLD.consumed_at) THEN
  RAISE EXCEPTION 'Plan quote already consumed' USING ERRCODE='23514';
 END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.billing_scope_id IS NOT NULL OR source.lifecycle_revision<>NEW.subscription_revision
 OR source.plan_key=NEW.target_plan_key OR source.catalog_version<>NEW.catalog_version
 OR (NEW.review->>'kind') IS DISTINCT FROM 'upgrade_estimate'
 OR (NEW.review->>'subscriptionId') IS DISTINCT FROM NEW.subscription_id::text
 OR (NEW.review->>'expectedSubscriptionRevision') IS DISTINCT FROM NEW.subscription_revision::text
 OR (NEW.review->>'sourcePlanKey') IS DISTINCT FROM source.plan_key
 OR (NEW.review->>'targetPlanKey') IS DISTINCT FROM NEW.target_plan_key
 OR (NEW.review->>'catalogVersion') IS DISTINCT FROM NEW.catalog_version
 OR (NEW.review->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at THEN
  RAISE EXCEPTION 'Plan quote source mismatch' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND (NEW.consumed_by_command_id IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NEW.created_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'New plan quote must be live and unconsumed' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.consumed_by_command_id IS NULL AND NEW.consumed_by_command_id IS NOT NULL THEN
  SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.consumed_by_command_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL OR command.kind<>'upgrade' OR command.status<>'PREPARED'
   OR ROW(command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_key) IS DISTINCT FROM ROW(NEW.actor_id,NEW.subscription_id,NEW.subscription_revision,NEW.target_plan_key)
   OR NEW.expires_at<=clock_timestamp() OR NEW.consumed_at<NEW.created_at OR NEW.consumed_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Plan quote requires its original live upgrade command' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER organization_plan_quote_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_plan_change_quotes FOR EACH ROW EXECUTE FUNCTION guard_organization_plan_quote();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('74269e73511d3de8b3798abf1b5bc8eed034e655a9bb5f93d2305f34fed4109f', 1796083200129);
-- apply 0512_organization_upgrade_dispatch
-- Organization upgrade dispatch provenance is separate from app and cancellation commands.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_upgrade_dispatch_state text;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_commands_org_upgrade_dispatch_check
CHECK (organization_upgrade_dispatch_state IS NULL OR
 (app_id IS NULL AND billing_scope_id IS NULL AND kind='upgrade'
  AND organization_upgrade_dispatch_state IN ('ready','started')));
;
CREATE FUNCTION guard_organization_upgrade_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE quote record;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.organization_upgrade_dispatch_state IS NOT NULL AND
   (NEW.organization_upgrade_dispatch_state<>'ready' OR NEW.status<>'PREPARED') THEN
   RAISE EXCEPTION 'Upgrade dispatch must begin unstarted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (OLD.organization_upgrade_dispatch_state IS NULL AND NEW.organization_upgrade_dispatch_state IS NOT NULL)
 OR (OLD.organization_upgrade_dispatch_state='ready' AND NEW.organization_upgrade_dispatch_state IS NULL)
 OR (OLD.organization_upgrade_dispatch_state='started' AND NEW.organization_upgrade_dispatch_state IS DISTINCT FROM 'started') THEN
  RAISE EXCEPTION 'Upgrade dispatch provenance cannot be reset or inferred' USING ERRCODE='23514';
 END IF;
 IF OLD.organization_upgrade_dispatch_state='ready' AND NEW.organization_upgrade_dispatch_state='started' THEN
  SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id;
  IF NOT FOUND OR ROW(quote.organization_id,quote.actor_id,quote.subscription_id,quote.subscription_revision,quote.target_plan_key)
   IS DISTINCT FROM ROW(NEW.organization_id,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision,NEW.target_plan_key)
   OR quote.expires_at<=clock_timestamp()
   OR NEW.status<>'OUTCOME_UNKNOWN' OR NEW.lease_token IS NULL
   OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at<=clock_timestamp() OR NEW.execution_generation<=0
   OR ROW(NEW.lease_token,NEW.execution_generation) IS DISTINCT FROM ROW(OLD.lease_token,OLD.execution_generation) THEN
   RAISE EXCEPTION 'Upgrade dispatch requires its live original review and execution lease' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER billing_commands_org_upgrade_dispatch_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_dispatch();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('0aaeb2bb7042adaf706f7ce3a5c356c74b1b254989f79ef1968fa17c630c991d', 1796083200130);
-- apply 0513_organization_upgrade_live_lease
-- Require the persisted lease to remain live before dispatch begins.
CREATE OR REPLACE FUNCTION guard_organization_upgrade_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE quote record;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.organization_upgrade_dispatch_state IS NOT NULL AND
   (NEW.organization_upgrade_dispatch_state<>'ready' OR NEW.status<>'PREPARED') THEN
   RAISE EXCEPTION 'Upgrade dispatch must begin unstarted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF (OLD.organization_upgrade_dispatch_state IS NULL AND NEW.organization_upgrade_dispatch_state IS NOT NULL)
 OR (OLD.organization_upgrade_dispatch_state='ready' AND NEW.organization_upgrade_dispatch_state IS NULL)
 OR (OLD.organization_upgrade_dispatch_state='started' AND NEW.organization_upgrade_dispatch_state IS DISTINCT FROM 'started') THEN
  RAISE EXCEPTION 'Upgrade dispatch provenance cannot be reset or inferred' USING ERRCODE='23514';
 END IF;
 IF OLD.organization_upgrade_dispatch_state='ready' AND NEW.organization_upgrade_dispatch_state='started' THEN
  SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id;
  IF NOT FOUND OR ROW(quote.organization_id,quote.actor_id,quote.subscription_id,quote.subscription_revision,quote.target_plan_key)
   IS DISTINCT FROM ROW(NEW.organization_id,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision,NEW.target_plan_key)
   OR quote.expires_at<=clock_timestamp()
   OR OLD.status<>'OUTCOME_UNKNOWN' OR OLD.lease_expires_at IS NULL
   OR OLD.lease_expires_at<=clock_timestamp()
   OR NEW.status<>'OUTCOME_UNKNOWN' OR NEW.lease_token IS NULL
   OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at<=clock_timestamp() OR NEW.execution_generation<=0
   OR ROW(NEW.lease_token,NEW.execution_generation) IS DISTINCT FROM ROW(OLD.lease_token,OLD.execution_generation) THEN
   RAISE EXCEPTION 'Upgrade dispatch requires its live original review and execution lease' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('18668227329f07a7332cf45ed54f4648c9c39f13a130e9f5eb9d9d0260a50654', 1796083200131);
-- apply 0514_organization_upgrade_quote_binding
-- Historical quote bindings are unknown; never infer them from current catalog configuration.
ALTER TABLE organization_plan_change_quotes ADD COLUMN provider_binding jsonb;
;
ALTER TABLE organization_plan_change_quotes ADD CONSTRAINT organization_upgrade_quote_binding_shape
CHECK (provider_binding IS NULL OR (
 jsonb_typeof(provider_binding)='object'
 AND (provider_binding-ARRAY['sourcePriceId','targetPriceId','sourceProductId','targetProductId','livemode','apiVersion'])='{}'::jsonb
 AND provider_binding->>'sourcePriceId' ~ '^price_[A-Za-z0-9]+$'
 AND provider_binding->>'targetPriceId' ~ '^price_[A-Za-z0-9]+$'
 AND provider_binding->>'sourceProductId' ~ '^prod_[A-Za-z0-9]+$'
 AND provider_binding->>'targetProductId' ~ '^prod_[A-Za-z0-9]+$'
 AND provider_binding->>'sourcePriceId'<>provider_binding->>'targetPriceId'
 AND provider_binding->>'sourceProductId'<>provider_binding->>'targetProductId'
 AND jsonb_typeof(provider_binding->'livemode')='boolean'
 AND provider_binding->>'apiVersion'='2024-11-20.acacia'
) IS TRUE);
;
CREATE FUNCTION guard_organization_upgrade_quote_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; quote record;
BEGIN
 IF TG_TABLE_NAME='organization_plan_change_quotes' THEN
  SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
  IF NEW.provider_binding IS NULL OR NOT FOUND OR source.provider<>'stripe'
   OR (NEW.provider_binding->>'livemode')::boolean IS DISTINCT FROM (source.provider_environment='live') THEN
   RAISE EXCEPTION 'New upgrade quote requires its observed provider binding' USING ERRCODE='23514';
  END IF;
 ELSE
  IF OLD.organization_upgrade_dispatch_state='ready' AND NEW.organization_upgrade_dispatch_state='started' THEN
   SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id;
   IF NOT FOUND OR quote.provider_binding IS NULL THEN
    RAISE EXCEPTION 'Upgrade dispatch cannot infer a historical quote binding' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER organization_upgrade_quote_binding_guard BEFORE INSERT ON organization_plan_change_quotes
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_quote_binding();
;
CREATE TRIGGER organization_upgrade_dispatch_binding_guard BEFORE UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_quote_binding();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('d9c4fbd2f9001339f40d5c53aa776f76e2f4aee593ad47bdf3ee36bf6d8ddb08', 1796083200132);
-- apply 0515_organization_upgrade_invoice_origins
-- Original-request attribution is separate from generic app results and paid settlement.
CREATE TABLE organization_upgrade_invoice_origins (
 command_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 invoice_id text NOT NULL,
 evidence_kind text NOT NULL,
 provider_event_id text,
 provider_request_id text NOT NULL,
 provider_idempotency_key text NOT NULL,
 customer_id text NOT NULL,
 subscription_id text NOT NULL,
 livemode boolean NOT NULL,
 api_version text NOT NULL,
 invoice_created_at timestamptz NOT NULL,
 event_created_at timestamptz,
 observed_at timestamptz NOT NULL,
 evidence_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT organization_upgrade_origin_command_fk FOREIGN KEY(command_id,organization_id)
 REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_upgrade_origin_shape CHECK (
 invoice_id ~ '^in_[A-Za-z0-9]+$'
 AND provider_request_id ~ '^req_[A-Za-z0-9]+$' AND customer_id ~ '^cus_[A-Za-z0-9]+$'
 AND subscription_id ~ '^sub_[A-Za-z0-9]+$' AND length(provider_idempotency_key)>0
 AND api_version='2024-11-20.acacia' AND evidence_digest ~ '^[a-f0-9]{64}$'
 AND observed_at>=invoice_created_at AND created_at>=observed_at
 AND ((evidence_kind='invoice_created_event' AND provider_event_id ~ '^evt_[A-Za-z0-9]+$' AND event_created_at>=invoice_created_at AND observed_at>=event_created_at) OR (evidence_kind='update_response' AND provider_event_id IS NULL AND event_created_at IS NULL)) IS TRUE)
);
;
CREATE INDEX organization_upgrade_origin_tenant_idx ON organization_upgrade_invoice_origins(organization_id,created_at);
CREATE UNIQUE INDEX organization_upgrade_origin_invoice_idx ON organization_upgrade_invoice_origins(livemode,invoice_id);
CREATE UNIQUE INDEX organization_upgrade_origin_event_idx ON organization_upgrade_invoice_origins(livemode,provider_event_id);
;
CREATE FUNCTION guard_organization_upgrade_invoice_origin() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command record; quote record; source record;
BEGIN
 SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.command_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR command.kind<>'upgrade' OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL
 OR command.merchant_key<>'platform' OR command.organization_upgrade_dispatch_state IS DISTINCT FROM 'started'
 OR command.status<>'OUTCOME_UNKNOWN' OR command.provider_idempotency_key<>NEW.provider_idempotency_key THEN
  RAISE EXCEPTION 'Original upgrade invoice requires its dispatched organization command' USING ERRCODE='23514';
 END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=command.id;
 IF NOT FOUND OR quote.provider_binding IS NULL OR ROW(quote.organization_id,quote.actor_id,quote.subscription_id,quote.subscription_revision,quote.target_plan_key)
 IS DISTINCT FROM ROW(command.organization_id,command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_key)
 OR (quote.provider_binding->>'livemode')::boolean IS DISTINCT FROM NEW.livemode
 OR NEW.invoice_created_at<to_timestamp((quote.review->>'prorationDate')::bigint) THEN
  RAISE EXCEPTION 'Original upgrade invoice requires the consumed original review' USING ERRCODE='23514';
 END IF;
 SELECT * INTO source FROM billing_subscription_revisions WHERE subscription_id=command.subscription_id
 AND organization_id=command.organization_id AND revision=command.expected_subscription_revision;
 IF NOT FOUND OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform' OR source.provider<>'stripe'
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id,(source.provider_environment='live'))
 IS DISTINCT FROM ROW(NEW.customer_id,NEW.subscription_id,NEW.livemode) OR NEW.observed_at>clock_timestamp() THEN
  RAISE EXCEPTION 'Original upgrade invoice differs from its historical source' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER organization_upgrade_invoice_origin_guard BEFORE INSERT ON organization_upgrade_invoice_origins
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_invoice_origin();
CREATE TRIGGER organization_upgrade_invoice_origin_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON organization_upgrade_invoice_origins
FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('bd700999df6fd75060831d38dfd924650ba590c79c6b4856b8320450a49138b9', 1796083200133);
-- apply 0516_organization_upgrade_paid_finalization
-- Organization upgrades require atomic original-invoice source and allowance publication.
ALTER TABLE billing_subscription_commands DROP CONSTRAINT billing_subscription_commands_cancellation_result_check;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_subscription_commands_cancellation_result_check CHECK (true) NOT VALID;
;
ALTER TABLE billing_subscription_commands DROP CONSTRAINT billing_subscription_commands_status_shape_check;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_subscription_commands_status_shape_check CHECK (true) NOT VALID;
;
CREATE FUNCTION guard_organization_upgrade_paid_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record; quote record; previous record; result record; posting record; projection record; bucket record; delta numeric;
BEGIN
 IF NEW.app_id IS NOT NULL OR NEW.billing_scope_id IS NOT NULL OR NEW.kind<>'upgrade' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.status='APPLIED' THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Applied organization upgrade result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status<>'APPLIED' THEN RETURN NEW; END IF;
 IF TG_OP='INSERT' OR OLD.status<>'OUTCOME_UNKNOWN' OR OLD.organization_upgrade_dispatch_state IS DISTINCT FROM 'started'
 OR OLD.lease_token IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
 OR NEW.execution_generation<>OLD.execution_generation OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.result_subscription_id IS DISTINCT FROM NEW.subscription_id OR NEW.result_subscription_revision IS DISTINCT FROM NEW.expected_subscription_revision+1
 OR NEW.provider_response_digest IS NULL OR NEW.provider_response_digest !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Paid organization upgrade requires its original live execution' USING ERRCODE='23514';
 END IF;
 SELECT * INTO origin FROM organization_upgrade_invoice_origins WHERE command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR origin.provider_idempotency_key<>NEW.provider_idempotency_key THEN RAISE EXCEPTION 'Paid upgrade lacks original invoice' USING ERRCODE='23514'; END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.provider_binding IS NULL OR quote.subscription_id<>NEW.subscription_id OR quote.subscription_revision<>NEW.expected_subscription_revision OR quote.target_plan_key<>NEW.target_plan_key THEN RAISE EXCEPTION 'Paid upgrade lacks original review' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.expected_subscription_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'Paid upgrade lacks original revision' USING ERRCODE='23514'; END IF;
 SELECT * INTO result FROM billing_subscriptions WHERE id=NEW.result_subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR result.billing_scope_id IS NOT NULL OR result.merchant_key<>'platform' OR result.lifecycle_revision<>NEW.result_subscription_revision
 OR result.plan_key<>NEW.target_plan_key OR result.status<>'active' OR result.cancel_at_period_end OR result.pending_plan_key IS NOT NULL OR result.ended_at IS NOT NULL OR result.dunning_started_at IS NOT NULL OR result.grace_expires_at IS NOT NULL
 OR ROW(result.stripe_customer_id,result.stripe_subscription_id,result.stripe_subscription_item_id,result.provider_environment,result.current_period_start,result.current_period_end,result.catalog_version)
 IS DISTINCT FROM ROW(previous.stripe_customer_id,previous.stripe_subscription_id,previous.stripe_subscription_item_id,previous.provider_environment,previous.current_period_start,previous.current_period_end,previous.catalog_version)
 OR result.stripe_customer_id<>origin.customer_id OR result.stripe_subscription_id<>origin.subscription_id OR (result.provider_environment='live') IS DISTINCT FROM origin.livemode THEN
  RAISE EXCEPTION 'Paid upgrade target source is not atomically published' USING ERRCODE='23514';
 END IF;
 SELECT * INTO projection FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL;
 IF NOT FOUND OR projection.source_subscription_id IS DISTINCT FROM NEW.subscription_id OR projection.source_subscription_revision IS DISTINCT FROM NEW.result_subscription_revision THEN RAISE EXCEPTION 'Paid upgrade entitlement is not atomically published' USING ERRCODE='23514'; END IF;
 SELECT * INTO bucket FROM subscription_allowance_periods WHERE organization_id=NEW.organization_id AND subscription_id=NEW.subscription_id AND billing_scope_id IS NULL AND period_start=previous.current_period_start AND period_end=previous.current_period_end;
 IF NOT FOUND OR bucket.merchant_key<>'platform' OR bucket.grant_source<>'paid_invoice' OR bucket.provider_environment<>result.provider_environment OR (bucket.expires_at<=clock_timestamp() AND bucket.available_amount<>0) THEN
  RAISE EXCEPTION 'Paid upgrade requires its original paid period without expired spending revival' USING ERRCODE='23514';
 END IF;
 delta=(quote.review->>'additionalAllowanceUsd')::numeric;
 SELECT * INTO posting FROM subscription_allowance_transactions WHERE merchant_key='platform' AND source_invoice_id=origin.invoice_id;
 IF delta IS NULL OR delta<0 OR (delta=0 AND FOUND) OR (delta>0 AND (NOT FOUND OR posting.organization_id<>NEW.organization_id OR posting.allowance_period_id<>bucket.id OR bucket.adjustment_amount<delta OR posting.kind<>'grant_adjustment' OR posting.amount<>delta OR posting.source_subscription_id<>NEW.subscription_id OR posting.source_subscription_revision<>NEW.result_subscription_revision OR posting.source_plan_key<>NEW.target_plan_key OR posting.source_catalog_version<>quote.catalog_version)) THEN
  RAISE EXCEPTION 'Paid upgrade requires its exact once-only allowance adjustment' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER organization_upgrade_paid_result_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_paid_result();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('447853abb67825905dc5b962de6ee1ac26ea16347e435da1497964df65414cd6', 1796083200134);
-- apply 0517_organization_upgrade_historical_targets
-- Authenticated historical target evidence is separate from current subscription authority.
CREATE TABLE organization_upgrade_historical_targets (
 command_id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 provider_event_id text NOT NULL,
 event_type text NOT NULL,
 api_version text NOT NULL,
 livemode boolean NOT NULL,
 invoice_id text NOT NULL,
 event_created_at timestamptz NOT NULL,
 observed_at timestamptz NOT NULL,
 evidence_digest text NOT NULL,
 raw_subscription jsonb NOT NULL,
 CONSTRAINT organization_upgrade_target_command_fk FOREIGN KEY(command_id,organization_id)
 REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_upgrade_target_origin_fk FOREIGN KEY(command_id)
 REFERENCES organization_upgrade_invoice_origins(command_id) ON DELETE RESTRICT,
 CONSTRAINT organization_upgrade_target_shape CHECK (
 provider_event_id ~ '^evt_[A-Za-z0-9]+$' AND invoice_id ~ '^in_[A-Za-z0-9]+$'
 AND event_type IN ('customer.subscription.updated','customer.subscription.pending_update_applied')
 AND api_version='2024-11-20.acacia'
 AND evidence_digest ~ '^[a-f0-9]{64}$' AND observed_at>=event_created_at
 AND jsonb_typeof(raw_subscription)='object')
);
;
CREATE UNIQUE INDEX organization_upgrade_target_event_idx ON organization_upgrade_historical_targets(livemode,provider_event_id);
CREATE INDEX organization_upgrade_target_tenant_idx ON organization_upgrade_historical_targets(organization_id,observed_at);
;
CREATE FUNCTION guard_organization_upgrade_historical_target() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command record; origin record; source record; quote record;
BEGIN
 SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.command_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR command.kind<>'upgrade' OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL
 OR command.merchant_key<>'platform' OR command.organization_upgrade_dispatch_state IS DISTINCT FROM 'started'
 OR command.status NOT IN ('OUTCOME_UNKNOWN','APPLIED') THEN
 RAISE EXCEPTION 'Historical target requires original dispatched organization upgrade' USING ERRCODE='23514'; END IF;
 SELECT * INTO origin FROM organization_upgrade_invoice_origins WHERE command_id=command.id AND organization_id=command.organization_id;
 IF NOT FOUND OR ROW(origin.invoice_id,origin.livemode) IS DISTINCT FROM ROW(NEW.invoice_id,NEW.livemode)
 OR NEW.event_created_at<origin.invoice_created_at OR NEW.observed_at>clock_timestamp() THEN
 RAISE EXCEPTION 'Historical target requires original invoice origin' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscription_revisions WHERE subscription_id=command.subscription_id AND organization_id=command.organization_id AND revision=command.expected_subscription_revision;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=command.id AND organization_id=command.organization_id;
 IF source.id IS NULL OR quote.id IS NULL OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform'
 OR (NEW.event_created_at>=to_timestamp((quote.review->>'prorationDate')::bigint)
 AND NEW.event_created_at<source.current_period_end
 AND NEW.raw_subscription->>'id'=source.stripe_subscription_id
 AND NEW.raw_subscription->>'customer'=source.stripe_customer_id
 AND NEW.raw_subscription->>'latest_invoice'=origin.invoice_id
 AND (NEW.raw_subscription->>'livemode')::boolean=origin.livemode
 AND NEW.raw_subscription->>'status'='active'
 AND NEW.raw_subscription->'pending_update'='null'::jsonb
 AND (NEW.raw_subscription->>'cancel_at_period_end')::boolean=false
 AND to_timestamp((NEW.raw_subscription->>'current_period_start')::bigint)=source.current_period_start
 AND to_timestamp((NEW.raw_subscription->>'current_period_end')::bigint)=source.current_period_end
 AND NEW.raw_subscription#>>'{items,data,0,id}'=source.stripe_subscription_item_id
 AND NEW.raw_subscription#>>'{items,data,0,price,id}'=quote.provider_binding->>'targetPriceId') IS NOT TRUE THEN
 RAISE EXCEPTION 'Historical target differs from original reviewed period and target' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER organization_upgrade_target_guard BEFORE INSERT ON organization_upgrade_historical_targets
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_historical_target();
CREATE TRIGGER organization_upgrade_target_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON organization_upgrade_historical_targets
FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('fb0509629243a460354249b8dba04744138059660271e64276fc6060d4583115', 1796083200135);
-- apply 0518_organization_upgrade_historical_settlement
-- Identify historical evidence separately from the fresh later-period observation.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_upgrade_settlement_evidence jsonb;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_upgrade_settlement_evidence_shape CHECK (
 organization_upgrade_settlement_evidence IS NULL OR (kind='upgrade' AND app_id IS NULL AND billing_scope_id IS NULL AND merchant_key='platform' AND status='APPLIED'
 AND organization_upgrade_settlement_evidence->>'kind'='historical_target_with_live_compatibility'
 AND organization_upgrade_settlement_evidence->>'eventId' ~ '^evt_[A-Za-z0-9]+$'
 AND organization_upgrade_settlement_evidence->>'eventDigest' ~ '^[a-f0-9]{64}$'
 AND organization_upgrade_settlement_evidence->>'liveDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(organization_upgrade_settlement_evidence->'livePeriodStart')='string'
 AND jsonb_typeof(organization_upgrade_settlement_evidence->'livePeriodEnd')='string'
 AND jsonb_typeof(organization_upgrade_settlement_evidence->'observedAt')='string') IS TRUE
);
;
CREATE FUNCTION guard_organization_upgrade_settlement_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt record; source record; proof jsonb;
BEGIN
 proof=NEW.organization_upgrade_settlement_evidence;
 IF TG_OP='UPDATE' AND OLD.organization_upgrade_settlement_evidence IS NOT NULL THEN
  IF proof IS DISTINCT FROM OLD.organization_upgrade_settlement_evidence THEN RAISE EXCEPTION 'Historical settlement evidence is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF proof IS NULL THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN' OR NEW.status<>'APPLIED' THEN
  RAISE EXCEPTION 'Historical evidence belongs only to original atomic paid settlement' USING ERRCODE='23514'; END IF;
 SELECT * INTO receipt FROM organization_upgrade_historical_targets WHERE command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR ROW(receipt.provider_event_id,receipt.evidence_digest) IS DISTINCT FROM ROW(proof->>'eventId',proof->>'eventDigest') THEN
  RAISE EXCEPTION 'Historical settlement requires its exact immutable target receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.expected_subscription_revision;
 IF NOT FOUND OR ((proof->>'livePeriodStart')::timestamptz>=source.current_period_end
 AND (proof->>'livePeriodStart')::timestamptz<=(proof->>'observedAt')::timestamptz
 AND (proof->>'observedAt')::timestamptz<(proof->>'livePeriodEnd')::timestamptz
 AND (proof->>'observedAt')::timestamptz<=clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Historical settlement requires a compatible later live period' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER organization_upgrade_settlement_evidence_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_settlement_evidence();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('3879e39cffabd84ccc7a7ffba97156304c910e5f21b1fbb8dda62687d6741816', 1796083200136);
-- apply 0519_organization_upgrade_void_result
-- Definitive original void outcomes preserve source authority and cannot be rewritten or dispatched again.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_upgrade_failure_evidence jsonb;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_upgrade_failure_evidence_shape CHECK (
 organization_upgrade_failure_evidence IS NULL OR (kind='upgrade' AND app_id IS NULL AND billing_scope_id IS NULL AND merchant_key='platform' AND status='FAILED'
 AND error_code='ORIGINAL_UPGRADE_INVOICE_VOID' AND organization_upgrade_dispatch_state='started'
 AND organization_upgrade_failure_evidence->>'kind'='original_invoice_void'
 AND organization_upgrade_failure_evidence->>'invoiceId' ~ '^in_[A-Za-z0-9]+$'
 AND organization_upgrade_failure_evidence->>'invoiceDigest' ~ '^[a-f0-9]{64}$'
 AND organization_upgrade_failure_evidence->>'liveDigest' ~ '^[a-f0-9]{64}$'
 AND ((organization_upgrade_failure_evidence->'paymentIntentId'='null'::jsonb AND organization_upgrade_failure_evidence->'paymentIntentDigest'='null'::jsonb)
 OR (organization_upgrade_failure_evidence->>'paymentIntentId' ~ '^pi_[A-Za-z0-9]+$' AND organization_upgrade_failure_evidence->>'paymentIntentDigest' ~ '^[a-f0-9]{64}$'))
 AND jsonb_typeof(organization_upgrade_failure_evidence->'livePeriodStart')='string'
 AND jsonb_typeof(organization_upgrade_failure_evidence->'livePeriodEnd')='string'
 AND jsonb_typeof(organization_upgrade_failure_evidence->'observedAt')='string') IS TRUE
);
;
CREATE FUNCTION guard_organization_upgrade_void_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE origin record; source record; proof jsonb;
BEGIN
 IF NEW.app_id IS NOT NULL OR NEW.billing_scope_id IS NOT NULL OR NEW.kind<>'upgrade' THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.organization_upgrade_failure_evidence IS NOT NULL THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Original void upgrade result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status<>'FAILED' OR NEW.organization_upgrade_dispatch_state IS DISTINCT FROM 'started' THEN RETURN NEW; END IF;
 proof=NEW.organization_upgrade_failure_evidence;
 IF proof IS NULL OR TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN'
 OR OLD.lease_token IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
 OR NEW.execution_generation<>OLD.execution_generation OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.provider_response_digest IS NULL OR NEW.provider_response_digest !~ '^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION 'Original void failure requires a proven live observation' USING ERRCODE='23514'; END IF;
 SELECT * INTO origin FROM organization_upgrade_invoice_origins WHERE command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR origin.invoice_id IS DISTINCT FROM proof->>'invoiceId' OR origin.provider_idempotency_key<>NEW.provider_idempotency_key THEN
  RAISE EXCEPTION 'Original void failure requires exact invoice attribution' USING ERRCODE='23514'; END IF;
 IF EXISTS (SELECT 1 FROM organization_upgrade_historical_targets WHERE command_id=NEW.id AND organization_id=NEW.organization_id) THEN
  RAISE EXCEPTION 'Original void failure conflicts with applied target evidence' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.lifecycle_revision IS DISTINCT FROM NEW.expected_subscription_revision OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform'
 OR source.status<>'active' OR source.cancel_at_period_end OR source.pending_plan_key IS NOT NULL OR source.ended_at IS NOT NULL OR source.dunning_started_at IS NOT NULL OR source.grace_expires_at IS NOT NULL
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(origin.customer_id,origin.subscription_id)
 OR (source.provider_environment='live') IS DISTINCT FROM origin.livemode
 OR NOT EXISTS (SELECT 1 FROM organization_subscription_authorities WHERE organization_id=NEW.organization_id AND subscription_id=source.id AND state='current')
 OR NOT EXISTS (SELECT 1 FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL AND source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision)
 OR (((proof->>'livePeriodStart')::timestamptz=source.current_period_start AND (proof->>'livePeriodEnd')::timestamptz=source.current_period_end)
 OR (proof->>'livePeriodStart')::timestamptz>=source.current_period_end) IS NOT TRUE
 OR ((proof->>'livePeriodStart')::timestamptz<=(proof->>'observedAt')::timestamptz AND (proof->>'observedAt')::timestamptz<(proof->>'livePeriodEnd')::timestamptz AND (proof->>'observedAt')::timestamptz<=clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Original void failure requires unchanged source and live compatible period' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER organization_upgrade_void_result_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands
FOR EACH ROW EXECUTE FUNCTION guard_organization_upgrade_void_result();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('088331deab134f4fbcc6f2b9b3860364b8ee41bac18bee50a6b27fd767569a1c', 1796083200137);
-- apply 0520_organization_downgrade_quotes
-- Shared immutable quote storage now distinguishes scheduled downgrade review from upgrade review.
CREATE OR REPLACE FUNCTION guard_organization_plan_quote() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; command record;
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'Plan quote audit terms cannot be deleted directly' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND (to_jsonb(NEW)-ARRAY['consumed_by_command_id','consumed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['consumed_by_command_id','consumed_at']) THEN
  RAISE EXCEPTION 'Plan quote terms are immutable' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.consumed_by_command_id IS NOT NULL AND ROW(NEW.consumed_by_command_id,NEW.consumed_at) IS DISTINCT FROM ROW(OLD.consumed_by_command_id,OLD.consumed_at) THEN
  RAISE EXCEPTION 'Plan quote already consumed' USING ERRCODE='23514';
 END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.billing_scope_id IS NOT NULL OR source.lifecycle_revision<>NEW.subscription_revision
 OR source.plan_key=NEW.target_plan_key OR source.catalog_version<>NEW.catalog_version
 OR ((NEW.review->>'kind') IS DISTINCT FROM 'upgrade_estimate' AND (NEW.review->>'kind') IS DISTINCT FROM 'downgrade_estimate')
 OR (NEW.review->>'subscriptionId') IS DISTINCT FROM NEW.subscription_id::text
 OR (NEW.review->>'expectedSubscriptionRevision') IS DISTINCT FROM NEW.subscription_revision::text
 OR (NEW.review->>'sourcePlanKey') IS DISTINCT FROM source.plan_key
 OR (NEW.review->>'targetPlanKey') IS DISTINCT FROM NEW.target_plan_key
 OR (NEW.review->>'catalogVersion') IS DISTINCT FROM NEW.catalog_version
 OR (NEW.review->>'expiresAt')::timestamptz IS DISTINCT FROM NEW.expires_at THEN
  RAISE EXCEPTION 'Plan quote source mismatch' USING ERRCODE='23514';
 END IF;
 IF NEW.review->>'kind'='downgrade_estimate' AND (
  NEW.provider_binding IS NULL
  OR jsonb_typeof(NEW.review->'amountDueNowCents') IS DISTINCT FROM 'number'
  OR (NEW.review->>'effectiveAt')::timestamptz IS DISTINCT FROM source.current_period_end
  OR (NEW.review->>'currentPeriodStart')::timestamptz IS DISTINCT FROM source.current_period_start
  OR (NEW.review->>'currentPeriodEnd')::timestamptz IS DISTINCT FROM source.current_period_end
  OR (NEW.review->>'amountDueNowCents') IS DISTINCT FROM '0'
 ) THEN
  RAISE EXCEPTION 'Downgrade review must retain the current paid period' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND (NEW.consumed_by_command_id IS NOT NULL OR NEW.expires_at<=clock_timestamp() OR NEW.created_at>clock_timestamp()) THEN
  RAISE EXCEPTION 'New plan quote must be live and unconsumed' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND OLD.consumed_by_command_id IS NULL AND NEW.consumed_by_command_id IS NOT NULL THEN
  SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.consumed_by_command_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL OR command.kind IS DISTINCT FROM (CASE WHEN NEW.review->>'kind'='upgrade_estimate' THEN 'upgrade' ELSE 'downgrade' END) OR command.status<>'PREPARED'
   OR ROW(command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_key) IS DISTINCT FROM ROW(NEW.actor_id,NEW.subscription_id,NEW.subscription_revision,NEW.target_plan_key)
   OR NEW.expires_at<=clock_timestamp() OR NEW.consumed_at<NEW.created_at OR NEW.consumed_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Plan quote requires its original live plan-change command' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('e3c9bb4fc5aad1cdb7995c41bc7ae448553d806765f279cb7dc33375e479d526', 1796083200138);
-- apply 0521_organization_schedule_effects
-- Sequential provider effects retain independent request/receipt identity under the original command lease.
CREATE TABLE organization_schedule_effects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 command_id uuid NOT NULL,
 predecessor_id uuid REFERENCES organization_schedule_effects(id) ON DELETE RESTRICT,
 kind text NOT NULL CHECK (kind IN ('schedule_create','schedule_configure')),
 provider_idempotency_key text NOT NULL CONSTRAINT organization_schedule_effect_provider_key UNIQUE,
 customer_id text NOT NULL,
 subscription_id text NOT NULL,
 livemode boolean NOT NULL,
 request_payload jsonb NOT NULL,
 request_digest text NOT NULL,
 state text NOT NULL DEFAULT 'ready',
 started_at timestamptz,
 started_generation bigint,
 started_lease_token uuid,
 receipt jsonb,
 receipt_digest text,
 observed_at timestamptz,
 observation_generation bigint,
 observation_lease_token uuid,
 created_at timestamptz NOT NULL,
 CONSTRAINT organization_schedule_effect_command_fk FOREIGN KEY(command_id,organization_id) REFERENCES billing_subscription_commands(id,organization_id) ON DELETE RESTRICT,
 CONSTRAINT organization_schedule_effect_command_kind UNIQUE(command_id,kind),
 CONSTRAINT organization_schedule_effect_identity CHECK ((customer_id ~ '^cus_[A-Za-z0-9]+$' AND subscription_id ~ '^sub_[A-Za-z0-9]+$' AND request_digest ~ '^[a-f0-9]{64}$' AND provider_idempotency_key='organization-schedule:'||command_id::text||':'||kind AND request_payload->>'kind'=kind AND jsonb_typeof(request_payload)='object' AND ((kind='schedule_create' AND predecessor_id IS NULL AND request_payload->>'subscriptionId'=subscription_id AND request_payload-ARRAY['kind','subscriptionId']='{}'::jsonb) OR (kind='schedule_configure' AND predecessor_id IS NOT NULL AND request_payload->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$' AND jsonb_typeof(request_payload->'params')='object' AND request_payload-ARRAY['kind','scheduleId','params']='{}'::jsonb))) IS TRUE),
 CONSTRAINT organization_schedule_effect_state CHECK ((
 (state='ready' AND started_at IS NULL AND started_generation IS NULL AND started_lease_token IS NULL AND receipt IS NULL AND receipt_digest IS NULL AND observed_at IS NULL AND observation_generation IS NULL AND observation_lease_token IS NULL)
 OR (state='started' AND started_at>=created_at AND started_generation>0 AND started_lease_token IS NOT NULL AND receipt IS NULL AND receipt_digest IS NULL AND observed_at IS NULL AND observation_generation IS NULL AND observation_lease_token IS NULL)
 OR (state='observed' AND started_at>=created_at AND started_generation>0 AND started_lease_token IS NOT NULL AND receipt IS NOT NULL AND receipt_digest ~ '^[a-f0-9]{64}$' AND observed_at>=started_at AND observation_generation>=started_generation AND observation_lease_token IS NOT NULL)
 ) IS TRUE),
 CONSTRAINT organization_schedule_effect_receipt CHECK (receipt IS NULL OR (
  jsonb_typeof(receipt)='object' AND receipt-ARRAY['kind','scheduleId','customerId','subscriptionId','livemode','apiVersion','providerRequestId','providerIdempotencyKey','eventId','evidenceDigest','observedAt']='{}'::jsonb
  AND receipt->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$' AND receipt->>'customerId'=customer_id AND receipt->>'subscriptionId'=subscription_id AND receipt->'livemode'=to_jsonb(livemode)
  AND receipt->>'apiVersion'='2024-11-20.acacia' AND receipt->>'providerRequestId' ~ '^req_[A-Za-z0-9]+$' AND receipt->>'providerIdempotencyKey'=provider_idempotency_key AND receipt->>'evidenceDigest' ~ '^[a-f0-9]{64}$'
  AND (receipt->>'observedAt')::timestamptz=observed_at
  AND ((receipt->>'kind'='response' AND receipt->'eventId'='null'::jsonb) OR (receipt->>'kind'='event' AND receipt->>'eventId' ~ '^evt_[A-Za-z0-9]+$'))
 ) IS TRUE)
);
;
CREATE FUNCTION guard_organization_schedule_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command record; quote record; source record; predecessor record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Schedule effect audit cannot be deleted' USING ERRCODE='23514'; END IF;
 SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.command_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR command.kind<>'downgrade' OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL OR command.merchant_key<>'platform' THEN
  RAISE EXCEPTION 'Schedule effect requires its original platform downgrade' USING ERRCODE='23514';
 END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=command.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.review->>'kind' IS DISTINCT FROM 'downgrade_estimate' OR ROW(quote.actor_id,quote.subscription_id,quote.subscription_revision,quote.target_plan_key) IS DISTINCT FROM ROW(command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_key) THEN
  RAISE EXCEPTION 'Schedule effect requires its original consumed review' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO source FROM billing_subscriptions WHERE id=command.subscription_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(NEW.customer_id,NEW.subscription_id) OR (source.provider_environment='live') IS DISTINCT FROM NEW.livemode OR source.lifecycle_revision<>command.expected_subscription_revision
   OR NEW.state<>'ready' OR command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR quote.expires_at<=clock_timestamp() OR NEW.created_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Schedule effect must begin ready under live original source' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','started_at','started_generation','started_lease_token','receipt','receipt_digest','observed_at','observation_generation','observation_lease_token']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','started_at','started_generation','started_lease_token','receipt','receipt_digest','observed_at','observation_generation','observation_lease_token']) THEN
   RAISE EXCEPTION 'Schedule effect request is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state='observed' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Schedule effect receipt is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.state<>'ready' AND ROW(NEW.started_at,NEW.started_generation,NEW.started_lease_token) IS DISTINCT FROM ROW(OLD.started_at,OLD.started_generation,OLD.started_lease_token) THEN RAISE EXCEPTION 'Schedule effect dispatch cannot be reset' USING ERRCODE='23514'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state='ready' AND NEW.state='started') OR (OLD.state='started' AND NEW.state='observed')) THEN RAISE EXCEPTION 'Schedule effect transition is invalid' USING ERRCODE='23514'; END IF;
  IF OLD.state='ready' AND NEW.state='started' THEN
   IF command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR ROW(NEW.started_generation,NEW.started_lease_token) IS DISTINCT FROM ROW(command.execution_generation,command.lease_token) OR NEW.started_at>clock_timestamp() OR quote.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Schedule dispatch requires the current original lease and live review' USING ERRCODE='23514';
   END IF;
  END IF;
  IF OLD.state='started' AND NEW.state='observed' THEN
   IF command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR ROW(NEW.observation_generation,NEW.observation_lease_token) IS DISTINCT FROM ROW(command.execution_generation,command.lease_token) OR NEW.observed_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Schedule observation requires the current original lease' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 IF NEW.kind='schedule_configure' THEN
  SELECT * INTO predecessor FROM organization_schedule_effects WHERE id=NEW.predecessor_id AND command_id=NEW.command_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR predecessor.kind<>'schedule_create' OR predecessor.state<>'observed' OR NEW.request_payload->>'scheduleId' IS DISTINCT FROM predecessor.receipt->>'scheduleId' OR (NEW.receipt IS NOT NULL AND NEW.receipt->>'scheduleId' IS DISTINCT FROM predecessor.receipt->>'scheduleId') THEN
   RAISE EXCEPTION 'Schedule configure requires its original observed create' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER organization_schedule_effect_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_schedule_effects FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_effect();
;
-- Other command writers must not erase uncertainty or revive a stale scheduling lease.
CREATE FUNCTION guard_organization_schedule_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id) THEN RETURN NEW; END IF;
 IF ROW(NEW.organization_id,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision,NEW.kind,NEW.target_plan_key,NEW.request_digest,NEW.provider_idempotency_key,NEW.app_id,NEW.billing_scope_id,NEW.merchant_key,NEW.provider_started_at)
  IS DISTINCT FROM ROW(OLD.organization_id,OLD.requested_by_user_id,OLD.subscription_id,OLD.expected_subscription_revision,OLD.kind,OLD.target_plan_key,OLD.request_digest,OLD.provider_idempotency_key,OLD.app_id,OLD.billing_scope_id,OLD.merchant_key,OLD.provider_started_at) THEN
  RAISE EXCEPTION 'Original schedule command authority cannot change' USING ERRCODE='23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  OLD.status='OUTCOME_UNKNOWN' AND NEW.status='FAILED'
  AND EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id AND kind='schedule_create' AND state='ready')
  AND NOT EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id AND (kind<>'schedule_create' OR state<>'ready'))
 ) THEN RAISE EXCEPTION 'Schedule effects require original outcome reconciliation before terminal publication' USING ERRCODE='23514'; END IF;
 IF NEW.execution_generation IS DISTINCT FROM OLD.execution_generation OR (NEW.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
  IF NEW.status<>'OUTCOME_UNKNOWN' OR NEW.execution_generation<>OLD.execution_generation+1 OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()) THEN
   RAISE EXCEPTION 'Schedule lease replacement requires an expired original generation' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.lease_token IS NOT NULL AND NEW.lease_expires_at>OLD.lease_expires_at THEN
  RAISE EXCEPTION 'Schedule lease cannot be extended or revived in place' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
;
CREATE TRIGGER organization_schedule_command_guard BEFORE UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_command();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('cebdfa8f59470d14b8769666d36cfcb686c107b8b74068baa1202c155f7af1f7', 1796083200139);
-- apply 0522_organization_schedule_quote_terms
-- Immutable original downgrade quote billing settings; legacy receipts remain recoverable.
CREATE TABLE organization_schedule_quote_terms (
 quote_id uuid PRIMARY KEY REFERENCES organization_plan_change_quotes(id) ON DELETE RESTRICT,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 snapshot jsonb NOT NULL,
 snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL,
 CONSTRAINT organization_schedule_quote_terms_shape CHECK((
  jsonb_typeof(snapshot)='object' AND snapshot->>'version'='1'
  AND jsonb_typeof(snapshot->'subscription')='object'
  AND jsonb_typeof(snapshot->'customer')='object'
  AND (snapshot-ARRAY['version','subscription','customer'])='{}'::jsonb
 ) IS TRUE)
);
;
CREATE FUNCTION guard_organization_schedule_quote_terms() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q record; s record;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'Original schedule quote terms are immutable' USING ERRCODE='23514';
 END IF;
 SELECT * INTO q FROM organization_plan_change_quotes WHERE id=NEW.quote_id FOR UPDATE;
 IF NOT FOUND OR q.organization_id<>NEW.organization_id OR q.review->>'kind'<>'downgrade_estimate'
 OR q.consumed_by_command_id IS NOT NULL OR q.expires_at<=clock_timestamp()
 OR NEW.created_at<q.created_at OR NEW.created_at>clock_timestamp() THEN
  RAISE EXCEPTION 'Schedule terms require the original live unconsumed quote' USING ERRCODE='23514';
 END IF;
 SELECT * INTO s FROM billing_subscriptions WHERE id=q.subscription_id AND organization_id=q.organization_id;
 IF NOT FOUND OR s.lifecycle_revision<>q.subscription_revision
 OR (NEW.snapshot->'subscription'->>'id') IS DISTINCT FROM s.stripe_subscription_id
 OR (NEW.snapshot->'subscription'->>'customer') IS DISTINCT FROM s.stripe_customer_id
 OR (NEW.snapshot->'customer'->>'customerId') IS DISTINCT FROM s.stripe_customer_id
 OR (NEW.snapshot->'subscription'->>'livemode') IS DISTINCT FROM (q.provider_binding->>'livemode')
 OR (NEW.snapshot->'customer'->>'livemode') IS DISTINCT FROM (q.provider_binding->>'livemode')
 OR (NEW.snapshot->'subscription'->>'current_period_start')::bigint IS DISTINCT FROM extract(epoch FROM s.current_period_start)::bigint
 OR (NEW.snapshot->'subscription'->>'current_period_end')::bigint IS DISTINCT FROM extract(epoch FROM s.current_period_end)::bigint
 OR (NEW.snapshot->'subscription'->'items'->'data'->0->>'id') IS DISTINCT FROM s.stripe_subscription_item_id
 OR (NEW.snapshot->'subscription'->'items'->'data'->0->'price'->>'id') IS DISTINCT FROM (q.provider_binding->>'sourcePriceId')
 THEN RAISE EXCEPTION 'Schedule terms source changed' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
;
CREATE TRIGGER organization_schedule_quote_terms_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_schedule_quote_terms FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_quote_terms();
;
CREATE FUNCTION require_organization_schedule_quote_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.review->>'kind'='downgrade_estimate' AND OLD.consumed_by_command_id IS NULL AND NEW.consumed_by_command_id IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM organization_schedule_quote_terms WHERE quote_id=NEW.id AND organization_id=NEW.organization_id)
 THEN RAISE EXCEPTION 'Downgrade quote requires retained provider terms' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
;
CREATE TRIGGER organization_schedule_quote_terms_required BEFORE UPDATE ON organization_plan_change_quotes FOR EACH ROW EXECUTE FUNCTION require_organization_schedule_quote_terms();
;
CREATE FUNCTION require_organization_schedule_effect_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' OR (OLD.state='ready' AND NEW.state='started') THEN
  IF NOT EXISTS (SELECT 1 FROM organization_plan_change_quotes q JOIN organization_schedule_quote_terms t ON t.quote_id=q.id AND t.organization_id=q.organization_id WHERE q.consumed_by_command_id=NEW.command_id AND q.organization_id=NEW.organization_id) THEN
   RAISE EXCEPTION 'New schedule effects require original retained terms' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
;
CREATE TRIGGER organization_schedule_effect_terms_required BEFORE INSERT OR UPDATE ON organization_schedule_effects FOR EACH ROW EXECUTE FUNCTION require_organization_schedule_effect_terms();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('906c83a881c37248d5f47af23ed1aa1339ad02a602fb82af083184f6b0cdc1ff', 1796083200140);
-- apply 0523_organization_schedule_compensation
-- Compensation retains an independent one-time release identity under the original lease.
-- Quote expiry cannot strand a proven unconfigured create; unknown configuration cannot be released.
ALTER TABLE organization_schedule_effects DROP CONSTRAINT organization_schedule_effects_kind_check;
ALTER TABLE organization_schedule_effects ADD CONSTRAINT organization_schedule_effects_kind_check CHECK(kind IN ('schedule_create','schedule_configure','schedule_release'));
ALTER TABLE organization_schedule_effects DROP CONSTRAINT organization_schedule_effect_identity;
ALTER TABLE organization_schedule_effects ADD CONSTRAINT organization_schedule_effect_identity CHECK ((customer_id ~ '^cus_[A-Za-z0-9]+$' AND subscription_id ~ '^sub_[A-Za-z0-9]+$' AND request_digest ~ '^[a-f0-9]{64}$' AND provider_idempotency_key='organization-schedule:'||command_id::text||':'||kind AND request_payload->>'kind'=kind AND jsonb_typeof(request_payload)='object' AND ((kind='schedule_create' AND predecessor_id IS NULL AND request_payload->>'subscriptionId'=subscription_id AND request_payload-ARRAY['kind','subscriptionId']='{}'::jsonb) OR (kind IN ('schedule_configure','schedule_release') AND predecessor_id IS NOT NULL AND request_payload->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$' AND jsonb_typeof(request_payload->'params')='object' AND request_payload-ARRAY['kind','scheduleId','params']='{}'::jsonb AND (kind<>'schedule_release' OR request_payload->'params'='{"preserve_cancel_date":true}'::jsonb)))) IS TRUE);
;
CREATE OR REPLACE FUNCTION guard_organization_schedule_effect() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command record; quote record; source record; predecessor record;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Schedule effect audit cannot be deleted' USING ERRCODE='23514'; END IF;
 SELECT * INTO command FROM billing_subscription_commands WHERE id=NEW.command_id AND organization_id=NEW.organization_id FOR UPDATE;
 IF NOT FOUND OR command.kind<>'downgrade' OR command.app_id IS NOT NULL OR command.billing_scope_id IS NOT NULL OR command.merchant_key<>'platform' THEN
  RAISE EXCEPTION 'Schedule effect requires its original platform downgrade' USING ERRCODE='23514';
 END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=command.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.review->>'kind' IS DISTINCT FROM 'downgrade_estimate' OR ROW(quote.actor_id,quote.subscription_id,quote.subscription_revision,quote.target_plan_key) IS DISTINCT FROM ROW(command.requested_by_user_id,command.subscription_id,command.expected_subscription_revision,command.target_plan_key) THEN
  RAISE EXCEPTION 'Schedule effect requires its original consumed review' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' THEN
  SELECT * INTO source FROM billing_subscriptions WHERE id=command.subscription_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(NEW.customer_id,NEW.subscription_id) OR (source.provider_environment='live') IS DISTINCT FROM NEW.livemode OR source.lifecycle_revision<>command.expected_subscription_revision
   OR NEW.state<>'ready' OR command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR (NEW.kind<>'schedule_release' AND quote.expires_at<=clock_timestamp()) OR NEW.created_at>clock_timestamp() THEN
   RAISE EXCEPTION 'Schedule effect must begin ready under live original source' USING ERRCODE='23514';
  END IF;
 ELSE
  IF (to_jsonb(NEW)-ARRAY['state','started_at','started_generation','started_lease_token','receipt','receipt_digest','observed_at','observation_generation','observation_lease_token']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','started_at','started_generation','started_lease_token','receipt','receipt_digest','observed_at','observation_generation','observation_lease_token']) THEN
   RAISE EXCEPTION 'Schedule effect request is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state='observed' AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN RAISE EXCEPTION 'Schedule effect receipt is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.state<>'ready' AND ROW(NEW.started_at,NEW.started_generation,NEW.started_lease_token) IS DISTINCT FROM ROW(OLD.started_at,OLD.started_generation,OLD.started_lease_token) THEN RAISE EXCEPTION 'Schedule effect dispatch cannot be reset' USING ERRCODE='23514'; END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT ((OLD.state='ready' AND NEW.state='started') OR (OLD.state='started' AND NEW.state='observed')) THEN RAISE EXCEPTION 'Schedule effect transition is invalid' USING ERRCODE='23514'; END IF;
  IF OLD.state='ready' AND NEW.state='started' THEN
   IF command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR ROW(NEW.started_generation,NEW.started_lease_token) IS DISTINCT FROM ROW(command.execution_generation,command.lease_token) OR NEW.started_at>clock_timestamp() OR (NEW.kind<>'schedule_release' AND quote.expires_at<=clock_timestamp()) THEN
    RAISE EXCEPTION 'Schedule dispatch requires the current original lease and live review' USING ERRCODE='23514';
   END IF;
  END IF;
  IF OLD.state='started' AND NEW.state='observed' THEN
   IF command.status<>'OUTCOME_UNKNOWN' OR command.lease_token IS NULL OR command.lease_expires_at IS NULL OR command.lease_expires_at<=clock_timestamp() OR ROW(NEW.observation_generation,NEW.observation_lease_token) IS DISTINCT FROM ROW(command.execution_generation,command.lease_token) OR NEW.observed_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Schedule observation requires the current original lease' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 IF NEW.kind IN ('schedule_configure','schedule_release') THEN
  SELECT * INTO predecessor FROM organization_schedule_effects WHERE id=NEW.predecessor_id AND command_id=NEW.command_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR predecessor.kind<>'schedule_create' OR predecessor.state<>'observed' OR NEW.request_payload->>'scheduleId' IS DISTINCT FROM predecessor.receipt->>'scheduleId' OR (NEW.receipt IS NOT NULL AND NEW.receipt->>'scheduleId' IS DISTINCT FROM predecessor.receipt->>'scheduleId') THEN
   RAISE EXCEPTION 'Schedule configure requires its original observed create' USING ERRCODE='23514';
  END IF;
 END IF;

 IF NEW.kind='schedule_release' AND EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=NEW.command_id AND kind='schedule_configure' AND state<>'ready') THEN
  RAISE EXCEPTION 'Unknown or observed configuration cannot be compensated by release' USING ERRCODE='23514';
 END IF;
 IF NEW.kind='schedule_configure' AND EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=NEW.command_id AND kind='schedule_release') THEN
  RAISE EXCEPTION 'Configuration cannot race an original compensation release' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('3fade468803bd80b224f8e091c3945f94cca6de9295f847fa62266c4ce7ff153', 1796083200141);
-- apply 0524_organization_schedule_compensation_result
-- A proven original partial-create release retires the downgrade without publishing a plan.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_schedule_failure_evidence jsonb;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_schedule_failure_evidence_shape CHECK (
 organization_schedule_failure_evidence IS NULL OR (
  kind='downgrade' AND app_id IS NULL AND billing_scope_id IS NULL AND merchant_key='platform'
  AND status='FAILED' AND error_code='ORIGINAL_SCHEDULE_CREATE_COMPENSATED'
  AND jsonb_typeof(organization_schedule_failure_evidence)='object'
  AND organization_schedule_failure_evidence->>'kind'='original_unconfigured_schedule_released'
  AND organization_schedule_failure_evidence->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$'
  AND organization_schedule_failure_evidence->>'createReceiptDigest' ~ '^[a-f0-9]{64}$'
  AND organization_schedule_failure_evidence->>'releaseReceiptDigest' ~ '^[a-f0-9]{64}$'
  AND organization_schedule_failure_evidence->>'snapshotDigest' ~ '^[a-f0-9]{64}$'
  AND organization_schedule_failure_evidence->>'retainedTermsDigest' ~ '^[a-f0-9]{64}$'
  AND organization_schedule_failure_evidence->>'sourceDigest' ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof(organization_schedule_failure_evidence->'quoteId')='string'
  AND jsonb_typeof(organization_schedule_failure_evidence->'createEffectId')='string'
  AND jsonb_typeof(organization_schedule_failure_evidence->'releaseEffectId')='string'
  AND jsonb_typeof(organization_schedule_failure_evidence->'observedAt')='string'
  AND organization_schedule_failure_evidence-ARRAY['kind','scheduleId','createReceiptDigest','releaseReceiptDigest','snapshotDigest','retainedTermsDigest','sourceDigest','quoteId','createEffectId','releaseEffectId','observedAt']='{}'::jsonb
 ) IS TRUE
);
;
CREATE FUNCTION guard_organization_schedule_compensation_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof jsonb; created_effect record; released_effect record; quote record; terms record; source record;
BEGIN
 IF TG_OP='UPDATE' AND OLD.organization_schedule_failure_evidence IS NOT NULL THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Original compensated schedule result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 proof=NEW.organization_schedule_failure_evidence;
 IF proof IS NULL THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN' OR NEW.status<>'FAILED'
 OR OLD.lease_token IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
 OR NEW.execution_generation<>OLD.execution_generation OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.provider_response_digest IS NULL OR NEW.provider_response_digest !~ '^[a-f0-9]{64}$'
 OR NEW.completed_at IS NULL OR NEW.completed_at>clock_timestamp()
 OR NEW.applied_at IS NOT NULL OR NEW.result_subscription_id IS NOT NULL OR NEW.result_subscription_revision IS NOT NULL
 OR ((proof->>'observedAt')::timestamptz<=clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Compensated schedule result requires a live original observation lease' USING ERRCODE='23514'; END IF;
 SELECT * INTO created_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_create';
 IF NOT FOUND OR created_effect.state<>'observed' OR created_effect.id::text IS DISTINCT FROM proof->>'createEffectId'
 OR created_effect.receipt_digest IS DISTINCT FROM proof->>'createReceiptDigest' OR created_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId' THEN
  RAISE EXCEPTION 'Compensated result requires exact original created receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO released_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_release';
 IF NOT FOUND OR released_effect.state<>'observed' OR released_effect.predecessor_id IS DISTINCT FROM created_effect.id
 OR released_effect.id::text IS DISTINCT FROM proof->>'releaseEffectId' OR released_effect.receipt_digest IS DISTINCT FROM proof->>'releaseReceiptDigest'
 OR released_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId'
 OR (proof->>'observedAt')::timestamptz<released_effect.observed_at
 OR EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=NEW.id AND kind='schedule_configure' AND state<>'ready') THEN
  RAISE EXCEPTION 'Compensated result requires exact original unconfigured release' USING ERRCODE='23514'; END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.id::text IS DISTINCT FROM proof->>'quoteId' OR quote.source_digest IS DISTINCT FROM proof->>'sourceDigest' THEN
  RAISE EXCEPTION 'Compensated result requires its original quote' USING ERRCODE='23514'; END IF;
 SELECT * INTO terms FROM organization_schedule_quote_terms WHERE quote_id=quote.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR terms.snapshot_digest IS DISTINCT FROM proof->>'retainedTermsDigest' THEN
  RAISE EXCEPTION 'Compensated result requires original retained settings' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.lifecycle_revision IS DISTINCT FROM NEW.expected_subscription_revision OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform'
 OR ((proof->>'observedAt')::timestamptz>=source.current_period_start AND (proof->>'observedAt')::timestamptz<source.current_period_end) IS NOT TRUE
 OR source.status<>'active' OR source.cancel_at_period_end OR source.pending_plan_key IS NOT NULL OR source.ended_at IS NOT NULL OR source.dunning_started_at IS NOT NULL OR source.grace_expires_at IS NOT NULL
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(created_effect.customer_id,created_effect.subscription_id)
 OR (source.provider_environment='live') IS DISTINCT FROM created_effect.livemode
 OR (terms.snapshot->'subscription'->>'current_period_start')::bigint IS DISTINCT FROM extract(epoch FROM source.current_period_start)::bigint
 OR (terms.snapshot->'subscription'->>'current_period_end')::bigint IS DISTINCT FROM extract(epoch FROM source.current_period_end)::bigint
 OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND stripe_customer_id=source.stripe_customer_id)
 OR NOT EXISTS(SELECT 1 FROM organization_subscription_authorities WHERE organization_id=NEW.organization_id AND subscription_id=source.id AND state='current')
 OR NOT EXISTS(SELECT 1 FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL AND source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision) THEN
  RAISE EXCEPTION 'Compensated result requires unchanged current source and projection' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
;
CREATE TRIGGER organization_schedule_compensation_result_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_compensation_result();
;
CREATE OR REPLACE FUNCTION guard_organization_schedule_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id) THEN RETURN NEW; END IF;
 IF ROW(NEW.organization_id,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision,NEW.kind,NEW.target_plan_key,NEW.request_digest,NEW.provider_idempotency_key,NEW.app_id,NEW.billing_scope_id,NEW.merchant_key,NEW.provider_started_at)
  IS DISTINCT FROM ROW(OLD.organization_id,OLD.requested_by_user_id,OLD.subscription_id,OLD.expected_subscription_revision,OLD.kind,OLD.target_plan_key,OLD.request_digest,OLD.provider_idempotency_key,OLD.app_id,OLD.billing_scope_id,OLD.merchant_key,OLD.provider_started_at) THEN
  RAISE EXCEPTION 'Original schedule command authority cannot change' USING ERRCODE='23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  OLD.status='OUTCOME_UNKNOWN' AND NEW.status='FAILED'
  AND EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id AND kind='schedule_create' AND state='ready')
  AND NOT EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id AND (kind<>'schedule_create' OR state<>'ready'))
 ) AND NOT (OLD.status='OUTCOME_UNKNOWN' AND NEW.status='FAILED' AND NEW.organization_schedule_failure_evidence IS NOT NULL) THEN RAISE EXCEPTION 'Schedule effects require original outcome reconciliation before terminal publication' USING ERRCODE='23514'; END IF;
 IF NEW.execution_generation IS DISTINCT FROM OLD.execution_generation OR (NEW.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
  IF NEW.status<>'OUTCOME_UNKNOWN' OR NEW.execution_generation<>OLD.execution_generation+1 OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()) THEN
   RAISE EXCEPTION 'Schedule lease replacement requires an expired original generation' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.lease_token IS NOT NULL AND NEW.lease_expires_at>OLD.lease_expires_at THEN
  RAISE EXCEPTION 'Schedule lease cannot be extended or revived in place' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('326722310762831d852239f0fc29b8b02afbeda6cf446303d241ac18e047c5e7', 1796083200142);
-- apply 0525_organization_schedule_configured_result
-- A proven original configuration publishes pending state, never an immediate paid-plan change.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_schedule_configuration_evidence jsonb;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_schedule_configuration_evidence_shape CHECK (
organization_schedule_configuration_evidence IS NULL OR (
 kind='downgrade' AND app_id IS NULL AND billing_scope_id IS NULL AND merchant_key='platform' AND status='APPLIED'
 AND jsonb_typeof(organization_schedule_configuration_evidence)='object'
 AND organization_schedule_configuration_evidence->>'kind'='original_schedule_configured'
 AND organization_schedule_configuration_evidence->>'targetPlanKey' IN ('plus_monthly','pro_monthly')
 AND jsonb_typeof(organization_schedule_configuration_evidence->'effectiveAt')='number'
 AND organization_schedule_configuration_evidence->>'effectiveAt' ~ '^[0-9]+$'
 AND organization_schedule_configuration_evidence->>'scheduleId' ~ '^sub_sched_[A-Za-z0-9]+$'
 AND organization_schedule_configuration_evidence ?& ARRAY['kind','effectiveAt','targetPlanKey','scheduleId','requestDigest','snapshotDigest','retainedTermsDigest','reviewDigest','providerBindingDigest','quoteId','sourceDigest','createEffectId','configurationEffectId','createReceiptDigest','configurationReceiptDigest','observedAt']
 AND organization_schedule_configuration_evidence-ARRAY['kind','effectiveAt','targetPlanKey','scheduleId','requestDigest','snapshotDigest','retainedTermsDigest','reviewDigest','providerBindingDigest','quoteId','sourceDigest','createEffectId','configurationEffectId','createReceiptDigest','configurationReceiptDigest','observedAt']='{}'::jsonb
 AND organization_schedule_configuration_evidence->>'requestDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'snapshotDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'retainedTermsDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'reviewDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'providerBindingDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(organization_schedule_configuration_evidence->'quoteId')='string'
 AND organization_schedule_configuration_evidence->>'sourceDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(organization_schedule_configuration_evidence->'createEffectId')='string'
 AND jsonb_typeof(organization_schedule_configuration_evidence->'configurationEffectId')='string'
 AND organization_schedule_configuration_evidence->>'createReceiptDigest' ~ '^[a-f0-9]{64}$'
 AND organization_schedule_configuration_evidence->>'configurationReceiptDigest' ~ '^[a-f0-9]{64}$'
 AND jsonb_typeof(organization_schedule_configuration_evidence->'observedAt')='string'
) IS TRUE
);
;
CREATE FUNCTION guard_organization_schedule_configured_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof jsonb; created_effect record; configured_effect record; quote record; terms record; source record; previous record; result record;
BEGIN
 IF TG_OP='UPDATE' AND OLD.organization_schedule_configuration_evidence IS NOT NULL THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Original configured schedule result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 proof=NEW.organization_schedule_configuration_evidence;
 IF proof IS NULL THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN' OR NEW.status<>'APPLIED'
 OR OLD.lease_token IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
 OR NEW.execution_generation<>OLD.execution_generation OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.provider_response_digest IS NULL OR NEW.provider_response_digest !~ '^[a-f0-9]{64}$'
 OR NEW.completed_at IS NULL OR NEW.completed_at>clock_timestamp() OR NEW.applied_at IS NULL OR NEW.applied_at>clock_timestamp()
 OR NEW.result_subscription_id IS DISTINCT FROM NEW.subscription_id
 OR NEW.result_subscription_revision IS DISTINCT FROM NEW.expected_subscription_revision+1
 OR ((proof->>'observedAt')::timestamptz<=clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Configured result requires live original lease and next revision' USING ERRCODE='23514'; END IF;
 SELECT * INTO created_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_create';
 IF NOT FOUND OR created_effect.state<>'observed' OR created_effect.id::text IS DISTINCT FROM proof->>'createEffectId'
 OR created_effect.receipt_digest IS DISTINCT FROM proof->>'createReceiptDigest' OR created_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId' THEN
  RAISE EXCEPTION 'Configured result requires original create receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO configured_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_configure';
 IF NOT FOUND OR configured_effect.state<>'observed' OR configured_effect.predecessor_id IS DISTINCT FROM created_effect.id
 OR configured_effect.id::text IS DISTINCT FROM proof->>'configurationEffectId' OR configured_effect.receipt_digest IS DISTINCT FROM proof->>'configurationReceiptDigest'
 OR configured_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId' OR configured_effect.request_digest IS DISTINCT FROM proof->>'requestDigest'
 OR (proof->>'observedAt')::timestamptz<configured_effect.observed_at
 OR EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=NEW.id AND kind='schedule_release') THEN
  RAISE EXCEPTION 'Configured result requires original configuration and no compensation' USING ERRCODE='23514'; END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.id::text IS DISTINCT FROM proof->>'quoteId' OR quote.source_digest IS DISTINCT FROM proof->>'sourceDigest'
 OR quote.review_digest IS DISTINCT FROM proof->>'reviewDigest' OR quote.target_plan_key IS DISTINCT FROM proof->>'targetPlanKey'
 OR quote.target_plan_key IS DISTINCT FROM NEW.target_plan_key
 OR configured_effect.started_at>=quote.expires_at OR configured_effect.started_at<(quote.review->>'observedAt')::timestamptz
 OR configured_effect.request_payload#>>'{params,phases,1,items,0,price}' IS DISTINCT FROM quote.provider_binding->>'targetPriceId'
 OR (proof->>'effectiveAt')::bigint IS DISTINCT FROM extract(epoch FROM (quote.review->>'effectiveAt')::timestamptz)::bigint THEN
  RAISE EXCEPTION 'Configured result requires exact original reviewed target' USING ERRCODE='23514'; END IF;
 SELECT * INTO terms FROM organization_schedule_quote_terms WHERE quote_id=quote.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR terms.snapshot_digest IS DISTINCT FROM proof->>'retainedTermsDigest' THEN
  RAISE EXCEPTION 'Configured result requires original retained settings' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.expected_subscription_revision;
 IF NOT FOUND OR previous.pending_plan_key IS NOT NULL OR previous.status<>'active' OR previous.cancel_at_period_end OR previous.ended_at IS NOT NULL OR previous.dunning_started_at IS NOT NULL OR previous.grace_expires_at IS NOT NULL THEN
  RAISE EXCEPTION 'Configured result requires eligible original paid revision' USING ERRCODE='23514'; END IF;
 SELECT * INTO result FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.result_subscription_revision;
 IF NOT FOUND OR result.pending_plan_key IS DISTINCT FROM NEW.target_plan_key OR result.source<>'reconciliation'
 OR result.provider_event_id IS NOT NULL OR result.provider_event_created_at IS NOT NULL
 OR result.provider_object_digest IS DISTINCT FROM NEW.provider_response_digest
 OR (to_jsonb(previous)-ARRAY['id','revision','source','recorded_at','pending_plan_key','provider_object_digest','provider_event_id','provider_event_created_at'])
    IS DISTINCT FROM (to_jsonb(result)-ARRAY['id','revision','source','recorded_at','pending_plan_key','provider_object_digest','provider_event_id','provider_event_created_at']) THEN
  RAISE EXCEPTION 'Configured result must preserve all paid revision fields' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.lifecycle_revision IS DISTINCT FROM NEW.result_subscription_revision OR source.pending_plan_key IS DISTINCT FROM NEW.target_plan_key
 OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform' OR source.plan_key IS DISTINCT FROM previous.plan_key
 OR source.provider_object_digest IS DISTINCT FROM NEW.provider_response_digest
 OR clock_timestamp()>=source.current_period_end
 OR ROW(source.billing_scope_id,source.merchant_key,source.plan_revision_id,source.trial_start,source.trial_end,source.quantity,source.provider,source.provider_environment,source.stripe_customer_id,source.stripe_subscription_id,source.stripe_subscription_item_id,source.catalog_version,source.plan_key,source.status,source.current_period_start,source.current_period_end,source.cancel_at_period_end,source.canceled_at,source.ended_at,source.dunning_started_at,source.grace_expires_at,source.pending_plan_key,source.provider_object_digest) IS DISTINCT FROM ROW(result.billing_scope_id,result.merchant_key,result.plan_revision_id,result.trial_start,result.trial_end,result.quantity,result.provider,result.provider_environment,result.stripe_customer_id,result.stripe_subscription_id,result.stripe_subscription_item_id,result.catalog_version,result.plan_key,result.status,result.current_period_start,result.current_period_end,result.cancel_at_period_end,result.canceled_at,result.ended_at,result.dunning_started_at,result.grace_expires_at,result.pending_plan_key,result.provider_object_digest)
 OR ((proof->>'observedAt')::timestamptz>=source.current_period_start AND (proof->>'observedAt')::timestamptz<source.current_period_end) IS NOT TRUE
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(created_effect.customer_id,created_effect.subscription_id)
 OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND stripe_customer_id=source.stripe_customer_id AND is_active AND account_lifecycle_state='active' AND paid_work_fenced_at IS NULL AND account_deletion_request_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM organization_subscription_authorities WHERE organization_id=NEW.organization_id AND subscription_id=source.id AND state='current')
 OR NOT EXISTS(SELECT 1 FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL AND source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision AND plan_key=previous.plan_key)
 OR EXISTS(SELECT 1 FROM subscription_allowance_transactions WHERE source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision) THEN
  RAISE EXCEPTION 'Configured result requires current projection without a new allowance posting' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
;
CREATE TRIGGER organization_schedule_configured_result_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_configured_result();
;
CREATE OR REPLACE FUNCTION guard_organization_schedule_command() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id) THEN RETURN NEW; END IF;
 IF ROW(NEW.organization_id,NEW.requested_by_user_id,NEW.subscription_id,NEW.expected_subscription_revision,NEW.kind,NEW.target_plan_key,NEW.request_digest,NEW.provider_idempotency_key,NEW.app_id,NEW.billing_scope_id,NEW.merchant_key,NEW.provider_started_at)
  IS DISTINCT FROM ROW(OLD.organization_id,OLD.requested_by_user_id,OLD.subscription_id,OLD.expected_subscription_revision,OLD.kind,OLD.target_plan_key,OLD.request_digest,OLD.provider_idempotency_key,OLD.app_id,OLD.billing_scope_id,OLD.merchant_key,OLD.provider_started_at) THEN
  RAISE EXCEPTION 'Original schedule command authority cannot change' USING ERRCODE='23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
  OLD.status='OUTCOME_UNKNOWN' AND NEW.status='FAILED'
  AND EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id AND kind='schedule_create' AND state='ready')
  AND NOT EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=OLD.id AND (kind<>'schedule_create' OR state<>'ready'))
 ) AND NOT (OLD.status='OUTCOME_UNKNOWN' AND NEW.status='FAILED' AND NEW.organization_schedule_failure_evidence IS NOT NULL) AND NOT (OLD.status='OUTCOME_UNKNOWN' AND NEW.status='APPLIED' AND NEW.organization_schedule_configuration_evidence IS NOT NULL) THEN RAISE EXCEPTION 'Schedule effects require original outcome reconciliation before terminal publication' USING ERRCODE='23514'; END IF;
 IF NEW.execution_generation IS DISTINCT FROM OLD.execution_generation OR (NEW.lease_token IS NOT NULL AND NEW.lease_token IS DISTINCT FROM OLD.lease_token) THEN
  IF NEW.status<>'OUTCOME_UNKNOWN' OR NEW.execution_generation<>OLD.execution_generation+1 OR NEW.lease_token IS NULL OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token OR (OLD.lease_expires_at IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()) THEN
   RAISE EXCEPTION 'Schedule lease replacement requires an expired original generation' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.lease_token IS NOT NULL AND NEW.lease_expires_at>OLD.lease_expires_at THEN
  RAISE EXCEPTION 'Schedule lease cannot be extended or revived in place' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
;
ALTER TABLE billing_subscription_commands DROP CONSTRAINT billing_subscription_commands_cancellation_result_check;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_subscription_commands_cancellation_result_check CHECK (
(app_id IS NOT NULL OR ((kind IN ('cancel','resume','upgrade') AND status = 'APPLIED' AND result_subscription_id IS NOT NULL AND subscription_id IS NOT NULL AND result_subscription_id = subscription_id AND result_subscription_revision IS NOT NULL AND result_subscription_revision > 0) OR ((kind NOT IN ('cancel','resume','upgrade') OR status <> 'APPLIED') AND result_subscription_revision IS NULL))) OR (app_id IS NULL AND billing_scope_id IS NULL AND kind='downgrade' AND status='APPLIED' AND organization_schedule_configuration_evidence IS NOT NULL AND subscription_id IS NOT NULL AND result_subscription_id=subscription_id AND result_subscription_revision=expected_subscription_revision+1) IS TRUE
);
;
ALTER TABLE billing_subscription_commands DROP CONSTRAINT billing_subscription_commands_status_shape_check;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT billing_subscription_commands_status_shape_check CHECK (
(status = 'PREPARED' AND execution_generation = 0 AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NULL AND completed_at IS NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'OUTCOME_UNKNOWN' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NULL AND completed_at IS NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'SUCCEEDED' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'APPLIED' AND (billing_scope_id IS NOT NULL OR kind IN ('checkout','cancel','resume','upgrade') OR (kind='downgrade' AND organization_schedule_configuration_evidence IS NOT NULL)) AND execution_generation > 0 AND provider_started_at IS NOT NULL AND provider_response_digest IS NOT NULL AND error_code IS NULL AND completed_at IS NOT NULL AND (result_subscription_id IS NOT NULL OR kind = 'import') AND applied_at IS NOT NULL) OR (status = 'FAILED' AND execution_generation > 0 AND provider_started_at IS NOT NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL) OR (status = 'SUPERSEDED' AND execution_generation = 0 AND provider_started_at IS NULL AND provider_response_digest IS NULL AND error_code IS NOT NULL AND completed_at IS NOT NULL AND result_subscription_id IS NULL AND applied_at IS NULL)
);
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('d10668a072213ceebf82f42f9272228c57d5ac6274e39966d4a8ef2e397d1ea3', 1796083200143);
-- apply 0526_organization_schedule_configured_snapshot
-- Retain original verified state beyond the provider's finite event-history window.
-- Historical terminal commands stay unchanged; missing snapshots are unavailable evidence.
ALTER TABLE billing_subscription_commands ADD COLUMN organization_schedule_configuration_snapshot jsonb;
;
ALTER TABLE billing_subscription_commands ADD CONSTRAINT organization_schedule_configuration_snapshot_shape CHECK (
 organization_schedule_configuration_snapshot IS NULL OR (
  organization_schedule_configuration_evidence IS NOT NULL
  AND jsonb_typeof(organization_schedule_configuration_snapshot)='object'
  AND NOT organization_schedule_configuration_snapshot ? 'lastResponse'
 ) IS TRUE
);
;
CREATE FUNCTION guard_organization_schedule_configured_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot jsonb; proof jsonb; original_effect record;
BEGIN
 snapshot=NEW.organization_schedule_configuration_snapshot;
 proof=NEW.organization_schedule_configuration_evidence;
 IF TG_OP='UPDATE' AND OLD.organization_schedule_configuration_evidence IS NOT NULL THEN
  IF snapshot IS DISTINCT FROM OLD.organization_schedule_configuration_snapshot THEN
   RAISE EXCEPTION 'Original configured snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF proof IS NULL THEN
  IF snapshot IS NOT NULL THEN RAISE EXCEPTION 'Configured snapshot requires original publication' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN' OR NEW.status<>'APPLIED' OR snapshot IS NULL THEN
  RAISE EXCEPTION 'Configured publication requires its original snapshot' USING ERRCODE='23514';
 END IF;
 SELECT * INTO original_effect FROM organization_schedule_effects
 WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_configure';
 IF NOT FOUND OR (
  jsonb_typeof(snapshot)='object'
  AND snapshot->>'object'='subscription_schedule'
  AND snapshot->>'id'=proof->>'scheduleId'
  AND snapshot->>'customer'=original_effect.customer_id
  AND snapshot->>'subscription'=original_effect.subscription_id
  AND snapshot->'livemode'=to_jsonb(original_effect.livemode)
  AND snapshot->>'status'='active' AND snapshot->>'end_behavior'='release'
  AND jsonb_typeof(snapshot->'phases')='array' AND jsonb_array_length(snapshot->'phases')=2
  AND snapshot#>'{current_phase,start_date}'=original_effect.request_payload#>'{params,phases,0,start_date}'
  AND snapshot#>'{current_phase,end_date}'=proof->'effectiveAt'
  AND snapshot#>'{phases,0,start_date}'=snapshot#>'{current_phase,start_date}'
  AND snapshot#>'{phases,0,end_date}'=proof->'effectiveAt'
  AND snapshot#>'{phases,1,start_date}'=proof->'effectiveAt'
  AND snapshot#>>'{phases,0,items,0,price}'=original_effect.request_payload#>>'{params,phases,0,items,0,price}'
  AND snapshot#>>'{phases,1,items,0,price}'=original_effect.request_payload#>>'{params,phases,1,items,0,price}'
 ) IS NOT TRUE THEN
  RAISE EXCEPTION 'Configured snapshot requires original schedule scope and target' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
;
CREATE TRIGGER organization_schedule_configured_snapshot_guard BEFORE INSERT OR UPDATE ON billing_subscription_commands FOR EACH ROW EXECUTE FUNCTION guard_organization_schedule_configured_snapshot();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('689c301d19786e25a5a2ba7286d0eb8665d508c1161f61c84f7dbdfbd83523d3', 1796083200144);
-- apply 0527_organization_schedule_late_configuration
-- Read-only recovery can record the original pending configuration after the paid boundary.
-- Provider evidence/live compatibility are verified by the service before publication.
-- Keep exact original dispatch, source/lease/organization fencing, expired entitlement
-- deadline and no new allowance posting; configuration never proves payment.
CREATE OR REPLACE FUNCTION guard_organization_schedule_configured_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof jsonb; created_effect record; configured_effect record; quote record; terms record; source record; previous record; result record;
BEGIN
 IF TG_OP='UPDATE' AND OLD.organization_schedule_configuration_evidence IS NOT NULL THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Original configured schedule result is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 proof=NEW.organization_schedule_configuration_evidence;
 IF proof IS NULL THEN RETURN NEW; END IF;
 IF TG_OP<>'UPDATE' OR OLD.status<>'OUTCOME_UNKNOWN' OR NEW.status<>'APPLIED'
 OR OLD.lease_token IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
 OR NEW.execution_generation<>OLD.execution_generation OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.provider_response_digest IS NULL OR NEW.provider_response_digest !~ '^[a-f0-9]{64}$'
 OR NEW.completed_at IS NULL OR NEW.completed_at>clock_timestamp() OR NEW.applied_at IS NULL OR NEW.applied_at>clock_timestamp()
 OR NEW.result_subscription_id IS DISTINCT FROM NEW.subscription_id
 OR NEW.result_subscription_revision IS DISTINCT FROM NEW.expected_subscription_revision+1
 OR ((proof->>'observedAt')::timestamptz<=clock_timestamp()) IS NOT TRUE THEN
  RAISE EXCEPTION 'Configured result requires live original lease and next revision' USING ERRCODE='23514'; END IF;
 SELECT * INTO created_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_create';
 IF NOT FOUND OR created_effect.state<>'observed' OR created_effect.id::text IS DISTINCT FROM proof->>'createEffectId'
 OR created_effect.receipt_digest IS DISTINCT FROM proof->>'createReceiptDigest' OR created_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId' THEN
  RAISE EXCEPTION 'Configured result requires original create receipt' USING ERRCODE='23514'; END IF;
 SELECT * INTO configured_effect FROM organization_schedule_effects WHERE command_id=NEW.id AND organization_id=NEW.organization_id AND kind='schedule_configure';
 IF NOT FOUND OR configured_effect.state<>'observed' OR configured_effect.predecessor_id IS DISTINCT FROM created_effect.id
 OR configured_effect.id::text IS DISTINCT FROM proof->>'configurationEffectId' OR configured_effect.receipt_digest IS DISTINCT FROM proof->>'configurationReceiptDigest'
 OR configured_effect.receipt->>'scheduleId' IS DISTINCT FROM proof->>'scheduleId' OR configured_effect.request_digest IS DISTINCT FROM proof->>'requestDigest'
 OR (proof->>'observedAt')::timestamptz<configured_effect.observed_at
 OR EXISTS(SELECT 1 FROM organization_schedule_effects WHERE command_id=NEW.id AND kind='schedule_release') THEN
  RAISE EXCEPTION 'Configured result requires original configuration and no compensation' USING ERRCODE='23514'; END IF;
 SELECT * INTO quote FROM organization_plan_change_quotes WHERE consumed_by_command_id=NEW.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR quote.id::text IS DISTINCT FROM proof->>'quoteId' OR quote.source_digest IS DISTINCT FROM proof->>'sourceDigest'
 OR quote.review_digest IS DISTINCT FROM proof->>'reviewDigest' OR quote.target_plan_key IS DISTINCT FROM proof->>'targetPlanKey'
 OR quote.target_plan_key IS DISTINCT FROM NEW.target_plan_key
 OR configured_effect.started_at>=quote.expires_at OR configured_effect.started_at<(quote.review->>'observedAt')::timestamptz
 OR configured_effect.request_payload#>>'{params,phases,1,items,0,price}' IS DISTINCT FROM quote.provider_binding->>'targetPriceId'
 OR (proof->>'effectiveAt')::bigint IS DISTINCT FROM extract(epoch FROM (quote.review->>'effectiveAt')::timestamptz)::bigint THEN
  RAISE EXCEPTION 'Configured result requires exact original reviewed target' USING ERRCODE='23514'; END IF;
 SELECT * INTO terms FROM organization_schedule_quote_terms WHERE quote_id=quote.id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR terms.snapshot_digest IS DISTINCT FROM proof->>'retainedTermsDigest' THEN
  RAISE EXCEPTION 'Configured result requires original retained settings' USING ERRCODE='23514'; END IF;
 SELECT * INTO previous FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.expected_subscription_revision;
 IF NOT FOUND OR previous.pending_plan_key IS NOT NULL OR previous.status<>'active' OR previous.cancel_at_period_end OR previous.ended_at IS NOT NULL OR previous.dunning_started_at IS NOT NULL OR previous.grace_expires_at IS NOT NULL THEN
  RAISE EXCEPTION 'Configured result requires eligible original paid revision' USING ERRCODE='23514'; END IF;
 SELECT * INTO result FROM billing_subscription_revisions WHERE subscription_id=NEW.subscription_id AND organization_id=NEW.organization_id AND revision=NEW.result_subscription_revision;
 IF NOT FOUND OR result.pending_plan_key IS DISTINCT FROM NEW.target_plan_key OR result.source<>'reconciliation'
 OR result.provider_event_id IS NOT NULL OR result.provider_event_created_at IS NOT NULL
 OR result.provider_object_digest IS DISTINCT FROM NEW.provider_response_digest
 OR (to_jsonb(previous)-ARRAY['id','revision','source','recorded_at','pending_plan_key','provider_object_digest','provider_event_id','provider_event_created_at'])
    IS DISTINCT FROM (to_jsonb(result)-ARRAY['id','revision','source','recorded_at','pending_plan_key','provider_object_digest','provider_event_id','provider_event_created_at']) THEN
  RAISE EXCEPTION 'Configured result must preserve all paid revision fields' USING ERRCODE='23514'; END IF;
 SELECT * INTO source FROM billing_subscriptions WHERE id=NEW.subscription_id AND organization_id=NEW.organization_id;
 IF NOT FOUND OR source.lifecycle_revision IS DISTINCT FROM NEW.result_subscription_revision OR source.pending_plan_key IS DISTINCT FROM NEW.target_plan_key
 OR source.billing_scope_id IS NOT NULL OR source.merchant_key<>'platform' OR source.plan_key IS DISTINCT FROM previous.plan_key
 OR source.provider_object_digest IS DISTINCT FROM NEW.provider_response_digest
 OR ROW(source.billing_scope_id,source.merchant_key,source.plan_revision_id,source.trial_start,source.trial_end,source.quantity,source.provider,source.provider_environment,source.stripe_customer_id,source.stripe_subscription_id,source.stripe_subscription_item_id,source.catalog_version,source.plan_key,source.status,source.current_period_start,source.current_period_end,source.cancel_at_period_end,source.canceled_at,source.ended_at,source.dunning_started_at,source.grace_expires_at,source.pending_plan_key,source.provider_object_digest) IS DISTINCT FROM ROW(result.billing_scope_id,result.merchant_key,result.plan_revision_id,result.trial_start,result.trial_end,result.quantity,result.provider,result.provider_environment,result.stripe_customer_id,result.stripe_subscription_id,result.stripe_subscription_item_id,result.catalog_version,result.plan_key,result.status,result.current_period_start,result.current_period_end,result.cancel_at_period_end,result.canceled_at,result.ended_at,result.dunning_started_at,result.grace_expires_at,result.pending_plan_key,result.provider_object_digest)
 OR ((proof->>'observedAt')::timestamptz>=source.current_period_start) IS NOT TRUE
 OR (configured_effect.started_at>=source.current_period_start AND configured_effect.started_at<source.current_period_end) IS NOT TRUE
 OR source.current_period_end IS DISTINCT FROM to_timestamp((proof->>'effectiveAt')::bigint)
 OR ROW(source.stripe_customer_id,source.stripe_subscription_id) IS DISTINCT FROM ROW(created_effect.customer_id,created_effect.subscription_id)
 OR NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND stripe_customer_id=source.stripe_customer_id AND is_active AND account_lifecycle_state='active' AND paid_work_fenced_at IS NULL AND account_deletion_request_id IS NULL)
 OR NOT EXISTS(SELECT 1 FROM organization_subscription_authorities WHERE organization_id=NEW.organization_id AND subscription_id=source.id AND state='current')
 OR NOT EXISTS(SELECT 1 FROM organization_entitlements WHERE organization_id=NEW.organization_id AND billing_scope_id IS NULL AND source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision AND plan_key=previous.plan_key AND effective_from=source.current_period_start AND effective_until=source.current_period_end)
 OR EXISTS(SELECT 1 FROM subscription_allowance_transactions WHERE source_subscription_id=source.id AND source_subscription_revision=source.lifecycle_revision) THEN
  RAISE EXCEPTION 'Configured result requires current projection without a new allowance posting' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('a198f2f372edb5a7210121956208a358d9b024eadd349469d3fb23c9c7a20a17', 1796083200145);
-- apply 0528_subscription_adjustment_observations
CREATE TABLE subscription_adjustment_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  grant_id uuid NOT NULL REFERENCES subscription_allowance_transactions(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL,
  version integer NOT NULL CHECK(version > 0),
  previous_id uuid REFERENCES subscription_adjustment_observations(id) ON DELETE RESTRICT,
  observation jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT subscription_adjustment_request_unique UNIQUE(grant_id,request_id),
  CONSTRAINT subscription_adjustment_version_unique UNIQUE(grant_id,version),
  CONSTRAINT subscription_adjustment_observation_shape CHECK ((
    jsonb_typeof(observation)='object'
    AND observation->>'kind'='renewal_adjustment_observation'
    AND observation->>'version'='1'
    AND observation->>'organizationId'=organization_id::text
    AND observation->>'digest' ~ '^[a-f0-9]{64}$'
    AND observation->>'grantDigest' ~ '^[a-f0-9]{64}$'
    AND observation->>'invoiceAuthorityDigest' ~ '^[a-f0-9]{64}$'
    AND observation->>'invoiceDetailsDigest' ~ '^[a-f0-9]{64}$'
    AND observation->>'settlementDetailsDigest' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(observation->'observation')='object'
    AND observation-ARRAY['kind','version','organizationId','subscriptionId','invoiceAuthorityDigest','invoiceDetailsDigest','settlementDetailsDigest','grantDigest','observation','digest']='{}'::jsonb
    AND isfinite(observed_at) AND observed_at<=recorded_at
  ) IS TRUE)
);
;
CREATE FUNCTION guard_subscription_adjustment_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row subscription_allowance_transactions%ROWTYPE;
DECLARE period_row subscription_allowance_periods%ROWTYPE;
DECLARE previous_row subscription_adjustment_observations%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'subscription adjustment observations are append only'; END IF;
  -- Same organization lock as funding publication; never hold it during provider reads.
  PERFORM id FROM organizations WHERE id=NEW.organization_id AND is_active=true
    AND account_lifecycle_state='active' AND account_deletion_request_id IS NULL
    AND paid_work_fenced_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription adjustment organization fenced'; END IF;
  SELECT * INTO grant_row FROM subscription_allowance_transactions WHERE id=NEW.grant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'subscription adjustment grant missing'; END IF;
  SELECT * INTO period_row FROM subscription_allowance_periods WHERE id=grant_row.allowance_period_id;
  IF NOT FOUND OR period_row.organization_id IS DISTINCT FROM NEW.organization_id
    OR period_row.billing_scope_id IS NOT NULL OR period_row.merchant_key IS DISTINCT FROM 'platform'
    OR period_row.grant_source IS DISTINCT FROM 'paid_invoice'
    OR grant_row.organization_id IS DISTINCT FROM NEW.organization_id
    OR grant_row.kind IS DISTINCT FROM 'grant' OR grant_row.billing_scope_id IS NOT NULL
    OR grant_row.merchant_key IS DISTINCT FROM 'platform'
    OR period_row.subscription_id::text IS DISTINCT FROM NEW.observation->>'subscriptionId'
    OR grant_row.request_digest IS DISTINCT FROM NEW.observation->>'grantDigest'
    OR grant_row.metadata->'renewalInvoiceAuthority'->>'digest' IS DISTINCT FROM NEW.observation->>'invoiceAuthorityDigest'
    OR grant_row.metadata->'renewalInvoiceDetails'->>'digest' IS DISTINCT FROM NEW.observation->>'invoiceDetailsDigest'
    OR grant_row.metadata->'renewalSettlementDetails'->>'digest' IS DISTINCT FROM NEW.observation->>'settlementDetailsDigest'
    OR period_row.stripe_invoice_id IS DISTINCT FROM NEW.observation->'observation'->'invoice'->>'id'
  THEN RAISE EXCEPTION 'subscription adjustment original grant mismatch'; END IF;
  SELECT * INTO previous_row FROM subscription_adjustment_observations WHERE grant_id=NEW.grant_id ORDER BY version DESC LIMIT 1;
  IF FOUND THEN
    IF NEW.previous_id IS DISTINCT FROM previous_row.id OR NEW.version<>previous_row.version+1
      OR NEW.observed_at<previous_row.observed_at
    THEN RAISE EXCEPTION 'subscription adjustment stale predecessor'; END IF;
  ELSIF NEW.previous_id IS NOT NULL OR NEW.version<>1 THEN
    RAISE EXCEPTION 'subscription adjustment initial predecessor mismatch';
  END IF;
  NEW.recorded_at:=clock_timestamp();
  RETURN NEW;
END $$;
;
CREATE TRIGGER subscription_adjustment_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_adjustment_observations FOR EACH ROW EXECUTE FUNCTION guard_subscription_adjustment_observation();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('d634a6d4414fd6ddfa29aeadaa8b3718836676af3c3ed7b72f0dc17613d434bd', 1796083200146);
-- apply 0529_subscription_adjustment_recovery
CREATE TABLE subscription_adjustment_scans (
  grant_id uuid PRIMARY KEY REFERENCES subscription_allowance_transactions(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
  failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
  next_due_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
;
CREATE TABLE subscription_adjustment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES subscription_adjustment_scans(grant_id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK(generation>0),
  lease_token uuid NOT NULL,
  expected_previous_id uuid REFERENCES subscription_adjustment_observations(id) ON DELETE RESTRICT,
  original_digest text NOT NULL CHECK(original_digest ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  disposition text NOT NULL DEFAULT 'processing',
  observation_id uuid REFERENCES subscription_adjustment_observations(id) ON DELETE RESTRICT,
  reason text,
  completed_at timestamptz,
  UNIQUE(grant_id,generation),
  CHECK(expires_at>started_at AND isfinite(expires_at)),
  CHECK(((disposition='processing' AND observation_id IS NULL AND reason IS NULL AND completed_at IS NULL)
     OR (disposition='recorded' AND observation_id IS NOT NULL AND reason IS NULL AND completed_at>=started_at)
     OR (disposition IN ('failed','superseded') AND observation_id IS NULL AND reason IS NOT NULL AND completed_at>=started_at)) IS TRUE)
);
;
CREATE UNIQUE INDEX subscription_adjustment_one_processing ON subscription_adjustment_attempts(grant_id) WHERE disposition='processing';
;
CREATE FUNCTION guard_subscription_adjustment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row subscription_allowance_transactions%ROWTYPE;
DECLARE scan_row subscription_adjustment_scans%ROWTYPE;
DECLARE observed_row subscription_adjustment_observations%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'adjustment attempts cannot be deleted'; END IF;
  IF TG_OP='UPDATE' AND (OLD.disposition<>'processing' OR
    (to_jsonb(NEW)-ARRAY['disposition','observation_id','reason','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['disposition','observation_id','reason','completed_at'])) THEN
    RAISE EXCEPTION 'adjustment attempt identity or terminal receipt is immutable';
  END IF;
  SELECT * INTO grant_row FROM subscription_allowance_transactions WHERE id=NEW.grant_id;
  SELECT * INTO scan_row FROM subscription_adjustment_scans WHERE grant_id=NEW.grant_id;
  IF grant_row.organization_id IS DISTINCT FROM NEW.organization_id OR grant_row.kind IS DISTINCT FROM 'grant'
    OR scan_row.organization_id IS DISTINCT FROM NEW.organization_id OR scan_row.generation IS DISTINCT FROM NEW.generation
  THEN RAISE EXCEPTION 'adjustment attempt original ownership mismatch'; END IF;
  IF NEW.disposition='recorded' THEN
    SELECT * INTO observed_row FROM subscription_adjustment_observations WHERE id=NEW.observation_id;
    IF NOT FOUND OR observed_row.grant_id IS DISTINCT FROM NEW.grant_id OR observed_row.organization_id IS DISTINCT FROM NEW.organization_id
      OR observed_row.request_id IS DISTINCT FROM NEW.id OR observed_row.previous_id IS DISTINCT FROM NEW.expected_previous_id
      OR clock_timestamp()>=NEW.expires_at
    THEN RAISE EXCEPTION 'adjustment attempt observation mismatch or expired lease'; END IF;
  END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER subscription_adjustment_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_adjustment_attempts FOR EACH ROW EXECUTE FUNCTION guard_subscription_adjustment_attempt();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('f54c264b08219767d8d02e9dd209c0e2addbacdd63b3a488382e8c85e8d3426e', 1796083200147);
-- apply 0530_subscription_invoice_event_evidence
CREATE TABLE subscription_invoice_event_evidence (
  receipt_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  evidence jsonb NOT NULL,
  FOREIGN KEY(receipt_id,organization_id) REFERENCES billing_subscription_event_receipts(id,organization_id) ON DELETE RESTRICT,
  CHECK ((jsonb_typeof(evidence)='object' AND evidence->>'kind'='subscription_invoice_event_observation'
    AND evidence->>'version'='1' AND evidence->>'digest' ~ '^[a-f0-9]{64}$'
    AND evidence->'scope'->>'organizationId'=organization_id::text) IS TRUE)
);
;
CREATE FUNCTION guard_subscription_invoice_event_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt billing_subscription_event_receipts%ROWTYPE;
DECLARE source billing_subscriptions%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'original invoice event evidence is immutable'; END IF;
  SELECT * INTO receipt FROM billing_subscription_event_receipts WHERE id=NEW.receipt_id;
  IF NOT FOUND OR receipt.billing_scope_id IS NOT NULL OR receipt.merchant_key<>'platform'
    OR receipt.organization_id IS DISTINCT FROM NEW.organization_id
    OR receipt.provider_object_type<>'invoice' OR receipt.event_type<>'invoice.paid'
    OR (NEW.evidence->'scope'->>'subscriptionId') IS DISTINCT FROM receipt.subscription_id::text
    OR (NEW.evidence->'scope'->>'providerEventId') IS DISTINCT FROM receipt.provider_event_id
    OR (NEW.evidence->'scope'->>'invoiceId') IS DISTINCT FROM receipt.provider_object_id
    OR (NEW.evidence->'scope'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (NEW.evidence->'event'->>'created')::numeric IS DISTINCT FROM extract(epoch FROM receipt.event_created_at)
  THEN RAISE EXCEPTION 'original invoice event owner mismatch'; END IF;
  SELECT * INTO source FROM billing_subscriptions WHERE id=receipt.subscription_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR source.billing_scope_id IS NOT NULL
    OR (NEW.evidence->'scope'->>'customerId') IS DISTINCT FROM source.stripe_customer_id
    OR (NEW.evidence->'scope'->>'providerSubscriptionId') IS DISTINCT FROM source.stripe_subscription_id
    OR source.provider_environment IS DISTINCT FROM (CASE WHEN receipt.livemode THEN 'live' ELSE 'test' END)
  THEN RAISE EXCEPTION 'original invoice subscription owner mismatch'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER subscription_invoice_event_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_invoice_event_evidence
FOR EACH ROW EXECUTE FUNCTION guard_subscription_invoice_event_evidence();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('00cd978751facd1a5509a35075386915025f79e2092feed78bd7aa10d2cec8d5', 1796083200148);
-- apply 0531_subscription_invoice_observations
CREATE TABLE subscription_invoice_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  request_id uuid NOT NULL,
  version integer NOT NULL CHECK(version>0),
  previous_id uuid REFERENCES subscription_invoice_observations(id) ON DELETE RESTRICT,
  observation jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(receipt_id,organization_id) REFERENCES billing_subscription_event_receipts(id,organization_id) ON DELETE RESTRICT,
  CHECK ((jsonb_typeof(observation)='object' AND observation->>'kind'='retained_invoice_balance_observation'
    AND observation->>'version'='1' AND observation->>'digest' ~ '^[a-f0-9]{64}$'
    AND observation->>'organizationId'=organization_id::text) IS TRUE)
);
CREATE UNIQUE INDEX subscription_invoice_observation_request_unique ON subscription_invoice_observations(receipt_id,request_id);
CREATE UNIQUE INDEX subscription_invoice_observation_version_unique ON subscription_invoice_observations(receipt_id,version);
;
CREATE FUNCTION guard_subscription_invoice_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt billing_subscription_event_receipts%ROWTYPE;
DECLARE original jsonb;
DECLARE head subscription_invoice_observations%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invoice observations are immutable'; END IF;
  SELECT * INTO receipt FROM billing_subscription_event_receipts WHERE id=NEW.receipt_id FOR UPDATE;
  IF NOT FOUND OR receipt.organization_id IS DISTINCT FROM NEW.organization_id
    OR receipt.billing_scope_id IS NOT NULL OR receipt.merchant_key<>'platform'
    OR receipt.status<>'processing' OR receipt.lease_token IS DISTINCT FROM NEW.request_id
    OR receipt.lease_expires_at IS NULL OR receipt.lease_expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'invoice observation lease mismatch'; END IF;
  SELECT evidence INTO original FROM subscription_invoice_event_evidence
    WHERE receipt_id=NEW.receipt_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR (NEW.observation->>'originalEvidenceDigest') IS DISTINCT FROM (original->>'digest')
    OR (NEW.observation->>'subscriptionId') IS DISTINCT FROM (original->'scope'->>'subscriptionId')
    OR (NEW.observation->>'invoiceId') IS DISTINCT FROM (original->'scope'->>'invoiceId')
    OR (NEW.observation->>'customerId') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (NEW.observation->>'providerAccountId') IS DISTINCT FROM (original->'scope'->>'providerAccountId')
    OR (NEW.observation->>'livemode') IS DISTINCT FROM (original->'scope'->>'livemode')
  THEN RAISE EXCEPTION 'invoice observation original owner mismatch'; END IF;
  SELECT * INTO head FROM subscription_invoice_observations WHERE receipt_id=NEW.receipt_id ORDER BY version DESC LIMIT 1;
  IF NEW.version IS DISTINCT FROM COALESCE(head.version,0)+1 OR NEW.previous_id IS DISTINCT FROM head.id
  THEN RAISE EXCEPTION 'invoice observation predecessor mismatch'; END IF;
  RETURN NEW;
END $$;
;
CREATE TRIGGER subscription_invoice_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_invoice_observations
FOR EACH ROW EXECUTE FUNCTION guard_subscription_invoice_observation();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('68c7cad92989708557cf69b137e701601559b40c328f28d6f651f9d5452c4be7', 1796083200149);
-- apply 0532_subscription_invoice_capture_observations
ALTER TABLE subscription_invoice_observations DROP CONSTRAINT subscription_invoice_observations_check;
ALTER TABLE subscription_invoice_observations ADD CONSTRAINT subscription_invoice_observations_payload_check CHECK (true) NOT VALID;
;
CREATE OR REPLACE FUNCTION guard_subscription_invoice_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt billing_subscription_event_receipts%ROWTYPE;
DECLARE original jsonb;
DECLARE head subscription_invoice_observations%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invoice observations are immutable'; END IF;
  SELECT * INTO receipt FROM billing_subscription_event_receipts WHERE id=NEW.receipt_id FOR UPDATE;
  IF NOT FOUND OR receipt.organization_id IS DISTINCT FROM NEW.organization_id
    OR receipt.billing_scope_id IS NOT NULL OR receipt.merchant_key<>'platform'
    OR receipt.status<>'processing' OR receipt.lease_token IS DISTINCT FROM NEW.request_id
    OR receipt.lease_expires_at IS NULL OR receipt.lease_expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'invoice observation lease mismatch'; END IF;
  SELECT evidence INTO original FROM subscription_invoice_event_evidence
    WHERE receipt_id=NEW.receipt_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR (NEW.observation->>'originalEvidenceDigest') IS DISTINCT FROM (original->>'digest')
    OR (NEW.observation->>'subscriptionId') IS DISTINCT FROM (original->'scope'->>'subscriptionId')
    OR (NEW.observation->>'invoiceId') IS DISTINCT FROM (original->'scope'->>'invoiceId')
    OR (NEW.observation->>'customerId') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (NEW.observation->>'providerAccountId') IS DISTINCT FROM (original->'scope'->>'providerAccountId')
    OR (NEW.observation->>'livemode') IS DISTINCT FROM (original->'scope'->>'livemode')
  THEN RAISE EXCEPTION 'invoice observation original owner mismatch'; END IF;
  IF NEW.observation->>'kind'='retained_collecting_invoice_capture' AND (
    COALESCE((original->'event'->'data'->'object'->>'starting_balance')::numeric,0)<=0
    OR COALESCE((original->'event'->'data'->'object'->>'amount_due')::numeric,0)<=0
    OR (NEW.observation->'payment'->>'id') IS DISTINCT FROM (original->'event'->'data'->'object'->>'payment_intent')
    OR (NEW.observation->'charge'->>'id') IS DISTINCT FROM (original->'event'->'data'->'object'->>'charge')
    OR (NEW.observation->'payment'->>'invoice') IS DISTINCT FROM receipt.provider_object_id
    OR (NEW.observation->'charge'->>'invoice') IS DISTINCT FROM receipt.provider_object_id
    OR (NEW.observation->'payment'->>'customer') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (NEW.observation->'charge'->>'customer') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (NEW.observation->'payment'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (NEW.observation->'charge'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (NEW.observation->'payment'->>'amount_received')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
    OR (NEW.observation->'charge'->>'amount_captured')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
  ) THEN RAISE EXCEPTION 'collecting capture original payment mismatch'; END IF;
  SELECT * INTO head FROM subscription_invoice_observations WHERE receipt_id=NEW.receipt_id ORDER BY version DESC LIMIT 1;
  IF NEW.version IS DISTINCT FROM COALESCE(head.version,0)+1 OR NEW.previous_id IS DISTINCT FROM head.id
  THEN RAISE EXCEPTION 'invoice observation predecessor mismatch'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('28e179cc5cc9f6995e651b2141ae7a04be70a7c4f230985f50c044200a7d3583', 1796083200150);
-- apply 0533_subscription_invoice_debt_observations
ALTER TABLE subscription_invoice_observations DROP CONSTRAINT subscription_invoice_observations_payload_check;
ALTER TABLE subscription_invoice_observations ADD CONSTRAINT subscription_invoice_observations_payload_check CHECK ((
  jsonb_typeof(observation)='object' AND observation->>'version'='1'
  AND observation->>'digest' ~ '^[a-f0-9]{64}$' AND observation->>'organizationId'=organization_id::text
  AND (
    observation->>'kind'='retained_invoice_balance_observation'
    OR (observation->>'kind'='observed_original_invoice_debt'
      AND observation->'capture'->>'kind'='retained_collecting_invoice_capture'
      AND observation->'capture'->>'version'='1'
      AND observation->'capture'->'balance'->>'kind'='retained_invoice_balance_observation'
      AND observation->'capture'->'balance'->>'version'='1'
      AND observation->'capture'->'balance'->>'digest' ~ '^[a-f0-9]{64}$'
      AND observation->'capture'->'balance'->>'organizationId'=observation->>'organizationId'
      AND observation->'capture'->'balance'->>'subscriptionId'=observation->>'subscriptionId'
      AND observation->'capture'->'balance'->>'providerAccountId'=observation->>'providerAccountId'
      AND observation->'capture'->'balance'->>'customerId'=observation->>'customerId'
      AND observation->'capture'->'balance'->>'invoiceId'=observation->>'invoiceId'
      AND observation->'capture'->'balance'->>'livemode'=observation->>'livemode'
      AND observation->'capture'->'balance'->>'currency'=observation->>'currency'
      AND observation->'capture'->'balance'->>'originalEvidenceDigest'=observation->>'originalEvidenceDigest'
      AND observation->'capture'->>'originalEvidenceDigest'=observation->>'originalEvidenceDigest'
      AND observation->'capture'->>'organizationId'=observation->>'organizationId'
      AND observation->'capture'->>'subscriptionId'=observation->>'subscriptionId'
      AND observation->'capture'->>'invoiceId'=observation->>'invoiceId'
      AND observation->'capture'->>'providerAccountId'=observation->>'providerAccountId'
      AND observation->'capture'->>'customerId'=observation->>'customerId'
      AND observation->'capture'->>'livemode'=observation->>'livemode'
      AND observation->'capture'->>'digest' ~ '^[a-f0-9]{64}$'
      AND observation->>'collectorOriginalEvidenceDigest'=observation->>'originalEvidenceDigest'
      AND observation->'capture'->>'currency'=observation->>'currency'
      AND observation->'trace'->>'currency'=observation->>'currency'
      AND observation->'trace'->>'kind'='original_invoice_debt_trace'
      AND observation->'trace'->>'version'='1'
      AND observation->'trace'->>'digest' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(observation->'originals')='array'
      AND jsonb_array_length(observation->'originals')>0
    )
    OR (observation->>'kind'='retained_collecting_invoice_capture'
      AND jsonb_typeof(observation->'balance')='object'
      AND observation->'balance'->>'kind'='retained_invoice_balance_observation'
      AND observation->'balance'->>'version'='1'
      AND observation->'balance'->>'digest' ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(observation->'payment')='object' AND observation->'payment'->>'id' ~ '^pi_[A-Za-z0-9]+$'
      AND jsonb_typeof(observation->'charge')='object' AND observation->'charge'->>'id' ~ '^ch_[A-Za-z0-9]+$'
      AND observation->'balance'->>'originalEvidenceDigest'=observation->>'originalEvidenceDigest'
      AND observation->'balance'->>'organizationId'=observation->>'organizationId'
      AND observation->'balance'->>'subscriptionId'=observation->>'subscriptionId'
      AND observation->'balance'->>'providerAccountId'=observation->>'providerAccountId'
      AND observation->'balance'->>'customerId'=observation->>'customerId'
      AND observation->'balance'->>'invoiceId'=observation->>'invoiceId'
      AND observation->'balance'->>'livemode'=observation->>'livemode'
      AND observation->'balance'->>'currency'=observation->>'currency'
    )
  )
) IS TRUE);
;
CREATE OR REPLACE FUNCTION guard_subscription_invoice_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt billing_subscription_event_receipts%ROWTYPE;
DECLARE original jsonb;
DECLARE capture jsonb;
DECLARE contributor jsonb;
DECLARE original_digest text;
DECLARE retained jsonb;
DECLARE head subscription_invoice_observations%ROWTYPE;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'invoice observations are immutable'; END IF;
  SELECT * INTO receipt FROM billing_subscription_event_receipts WHERE id=NEW.receipt_id FOR UPDATE;
  IF NOT FOUND OR receipt.organization_id IS DISTINCT FROM NEW.organization_id
    OR receipt.billing_scope_id IS NOT NULL OR receipt.merchant_key<>'platform'
    OR receipt.status<>'processing' OR receipt.lease_token IS DISTINCT FROM NEW.request_id
    OR receipt.lease_expires_at IS NULL OR receipt.lease_expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'invoice observation lease mismatch'; END IF;
  SELECT evidence INTO original FROM subscription_invoice_event_evidence
    WHERE receipt_id=NEW.receipt_id AND organization_id=NEW.organization_id;
  IF NOT FOUND OR (NEW.observation->>'originalEvidenceDigest') IS DISTINCT FROM (original->>'digest')
    OR (NEW.observation->>'subscriptionId') IS DISTINCT FROM (original->'scope'->>'subscriptionId')
    OR (NEW.observation->>'invoiceId') IS DISTINCT FROM (original->'scope'->>'invoiceId')
    OR (NEW.observation->>'customerId') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (NEW.observation->>'providerAccountId') IS DISTINCT FROM (original->'scope'->>'providerAccountId')
    OR (NEW.observation->>'livemode') IS DISTINCT FROM (original->'scope'->>'livemode')
  THEN RAISE EXCEPTION 'invoice observation original owner mismatch'; END IF;
  capture := CASE WHEN NEW.observation->>'kind'='observed_original_invoice_debt' THEN NEW.observation->'capture' ELSE NEW.observation END;
  IF NEW.observation->>'kind' IN ('retained_collecting_invoice_capture','observed_original_invoice_debt') AND (
    COALESCE((original->'event'->'data'->'object'->>'starting_balance')::numeric,0)<=0
    OR COALESCE((original->'event'->'data'->'object'->>'amount_due')::numeric,0)<=0
    OR (capture->'payment'->>'id') IS DISTINCT FROM (original->'event'->'data'->'object'->>'payment_intent')
    OR (capture->'charge'->>'id') IS DISTINCT FROM (original->'event'->'data'->'object'->>'charge')
    OR (capture->'payment'->>'invoice') IS DISTINCT FROM receipt.provider_object_id
    OR (capture->'charge'->>'invoice') IS DISTINCT FROM receipt.provider_object_id
    OR (capture->'payment'->>'customer') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (capture->'charge'->>'customer') IS DISTINCT FROM (original->'scope'->>'customerId')
    OR (capture->'payment'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (capture->'charge'->>'livemode') IS DISTINCT FROM receipt.livemode::text
    OR (capture->'payment'->>'amount_received')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
    OR (capture->'charge'->>'amount_captured')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
  ) THEN RAISE EXCEPTION 'collecting capture original payment mismatch'; END IF;
  IF NEW.observation->>'kind'='observed_original_invoice_debt' THEN
    IF (NEW.observation->>'currency') IS DISTINCT FROM (original->'event'->'data'->'object'->>'currency')
      OR (NEW.observation->'trace'->>'organizationId') IS DISTINCT FROM NEW.organization_id::text
      OR (NEW.observation->'trace'->>'providerAccountId') IS DISTINCT FROM (original->'scope'->>'providerAccountId')
      OR (NEW.observation->'trace'->>'customerId') IS DISTINCT FROM (original->'scope'->>'customerId')
      OR (NEW.observation->'trace'->>'livemode') IS DISTINCT FROM (original->'scope'->>'livemode')
      OR (NEW.observation->'trace'->>'collectorInvoiceId') IS DISTINCT FROM (original->'scope'->>'invoiceId')
      OR (NEW.observation->'trace'->>'collectorOriginalEvidenceDigest') IS DISTINCT FROM (original->>'digest')
      OR (NEW.observation->'trace'->>'carriedDebit')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'starting_balance')::numeric
      OR (NEW.observation->'trace'->>'collectorInvoiceTotal')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'total')::numeric
      OR (NEW.observation->'trace'->>'expectedAmountDue')::numeric IS DISTINCT FROM (original->'event'->'data'->'object'->>'amount_due')::numeric
      OR (SELECT sum((c->>'amount')::numeric) FROM jsonb_array_elements(NEW.observation->'trace'->'components') c) IS DISTINCT FROM (original->'event'->'data'->'object'->>'starting_balance')::numeric
      OR (capture->'balance'->'invoice') IS DISTINCT FROM (original->'event'->'data'->'object')
      OR jsonb_typeof(NEW.observation->'trace'->'components') IS DISTINCT FROM 'array'
      OR jsonb_array_length(NEW.observation->'trace'->'components')<>jsonb_array_length(NEW.observation->'originals')
      OR (SELECT count(DISTINCT value->>'invoiceId') FROM jsonb_array_elements(NEW.observation->'originals'))<>jsonb_array_length(NEW.observation->'originals')
    THEN RAISE EXCEPTION 'debt attribution shape mismatch'; END IF;
    FOR contributor IN SELECT value FROM jsonb_array_elements(NEW.observation->'originals') LOOP
      IF jsonb_typeof(contributor->'originalEvidenceDigests') IS DISTINCT FROM 'array'
        OR jsonb_array_length(contributor->'originalEvidenceDigests')=0
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.observation->'trace'->'components') c
          WHERE c->>'invoiceId'=contributor->>'invoiceId' AND c->'originalEvidenceDigests'=contributor->'originalEvidenceDigests')
      THEN RAISE EXCEPTION 'debt contributor trace mismatch'; END IF;
      FOR original_digest IN SELECT jsonb_array_elements_text(contributor->'originalEvidenceDigests') LOOP
        SELECT evidence INTO retained FROM subscription_invoice_event_evidence
          WHERE organization_id=NEW.organization_id AND evidence->>'digest'=original_digest
          AND evidence->'scope'->>'invoiceId'=contributor->>'invoiceId'
          AND evidence->'scope'->>'providerAccountId'=original->'scope'->>'providerAccountId'
          AND evidence->'scope'->>'customerId'=original->'scope'->>'customerId'
          AND evidence->'scope'->>'livemode'=original->'scope'->>'livemode';
        IF NOT FOUND OR (retained->'event'->'data'->'object') IS DISTINCT FROM (contributor->'invoice')
          OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.observation->'trace'->'components') c
            WHERE c->>'invoiceId'=contributor->>'invoiceId'
              AND c->>'subscriptionId'=retained->'scope'->>'subscriptionId'
              AND c->>'providerSubscriptionId'=retained->'scope'->>'providerSubscriptionId'
              AND c->'period'=retained->'event'->'data'->'object'->'lines'->'data'->0->'period'
              AND (c->>'amount')::numeric=(retained->'event'->'data'->'object'->>'total')::numeric)
        THEN RAISE EXCEPTION 'debt contributor original mismatch'; END IF;
      END LOOP;
    END LOOP;
  END IF;
  SELECT * INTO head FROM subscription_invoice_observations WHERE receipt_id=NEW.receipt_id ORDER BY version DESC LIMIT 1;
  IF NEW.version IS DISTINCT FROM COALESCE(head.version,0)+1 OR NEW.previous_id IS DISTINCT FROM head.id
  THEN RAISE EXCEPTION 'invoice observation predecessor mismatch'; END IF;
  RETURN NEW;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('5636c79544cf9191e03cb896c573b2a17cc19adc2086d0eb475c00b504094e8e', 1796083200151);
-- apply 0534_subscription_allowance_invoice_authority
-- The trial variant makes invoice IDs nullable. CHECK(NULL) otherwise admits a
-- paid-invoice grant without its invoice identity. Preserve existing rows and
-- fail migration on invalid historical data rather than inventing provenance.
ALTER TABLE subscription_allowance_periods
  DROP CONSTRAINT subscription_allowance_periods_invoice_id_check,
  ADD CONSTRAINT subscription_allowance_periods_invoice_id_check CHECK (true) NOT VALID;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('9b77f53d8af8f18d7390265657ab067f54df026e8264a2482cdca2c44b0ba616', 1796083200152);
-- already effective in production: 0535_managed_gmail_read_state_operations
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('506220a7a7e4b208c56c4210c3cc9798a64547e8a3ad8935d653c5f0ce9a59ba', 1796083200153);
-- already effective in production: 0536_rooms_connector_server_id
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('e5e318f18f48da4de87058f94a385592c433b3609a149d3c0e81ea0ffa15068e', 1796083200154);
-- already effective in production: 0537_relationships_extraction_evidence
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('23e41f9da9293663d8416a4a2a55f1c12cef733a58c204f5450bb442bf209170', 1796083200155);
-- apply 0538_message_server_agents
-- Cloud schema/journal drift: message_server_agents is one of the plugin-sql
-- core tables the cloud schemas barrel re-exports, but the cloud journal never
-- created it (only the standalone plugin-sql journal did). Databases built by
-- replaying this journal have no such relation, so any query touching it fails.
-- DDL matches the drizzle-generated shape of the plugin-sql baseline.
-- Databases that also ran the plugin-sql journal (staging) already have the
-- table, so every statement is idempotent.
CREATE TABLE IF NOT EXISTS "message_server_agents" (
	"message_server_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	CONSTRAINT "message_server_agents_message_server_id_agent_id_pk" PRIMARY KEY("message_server_id","agent_id")
);
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_server_agents_message_server_id_message_servers_id_fk') THEN
    ALTER TABLE "message_server_agents" ADD CONSTRAINT "message_server_agents_message_server_id_message_servers_id_fk" FOREIGN KEY ("message_server_id") REFERENCES "public"."message_servers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'message_server_agents_agent_id_agents_id_fk') THEN
    ALTER TABLE "message_server_agents" ADD CONSTRAINT "message_server_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('ebbebfd2de044decc1b0e3e41fa3bcd2f6321fc5e094040ef7e42e13661e082f', 1796083200156);
-- apply 0539_agent_identities
-- Cloud schema/journal drift: the agent_identities drizzle schema (ERC-8004
-- agent identity registry) declares the table and its indexes, but no journal
-- entry created it, so journal-migrated databases (CI lanes, staging,
-- production) have no such relation. DDL matches the declared drizzle shape.
CREATE TABLE "agent_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sandbox_agent_id" uuid NOT NULL,
	"standard" text DEFAULT 'erc-8004' NOT NULL,
	"chain_id" integer NOT NULL,
	"registry_address" text NOT NULL,
	"token_id" text NOT NULL,
	"agent_uri" text NOT NULL,
	"uri_ipfs" text,
	"owner_wallet_address" text NOT NULL,
	"tx_hash" text NOT NULL,
	"block_number" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
;
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
;
ALTER TABLE "agent_identities" ADD CONSTRAINT "agent_identities_sandbox_agent_id_agent_sandboxes_id_fk" FOREIGN KEY ("sandbox_agent_id") REFERENCES "public"."agent_sandboxes"("id") ON DELETE cascade ON UPDATE no action;
;
CREATE INDEX "agent_identities_sandbox_idx" ON "agent_identities" USING btree ("sandbox_agent_id");
;
CREATE INDEX "agent_identities_organization_idx" ON "agent_identities" USING btree ("organization_id");
;
CREATE UNIQUE INDEX "agent_identities_chain_registry_token_unique" ON "agent_identities" USING btree ("chain_id","registry_address","token_id");
;
CREATE UNIQUE INDEX "agent_identities_sandbox_standard_chain_unique" ON "agent_identities" USING btree ("sandbox_agent_id","standard","chain_id");
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('4e74085eaf5dc616e23fb9e390cf6371f350b092d1b0e49109868e261d6fbfbe', 1796083200157);
-- already effective in production: 0540_embeddings_space_nonce_dim2048
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('f1e52320717cdf0556b7aa774bccae3a709418084f17fe7b597ad785e50205ad', 1796083200158);
-- apply 0541_app_pilot_redemptions
-- Sponsored pilot admission is separate from Stripe subscription/payment authority.
-- This ledger does not itself publish entitlements or spendable allowance.
CREATE TABLE app_pilot_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  plan_revision_id uuid NOT NULL REFERENCES app_billing_plan_revisions(id) ON DELETE RESTRICT,
  livemode boolean NOT NULL,
  code_digest text NOT NULL CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  maximum_redemptions integer NOT NULL CHECK (maximum_redemptions > 0),
  opens_at timestamptz NOT NULL,
  closes_at timestamptz NOT NULL CHECK (closes_at > opens_at),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, livemode, code_digest)
);
;
CREATE TABLE app_pilot_invitations (
  campaign_id uuid NOT NULL REFERENCES app_pilot_campaigns(id) ON DELETE RESTRICT,
  eligibility_principal_id uuid NOT NULL REFERENCES billing_eligibility_principals(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, eligibility_principal_id)
);
;
CREATE TABLE app_pilot_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES app_pilot_campaigns(id) ON DELETE RESTRICT,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  livemode boolean NOT NULL,
  eligibility_principal_id uuid NOT NULL REFERENCES billing_eligibility_principals(id) ON DELETE RESTRICT,
  billing_scope_id uuid NOT NULL REFERENCES app_billing_scopes(id) ON DELETE RESTRICT,
  plan_revision_id uuid NOT NULL REFERENCES app_billing_plan_revisions(id) ON DELETE RESTRICT,
  redeemed_by_user_id uuid NOT NULL REFERENCES billing_identity_subjects(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (app_id, livemode, eligibility_principal_id),
  FOREIGN KEY (campaign_id, eligibility_principal_id)
    REFERENCES app_pilot_invitations(campaign_id, eligibility_principal_id) ON DELETE RESTRICT,
  CHECK (ends_at = ((starts_at AT TIME ZONE 'UTC') + interval '6 months') AT TIME ZONE 'UTC')
);
;
CREATE INDEX app_pilot_redemptions_scope_idx ON app_pilot_redemptions(billing_scope_id);
CREATE INDEX app_pilot_redemptions_campaign_idx ON app_pilot_redemptions(campaign_id);
;
CREATE FUNCTION guard_app_pilot_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Pilot history cannot be deleted';
  END IF;
  IF (to_jsonb(NEW) - 'revoked_at') IS DISTINCT FROM (to_jsonb(OLD) - 'revoked_at')
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'Pilot terms are immutable; revocation cannot be undone';
  END IF;
  RETURN NEW;
END;
$$;
;
CREATE TRIGGER app_pilot_campaigns_immutable BEFORE UPDATE OR DELETE ON app_pilot_campaigns
  FOR EACH ROW EXECUTE FUNCTION guard_app_pilot_record();
CREATE TRIGGER app_pilot_invitations_immutable BEFORE UPDATE OR DELETE ON app_pilot_invitations
  FOR EACH ROW EXECUTE FUNCTION guard_app_pilot_record();
CREATE TRIGGER app_pilot_redemptions_immutable BEFORE UPDATE OR DELETE ON app_pilot_redemptions
  FOR EACH ROW EXECUTE FUNCTION guard_app_pilot_record();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('e9836cbf3e616ced8cae9abfbcc8768707c9eaaeeeeb8b9b09aef9549634c932', 1796083200159);
-- already effective in production: 0542_subscription_grant_codes
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('d83ab6316c72e8fa7babcd6b4b58f84df4d9d7e1fd24347c8076065bae22ac9b', 1796083200160);
-- apply 0543_app_pilot_allowance
-- Sponsored access uses the existing allowance/reservation ledgers, never invented Stripe records.
ALTER TABLE subscription_allowance_periods
  ALTER COLUMN subscription_id DROP NOT NULL,
  ALTER COLUMN subscription_revision DROP NOT NULL,
  ADD COLUMN pilot_redemption_id uuid REFERENCES app_pilot_redemptions(id) ON DELETE RESTRICT;
;
ALTER TABLE subscription_allowance_periods DROP CONSTRAINT subscription_allowance_periods_invoice_id_check;
ALTER TABLE subscription_allowance_periods ADD CONSTRAINT subscription_allowance_periods_invoice_id_check CHECK (
  provider_environment IN ('test','live') AND (
    (provider = 'stripe' AND promo_grant_id IS NULL AND pilot_redemption_id IS NULL AND subscription_id IS NOT NULL AND subscription_revision IS NOT NULL AND (
      (grant_source = 'paid_invoice' AND stripe_invoice_id IS NOT NULL AND stripe_invoice_id ~ '^in_[A-Za-z0-9]+$' AND trial_claim_id IS NULL)
      OR (grant_source = 'trial_claim' AND billing_scope_id IS NOT NULL AND stripe_invoice_id IS NULL AND trial_claim_id IS NOT NULL)))
    OR (provider = 'eliza' AND grant_source = 'promo_grant' AND promo_grant_id IS NOT NULL AND pilot_redemption_id IS NULL
      AND billing_scope_id IS NULL AND merchant_key = 'platform' AND subscription_id IS NULL
      AND subscription_revision IS NULL AND stripe_invoice_id IS NULL AND trial_claim_id IS NULL)
    OR (provider = 'pilot' AND grant_source = 'pilot' AND promo_grant_id IS NULL AND pilot_redemption_id IS NOT NULL AND billing_scope_id IS NOT NULL
      AND subscription_id IS NULL AND subscription_revision IS NULL AND stripe_invoice_id IS NULL AND trial_claim_id IS NULL)
  )
);
CREATE UNIQUE INDEX subscription_allowance_periods_pilot_month_idx ON subscription_allowance_periods(pilot_redemption_id,period_start) WHERE pilot_redemption_id IS NOT NULL;
;
CREATE TABLE app_pilot_activations (
  redemption_id uuid PRIMARY KEY REFERENCES app_pilot_redemptions(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER app_pilot_activations_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON app_pilot_activations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
;
CREATE FUNCTION validate_app_pilot_allowance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; sc record; p record; i integer; expected_start timestamptz; expected_end timestamptz;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.pilot_redemption_id IS DISTINCT FROM OLD.pilot_redemption_id OR
    (OLD.pilot_redemption_id IS NOT NULL AND
      ROW(NEW.organization_id,NEW.merchant_key,NEW.provider,NEW.provider_environment,NEW.grant_source,NEW.plan_key,NEW.catalog_version,NEW.period_start,NEW.period_end,NEW.expires_at,NEW.granted_amount,NEW.adjustment_amount)
      IS DISTINCT FROM ROW(OLD.organization_id,OLD.merchant_key,OLD.provider,OLD.provider_environment,OLD.grant_source,OLD.plan_key,OLD.catalog_version,OLD.period_start,OLD.period_end,OLD.expires_at,OLD.granted_amount,OLD.adjustment_amount))) THEN
    RAISE EXCEPTION 'Pilot allowance terms are immutable';
  END IF;
  IF NEW.pilot_redemption_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO r FROM app_pilot_redemptions WHERE id=NEW.pilot_redemption_id;
  SELECT * INTO sc FROM app_billing_scopes WHERE id=r.billing_scope_id;
  SELECT * INTO p FROM app_billing_plan_revisions WHERE id=r.plan_revision_id;
  IF r.id IS NULL OR sc.id IS NULL OR p.id IS NULL OR
    (r.app_id,r.livemode,r.billing_scope_id) IS DISTINCT FROM (sc.app_id,sc.livemode,NEW.billing_scope_id) OR
    (p.app_id,p.merchant_id,p.product_family_key) IS DISTINCT FROM (sc.app_id,sc.merchant_id,sc.product_family_key) OR
    NEW.organization_id <> sc.organization_id OR NEW.plan_key <> p.plan_key OR NEW.catalog_version <> p.id::text OR
    NEW.granted_amount <> p.paid_allowance_usd OR NEW.adjustment_amount <> 0 OR p.interval <> 'month' OR p.interval_count <> 1 THEN
    RAISE EXCEPTION 'Pilot allowance source mismatch';
  END IF;
  FOR i IN 0..5 LOOP
    expected_start := ((r.starts_at AT TIME ZONE 'UTC') + make_interval(months => i)) AT TIME ZONE 'UTC';
    expected_end := ((r.starts_at AT TIME ZONE 'UTC') + make_interval(months => i+1)) AT TIME ZONE 'UTC';
    IF NEW.period_start = expected_start AND NEW.period_end = expected_end THEN RETURN NEW; END IF;
  END LOOP;
  RAISE EXCEPTION 'Pilot allowance period is not an original calendar month';
END $$;
CREATE TRIGGER subscription_allowance_periods_pilot_source BEFORE INSERT OR UPDATE ON subscription_allowance_periods
  FOR EACH ROW EXECUTE FUNCTION validate_app_pilot_allowance();
;
CREATE FUNCTION validate_app_pilot_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; p record; n integer;
BEGIN
  SELECT * INTO r FROM app_pilot_redemptions WHERE id=NEW.redemption_id;
  SELECT * INTO p FROM app_billing_plan_revisions WHERE id=r.plan_revision_id;
  SELECT count(*) INTO n FROM subscription_allowance_periods WHERE pilot_redemption_id=r.id;
  IF r.id IS NULL OR p.id IS NULL OR n <> (CASE WHEN p.paid_allowance_usd > 0 THEN 6 ELSE 0 END) THEN
    RAISE EXCEPTION 'Pilot activation requires complete monthly allowance publication';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER app_pilot_activations_complete BEFORE INSERT ON app_pilot_activations
  FOR EACH ROW EXECUTE FUNCTION validate_app_pilot_activation();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('c6704cc35df7bb7da4f82e6dff1a032a893e1a0d488650022053b169327e6e91', 1796083200161);
-- apply 0544_inference_funding_budgets
-- Budget grants hold funds in the existing reservation ledger. Request receipts
-- consume those holds; closing a durably sealed grant settles its aggregate once.
CREATE TABLE inference_funding_budget_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  funding_reservation_id uuid NOT NULL,
  request_digest text NOT NULL,
  policy_generation text NOT NULL,
  policy_epoch text NOT NULL,
  amount numeric(16,6) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  seal_sequence integer,
  seal_amount numeric(16,6),
  seal_signature text,
  CONSTRAINT inference_funding_budget_grants_reservation_tenant_fk FOREIGN KEY (funding_reservation_id,organization_id) REFERENCES billing_funding_reservations(id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT inference_funding_budget_grants_shape CHECK (amount > 0 AND request_digest ~ '^[0-9a-f]{64}$' AND policy_generation ~ '^(0|[1-9][0-9]*)$' AND policy_epoch ~ '^(0|[1-9][0-9]*)$' AND expires_at > created_at AND
    ((closed_at IS NULL AND seal_sequence IS NULL AND seal_amount IS NULL AND seal_signature IS NULL) OR
     (closed_at IS NOT NULL AND seal_sequence >= 0 AND seal_amount >= 0 AND seal_amount <= amount AND seal_signature ~ '^[0-9a-f]{64}$')))
);
CREATE UNIQUE INDEX inference_funding_budget_grants_id_org_idx ON inference_funding_budget_grants(id,organization_id);
CREATE UNIQUE INDEX inference_funding_budget_grants_reservation_idx ON inference_funding_budget_grants(funding_reservation_id);
;
CREATE TABLE inference_funding_budget_receipts (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  request_id text NOT NULL,
  request_digest text NOT NULL,
  amount numeric(16,6) NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inference_funding_budget_receipts_shape CHECK (length(request_id) BETWEEN 1 AND 128 AND request_digest ~ '^[0-9a-f]{64}$' AND amount >= 0)
);
CREATE UNIQUE INDEX inference_funding_budget_receipts_org_request_idx ON inference_funding_budget_receipts(organization_id,request_id);
CREATE TABLE inference_funding_budget_consumptions (
  organization_id uuid NOT NULL,
  request_id text NOT NULL,
  grant_id uuid NOT NULL,
  sequence integer NOT NULL,
  amount numeric(16,6) NOT NULL,
  CONSTRAINT inference_funding_budget_consumptions_grant_tenant_fk FOREIGN KEY (grant_id,organization_id) REFERENCES inference_funding_budget_grants(id,organization_id) ON DELETE RESTRICT,
  CONSTRAINT inference_funding_budget_consumptions_receipt_tenant_fk FOREIGN KEY (organization_id,request_id) REFERENCES inference_funding_budget_receipts(organization_id,request_id) ON DELETE RESTRICT,
  CONSTRAINT inference_funding_budget_consumptions_shape CHECK (sequence > 0 AND amount > 0)
);
CREATE UNIQUE INDEX inference_funding_budget_consumptions_sequence_idx ON inference_funding_budget_consumptions(grant_id,sequence);
CREATE UNIQUE INDEX inference_funding_budget_consumptions_request_idx ON inference_funding_budget_consumptions(organization_id,request_id,grant_id);
;
CREATE FUNCTION guard_inference_funding_budget_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE backing record; consumed numeric; n bigint; last_seq integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.closed_at IS NOT NULL OR
    ROW(NEW.id,NEW.organization_id,NEW.funding_reservation_id,NEW.request_digest,NEW.policy_generation,NEW.policy_epoch,NEW.amount,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.organization_id,OLD.funding_reservation_id,OLD.request_digest,OLD.policy_generation,OLD.policy_epoch,OLD.amount,OLD.expires_at,OLD.created_at)) THEN
    RAISE EXCEPTION 'Budget grant identity and closed result are immutable' USING ERRCODE='23514';
  END IF;
  SELECT * INTO backing FROM billing_funding_reservations WHERE id=NEW.funding_reservation_id AND organization_id=NEW.organization_id;
  IF backing.id IS NULL OR backing.logical_operation_id <> 'inference-budget:' || NEW.id::text OR backing.funding_class <> 'allowance_eligible' OR backing.billing_scope_id IS NOT NULL OR backing.merchant_key <> 'platform' OR backing.requested_amount <> NEW.amount OR backing.expires_at <> NEW.expires_at THEN
    RAISE EXCEPTION 'Budget grant must match its canonical funding reservation' USING ERRCODE='23514';
  END IF;
  IF TG_OP='INSERT' AND (backing.status <> 'reserved' OR NEW.closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'New budget grant requires an open funding reservation' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    SELECT COALESCE(sum(amount),0),count(*),COALESCE(max(sequence),0) INTO consumed,n,last_seq FROM inference_funding_budget_consumptions WHERE grant_id=NEW.id;
    IF NEW.closed_at IS NULL OR NEW.seal_amount IS DISTINCT FROM consumed OR NEW.seal_sequence IS DISTINCT FROM last_seq OR n <> last_seq OR backing.status <> 'finalized' OR
      consumed <> (SELECT COALESCE(sum(finalized_amount),0) FROM billing_funding_allocations WHERE reservation_id=backing.id AND organization_id=NEW.organization_id) THEN
      RAISE EXCEPTION 'Budget close requires its complete consumed watermark and finalized backing' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inference_funding_budget_grants_guard BEFORE INSERT OR UPDATE ON inference_funding_budget_grants FOR EACH ROW EXECUTE FUNCTION guard_inference_funding_budget_grant();
CREATE TRIGGER inference_funding_budget_grants_retained BEFORE DELETE OR TRUNCATE ON inference_funding_budget_grants FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
;
CREATE FUNCTION guard_inference_funding_budget_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE budget record; consumed numeric;
BEGIN
  SELECT * INTO budget FROM inference_funding_budget_grants WHERE id=NEW.grant_id AND organization_id=NEW.organization_id FOR UPDATE;
  IF budget.id IS NULL OR budget.closed_at IS NOT NULL THEN RAISE EXCEPTION 'Budget grant is not open' USING ERRCODE='23514'; END IF;
  SELECT COALESCE(sum(amount),0) INTO consumed FROM inference_funding_budget_consumptions WHERE grant_id=NEW.grant_id;
  IF consumed + NEW.amount > budget.amount THEN RAISE EXCEPTION 'Budget consumption exceeds its reserved funds' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inference_funding_budget_consumptions_guard BEFORE INSERT ON inference_funding_budget_consumptions FOR EACH ROW EXECUTE FUNCTION guard_inference_funding_budget_consumption();
CREATE TRIGGER inference_funding_budget_consumptions_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inference_funding_budget_consumptions FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
CREATE TRIGGER inference_funding_budget_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON inference_funding_budget_receipts FOR EACH STATEMENT EXECUTE FUNCTION reject_subscription_append_only_mutation();
;
CREATE FUNCTION validate_inference_funding_budget_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; consumed numeric;
BEGIN
  SELECT amount INTO expected FROM inference_funding_budget_receipts WHERE organization_id=NEW.organization_id AND request_id=NEW.request_id;
  SELECT COALESCE(sum(amount),0) INTO consumed FROM inference_funding_budget_consumptions WHERE organization_id=NEW.organization_id AND request_id=NEW.request_id;
  IF expected IS NULL OR expected <> consumed THEN RAISE EXCEPTION 'Budget receipt must conserve its grant allocations' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inference_funding_budget_receipt_conservation AFTER INSERT ON inference_funding_budget_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inference_funding_budget_receipt();
CREATE CONSTRAINT TRIGGER inference_funding_budget_consumption_conservation AFTER INSERT ON inference_funding_budget_consumptions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_inference_funding_budget_receipt();
;
-- A generic stale-hold cancellation must never return funds still owned by a DO.
CREATE FUNCTION guard_inference_budget_backing_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE budget_id uuid;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    SELECT id INTO budget_id FROM inference_funding_budget_grants WHERE funding_reservation_id=OLD.id AND closed_at IS NULL;
    IF budget_id IS NOT NULL AND current_setting('eliza.inference_budget_close',true) IS DISTINCT FROM budget_id::text THEN
      RAISE EXCEPTION 'Open inference budget requires its verified durable close' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inference_budget_backing_terminal_guard BEFORE UPDATE ON billing_funding_reservations FOR EACH ROW EXECUTE FUNCTION guard_inference_budget_backing_terminal();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('2126b4e3f08b86621e757f9c3bdf99d278fa84ee28b9fb48c5c856b79d702471', 1796083200162);
-- apply 0545_inference_policy_mutation_fences
CREATE TABLE inference_policy_authorities (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
 enabled boolean NOT NULL DEFAULT false,
 epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
;
CREATE TABLE inference_policy_mutations (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 mutation_id text NOT NULL,
 fence_token text NOT NULL,
 permit_expires_at timestamptz NOT NULL,
 applying_txid bigint NOT NULL,
 phase text NOT NULL CHECK (phase IN ('applying','applied','complete')),
 epoch bigint,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id,mutation_id),
 CONSTRAINT inference_policy_mutations_identity_check CHECK (length(mutation_id) BETWEEN 1 AND 128 AND length(fence_token) > 0),
 CONSTRAINT inference_policy_mutations_epoch_check CHECK ((phase = 'applying' AND epoch IS NULL) OR (phase IN ('applied','complete') AND epoch >= 1))
);
;
CREATE FUNCTION require_inference_policy_fence(org uuid, force_fence boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF org IS NULL THEN RETURN; END IF;
 -- Also serialize first enrollment with previously unenrolled policy writers.
 PERFORM pg_advisory_xact_lock(hashtextextended('inference-policy:' || org::text, 0));
 IF NOT force_fence AND NOT EXISTS (SELECT 1 FROM inference_policy_authorities WHERE organization_id = org AND enabled) THEN RETURN; END IF;
 IF NOT EXISTS (SELECT 1 FROM inference_policy_mutations WHERE organization_id = org AND applying_txid = txid_current() AND phase = 'applying' AND permit_expires_at > clock_timestamp()) THEN
  RAISE EXCEPTION 'INFERENCE_POLICY_FENCE_REQUIRED' USING ERRCODE = 'P0001';
 END IF;
END $$;
;
CREATE FUNCTION guard_inference_policy_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; org uuid; changed boolean := TG_OP <> 'UPDATE'; column_name text;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
 IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
 IF TG_OP = 'UPDATE' THEN
  IF TG_NARGS = 1 THEN changed := (old_row - 'updated_at') IS DISTINCT FROM (new_row - 'updated_at');
  ELSE
   FOR i IN 1..TG_NARGS-1 LOOP
    column_name := TG_ARGV[i];
    IF old_row->column_name IS DISTINCT FROM new_row->column_name THEN changed := true; EXIT; END IF;
   END LOOP;
  END IF;
 END IF;
 IF NOT changed THEN RETURN NEW; END IF;
 IF old_row IS NOT NULL THEN
  org := (old_row->>TG_ARGV[0])::uuid;
  PERFORM require_inference_policy_fence(org, TG_TABLE_NAME = 'inference_policy_authorities' AND (old_row->>'enabled')::boolean);
 END IF;
 IF new_row IS NOT NULL THEN
  org := (new_row->>TG_ARGV[0])::uuid;
  PERFORM require_inference_policy_fence(org, TG_TABLE_NAME = 'inference_policy_authorities' AND (new_row->>'enabled')::boolean);
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON inference_policy_authorities FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id','enabled','epoch');
;
CREATE TRIGGER inference_policy_guard BEFORE UPDATE OR DELETE ON organizations FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('id','is_active','account_lifecycle_state','account_deletion_request_id','paid_work_fenced_at','settings');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON api_keys FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id','organization_id','user_id','key_hash','is_active','deleted_at','expires_at','rate_limit','source_app_id');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_subscription_authorities FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_entitlements FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_subscriptions FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_subscription_revisions FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_grants FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON org_rate_limit_overrides FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_config FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_payment_reversal_holds FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_allowance_periods FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id','organization_id','billing_scope_id','merchant_key','subscription_id','subscription_revision','pilot_redemption_id','grant_source','trial_claim_id','promo_grant_id','plan_key','catalog_version','period_start','period_end','expires_at','state','granted_amount','adjustment_amount');
;
CREATE FUNCTION guard_inference_user_policy_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; user_ids uuid[]; org uuid;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
 IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'users' AND (old_row->'is_active',old_row->'organization_id',old_row->'steward_user_id',old_row->'role',old_row->'expires_at',old_row->'deleted_at',old_row->'auth_fenced_at',old_row->'account_lifecycle_state',old_row->'account_deletion_request_id') IS NOT DISTINCT FROM (new_row->'is_active',new_row->'organization_id',new_row->'steward_user_id',new_row->'role',new_row->'expires_at',new_row->'deleted_at',new_row->'auth_fenced_at',new_row->'account_lifecycle_state',new_row->'account_deletion_request_id') THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'user_identities' AND (old_row->'user_id',old_row->'steward_user_id',old_row->'expires_at',old_row->'is_anonymous') IS NOT DISTINCT FROM (new_row->'user_id',new_row->'steward_user_id',new_row->'expires_at',new_row->'is_anonymous') THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'user_moderation_status' AND (old_row->'status',old_row->'total_violations',old_row->'user_id') IS NOT DISTINCT FROM (new_row->'status',new_row->'total_violations',new_row->'user_id') THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME = 'users' THEN
  user_ids := ARRAY[(old_row->>'id')::uuid,(new_row->>'id')::uuid];
  PERFORM require_inference_policy_fence((old_row->>'organization_id')::uuid);
  PERFORM require_inference_policy_fence((new_row->>'organization_id')::uuid);
 ELSE user_ids := ARRAY[(old_row->>'user_id')::uuid,(new_row->>'user_id')::uuid]; END IF;
 FOR org IN SELECT organization_id FROM users WHERE id = ANY(user_ids) AND organization_id IS NOT NULL UNION SELECT organization_id FROM api_keys WHERE user_id = ANY(user_ids) ORDER BY 1 LOOP
  PERFORM require_inference_policy_fence(org);
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION guard_inference_user_policy_write();
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON user_moderation_status FOR EACH ROW EXECUTE FUNCTION guard_inference_user_policy_write();
;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON user_identities FOR EACH ROW EXECUTE FUNCTION guard_inference_user_policy_write();
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('714b1f5a071c173557fd668c90aa118a74899d9cfb329db7b65926b46cd80fb9', 1796083200163);
-- apply 0546_lifetime_subscription_grants
-- Lifetime grants have no expiry. Existing bounded codes and grants retain their terms.
ALTER TABLE subscription_grant_codes ALTER COLUMN duration_days DROP NOT NULL;
;
ALTER TABLE subscription_grants ALTER COLUMN ends_at DROP NOT NULL;
;
ALTER TABLE organization_entitlements DROP CONSTRAINT organization_entitlements_plan_state_check;
;
ALTER TABLE organization_entitlements ADD CONSTRAINT organization_entitlements_plan_state_check CHECK (
  (source_grant_id IS NULL AND (
    (billing_scope_id IS NOT NULL AND source_subscription_id IS NOT NULL AND source_subscription_revision IS NOT NULL
      AND state IN ('trialing','active','grace','past_due','unpaid','paused','canceled','incomplete','incomplete_expired')
      AND access IN ('granted','read_only','denied') AND entitlement_effective = (access = 'granted'))
    OR (billing_scope_id IS NULL AND plan_key IN ('free','plus_monthly','pro_monthly')
      AND state IN ('free','active','grace','past_due','unpaid') AND (
        (plan_key = 'free' AND state = 'free' AND entitlement_effective
          AND (source_subscription_id IS NULL) = (source_subscription_revision IS NULL))
        OR (plan_key <> 'free' AND state <> 'free' AND source_subscription_id IS NOT NULL
          AND source_subscription_revision IS NOT NULL
          AND (entitlement_effective = (state IN ('active','grace'))))))
  ))
  OR (source_grant_id IS NOT NULL AND billing_scope_id IS NULL
    AND plan_key IN ('plus_monthly','pro_monthly') AND state = 'active' AND entitlement_effective
    AND access = 'granted' AND source_subscription_id IS NULL AND source_subscription_revision IS NULL)
);
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('f0a6da3652dda306c33863b4e9f23c8e61b5a5e11c28eed49b77bff2c2b85e56', 1796083200164);
-- apply 0547_subscription_grant_calendar_terms
-- Calendar-month grant terms and paid-plan exclusivity (for example a six-month
-- pilot code). Existing codes keep their day or lifetime terms. A code has at
-- most one term: duration_days, duration_months, or neither (lifetime).
ALTER TABLE subscription_grant_codes ADD COLUMN duration_months integer
  CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 24);
;
ALTER TABLE subscription_grant_codes ADD CONSTRAINT subscription_grant_codes_single_term_check
  CHECK (duration_days IS NULL OR duration_months IS NULL);
;
-- An exclusive code is refused while the organization has an open paid
-- subscription (or its subscription authority is unknown), so an existing
-- payer never holds a grant and an invoice for the same window.
ALTER TABLE subscription_grant_codes ADD COLUMN requires_no_paid_plan boolean NOT NULL DEFAULT false;
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('87b1270f7ebf32304c0505bbd96bec690439dcc021bcab89830f142a01f6139f', 1796083200165);
-- apply 0548_agent_provisioning_deferred_backfill
-- Rows created with `autoProvision: false` before the deferred marker existed
-- are pending with no provision job on purpose. Mark pending eager-tier rows
-- that have no live provision job, so the orphaned-pending sweep cannot fail
-- one. A real orphan marked here stays recoverable: the dashboard shows it as
-- pending with Start, which calls `/provision` and enqueues the job.
UPDATE agent_sandboxes AS s
SET agent_config = COALESCE(s.agent_config, '{}'::jsonb) || '{"__agentProvisioningDeferred": true}'::jsonb
WHERE s.status = 'pending'
  AND s.pool_status IS NULL
  AND s.execution_tier IN ('dedicated-always', 'custom')
  AND NOT EXISTS (
    SELECT 1 FROM jobs AS j
    WHERE j.agent_id = s.id::text
      AND j.organization_id = s.organization_id
      AND j.type = 'agent_provision'
      AND (
        j.status IN ('pending', 'in_progress')
        OR (j.execution_generation IS NOT NULL AND j.execution_quiesced_at IS NULL)
      )
  );
;
INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES ('657decd32efe57833277f66dbfaf3f2ced43292fb7d124c95d013bbd8b916ebf', 1796083200166);
DO $$ BEGIN
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 519 THEN RAISE EXCEPTION 'ledger_count_mismatch after repair'; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE contype='c' AND pg_get_constraintdef(oid) ~ '^CHECK \(true\)') THEN RAISE EXCEPTION 'placeholder_constraint_survived'; END IF;
END $$;
COMMIT;
