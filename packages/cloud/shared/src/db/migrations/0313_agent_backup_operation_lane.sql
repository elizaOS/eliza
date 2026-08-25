CREATE TABLE IF NOT EXISTS "agent_backup_operation_lane" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"owner_id" text,
	"generation" uuid,
	"organization_id" uuid,
	"backup_id" uuid,
	"operation_id" uuid,
	"claimed_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"claim_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_backup_operation_lane_singleton_check" CHECK ("agent_backup_operation_lane"."singleton"),
	CONSTRAINT "agent_backup_operation_lane_shape_check" CHECK (("agent_backup_operation_lane"."claim_sequence" >= 0 AND ((
		"agent_backup_operation_lane"."owner_id" IS NULL
		AND "agent_backup_operation_lane"."generation" IS NULL
		AND "agent_backup_operation_lane"."organization_id" IS NULL
		AND "agent_backup_operation_lane"."backup_id" IS NULL
		AND "agent_backup_operation_lane"."operation_id" IS NULL
		AND "agent_backup_operation_lane"."claimed_at" IS NULL
		AND "agent_backup_operation_lane"."lease_expires_at" IS NULL
		AND "agent_backup_operation_lane"."released_at" IS NULL
	) OR (
		"agent_backup_operation_lane"."owner_id" IS NOT NULL
		AND btrim("agent_backup_operation_lane"."owner_id") = "agent_backup_operation_lane"."owner_id"
		AND octet_length("agent_backup_operation_lane"."owner_id") BETWEEN 1 AND 255
		AND "agent_backup_operation_lane"."owner_id" !~ '[[:cntrl:]]'
		AND "agent_backup_operation_lane"."generation" IS NOT NULL
		AND "agent_backup_operation_lane"."organization_id" IS NOT NULL
		AND "agent_backup_operation_lane"."backup_id" IS NOT NULL
		AND "agent_backup_operation_lane"."operation_id" IS NOT NULL
		AND "agent_backup_operation_lane"."claimed_at" IS NOT NULL
		AND "agent_backup_operation_lane"."lease_expires_at" > "agent_backup_operation_lane"."claimed_at"
		AND ("agent_backup_operation_lane"."released_at" IS NULL
			OR "agent_backup_operation_lane"."released_at" >= "agent_backup_operation_lane"."claimed_at")
		AND "agent_backup_operation_lane"."claim_sequence" >= 1
	))) IS TRUE)
);
--> statement-breakpoint
INSERT INTO "agent_backup_operation_lane" ("singleton") VALUES (true)
ON CONFLICT ("singleton") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_operation_tenant_watermarks" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"last_backup_id" uuid NOT NULL,
	"last_operation_id" uuid NOT NULL,
	"last_service_sequence" bigint NOT NULL,
	"service_count" bigint DEFAULT 1 NOT NULL,
	"last_served_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_backup_operation_tenant_watermarks_counters_check"
		CHECK ("last_service_sequence" >= 1 AND "service_count" >= 1),
	CONSTRAINT "agent_backup_op_tenant_watermarks_org_fkey"
		FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
		ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_operation_node_watermarks" (
	"source_node_history_id" uuid PRIMARY KEY NOT NULL,
	"source_node_record_id" uuid NOT NULL,
	"source_node_incarnation" uuid NOT NULL,
	"last_backup_id" uuid NOT NULL,
	"last_operation_id" uuid NOT NULL,
	"last_service_sequence" bigint NOT NULL,
	"service_count" bigint DEFAULT 1 NOT NULL,
	"last_served_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_backup_operation_node_watermarks_counters_check"
		CHECK ("last_service_sequence" >= 1 AND "service_count" >= 1),
	CONSTRAINT "agent_backup_op_node_watermarks_node_fkey"
		FOREIGN KEY ("source_node_record_id") REFERENCES "public"."docker_nodes"("id")
		ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "agent_backup_op_node_watermarks_occurrence_fkey"
		FOREIGN KEY ("source_node_history_id", "source_node_record_id", "source_node_incarnation")
		REFERENCES "public"."agent_node_incarnation_histories"("id", "docker_node_record_id", "node_incarnation")
		ON DELETE restrict ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_operation_tenant_watermarks_sequence_uidx"
	ON "agent_backup_operation_tenant_watermarks" USING btree ("last_service_sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_operation_node_watermarks_sequence_uidx"
	ON "agent_backup_operation_node_watermarks" USING btree ("last_service_sequence");
