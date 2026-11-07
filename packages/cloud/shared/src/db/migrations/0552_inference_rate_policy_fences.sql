-- Rate-only enrollment shares the existing epoch and mutation receipts. It
-- never enables funding delegation or creates an escrow grant.
ALTER TABLE inference_policy_authorities ADD COLUMN rate_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_inference_policy_fence(org uuid, force_fence boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF org IS NULL THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inference-policy:' || org::text, 0));
 IF NOT force_fence AND NOT EXISTS (SELECT 1 FROM inference_policy_authorities WHERE organization_id = org AND (enabled OR rate_enabled)) THEN RETURN; END IF;
 IF NOT EXISTS (SELECT 1 FROM inference_policy_mutations WHERE organization_id = org AND applying_txid = txid_current() AND phase = 'applying' AND permit_expires_at > clock_timestamp()) THEN
  RAISE EXCEPTION 'INFERENCE_POLICY_FENCE_REQUIRED' USING ERRCODE = 'P0001';
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_inference_policy_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; org uuid; changed boolean := TG_OP <> 'UPDATE'; column_name text;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
 IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
 IF TG_OP = 'UPDATE' THEN
  IF TG_NARGS = 1 THEN changed := (old_row - 'updated_at') IS DISTINCT FROM (new_row - 'updated_at');
  ELSE
   FOR i IN 1..TG_NARGS-1 LOOP
    column_name := TG_ARGV[i];
    IF old_row->column_name IS DISTINCT FROM new_row->column_name THEN changed := true; EXIT; END IF;
   END LOOP;
  END IF;
 END IF;
 IF NOT changed THEN RETURN NEW; END IF;
 IF old_row IS NOT NULL THEN
  org := (old_row->>TG_ARGV[0])::uuid;
  PERFORM require_inference_policy_fence(org, TG_TABLE_NAME = 'inference_policy_authorities' AND ((old_row->>'enabled')::boolean OR (old_row->>'rate_enabled')::boolean));
 END IF;
 IF new_row IS NOT NULL THEN
  org := (new_row->>TG_ARGV[0])::uuid;
  PERFORM require_inference_policy_fence(org, TG_TABLE_NAME = 'inference_policy_authorities' AND ((new_row->>'enabled')::boolean OR (new_row->>'rate_enabled')::boolean));
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER inference_policy_guard ON inference_policy_authorities;
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON inference_policy_authorities FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id','enabled','rate_enabled','epoch');
