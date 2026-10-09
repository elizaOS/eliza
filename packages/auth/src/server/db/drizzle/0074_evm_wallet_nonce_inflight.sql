CREATE TABLE IF NOT EXISTS "evm_wallet_nonce_inflight" (
  "wallet_address" varchar(42) NOT NULL,
  "chain_id" integer NOT NULL,
  "nonce" bigint NOT NULL,
  "state" varchar(16) DEFAULT 'allocated' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "evm_wallet_nonce_inflight_key_idx"
  ON "evm_wallet_nonce_inflight" ("wallet_address", "chain_id", "nonce");

CREATE INDEX IF NOT EXISTS "evm_wallet_nonce_inflight_reclaim_idx"
  ON "evm_wallet_nonce_inflight" ("wallet_address", "chain_id", "state", "nonce");
