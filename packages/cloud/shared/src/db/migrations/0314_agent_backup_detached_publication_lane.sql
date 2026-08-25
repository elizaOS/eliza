ALTER TABLE "agent_backup_operation_lane"
	ADD COLUMN IF NOT EXISTS "operation_phase" text;
--> statement-breakpoint
UPDATE "agent_backup_operation_lane"
	SET "operation_phase" = 'capture'
	WHERE "owner_id" IS NOT NULL AND "operation_phase" IS NULL;
--> statement-breakpoint
ALTER TABLE "agent_backup_operation_lane"
	DROP CONSTRAINT IF EXISTS "agent_backup_operation_lane_shape_check";
--> statement-breakpoint
ALTER TABLE "agent_backup_operation_lane"
	ADD CONSTRAINT "agent_backup_operation_lane_shape_check" CHECK ((
		"claim_sequence" >= 0 AND ((
			"owner_id" IS NULL
			AND "generation" IS NULL
			AND "organization_id" IS NULL
			AND "backup_id" IS NULL
			AND "operation_id" IS NULL
			AND "operation_phase" IS NULL
			AND "claimed_at" IS NULL
			AND "lease_expires_at" IS NULL
			AND "released_at" IS NULL
		) OR (
			"owner_id" IS NOT NULL
			AND btrim("owner_id") = "owner_id"
			AND octet_length("owner_id") BETWEEN 1 AND 255
			AND "owner_id" !~ '[[:cntrl:]]'
			AND "generation" IS NOT NULL
			AND "organization_id" IS NOT NULL
			AND "backup_id" IS NOT NULL
			AND "operation_id" IS NOT NULL
			AND "operation_phase" IN ('capture', 'publication')
			AND "claimed_at" IS NOT NULL
			AND "lease_expires_at" > "claimed_at"
			AND ("released_at" IS NULL OR "released_at" >= "claimed_at")
			AND "claim_sequence" >= 1
		))
	) IS TRUE);
--> statement-breakpoint
ALTER TABLE "agent_backup_operation_node_watermarks"
	DROP CONSTRAINT IF EXISTS "agent_backup_op_node_watermarks_node_fkey";
