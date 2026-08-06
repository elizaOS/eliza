CREATE INDEX IF NOT EXISTS "agent_sandboxes_container_name_idx"
	ON "agent_sandboxes" USING btree ("container_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sandboxes_replacement_cleanup_container_name_idx"
	ON "agent_sandboxes" USING btree ("replacement_cleanup_container_name")
	WHERE "replacement_cleanup_container_name" IS NOT NULL;
