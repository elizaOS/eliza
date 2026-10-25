-- Allows identity links proven by a trusted connector transport to retain
-- honest provenance instead of being mislabeled as an OAuth authorization.

ALTER TABLE "identity_links"
  DROP CONSTRAINT IF EXISTS "identity_links_source_check";

ALTER TABLE "identity_links"
  ADD CONSTRAINT "identity_links_source_check"
  CHECK ("source" IN ('oauth', 'manual', 'wallet', 'transport'));
