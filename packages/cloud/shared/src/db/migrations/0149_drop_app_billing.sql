-- Drop the dead app_billing table (#8923). It was a stranded read-optimized
-- projection of monetization columns that current code never reads or writes —
-- `apps` is the single source of truth (monetization_enabled,
-- inference_markup_percentage, purchase_share_percentage, …). Keeping the table
-- and the apps.billing relation created a source-of-truth contradiction. Assert
-- it holds no rows before dropping so a stray production row blocks the
-- migration loudly instead of silently discarding data. Guarded for idempotency.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'app_billing'
  ) THEN
    IF (SELECT count(*) FROM "app_billing") > 0 THEN
      RAISE EXCEPTION 'app_billing holds % row(s); refusing to drop a non-empty table', (SELECT count(*) FROM "app_billing");
    END IF;
  END IF;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "app_billing" CASCADE;
