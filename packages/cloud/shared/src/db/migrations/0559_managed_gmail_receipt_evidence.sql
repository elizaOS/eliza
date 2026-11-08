-- Managed Inbox: an outcome-unknown send can be settled as succeeded once Gmail shows
-- the sent message with the request's own Message-ID. Only outcome-unknown ->
-- succeeded is added; nothing moves back to prepared or dispatched, so a settled
-- request can never be dispatched again. Existing receipts are unchanged.
CREATE OR REPLACE FUNCTION guard_managed_gmail_operation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.organization_id,NEW.user_id,NEW.grant_id,NEW.request_id,NEW.kind,NEW.review_digest,NEW.created_at)
     IS DISTINCT FROM (OLD.organization_id,OLD.user_id,OLD.grant_id,OLD.request_id,OLD.kind,OLD.review_digest,OLD.created_at) THEN
    RAISE EXCEPTION 'Gmail operation identity and review are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.state='prepared' AND NEW.state='dispatched')
      OR (OLD.state='prepared' AND NEW.state='rejected' AND NEW.rejection_code='cancelled' AND NEW.dispatched_at IS NULL)
      OR (OLD.state='dispatched' AND NEW.state IN ('succeeded','rejected','outcome-unknown'))
      OR (OLD.state='outcome-unknown' AND NEW.state='succeeded')) THEN
    RAISE EXCEPTION 'Gmail operation cannot be redispatched or rewritten' USING ERRCODE='55000';
  END IF;
  IF OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
    RAISE EXCEPTION 'Gmail dispatch identity is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
