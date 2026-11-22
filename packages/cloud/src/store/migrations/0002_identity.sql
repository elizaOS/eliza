CREATE TABLE IF NOT EXISTS cloud_sign_in_identities (
  provider text NOT NULL CHECK (provider IN ('google', 'email', 'sms')),
  provider_subject text NOT NULL,
  account_id text NOT NULL REFERENCES accounts (key),
  PRIMARY KEY (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS cloud_sign_in_identities_account ON cloud_sign_in_identities (account_id);

CREATE TABLE IF NOT EXISTS cloud_spent_refresh (
  digest text PRIMARY KEY,
  access_digest text NOT NULL UNIQUE,
  session_key text NOT NULL REFERENCES sessions (key),
  generation integer NOT NULL CHECK (generation > 0)
);
CREATE INDEX IF NOT EXISTS cloud_spent_refresh_session_idx ON cloud_spent_refresh (session_key);

CREATE TABLE referral_codes (
  code text PRIMARY KEY CHECK (code = upper(btrim(code)) AND code <> ''),
  user_id text NOT NULL UNIQUE REFERENCES accounts (key)
);

CREATE TABLE referral_uses (
  user_id text PRIMARY KEY REFERENCES accounts (key),
  code text NOT NULL,
  referrer_user_id text NOT NULL REFERENCES accounts (key),
  created_at bigint NOT NULL,
  CHECK (referrer_user_id <> user_id)
);
CREATE INDEX referral_uses_referrer ON referral_uses (referrer_user_id);
