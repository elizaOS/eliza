/** Constrains persisted subscription settlement value that exceeded its reservation. */
ALTER TABLE "billing_funding_reservations"
  ADD CONSTRAINT "billing_funding_reservations_uncollected_overage_check"
  CHECK (uncollected_overage_amount >= 0 AND (status = 'finalized' OR uncollected_overage_amount = 0));
