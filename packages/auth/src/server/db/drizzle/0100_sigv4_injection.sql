ALTER TABLE "secret_routes"
  ADD COLUMN "injection_strategy" varchar(32) NOT NULL DEFAULT 'header',
  ADD COLUMN "injection_config" jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint

ALTER TABLE "secret_routes"
  ADD CONSTRAINT "secret_routes_injection_strategy_chk"
  CHECK ("injection_strategy" IN ('header', 'sigv4'));
--> statement-breakpoint

ALTER TABLE "secret_routes"
  ADD CONSTRAINT "secret_routes_injection_config_chk" CHECK (
    ("injection_strategy" = 'header' AND "injection_config" = '{}'::jsonb)
    OR
    ("injection_strategy" = 'sigv4'
      AND "injection_config"->>'service' = 'ec2'
      AND "injection_config"->>'region' ~ '^[a-z]{2}(-[a-z0-9]+){1,3}-[1-9][0-9]?$'
      AND "host_pattern" = 'ec2.' || ("injection_config"->>'region') || '.amazonaws.com'
      AND "path_pattern" = '/'
      AND "method" = 'POST'
      AND ("injection_config" - 'service' - 'region') = '{}'::jsonb)
  );
--> statement-breakpoint

CREATE OR REPLACE FUNCTION steward_bump_secret_route_authority_revision() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (
    OLD."host_pattern"          IS DISTINCT FROM NEW."host_pattern"          OR
    OLD."path_pattern"          IS DISTINCT FROM NEW."path_pattern"          OR
    OLD."method"                IS DISTINCT FROM NEW."method"                OR
    OLD."inject_as"             IS DISTINCT FROM NEW."inject_as"             OR
    OLD."inject_key"            IS DISTINCT FROM NEW."inject_key"            OR
    OLD."inject_format"         IS DISTINCT FROM NEW."inject_format"         OR
    OLD."injection_strategy"    IS DISTINCT FROM NEW."injection_strategy"    OR
    OLD."injection_config"      IS DISTINCT FROM NEW."injection_config"      OR
    OLD."secret_id"             IS DISTINCT FROM NEW."secret_id"             OR
    OLD."enabled"               IS DISTINCT FROM NEW."enabled"               OR
    OLD."authority_mode"        IS DISTINCT FROM NEW."authority_mode"        OR
    OLD."provider_operation_id" IS DISTINCT FROM NEW."provider_operation_id"
  ) THEN
    NEW."authority_revision" := OLD."authority_revision" + 1;
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint

ALTER TABLE "provider_action_bindings"
  DROP CONSTRAINT "provider_action_bindings_profile_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings"
  ADD CONSTRAINT "provider_action_bindings_profile_chk"
  CHECK ("canonical_profile" IN (
    'github.provider-action.v1',
    'x.provider-action.v1',
    'generic-http.provider-action.v1',
    'slack.provider-action.v1',
    'google.provider-action.v1',
    'aws.provider-action.v1'
  ));
