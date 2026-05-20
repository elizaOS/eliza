CREATE TABLE IF NOT EXISTS "DailyTopic" (
  "id" text PRIMARY KEY NOT NULL,
  "date" timestamp NOT NULL,
  "topicKey" text NOT NULL,
  "topicLabel" text NOT NULL,
  "summary" text NOT NULL,
  "sourceType" text NOT NULL,
  "sourceHeadlineIds" json NOT NULL,
  "selectionReason" text,
  "isLocked" boolean DEFAULT false NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp NOT NULL,
  CONSTRAINT "DailyTopic_date_unique" UNIQUE("date")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "DailyTopic_date_idx" ON "DailyTopic" USING btree ("date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "DailyTopic_topicKey_idx" ON "DailyTopic" USING btree ("topicKey");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "DailyTopic_isLocked_date_idx" ON "DailyTopic" USING btree ("isLocked","date");
--> statement-breakpoint

ALTER TABLE "Question"
  ADD COLUMN IF NOT EXISTS "topicKey" text,
  ADD COLUMN IF NOT EXISTS "topicLabel" text,
  ADD COLUMN IF NOT EXISTS "topicDate" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "Question_topicKey_topicDate_idx" ON "Question" USING btree ("topicKey","topicDate");
--> statement-breakpoint

ALTER TABLE "TimeframedMarket"
  ADD COLUMN IF NOT EXISTS "topicKey" text,
  ADD COLUMN IF NOT EXISTS "topicLabel" text,
  ADD COLUMN IF NOT EXISTS "topicDate" timestamp;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TimeframedMarket_topicKey_topicDate_idx" ON "TimeframedMarket" USING btree ("topicKey","topicDate");
