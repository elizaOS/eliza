ALTER TABLE "Question" ADD COLUMN "resolutionConfidence" double precision;
ALTER TABLE "Question" ADD COLUMN "requiresManualReview" boolean NOT NULL DEFAULT false;
ALTER TABLE "Question" ADD COLUMN "resolutionReviewStatus" text;
ALTER TABLE "Question" ADD COLUMN "resolutionReviewedAt" timestamp;
ALTER TABLE "Question" ADD COLUMN "resolutionReviewedBy" text;

-- Composite index optimized for admin resolution queue query:
-- SELECT ... WHERE status = 'active' AND requiresManualReview = true
--   AND (resolutionReviewStatus IS NULL OR resolutionReviewStatus = 'pending')
-- Column order matches query filter selectivity: status (most selective) first
CREATE INDEX IF NOT EXISTS "Question_requiresManualReview_status_idx"
ON "Question" ("status", "requiresManualReview", "resolutionReviewStatus");

