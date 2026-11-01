-- An old repeatable-read snapshot can hide a concurrent first enrollment,
-- including an authority row that did not exist when the snapshot started.
-- An advisory lock or SELECT FOR UPDATE cannot refresh that missing row.
CREATE OR REPLACE FUNCTION require_inference_policy_fence(org uuid, force_fence boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF org IS NULL THEN RETURN; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('inference-policy:' || org::text, 0));
 -- Read the permit after the lock wait, with the current wall clock. A permit
 -- from another transaction, another organization, or one that expired while
 -- waiting cannot authorize this write.
 IF EXISTS (SELECT 1 FROM inference_policy_mutations WHERE organization_id = org AND applying_txid = txid_current() AND phase = 'applying' AND permit_expires_at > clock_timestamp()) THEN RETURN; END IF;
 -- Unfenced writes may inspect enrollment only with a fresh statement snapshot.
 -- Existing managed writers use READ COMMITTED. A snapshot-isolated caller
 -- must restart the whole transaction or acquire its own valid mutation permit.
 IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
  RAISE EXCEPTION 'INFERENCE_POLICY_FRESH_SNAPSHOT_REQUIRED' USING ERRCODE = '40001', HINT = 'Retry the transaction at READ COMMITTED or obtain a managed inference policy mutation permit.';
 END IF;
 IF NOT force_fence AND NOT EXISTS (SELECT 1 FROM inference_policy_authorities WHERE organization_id = org AND (enabled OR rate_enabled)) THEN RETURN; END IF;
 RAISE EXCEPTION 'INFERENCE_POLICY_FENCE_REQUIRED' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
-- The same user lock covers key associations and standing. Shared key locks
-- allow concurrent key issuance; an exclusive standing lock freezes the set
-- of organizations before the READ COMMITTED discovery statement starts.
CREATE FUNCTION lock_inference_policy_users(user_ids uuid[], shared_lock boolean DEFAULT false) RETURNS void LANGUAGE plpgsql AS $$
DECLARE user_id uuid;
BEGIN
 FOR user_id IN SELECT DISTINCT value FROM unnest(user_ids) AS value WHERE value IS NOT NULL ORDER BY value LOOP
  IF shared_lock THEN
   PERFORM pg_advisory_xact_lock_shared(hashtextextended('inference-user-policy:' || user_id::text, 0));
  ELSE
   PERFORM pg_advisory_xact_lock(hashtextextended('inference-user-policy:' || user_id::text, 0));
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION guard_inference_key_user_association() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_user uuid; new_user uuid;
BEGIN
 IF TG_OP = 'UPDATE' AND (OLD.user_id, OLD.organization_id) IS NOT DISTINCT FROM (NEW.user_id, NEW.organization_id) THEN RETURN NEW; END IF;
 IF TG_OP <> 'INSERT' THEN old_user := OLD.user_id; END IF;
 IF TG_OP <> 'DELETE' THEN new_user := NEW.user_id; END IF;
 PERFORM lock_inference_policy_users(ARRAY[old_user, new_user], true);
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- PostgreSQL runs same-event triggers in name order. Take user locks before
-- the existing organization fence for writes that alter an association.
CREATE TRIGGER inference_key_user_association_guard BEFORE INSERT OR UPDATE OR DELETE ON api_keys FOR EACH ROW EXECUTE FUNCTION guard_inference_key_user_association();
--> statement-breakpoint
-- User standing affects every organization that issued a key to this user.
-- A transaction-level snapshot can hide a newer association, so no set of
-- permits for the visible organizations proves that this discovery is complete.
CREATE OR REPLACE FUNCTION guard_inference_user_policy_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row jsonb; new_row jsonb; user_ids uuid[]; org uuid;
BEGIN
 IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
 IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'users' AND (old_row->'is_active',old_row->'organization_id',old_row->'steward_user_id',old_row->'role',old_row->'expires_at',old_row->'deleted_at',old_row->'auth_fenced_at',old_row->'account_lifecycle_state',old_row->'account_deletion_request_id') IS NOT DISTINCT FROM (new_row->'is_active',new_row->'organization_id',new_row->'steward_user_id',new_row->'role',new_row->'expires_at',new_row->'deleted_at',new_row->'auth_fenced_at',new_row->'account_lifecycle_state',new_row->'account_deletion_request_id') THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'user_identities' AND (old_row->'user_id',old_row->'steward_user_id',old_row->'expires_at',old_row->'is_anonymous') IS NOT DISTINCT FROM (new_row->'user_id',new_row->'steward_user_id',new_row->'expires_at',new_row->'is_anonymous') THEN RETURN NEW; END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'user_moderation_status' AND (old_row->'status',old_row->'total_violations',old_row->'user_id') IS NOT DISTINCT FROM (new_row->'status',new_row->'total_violations',new_row->'user_id') THEN RETURN NEW; END IF;
 IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
  RAISE EXCEPTION 'INFERENCE_POLICY_FRESH_SNAPSHOT_REQUIRED' USING ERRCODE = '40001', HINT = 'Retry user standing and identity changes in a READ COMMITTED transaction.';
 END IF;
 IF TG_TABLE_NAME = 'users' THEN user_ids := ARRAY[(old_row->>'id')::uuid,(new_row->>'id')::uuid];
 ELSE user_ids := ARRAY[(old_row->>'user_id')::uuid,(new_row->>'user_id')::uuid]; END IF;
 PERFORM lock_inference_policy_users(user_ids);
 IF TG_TABLE_NAME = 'users' THEN
  PERFORM require_inference_policy_fence((old_row->>'organization_id')::uuid);
  PERFORM require_inference_policy_fence((new_row->>'organization_id')::uuid);
 END IF;
 FOR org IN SELECT organization_id FROM users WHERE id = ANY(user_ids) AND organization_id IS NOT NULL UNION SELECT organization_id FROM api_keys WHERE user_id = ANY(user_ids) ORDER BY 1 LOOP
  PERFORM require_inference_policy_fence(org);
 END LOOP;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
