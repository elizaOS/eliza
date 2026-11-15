-- Validates 0555's lease check in its own transaction, which holds only SHARE
-- UPDATE EXCLUSIVE on the hot webhook table, so webhook inserts keep flowing.
ALTER TABLE "webhook_events" VALIDATE CONSTRAINT "webhook_events_delivery_lease_check";
