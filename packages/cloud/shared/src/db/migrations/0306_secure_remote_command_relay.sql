CREATE TABLE IF NOT EXISTS "remote_command_envelopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL REFERENCES "remote_sessions"("id") ON DELETE cascade,
	"grant_id" uuid NOT NULL,
	"grant_revision" integer NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"host_id" uuid NOT NULL REFERENCES "remote_hosts"("id") ON DELETE cascade,
	"controller_device_id" text NOT NULL,
	"controller_key_id" text NOT NULL,
	"target_key_id" text NOT NULL,
	"command_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"nonce" text NOT NULL,
	"envelope" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claim_expires_at" timestamp with time zone,
	"start_receipt" jsonb,
	"started_at" timestamp with time zone,
	"result_envelope" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "remote_command_envelopes_positive_sequence_check"
		CHECK ("sequence" > 0 AND "attempts" >= 0 AND "grant_revision" > 0),
	CONSTRAINT "remote_command_envelopes_lifecycle_shape_check" CHECK (
		("status" = 'pending' AND "claim_token" IS NULL AND "claim_expires_at" IS NULL
			AND "start_receipt" IS NULL AND "started_at" IS NULL AND "result_envelope" IS NULL)
		OR ("status" = 'claimed' AND "claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL
			AND "start_receipt" IS NULL AND "started_at" IS NULL AND "result_envelope" IS NULL)
		OR ("status" IN ('started', 'execution_ambiguous') AND "claim_token" IS NOT NULL
			AND "claim_expires_at" IS NULL AND "start_receipt" IS NOT NULL
			AND "started_at" IS NOT NULL AND "result_envelope" IS NULL)
		OR ("status" = 'completed' AND "claim_token" IS NOT NULL AND "claim_expires_at" IS NULL
			AND "start_receipt" IS NOT NULL AND "started_at" IS NOT NULL
			AND "result_envelope" IS NOT NULL AND "completed_at" IS NOT NULL)
		OR ("status" IN ('expired', 'cancelled') AND "claim_token" IS NULL
			AND "claim_expires_at" IS NULL AND "start_receipt" IS NULL
			AND "started_at" IS NULL AND "result_envelope" IS NULL)
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_command_envelopes_session_queue_idx"
	ON "remote_command_envelopes" ("session_id", "status", "sequence");
CREATE INDEX IF NOT EXISTS "remote_command_envelopes_host_queue_idx"
	ON "remote_command_envelopes" ("host_id", "status", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "remote_command_envelopes_session_command_unique"
	ON "remote_command_envelopes" ("session_id", "command_id");
CREATE UNIQUE INDEX IF NOT EXISTS "remote_command_envelopes_session_sequence_unique"
	ON "remote_command_envelopes" ("session_id", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "remote_command_envelopes_session_nonce_unique"
	ON "remote_command_envelopes" ("session_id", "nonce");
