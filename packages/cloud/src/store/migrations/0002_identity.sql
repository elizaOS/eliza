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
