-- API keys no longer carry per-key permission scopes. A key is just a key with
-- full access for its organization; scope enforcement + the column are removed.
ALTER TABLE api_keys DROP COLUMN IF EXISTS permissions;
