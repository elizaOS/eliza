-- Subscription-funded container charges are receipted by their finalized
-- allowance-first funding reservation. Earnings converted under the
-- pay-as-you-go toggle keep their own purchased-credit debit row, so a funded
-- receipt may carry both identifiers.
ALTER TABLE "container_billing_records" ADD COLUMN IF NOT EXISTS "funding_reservation_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='container_billing_records'::regclass AND conname='container_billing_records_funding_reservation_tenant_fk') THEN
    ALTER TABLE "container_billing_records" ADD CONSTRAINT "container_billing_records_funding_reservation_tenant_fk" FOREIGN KEY ("funding_reservation_id","organization_id") REFERENCES "public"."billing_funding_reservations"("id","organization_id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "container_billing_records_funding_reservation_idx" ON "container_billing_records" USING btree ("funding_reservation_id") WHERE "container_billing_records"."funding_reservation_id" IS NOT NULL;
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='container_billing_records'::regclass AND tgname='container_billing_records_funding_reservation_guard') THEN
    CREATE TRIGGER container_billing_records_funding_reservation_guard BEFORE INSERT ON container_billing_records
      FOR EACH ROW EXECUTE FUNCTION guard_container_funded_billing_receipt();
  END IF;
END $$;
