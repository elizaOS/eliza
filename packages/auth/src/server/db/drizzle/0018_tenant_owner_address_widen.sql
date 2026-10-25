-- Widen tenants.owner_address to fit Solana tenant ids ("solana:<base58>" up to ~51 chars)
-- Was varchar(42) (designed for EIP-55 EVM addresses)
ALTER TABLE "tenants" ALTER COLUMN "owner_address" TYPE varchar(128);
