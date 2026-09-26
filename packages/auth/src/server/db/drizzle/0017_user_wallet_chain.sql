ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wallet_chain" varchar(16) DEFAULT 'ethereum';
