-- A container stop has exactly one terminal billing receipt for an elapsed
-- period: either collected (`success`) or durably recorded as `uncollected`.
-- Replace the earlier success-only predicate. The migration runner owns the
-- surrounding transaction, so this file must not commit independently of its
-- journal entry. If historical rows conflict, that outer transaction fails
-- closed and preserves the previous index.

DROP INDEX IF EXISTS "container_billing_records_period_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "container_billing_records_period_unique"
  ON "container_billing_records" ("container_id", "billing_period_start")
  WHERE "status" IN ('success', 'uncollected');
