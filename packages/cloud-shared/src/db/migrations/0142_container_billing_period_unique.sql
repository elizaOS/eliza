ALTER TABLE "container_billing_records" ADD COLUMN IF NOT EXISTS "billing_period" text;

UPDATE "container_billing_records"
SET "billing_period" = to_char("billing_period_start" AT TIME ZONE 'UTC', 'YYYY-MM-DD')
WHERE "billing_period" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "container_billing_records_container_period_success_unique"
  ON "container_billing_records" ("container_id", "billing_period")
  WHERE "status" = 'success' AND "billing_period" IS NOT NULL;
