-- Index for findOrCreateUserByWalletAddress lookups (avoids sequential scan at scale)
CREATE INDEX IF NOT EXISTS users_wallet_address_idx ON users (wallet_address);
