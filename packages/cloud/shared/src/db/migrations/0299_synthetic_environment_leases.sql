CREATE TABLE IF NOT EXISTS "synthetic_environment_leases" (
	"namespace" text PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"lease_id" uuid,
	"owner_id" text,
	"owner_process_id" integer,
	"owner_host" text,
	"acquired_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"revision" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthetic_environment_leases_generation_check" CHECK (
		"generation" >= 0 AND "revision" >= 0
	),
	CONSTRAINT "synthetic_environment_leases_authority_shape_check" CHECK (
		(
			"lease_id" IS NULL
			AND "owner_id" IS NULL
			AND "owner_process_id" IS NULL
			AND "owner_host" IS NULL
			AND "expires_at" IS NULL
		) OR (
			"lease_id" IS NOT NULL
			AND "owner_id" IS NOT NULL
			AND "owner_host" IS NOT NULL
			AND "acquired_at" IS NOT NULL
			AND "heartbeat_at" IS NOT NULL
			AND "expires_at" IS NOT NULL
		)
	)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "synthetic_environment_leases_expires_idx"
	ON "synthetic_environment_leases" USING btree ("expires_at");
