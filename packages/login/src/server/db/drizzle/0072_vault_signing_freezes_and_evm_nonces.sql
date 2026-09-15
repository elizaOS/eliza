CREATE TABLE IF NOT EXISTS "vault_signing_freezes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "scope_type" varchar(16) NOT NULL,
  "agent_id" varchar(64) REFERENCES "agents"("id") ON DELETE cascade,
  "wallet_id" uuid REFERENCES "agent_wallets"("id") ON DELETE cascade,
  "reason" text,
  "created_by_type" varchar(32) NOT NULL DEFAULT 'system',
  "created_by_id" varchar(128),
  "lifted_at" timestamp with time zone,
  "lifted_by_type" varchar(32),
  "lifted_by_id" varchar(128),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vault_signing_freezes_scope_chk"
    CHECK (
      ("scope_type" = 'tenant' AND "agent_id" IS NULL AND "wallet_id" IS NULL)
      OR ("scope_type" = 'agent' AND "agent_id" IS NOT NULL AND "wallet_id" IS NULL)
      OR ("scope_type" = 'wallet' AND "wallet_id" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "vault_signing_freezes_tenant_active_idx"
  ON "vault_signing_freezes" ("tenant_id", "scope_type")
  WHERE "scope_type" = 'tenant' AND "lifted_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "vault_signing_freezes_agent_active_idx"
  ON "vault_signing_freezes" ("tenant_id", "agent_id")
  WHERE "scope_type" = 'agent' AND "lifted_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "vault_signing_freezes_wallet_active_idx"
  ON "vault_signing_freezes" ("wallet_id")
  WHERE "scope_type" = 'wallet' AND "lifted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "vault_signing_freezes_tenant_scope_idx"
  ON "vault_signing_freezes" ("tenant_id", "scope_type");
CREATE INDEX IF NOT EXISTS "vault_signing_freezes_agent_idx"
  ON "vault_signing_freezes" ("agent_id");
CREATE INDEX IF NOT EXISTS "vault_signing_freezes_wallet_idx"
  ON "vault_signing_freezes" ("wallet_id");

CREATE TABLE IF NOT EXISTS "evm_wallet_nonces" (
  "wallet_address" varchar(42) NOT NULL,
  "chain_id" integer NOT NULL,
  "next_nonce" bigint NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "evm_wallet_nonces_wallet_chain_idx"
  ON "evm_wallet_nonces" ("wallet_address", "chain_id");
