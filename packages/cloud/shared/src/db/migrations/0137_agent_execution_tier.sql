-- Agent execution tier — so most agents run container-free in the shared
-- runtime instead of each getting a dedicated container.
--
-- New agents default to 'shared'. Every row that exists when this runs is a
-- container agent (the shared tier did not exist before), so it is backfilled:
-- a BYO Docker image -> 'custom', otherwise -> 'dedicated-lazy'.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the backfill only touches rows still
-- at the 'shared' default, so a re-run is a no-op. See
-- packages/cloud-shared/src/lib/services/shared-runtime/agent-tier.ts.

ALTER TABLE "agent_sandboxes"
	ADD COLUMN IF NOT EXISTS "execution_tier" text DEFAULT 'shared' NOT NULL;
--> statement-breakpoint
UPDATE "agent_sandboxes"
	SET "execution_tier" = CASE
		WHEN "docker_image" IS NOT NULL AND length(trim("docker_image")) > 0 THEN 'custom'
		ELSE 'dedicated-lazy'
	END
	WHERE "execution_tier" = 'shared';
