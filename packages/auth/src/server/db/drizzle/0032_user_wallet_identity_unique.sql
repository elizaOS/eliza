CREATE UNIQUE INDEX IF NOT EXISTS users_wallet_identity_unique_idx
  ON users (wallet_chain, wallet_address)
  WHERE wallet_address IS NOT NULL;
