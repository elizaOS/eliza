-- Fence receipt actors/jobs to their tenant and make authority append-only.

CREATE OR REPLACE FUNCTION "billing_cancel_actor_tenant_guard"() RETURNS trigger AS $$
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
CREATE OR REPLACE FUNCTION "billing_cancel_command_job_tenant_guard"() RETURNS trigger AS $$
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
CREATE OR REPLACE FUNCTION "billing_cancel_authority_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    CONSTRAINT = TG_ARGV[0],
    MESSAGE = format('%s: authority fields are immutable', TG_ARGV[0]);
END;
$$ LANGUAGE plpgsql;
