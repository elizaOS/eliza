-- Add Discord alert outbox + thread routing for the Sentry incident worker

DO $$
BEGIN
  CREATE TYPE "SentryIncidentAlertOutboxStatus" AS ENUM (
    'pending',
    'processing',
    'sent',
    'failed',
    'dead'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "SentryIncidentAlertOutbox" (
  "id" text PRIMARY KEY NOT NULL,
  "runId" text,
  "inboxId" text NOT NULL,
  "sentryIssueKey" text NOT NULL,
  "eventType" text NOT NULL,
  "dedupeKey" text NOT NULL,
  "payload" json NOT NULL,
  "status" "SentryIncidentAlertOutboxStatus" NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "maxAttempts" integer NOT NULL DEFAULT 8,
  "nextAttemptAt" timestamp NOT NULL DEFAULT now(),
  "processingStartedAt" timestamp,
  "sentAt" timestamp,
  "lastError" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL,
  CONSTRAINT "SentryIncidentAlertOutbox_dedupeKey_unique" UNIQUE("dedupeKey")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryIncidentAlertOutbox_status_nextAttemptAt_idx"
  ON "SentryIncidentAlertOutbox" USING btree ("status", "nextAttemptAt");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryIncidentAlertOutbox_issueKey_createdAt_idx"
  ON "SentryIncidentAlertOutbox" USING btree ("sentryIssueKey", "createdAt");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryIncidentAlertOutbox_runId_idx"
  ON "SentryIncidentAlertOutbox" USING btree ("runId");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryIncidentAlertOutbox_inboxId_idx"
  ON "SentryIncidentAlertOutbox" USING btree ("inboxId");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "SentryIncidentDiscordThread" (
  "id" text PRIMARY KEY NOT NULL,
  "sentryIssueKey" text NOT NULL,
  "channelId" text NOT NULL,
  "rootMessageId" text NOT NULL,
  "threadId" text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL,
  CONSTRAINT "SentryIncidentDiscordThread_sentryIssueKey_unique" UNIQUE("sentryIssueKey"),
  CONSTRAINT "SentryIncidentDiscordThread_threadId_unique" UNIQUE("threadId")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryIncidentDiscordThread_threadId_idx"
  ON "SentryIncidentDiscordThread" USING btree ("threadId");
