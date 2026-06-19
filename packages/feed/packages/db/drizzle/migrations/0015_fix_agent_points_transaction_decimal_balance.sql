-- Migration: Fix AgentPointsTransaction balanceBefore/balanceAfter to decimal
-- Fixes type mismatch where virtualBalance (decimal) was being inserted into integer columns
-- causing PostgreSQL error 22P02 for values like 199.08

-- Alter balanceBefore column from integer to decimal(18,2)
ALTER TABLE "AgentPointsTransaction" 
  ALTER COLUMN "balanceBefore" SET DATA TYPE numeric(18, 2);

-- Alter balanceAfter column from integer to decimal(18,2)
ALTER TABLE "AgentPointsTransaction" 
  ALTER COLUMN "balanceAfter" SET DATA TYPE numeric(18, 2);
