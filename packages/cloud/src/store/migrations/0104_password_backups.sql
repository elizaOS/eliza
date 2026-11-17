CREATE TABLE cloud_password_backups (
  client_id text NOT NULL,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(key) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  snapshot bytea CHECK (octet_length(snapshot) BETWEEN 1 AND 2097152),
  PRIMARY KEY (client_id, organization_id, account_id)
);

CREATE TABLE cloud_password_backup_approvals (
  proof_digest text PRIMARY KEY CHECK (proof_digest ~ '^[0-9a-f]{64}$'),
  session_key text NOT NULL REFERENCES sessions(key) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(key) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('staging', 'production')),
  redirect_uri text NOT NULL,
  expires_at bigint NOT NULL
);

CREATE INDEX cloud_password_backup_approvals_expiry ON cloud_password_backup_approvals (expires_at);
