CREATE TABLE IF NOT EXISTS subscription_notice_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, subscription_id uuid NOT NULL,
 source_revision bigint NOT NULL, kind text NOT NULL DEFAULT 'cancel_effective', state text NOT NULL DEFAULT 'policy_unavailable',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), last_inspected_at timestamptz,
 CONSTRAINT subscription_notice_intents_source_fk FOREIGN KEY(subscription_id,organization_id,source_revision)
 REFERENCES billing_subscription_revisions(subscription_id,organization_id,revision) ON DELETE CASCADE,
 CONSTRAINT subscription_notice_intents_shape_check CHECK(source_revision>0 AND kind='cancel_effective' AND state IN ('policy_unavailable','scheduled','dispatching','accepted','rejected','uncertain','unavailable','superseded','reconciliation_required'))
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_notice_intents_revision_kind_idx ON subscription_notice_intents(subscription_id,source_revision,kind);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_notice_intents_id_org_idx ON subscription_notice_intents(id,organization_id);
CREATE TABLE IF NOT EXISTS subscription_notice_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), notice_id uuid NOT NULL, organization_id uuid NOT NULL, policy_digest text NOT NULL,
 status text NOT NULL DEFAULT 'dispatching', provider text, message_id text, reason text, started_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL, completed_at timestamptz,
 CONSTRAINT subscription_notice_attempts_notice_fk FOREIGN KEY(notice_id,organization_id) REFERENCES subscription_notice_intents(id,organization_id) ON DELETE CASCADE,
 CONSTRAINT subscription_notice_attempts_shape_check CHECK(policy_digest ~ '^[0-9a-f]{64}$' AND expires_at>started_at AND status IN ('dispatching','accepted','rejected','uncertain','unavailable','superseded') AND ((status='dispatching' AND completed_at IS NULL) OR (status<>'dispatching' AND completed_at IS NOT NULL)) AND (status<>'accepted' OR (provider IS NOT NULL AND provider IN ('smtp','sendgrid') AND message_id IS NOT NULL)))
);
CREATE UNIQUE INDEX IF NOT EXISTS subscription_notice_attempts_notice_idx ON subscription_notice_attempts(notice_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_subscription_notice_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='subscription_notice_intents' THEN
  IF (NEW.id,NEW.organization_id,NEW.subscription_id,NEW.source_revision,NEW.kind,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.subscription_id,OLD.source_revision,OLD.kind,OLD.created_at) THEN RAISE EXCEPTION 'Notice source identity is immutable'; END IF;
  IF OLD.state NOT IN ('policy_unavailable','scheduled','dispatching') AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Notice outcome is immutable'; END IF;
 ELSE
  IF (NEW.id,NEW.notice_id,NEW.organization_id,NEW.policy_digest,NEW.started_at,NEW.expires_at) IS DISTINCT FROM (OLD.id,OLD.notice_id,OLD.organization_id,OLD.policy_digest,OLD.started_at,OLD.expires_at) THEN RAISE EXCEPTION 'Notice attempt identity is immutable'; END IF;
  IF OLD.status<>'dispatching' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Notice attempt outcome is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS subscription_notice_identity_guard ON subscription_notice_intents;
CREATE TRIGGER subscription_notice_identity_guard BEFORE UPDATE ON subscription_notice_intents FOR EACH ROW EXECUTE FUNCTION guard_subscription_notice_identity();
DROP TRIGGER IF EXISTS subscription_notice_attempt_guard ON subscription_notice_attempts;
CREATE TRIGGER subscription_notice_attempt_guard BEFORE UPDATE ON subscription_notice_attempts FOR EACH ROW EXECUTE FUNCTION guard_subscription_notice_identity();
