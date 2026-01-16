-- Rollback Migration: Remove Procedural Narrative System
-- Reverses changes from 0016_add_procedural_narrative_system.sql

-- Drop indexes first
DROP INDEX IF EXISTS "OrganizationState_sentiment_idx";
DROP INDEX IF EXISTS "ActorState_lastActiveAt_idx";
DROP INDEX IF EXISTS "ActorState_lastPostAt_idx";
DROP INDEX IF EXISTS "ArcState_currentState_idx";
DROP INDEX IF EXISTS "ArcState_questionId_unique";
DROP INDEX IF EXISTS "QuestionArcPlan_questionId_idx";
DROP INDEX IF EXISTS "GameOnboarding_currentStep_idx";
DROP INDEX IF EXISTS "GameOnboarding_isComplete_idx";

-- Drop tables
DROP TABLE IF EXISTS "ArcState";
DROP TABLE IF EXISTS "QuestionArcPlan";
DROP TABLE IF EXISTS "GameOnboarding";

-- Drop CHECK constraints before dropping columns that have them
ALTER TABLE "OrganizationState" DROP CONSTRAINT IF EXISTS sentiment_range;
ALTER TABLE "ActorState" DROP CONSTRAINT IF EXISTS current_mood_bounds;

-- Remove OrganizationState columns
ALTER TABLE "OrganizationState" DROP COLUMN IF EXISTS "activeModifiers";
ALTER TABLE "OrganizationState" DROP COLUMN IF EXISTS "sentiment";
ALTER TABLE "OrganizationState" DROP COLUMN IF EXISTS "basePrice";

-- Remove ActorState columns
ALTER TABLE "ActorState" DROP COLUMN IF EXISTS "relationships";
ALTER TABLE "ActorState" DROP COLUMN IF EXISTS "recentMemories";
ALTER TABLE "ActorState" DROP COLUMN IF EXISTS "currentMood";
ALTER TABLE "ActorState" DROP COLUMN IF EXISTS "postsTodayResetAt";
ALTER TABLE "ActorState" DROP COLUMN IF EXISTS "postsToday";
ALTER TABLE "ActorState" DROP COLUMN IF EXISTS "lastActiveAt";
ALTER TABLE "ActorState" DROP COLUMN IF EXISTS "lastPostAt";
