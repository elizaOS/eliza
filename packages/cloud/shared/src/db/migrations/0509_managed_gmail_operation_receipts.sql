-- Managed Inbox effects: database admission is not Gmail-side idempotency.
CREATE TABLE managed_gmail_operation_receipts (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('send','draft-create','draft-replace','draft-delete','archive','unarchive','trash','untrash')),
  review_digest text NOT NULL CHECK (review_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','dispatched','succeeded','rejected','outcome-unknown')),
  provider_result jsonb,
  rejection_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (organization_id,user_id,grant_id,request_id),
  CHECK ((state='prepared' AND dispatched_at IS NULL AND finished_at IS NULL)
      OR (state='dispatched' AND dispatched_at IS NOT NULL AND finished_at IS NULL)
      OR (state IN ('succeeded','rejected','outcome-unknown') AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL)),
  CHECK ((state='succeeded') = (provider_result IS NOT NULL)),
  CHECK (rejection_code IS NULL OR state='rejected')
);
CREATE FUNCTION guard_managed_gmail_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.organization_id,NEW.user_id,NEW.grant_id,NEW.request_id,NEW.kind,NEW.review_digest,NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id,OLD.user_id,OLD.grant_id,OLD.request_id,OLD.kind,OLD.review_digest,OLD.created_at) THEN
    RAISE EXCEPTION 'Gmail operation identity and review are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.state='prepared' AND NEW.state='dispatched')
      OR (OLD.state='dispatched' AND NEW.state IN ('succeeded','rejected','outcome-unknown'))) THEN
    RAISE EXCEPTION 'Gmail operation cannot be redispatched or rewritten' USING ERRCODE='55000';
  END IF;
  IF OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
    RAISE EXCEPTION 'Gmail dispatch identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER managed_gmail_operation_receipt_guard BEFORE UPDATE ON managed_gmail_operation_receipts
 FOR EACH ROW EXECUTE FUNCTION guard_managed_gmail_operation_receipt();
