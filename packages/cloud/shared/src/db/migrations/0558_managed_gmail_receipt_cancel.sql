-- Managed Inbox: the owner can discard a reviewed request that was never dispatched.
-- A cancelled request is state 'rejected' with rejection_code 'cancelled' and no
-- dispatched_at. Only 'prepared' can be cancelled, and a cancelled request can
-- never be dispatched afterwards. Existing receipts are unchanged.
ALTER TABLE managed_gmail_operation_receipts
  DROP CONSTRAINT managed_gmail_operation_receipts_check,
  ADD CONSTRAINT managed_gmail_operation_receipts_check CHECK (
    (state='prepared' AND dispatched_at IS NULL AND finished_at IS NULL)
    OR (state='dispatched' AND dispatched_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('succeeded','rejected','outcome-unknown') AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL)
    OR (state='rejected' AND rejection_code='cancelled' AND dispatched_at IS NULL AND finished_at IS NOT NULL)
  );
CREATE OR REPLACE FUNCTION guard_managed_gmail_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.organization_id,NEW.user_id,NEW.grant_id,NEW.request_id,NEW.kind,NEW.review_digest,NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id,OLD.user_id,OLD.grant_id,OLD.request_id,OLD.kind,OLD.review_digest,OLD.created_at) THEN
    RAISE EXCEPTION 'Gmail operation identity and review are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.state='prepared' AND NEW.state='dispatched')
      OR (OLD.state='prepared' AND NEW.state='rejected' AND NEW.rejection_code='cancelled' AND NEW.dispatched_at IS NULL)
      OR (OLD.state='dispatched' AND NEW.state IN ('succeeded','rejected','outcome-unknown'))) THEN
    RAISE EXCEPTION 'Gmail operation cannot be redispatched or rewritten' USING ERRCODE='55000';
  END IF;
  IF OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
    RAISE EXCEPTION 'Gmail dispatch identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
