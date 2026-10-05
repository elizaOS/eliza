-- Preserve completed zero-collected funding outcomes without permitting zero-value live holds.
ALTER TABLE "billing_funding_reservations"
  DROP CONSTRAINT "billing_funding_reservations_amount_check";
--> statement-breakpoint
ALTER TABLE "billing_funding_reservations"
  ADD CONSTRAINT "billing_funding_reservations_amount_check"
  CHECK (reserved_amount = requested_amount AND
    (requested_amount > 0 OR (requested_amount = 0 AND status = 'finalized')));
