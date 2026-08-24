-- Keeps account authority fenced until cancellation provider cleanup completes.

ALTER TABLE "account_deletion_requests" DROP CONSTRAINT "account_deletion_requests_status_check";
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_status_check"
  CHECK ("status" IN ('requested', 'reserved', 'recovery', 'canceling', 'scheduled',
    'processing', 'completed', 'canceled', 'action_required'));
