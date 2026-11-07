-- Calendar-month grant terms and paid-plan exclusivity (for example a six-month
-- pilot code). Existing codes keep their day or lifetime terms. A code has at
-- most one term: duration_days, duration_months, or neither (lifetime).
ALTER TABLE subscription_grant_codes ADD COLUMN duration_months integer
  CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 24);
--> statement-breakpoint
ALTER TABLE subscription_grant_codes ADD CONSTRAINT subscription_grant_codes_single_term_check
  CHECK (duration_days IS NULL OR duration_months IS NULL);
--> statement-breakpoint
-- An exclusive code is refused while the organization has an open paid
-- subscription (or its subscription authority is unknown), so an existing
-- payer never holds a grant and an invoice for the same window.
ALTER TABLE subscription_grant_codes ADD COLUMN requires_no_paid_plan boolean NOT NULL DEFAULT false;
