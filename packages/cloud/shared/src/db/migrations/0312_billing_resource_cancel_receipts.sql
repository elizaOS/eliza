ALTER TABLE "container_compute_stop_intents"
  ADD COLUMN "authorization" text DEFAULT 'billing_request' NOT NULL;
--> statement-breakpoint
ALTER TABLE "container_compute_stop_intents"
  ADD CONSTRAINT "container_compute_stop_intents_authorization_check"
  CHECK ("authorization" IN ('billing_request', 'user_request'));
--> statement-breakpoint
CREATE UNIQUE INDEX "container_compute_stop_intents_user_generation_unique"
  ON "container_compute_stop_intents" ("organization_id", "container_id", "lifecycle_revision")
  WHERE "authorization" = 'user_request';
--> statement-breakpoint
ALTER TABLE "agent_compute_stop_intents"
  ADD COLUMN "authorization" text DEFAULT 'billing_request' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_compute_stop_intents"
  ADD CONSTRAINT "agent_compute_stop_intents_authorization_check"
  CHECK ("authorization" IN ('billing_request', 'user_request'));
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_compute_stop_intents_user_request_unique"
  ON "agent_compute_stop_intents" ("organization_id", "agent_id", "lifecycle_revision")
  WHERE "authorization" = 'user_request';
--> statement-breakpoint
ALTER TABLE "jobs"
  ADD CONSTRAINT "jobs_id_org_unique" UNIQUE("id", "organization_id");
--> statement-breakpoint
ALTER TABLE "users"
  ADD CONSTRAINT "users_id_org_unique" UNIQUE("id", "organization_id");
--> statement-breakpoint
CREATE TABLE "billing_cancel_commands" (
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
ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT "billing_cancel_commands_requesting_user_tenant_fkey"
  FOREIGN KEY ("requested_by_user_id", "organization_id")
  REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT "billing_cancel_commands_job_tenant_fkey"
  FOREIGN KEY ("job_id", "organization_id")
  REFERENCES "jobs"("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_cancel_commands_logical_unique"
  ON "billing_cancel_commands" ("organization_id", "resource_type", "resource_id", "expected_lifecycle_revision", "action");
--> statement-breakpoint
CREATE INDEX "billing_cancel_commands_org_created_idx"
  ON "billing_cancel_commands" ("organization_id", "created_at");
--> statement-breakpoint
CREATE TABLE "billing_cancel_command_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "idempotency_key_hash" text NOT NULL,
  "request_digest" text NOT NULL,
  "command_id" uuid NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "billing_cancel_command_keys_org_key_unique" UNIQUE("organization_id", "idempotency_key_hash"),
  CONSTRAINT "billing_cancel_command_keys_digest_shape_check"
    CHECK ("idempotency_key_hash" ~ '^[a-f0-9]{64}$' AND "request_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT "billing_cancel_command_keys_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT "billing_cancel_command_keys_requesting_user_tenant_fkey"
  FOREIGN KEY ("requested_by_user_id", "organization_id")
  REFERENCES "users"("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT "billing_cancel_command_keys_command_tenant_fkey"
  FOREIGN KEY ("command_id", "organization_id")
  REFERENCES "billing_cancel_commands"("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "billing_cancel_command_keys_command_idx"
  ON "billing_cancel_command_keys" ("command_id");
