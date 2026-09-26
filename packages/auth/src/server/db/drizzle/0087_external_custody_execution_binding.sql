-- Bind governed EVM execution and approval snapshots to external custody identity.
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "execution_backend" varchar(32),
  ADD COLUMN IF NOT EXISTS "execution_backend_identity_digest" varchar(64);

ALTER TABLE "execution_authorization_nonces"
  ADD COLUMN IF NOT EXISTS "backend_identity_digest" varchar(64);

ALTER TABLE "execution_authorization_nonces"
  ADD CONSTRAINT "execution_auth_external_identity_chk" CHECK (
    ("backend" = 'external-custody' AND "backend_identity_digest" ~ '^[0-9a-f]{64}$') OR
    ("backend" IN ('local-vault', 'credential-proxy') AND "backend_identity_digest" IS NULL)
  );

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_external_identity_chk" CHECK (
    (
      ("execution_backend" = 'external-custody' AND "execution_backend_identity_digest" ~ '^[0-9a-f]{64}$') OR
      ("execution_backend" = 'local-vault' AND "execution_backend_identity_digest" IS NULL) OR
      ("execution_backend" IS NULL AND "execution_backend_identity_digest" IS NULL)
    ) IS TRUE
  );
