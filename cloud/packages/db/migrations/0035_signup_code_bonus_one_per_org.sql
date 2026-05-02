-- One signup code bonus credit per organization (prevents double-redemption race).
-- Partial unique index: only one credit_transactions row per org with type = 'credit'
-- and metadata.type = 'signup_code_bonus'.

CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_signup_code_bonus_org_idx
  ON credit_transactions (organization_id)
  WHERE type = 'credit' AND (metadata->>'type' = 'signup_code_bonus');
