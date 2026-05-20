-- Rollback: Remove daily login streak tracking fields from User table
-- Purpose: Revert BAB-88 - Daily Login Rewards & Streak System

-- Remove indexes first
DROP INDEX IF EXISTS "User_dailyLoginStreak_idx";
DROP INDEX IF EXISTS "User_longestStreak_idx";
DROP INDEX IF EXISTS "User_lastDailyLogin_idx";

-- Remove CHECK constraints
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_dailyLoginStreak_check";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_longestStreak_check";
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_totalDailyLogins_check";

-- Remove columns
ALTER TABLE "User" DROP COLUMN IF EXISTS "dailyLoginStreak";
ALTER TABLE "User" DROP COLUMN IF EXISTS "lastDailyLogin";
ALTER TABLE "User" DROP COLUMN IF EXISTS "longestStreak";
ALTER TABLE "User" DROP COLUMN IF EXISTS "totalDailyLogins";
