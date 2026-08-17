-- Conservatively baseline every organization present at backfill time; new
-- organizations created after this migration retain the column default NULL.
UPDATE "organizations"
SET "auto_top_up_covered_balance_decrease_revision" = "balance_decrease_revision"
WHERE "auto_top_up_covered_balance_decrease_revision" IS NULL;
