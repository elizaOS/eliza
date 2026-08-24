-- Durable cancellation receipts follow the Personal Shared 0312 migration.
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
ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT "billing_cancel_commands_requested_by_user_id_users_id_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "billing_cancel_commands" ADD CONSTRAINT "billing_cancel_commands_job_id_jobs_id_fk"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT;
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
ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT "billing_cancel_command_keys_requested_by_user_id_users_id_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT "billing_cancel_command_keys_command_tenant_fkey"
  FOREIGN KEY ("command_id", "organization_id")
  REFERENCES "billing_cancel_commands"("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX "billing_cancel_command_keys_command_idx"
  ON "billing_cancel_command_keys" ("command_id");
--> statement-breakpoint
CREATE FUNCTION "billing_cancel_actor_tenant_guard"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "users"
    WHERE "id" = NEW."requested_by_user_id"
      AND "organization_id" = NEW."organization_id"
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = TG_ARGV[0],
      MESSAGE = format('%s: actor must belong to the receipt tenant', TG_ARGV[0]);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "billing_cancel_command_job_tenant_guard"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "jobs"
    WHERE "id" = NEW."job_id"
      AND "organization_id" = NEW."organization_id"
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      CONSTRAINT = 'billing_cancel_commands_job_tenant_guard',
      MESSAGE = 'billing_cancel_commands_job_tenant_guard: job must belong to the receipt tenant';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "billing_cancel_authority_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = TG_ARGV[0],
    MESSAGE = format('%s: authority fields are immutable', TG_ARGV[0]);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_commands_actor_tenant_guard"
  BEFORE INSERT ON "billing_cancel_commands"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_actor_tenant_guard"(
    'billing_cancel_commands_requesting_user_tenant_guard'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_commands_job_tenant_guard"
  BEFORE INSERT ON "billing_cancel_commands"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_command_job_tenant_guard"();
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_commands_authority_immutable"
  BEFORE UPDATE OR DELETE ON "billing_cancel_commands"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_authority_immutable"(
    'billing_cancel_commands_authority_immutable'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_commands_truncate_guard"
  BEFORE TRUNCATE ON "billing_cancel_commands"
  FOR EACH STATEMENT EXECUTE FUNCTION "billing_cancel_authority_immutable"(
    'billing_cancel_commands_truncate_guard'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_command_keys_actor_tenant_guard"
  BEFORE INSERT ON "billing_cancel_command_keys"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_actor_tenant_guard"(
    'billing_cancel_command_keys_requesting_user_tenant_guard'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_command_keys_authority_immutable"
  BEFORE UPDATE OR DELETE ON "billing_cancel_command_keys"
  FOR EACH ROW EXECUTE FUNCTION "billing_cancel_authority_immutable"(
    'billing_cancel_command_keys_authority_immutable'
  );
--> statement-breakpoint
CREATE TRIGGER "billing_cancel_command_keys_truncate_guard"
  BEFORE TRUNCATE ON "billing_cancel_command_keys"
  FOR EACH STATEMENT EXECUTE FUNCTION "billing_cancel_authority_immutable"(
    'billing_cancel_command_keys_truncate_guard'
  );
