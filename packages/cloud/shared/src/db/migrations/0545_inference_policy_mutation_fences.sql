CREATE TABLE inference_policy_authorities (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE RESTRICT,
 enabled boolean NOT NULL DEFAULT false,
 epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE inference_policy_mutations (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
 mutation_id text NOT NULL,
 fence_token text NOT NULL,
 permit_expires_at timestamptz NOT NULL,
 applying_txid bigint NOT NULL,
 phase text NOT NULL CHECK (phase IN ('applying','applied','complete')),
 epoch bigint,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id,mutation_id),
 CONSTRAINT inference_policy_mutations_identity_check CHECK (length(mutation_id) BETWEEN 1 AND 128 AND length(fence_token) > 0),
 CONSTRAINT inference_policy_mutations_epoch_check CHECK ((phase = 'applying' AND epoch IS NULL) OR (phase IN ('applied','complete') AND epoch >= 1))
);
--> statement-breakpoint
CREATE FUNCTION require_inference_policy_fence(org uuid, force_fence boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF org IS NULL THEN RETURN; END IF;
 -- Also serialize first enrollment with previously unenrolled policy writers.
 PERFORM pg_advisory_xact_lock(hashtextextended('inference-policy:' || org::text, 0));
 IF NOT force_fence AND NOT EXISTS (SELECT 1 FROM inference_policy_authorities WHERE organization_id = org AND enabled) THEN RETURN; END IF;
 IF NOT EXISTS (SELECT 1 FROM inference_policy_mutations WHERE organization_id = org AND applying_txid = txid_current() AND phase = 'applying' AND permit_expires_at > clock_timestamp()) THEN
  RAISE EXCEPTION 'INFERENCE_POLICY_FENCE_REQUIRED' USING ERRCODE = 'P0001';
 END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_inference_policy_write() RETURNS trigger LANGUAGE plpgsql AS $$
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
  PERFORM require_inference_policy_fence(org, TG_TABLE_NAME = 'inference_policy_authorities' AND (old_row->>'enabled')::boolean);
 END IF;
 IF new_row IS NOT NULL THEN
  org := (new_row->>TG_ARGV[0])::uuid;
  PERFORM require_inference_policy_fence(org, TG_TABLE_NAME = 'inference_policy_authorities' AND (new_row->>'enabled')::boolean);
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON inference_policy_authorities FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id','enabled','epoch');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE UPDATE OR DELETE ON organizations FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('id','is_active','account_lifecycle_state','account_deletion_request_id','paid_work_fenced_at','settings');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON api_keys FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id','organization_id','user_id','key_hash','is_active','deleted_at','expires_at','rate_limit','source_app_id');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_subscription_authorities FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_entitlements FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_subscriptions FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON billing_subscription_revisions FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_grants FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON org_rate_limit_overrides FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_config FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON organization_payment_reversal_holds FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id');
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_allowance_periods FOR EACH ROW EXECUTE FUNCTION guard_inference_policy_write('organization_id','organization_id','billing_scope_id','merchant_key','subscription_id','subscription_revision','pilot_redemption_id','grant_source','trial_claim_id','promo_grant_id','plan_key','catalog_version','period_start','period_end','expires_at','state','granted_amount','adjustment_amount');
--> statement-breakpoint
CREATE FUNCTION guard_inference_user_policy_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; user_ids uuid[]; org uuid;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
 IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'users' AND (old_row->'is_active',old_row->'organization_id',old_row->'steward_user_id',old_row->'role',old_row->'expires_at',old_row->'deleted_at',old_row->'auth_fenced_at',old_row->'account_lifecycle_state',old_row->'account_deletion_request_id') IS NOT DISTINCT FROM (new_row->'is_active',new_row->'organization_id',new_row->'steward_user_id',new_row->'role',new_row->'expires_at',new_row->'deleted_at',new_row->'auth_fenced_at',new_row->'account_lifecycle_state',new_row->'account_deletion_request_id') THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'user_identities' AND (old_row->'user_id',old_row->'steward_user_id',old_row->'expires_at',old_row->'is_anonymous') IS NOT DISTINCT FROM (new_row->'user_id',new_row->'steward_user_id',new_row->'expires_at',new_row->'is_anonymous') THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'user_moderation_status' AND (old_row->'status',old_row->'total_violations',old_row->'user_id') IS NOT DISTINCT FROM (new_row->'status',new_row->'total_violations',new_row->'user_id') THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME = 'users' THEN
  user_ids := ARRAY[(old_row->>'id')::uuid,(new_row->>'id')::uuid];
  PERFORM require_inference_policy_fence((old_row->>'organization_id')::uuid);
  PERFORM require_inference_policy_fence((new_row->>'organization_id')::uuid);
 ELSE user_ids := ARRAY[(old_row->>'user_id')::uuid,(new_row->>'user_id')::uuid]; END IF;
 FOR org IN SELECT organization_id FROM users WHERE id = ANY(user_ids) AND organization_id IS NOT NULL UNION SELECT organization_id FROM api_keys WHERE user_id = ANY(user_ids) ORDER BY 1 LOOP
  PERFORM require_inference_policy_fence(org);
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION guard_inference_user_policy_write();
--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON user_moderation_status FOR EACH ROW EXECUTE FUNCTION guard_inference_user_policy_write();

--> statement-breakpoint
CREATE TRIGGER inference_policy_guard BEFORE INSERT OR UPDATE OR DELETE ON user_identities FOR EACH ROW EXECUTE FUNCTION guard_inference_user_policy_write();
