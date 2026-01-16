-- Add reportedCommentId field to Report table for direct comment reporting
-- This enables comments to be reported and moderated independently from posts

ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "reportedCommentId" text;

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS "Report_reportedCommentId_idx" ON "Report" ("reportedCommentId");
CREATE INDEX IF NOT EXISTS "Report_reportedCommentId_status_idx" ON "Report" ("reportedCommentId", "status");
