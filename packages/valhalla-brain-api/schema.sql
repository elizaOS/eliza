CREATE TABLE IF NOT EXISTS api_keys (
  key_hash TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_id TEXT
);

CREATE TABLE IF NOT EXISTS usage_daily (
  key_hash TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL,
  PRIMARY KEY (key_hash, day)
);

CREATE TABLE IF NOT EXISTS portal_users (
  id TEXT PRIMARY KEY,
  email TEXT,
  plan TEXT NOT NULL,
  license_tail TEXT,
  telegram TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_wallets (
  pubkey TEXT PRIMARY KEY,
  user_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf TEXT NOT NULL,
  exp TEXT NOT NULL
);
