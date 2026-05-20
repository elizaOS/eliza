-- Add Sentry webhook inbox table for autonomous incident worker ingestion
-- Stores verified webhook payloads with idempotency keys and worker processing state

DO $$
BEGIN
  CREATE TYPE "SentryWebhookInboxStatus" AS ENUM (
    'pending',
    'processing',
    'processed',
    'failed',
    'dead'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "SentryWebhookInbox" (
  "id" text PRIMARY KEY NOT NULL,
  "provider" text NOT NULL DEFAULT 'sentry',
  "resource" text NOT NULL,
  "action" text,
  "organizationSlug" text,
  "projectSlug" text,
  "issueId" text,
  "issueShortId" text,
  "issueTitle" text,
  "issueUrl" text,
  "eventId" text,
  "level" text,
  "culprit" text,
  "dedupeKey" text NOT NULL,
  "routingKey" text,
  "webhookTimestamp" timestamp,
  "status" "SentryWebhookInboxStatus" NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "maxAttempts" integer NOT NULL DEFAULT 8,
  "nextAttemptAt" timestamp NOT NULL DEFAULT now(),
  "processingStartedAt" timestamp,
  "processedAt" timestamp,
  "failedAt" timestamp,
  "lastError" text,
  "payload" json NOT NULL,
  "metadata" json,
  "receivedAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL,
  CONSTRAINT "SentryWebhookInbox_dedupeKey_unique" UNIQUE("dedupeKey")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryWebhookInbox_status_nextAttemptAt_idx"
  ON "SentryWebhookInbox" USING btree ("status", "nextAttemptAt");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryWebhookInbox_project_issue_status_idx"
  ON "SentryWebhookInbox" USING btree ("projectSlug", "issueId", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryWebhookInbox_eventId_idx"
  ON "SentryWebhookInbox" USING btree ("eventId");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryWebhookInbox_routingKey_status_idx"
  ON "SentryWebhookInbox" USING btree ("routingKey", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryWebhookInbox_receivedAt_idx"
  ON "SentryWebhookInbox" USING btree ("receivedAt");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryWebhookInbox_resource_action_idx"
  ON "SentryWebhookInbox" USING btree ("resource", "action");
