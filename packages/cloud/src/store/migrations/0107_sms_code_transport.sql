ALTER TABLE cloud_code_challenges
  DROP CONSTRAINT cloud_code_challenges_check,
  ADD CONSTRAINT cloud_code_challenges_email_digest_required CHECK (provider <> 'email' OR code_hash IS NOT NULL);
