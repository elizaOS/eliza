-- Durable organization-level auto-top-up re-arm fence objects. The existing
-- organization baseline is applied separately by the following migration.
CREATE SEQUENCE IF NOT EXISTS "organization_balance_decrease_revision_seq" AS bigint;
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "balance_decrease_revision" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "auto_top_up_covered_balance_decrease_revision" bigint;

CREATE OR REPLACE FUNCTION "advance_organization_balance_decrease_revision"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."credit_balance" < OLD."credit_balance" THEN
    NEW."balance_decrease_revision" := nextval('organization_balance_decrease_revision_seq');
  ELSE
    NEW."balance_decrease_revision" := OLD."balance_decrease_revision";
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "organizations_balance_decrease_revision_trigger" ON "organizations";
CREATE TRIGGER "organizations_balance_decrease_revision_trigger"
BEFORE UPDATE OF "credit_balance" ON "organizations" FOR EACH ROW
EXECUTE FUNCTION "advance_organization_balance_decrease_revision"();
CREATE OR REPLACE FUNCTION "fence_auto_top_up_credit"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."type" = 'credit' AND NEW."metadata"->>'type' = 'auto_top_up' THEN
    UPDATE "organizations"
    SET "auto_top_up_covered_balance_decrease_revision" = "balance_decrease_revision"
    WHERE "id" = NEW."organization_id";
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "credit_transactions_auto_top_up_fence_trigger" ON "credit_transactions";
CREATE TRIGGER "credit_transactions_auto_top_up_fence_trigger"
AFTER INSERT ON "credit_transactions" FOR EACH ROW EXECUTE FUNCTION "fence_auto_top_up_credit"();
