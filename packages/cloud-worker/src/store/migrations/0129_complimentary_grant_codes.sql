ALTER TABLE grant_codes
  ADD COLUMN sponsored_inference boolean NOT NULL DEFAULT false,
  ADD COLUMN recipient_digest text,
  ADD CONSTRAINT grant_codes_sponsored_plan CHECK (NOT sponsored_inference OR plan_key = 'pro_monthly'),
  ADD CONSTRAINT grant_codes_recipient_requires_sponsorship CHECK (
    recipient_digest IS NULL OR (sponsored_inference AND recipient_digest ~ '^[0-9a-f]{64}$')
  );

CREATE INDEX grant_codes_recipient ON grant_codes (recipient_digest, key)
  WHERE recipient_digest IS NOT NULL;
