DROP INDEX IF EXISTS "Question_requiresManualReview_status_idx";

ALTER TABLE "Question" DROP COLUMN IF EXISTS "resolutionReviewedBy";
ALTER TABLE "Question" DROP COLUMN IF EXISTS "resolutionReviewedAt";
ALTER TABLE "Question" DROP COLUMN IF EXISTS "resolutionReviewStatus";
ALTER TABLE "Question" DROP COLUMN IF EXISTS "requiresManualReview";
ALTER TABLE "Question" DROP COLUMN IF EXISTS "resolutionConfidence";

