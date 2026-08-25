-- Mobile credentials retain the app registration that minted them even after
-- that app is deleted. The UUID deliberately has no FK: deletion must revoke
-- the credential without erasing its security/audit attribution.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS source_app_id UUID;
--> statement-breakpoint

UPDATE api_keys AS credential
SET source_app_id = auth_grant.app_id
FROM mobile_app_auth_grants AS auth_grant
WHERE auth_grant.credential_id = credential.id
  AND credential.source_app_id IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS api_keys_source_app_id_idx
  ON api_keys(source_app_id)
  WHERE source_app_id IS NOT NULL;
