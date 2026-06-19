CREATE TABLE "ScamBenchSession" (
	"id" text PRIMARY KEY NOT NULL,
	"participantId" text NOT NULL,
	"userId" text,
	"source" text DEFAULT 'web' NOT NULL,
	"mturkAssignmentId" text,
	"mturkHitId" text,
	"mturkWorkerId" text,
	"scenarioCount" integer NOT NULL,
	"overallAccuracy" double precision NOT NULL,
	"attackAccuracy" double precision NOT NULL,
	"legitimateAccuracy" double precision NOT NULL,
	"avgReadTimeMs" double precision NOT NULL,
	"avgResponseTimeMs" double precision NOT NULL,
	"totalDurationMs" double precision,
	"responses" json NOT NULL,
	"userAgent" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "UserAgentConfig" ADD COLUMN "alignment" text DEFAULT 'neutral' NOT NULL;--> statement-breakpoint
ALTER TABLE "UserAgentConfig" ADD COLUMN "team" text DEFAULT 'gray' NOT NULL;--> statement-breakpoint
CREATE INDEX "scambench_session_participant_idx" ON "ScamBenchSession" USING btree ("participantId");--> statement-breakpoint
CREATE INDEX "scambench_session_source_idx" ON "ScamBenchSession" USING btree ("source");--> statement-breakpoint
CREATE INDEX "scambench_session_created_idx" ON "ScamBenchSession" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "UserAgentConfig_alignment_team_idx" ON "UserAgentConfig" USING btree ("alignment","team");