CREATE TABLE subscription_adjustment_scans (
  grant_id uuid PRIMARY KEY REFERENCES subscription_allowance_transactions(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
  failures integer NOT NULL DEFAULT 0 CHECK(failures>=0),
  next_due_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE TABLE subscription_adjustment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL REFERENCES subscription_adjustment_scans(grant_id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  generation integer NOT NULL CHECK(generation>0),
  lease_token uuid NOT NULL,
  expected_previous_id uuid REFERENCES subscription_adjustment_observations(id) ON DELETE RESTRICT,
  original_digest text NOT NULL CHECK(original_digest ~ '^[a-f0-9]{64}$'),
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  disposition text NOT NULL DEFAULT 'processing',
  observation_id uuid REFERENCES subscription_adjustment_observations(id) ON DELETE RESTRICT,
  reason text,
  completed_at timestamptz,
  UNIQUE(grant_id,generation),
  CHECK(expires_at>started_at AND isfinite(expires_at)),
  CHECK(((disposition='processing' AND observation_id IS NULL AND reason IS NULL AND completed_at IS NULL)
     OR (disposition='recorded' AND observation_id IS NOT NULL AND reason IS NULL AND completed_at>=started_at)
     OR (disposition IN ('failed','superseded') AND observation_id IS NULL AND reason IS NOT NULL AND completed_at>=started_at)) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX subscription_adjustment_one_processing ON subscription_adjustment_attempts(grant_id) WHERE disposition='processing';
--> statement-breakpoint
CREATE FUNCTION guard_subscription_adjustment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_row subscription_allowance_transactions%ROWTYPE;
DECLARE scan_row subscription_adjustment_scans%ROWTYPE;
DECLARE observed_row subscription_adjustment_observations%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'adjustment attempts cannot be deleted'; END IF;
  IF TG_OP='UPDATE' AND (OLD.disposition<>'processing' OR
    (to_jsonb(NEW)-ARRAY['disposition','observation_id','reason','completed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['disposition','observation_id','reason','completed_at'])) THEN
    RAISE EXCEPTION 'adjustment attempt identity or terminal receipt is immutable';
  END IF;
  SELECT * INTO grant_row FROM subscription_allowance_transactions WHERE id=NEW.grant_id;
  SELECT * INTO scan_row FROM subscription_adjustment_scans WHERE grant_id=NEW.grant_id;
  IF grant_row.organization_id IS DISTINCT FROM NEW.organization_id OR grant_row.kind IS DISTINCT FROM 'grant'
    OR scan_row.organization_id IS DISTINCT FROM NEW.organization_id OR scan_row.generation IS DISTINCT FROM NEW.generation
  THEN RAISE EXCEPTION 'adjustment attempt original ownership mismatch'; END IF;
  IF NEW.disposition='recorded' THEN
    SELECT * INTO observed_row FROM subscription_adjustment_observations WHERE id=NEW.observation_id;
    IF NOT FOUND OR observed_row.grant_id IS DISTINCT FROM NEW.grant_id OR observed_row.organization_id IS DISTINCT FROM NEW.organization_id
      OR observed_row.request_id IS DISTINCT FROM NEW.id OR observed_row.previous_id IS DISTINCT FROM NEW.expected_previous_id
      OR clock_timestamp()>=NEW.expires_at
    THEN RAISE EXCEPTION 'adjustment attempt observation mismatch or expired lease'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER subscription_adjustment_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON subscription_adjustment_attempts FOR EACH ROW EXECUTE FUNCTION guard_subscription_adjustment_attempt();
