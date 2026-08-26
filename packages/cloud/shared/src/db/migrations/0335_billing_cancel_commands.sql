-- Persist one tenant-scoped durable command for each resource lifecycle stop.

CREATE TABLE IF NOT EXISTS "billing_cancel_commands" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "expected_lifecycle_revision" bigint NOT NULL,
  "action" text DEFAULT 'stop' NOT NULL,
  "job_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "billing_cancel_commands_id_org_unique" UNIQUE("id", "organization_id"),
  CONSTRAINT "billing_cancel_commands_job_unique" UNIQUE("job_id"),
  CONSTRAINT "billing_cancel_commands_shape_check"
    CHECK ("resource_type" IN ('container', 'agent_sandbox')
      AND "action" = 'stop' AND "expected_lifecycle_revision" >= 0)
);
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT "billing_cancel_commands_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT "billing_cancel_commands_requested_by_user_id_users_id_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT "billing_cancel_commands_job_id_jobs_id_fk"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "billing_cancel_commands_logical_unique"
  ON "billing_cancel_commands" ("organization_id", "resource_type", "resource_id", "expected_lifecycle_revision", "action");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_cancel_commands_org_created_idx"
  ON "billing_cancel_commands" ("organization_id", "created_at");
