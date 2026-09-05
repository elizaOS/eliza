-- Steward Auth Migration — adds auth tables + agent extensions
-- Safe to run on existing DB (all IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)

-- New columns on agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_type VARCHAR(32) DEFAULT 'agent';

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE,
  email_verified BOOLEAN DEFAULT false,
  name VARCHAR(255),
  image TEXT,
  wallet_address VARCHAR(128),
  steward_wallet_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WebAuthn authenticators (passkeys)
CREATE TABLE IF NOT EXISTS authenticators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  credential_public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  credential_device_type VARCHAR(32),
  credential_backed_up BOOLEAN DEFAULT false,
  transports TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authenticators_user_id_idx ON authenticators(user_id);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

-- OAuth accounts
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL,
  provider_account_id VARCHAR(255) NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_unique ON accounts(provider, provider_account_id);
CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts(user_id);

-- User-tenant membership
CREATE TABLE IF NOT EXISTS user_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_tenants_unique ON user_tenants(user_id, tenant_id);
