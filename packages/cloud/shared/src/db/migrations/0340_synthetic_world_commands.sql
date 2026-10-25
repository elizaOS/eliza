CREATE TABLE IF NOT EXISTS "synthetic_world_commands" (
	"namespace" text NOT NULL,
	"command_id" text NOT NULL,
	"generation" integer NOT NULL,
	"command_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"payload_json" text NOT NULL,
	"phase" text NOT NULL,
	"outcome" text NOT NULL,
	"result_json" text,
	"error_code" text,
	"error_message" text,
	"execution_token" text,
	"created_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" integer NOT NULL,
	CONSTRAINT "synthetic_world_commands_namespace_command_id_pk" PRIMARY KEY("namespace","command_id"),
	CONSTRAINT "synthetic_world_commands_generation_revision_check" CHECK (
		"generation" > 0 AND "revision" > 0
	),
	CONSTRAINT "synthetic_world_commands_phase_check" CHECK (
		"phase" IN ('OWNED', 'EXECUTING', 'COMMITTED', 'SUCCEEDED', 'FAILED', 'DIRTY')
	),
	CONSTRAINT "synthetic_world_commands_outcome_check" CHECK (
		"outcome" IN ('PENDING', 'KNOWN_SUCCESS', 'KNOWN_FAILURE', 'UNKNOWN')
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "synthetic_world_commands_recovery_idx"
	ON "synthetic_world_commands" USING btree ("namespace", "generation", "phase");
