-- Allows canonical organization updates reached through another trusted trigger to keep the guarded billing shadow synchronized.
CREATE OR REPLACE FUNCTION "guard_organization_billing_shadow"() RETURNS trigger AS $$ BEGIN
  -- Direct shadow mutations enter at depth one. Canonical organization sync
  -- enters at depth two, or deeper when a lifecycle trigger updates the
  -- organization inside its own statement. Only the direct path is forbidden.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'organization_billing is a read-only shadow of organizations'
      USING ERRCODE = '23514', CONSTRAINT = 'organization_billing_shadow_mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
