-- Add durable run tracking for the external Sentry incident worker

DO $$
BEGIN
  CREATE TYPE "SentryIncidentRunStatus" AS ENUM (
    'running',
    'completed',
    'failed',
    'suppressed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  CREATE TYPE "SentryIncidentRunDecision" AS ENUM (
    'pending',
    'skip_linear',
    'reuse_linear',
    'create_linear',
    'process_issue'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "SentryIncidentRun" (
  "id" text PRIMARY KEY NOT NULL,
  "inboxId" text NOT NULL,
  "sentryIssueKey" text NOT NULL,
  "issueId" text,
  "issueShortId" text,
  "action" text,
  "workerId" text NOT NULL,
  "status" "SentryIncidentRunStatus" NOT NULL DEFAULT 'running',
  "decision" "SentryIncidentRunDecision" NOT NULL DEFAULT 'pending',
  "linearIssueId" text,
  "linearIssueUrl" text,
  "codexSessionId" text,
  "summary" text,
  "resultReason" text,
  "error" text,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "finishedAt" timestamp,
  "updatedAt" timestamp NOT NULL
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryIncidentRun_inboxId_idx"
  ON "SentryIncidentRun" USING btree ("inboxId");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryIncidentRun_issueKey_createdAt_idx"
  ON "SentryIncidentRun" USING btree ("sentryIssueKey", "createdAt");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryIncidentRun_linearIssueId_idx"
  ON "SentryIncidentRun" USING btree ("linearIssueId");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "SentryIncidentRun_status_createdAt_idx"
  ON "SentryIncidentRun" USING btree ("status", "createdAt");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "SentryIncidentRun_activeIssue_unique_idx"
  ON "SentryIncidentRun" USING btree ("sentryIssueKey")
  WHERE "status" = 'running';
