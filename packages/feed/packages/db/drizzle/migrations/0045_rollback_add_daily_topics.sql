DROP INDEX IF EXISTS "TimeframedMarket_topicKey_topicDate_idx";
--> statement-breakpoint
ALTER TABLE "TimeframedMarket"
  DROP COLUMN IF EXISTS "topicKey",
  DROP COLUMN IF EXISTS "topicLabel",
  DROP COLUMN IF EXISTS "topicDate";
--> statement-breakpoint

DROP INDEX IF EXISTS "Question_topicKey_topicDate_idx";
--> statement-breakpoint
ALTER TABLE "Question"
  DROP COLUMN IF EXISTS "topicKey",
  DROP COLUMN IF EXISTS "topicLabel",
  DROP COLUMN IF EXISTS "topicDate";
--> statement-breakpoint

DROP INDEX IF EXISTS "DailyTopic_isLocked_date_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "DailyTopic_topicKey_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "DailyTopic_date_idx";
--> statement-breakpoint
DROP TABLE IF EXISTS "DailyTopic";
