-- Backfill the immutable terminal timestamp for historical failures and
-- cancellations. execution_quiesced_at is the closest durable terminal
-- boundary; older rows fall back to their last mutation, start, or creation.
UPDATE "jobs"
SET "completed_at" = COALESCE(
  "execution_quiesced_at",
  "updated_at",
  "started_at",
  "created_at"
)
WHERE "status" IN ('failed', 'cancelled')
  AND "completed_at" IS NULL;
