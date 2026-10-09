-- Subscription-funded legacy agent charges are receipted by their finalized
-- allowance-first funding reservation instead of a purchased-credit debit row.
ALTER TABLE "agent_billing_records" ADD COLUMN IF NOT EXISTS "funding_reservation_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_billing_records'::regclass AND conname='agent_billing_records_funding_reservation_tenant_fk') THEN
    ALTER TABLE "agent_billing_records" ADD CONSTRAINT "agent_billing_records_funding_reservation_tenant_fk" FOREIGN KEY ("funding_reservation_id","organization_id") REFERENCES "public"."billing_funding_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_billing_records_funding_reservation_idx" ON "agent_billing_records" USING btree ("funding_reservation_id") WHERE "agent_billing_records"."funding_reservation_id" IS NOT NULL;
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='agent_billing_records'::regclass AND tgname='agent_billing_records_funding_reservation_guard') THEN
    CREATE TRIGGER agent_billing_records_funding_reservation_guard BEFORE INSERT ON agent_billing_records
      FOR EACH ROW EXECUTE FUNCTION guard_agent_reserved_billing_receipt();
  END IF;
END $$;
