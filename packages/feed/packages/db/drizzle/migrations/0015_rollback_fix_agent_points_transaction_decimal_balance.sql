-- Rollback: Revert AgentPointsTransaction balanceBefore/balanceAfter to integer
--
-- WARNING: DATA LOSS - This migration will TRUNCATE fractional values!
-- Rows where balanceBefore or balanceAfter have non-zero fractional parts
-- (e.g., 123.45) will be truncated to integers (e.g., 123).
--
-- RECOMMENDED: Before running this migration:
-- 1. Take a backup of the AgentPointsTransaction table
-- 2. Export affected rows using the query below
--
-- Query to detect rows with fractional cents that will lose precision:
-- SELECT id, "balanceBefore", "balanceAfter"
-- FROM "AgentPointsTransaction"
-- WHERE "balanceBefore" != FLOOR("balanceBefore")
--    OR "balanceAfter" != FLOOR("balanceAfter");

ALTER TABLE "AgentPointsTransaction" 
  ALTER COLUMN "balanceBefore" SET DATA TYPE integer USING "balanceBefore"::integer;

ALTER TABLE "AgentPointsTransaction" 
  ALTER COLUMN "balanceAfter" SET DATA TYPE integer USING "balanceAfter"::integer;
