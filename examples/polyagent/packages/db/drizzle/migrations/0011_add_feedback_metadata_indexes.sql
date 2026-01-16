-- Add indexes for game feedback metadata queries
-- These functional indexes optimize the admin feedback API filters

-- Index for filtering by feedback type
CREATE INDEX IF NOT EXISTS "Feedback_metadata_feedbackType_idx" 
  ON "Feedback" ((metadata->>'feedbackType')) 
  WHERE "interactionType" = 'general_game_feedback';

-- Index for filtering by Linear issue presence
CREATE INDEX IF NOT EXISTS "Feedback_metadata_linearIssueId_idx" 
  ON "Feedback" ((metadata->>'linearIssueId')) 
  WHERE "interactionType" = 'general_game_feedback';
