ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD COLUMN IF NOT EXISTS "locator_vpn_authority" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_replacement_attempt_vpn_authority_owner_check";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_replacement_attempt_vpn_authority_owner_check" CHECK ((
    locator_vpn_authority IS NULL OR (
      locator_recorded_at IS NOT NULL
      AND locator_vpn_node_name IS NOT NULL
      AND jsonb_typeof(locator_vpn_authority->'server') = 'object'
      AND (locator_vpn_authority->'node' = 'null'::jsonb OR (
        jsonb_typeof(locator_vpn_authority->'node') = 'object'
        AND locator_vpn_node_id IS NOT NULL
        AND locator_vpn_authority->'node'->>'id' = locator_vpn_node_id
      ))
    )
  ) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_agent_replacement_vpn_authority() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locator_vpn_authority IS NULL THEN
    IF NEW.locator_vpn_authority IS NOT NULL AND OLD.locator_recorded_at IS NOT NULL THEN
      RAISE EXCEPTION 'replacement VPN scope must be captured with initial intent' USING ERRCODE='23514';
    END IF;
  ELSE
    IF NEW.locator_vpn_authority IS NULL
      OR (OLD.locator_vpn_authority - 'node') IS DISTINCT FROM (NEW.locator_vpn_authority - 'node')
      OR (OLD.locator_vpn_authority->'node' <> 'null'::jsonb
        AND OLD.locator_vpn_authority->'node' IS DISTINCT FROM NEW.locator_vpn_authority->'node')
      OR (OLD.locator_vpn_authority->'node' = 'null'::jsonb
        AND NEW.locator_vpn_authority->'node' <> 'null'::jsonb
        AND (OLD.state <> 'in_flight_unresolved' OR NEW.state <> 'in_flight_unresolved')) THEN
      RAISE EXCEPTION 'replacement VPN authority is immutable after capture' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_replacement_vpn_authority_guard ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE TRIGGER agent_replacement_vpn_authority_guard BEFORE UPDATE OF locator_vpn_authority
  ON "agent_sandbox_replacement_attempts" FOR EACH ROW EXECUTE FUNCTION guard_agent_replacement_vpn_authority();
