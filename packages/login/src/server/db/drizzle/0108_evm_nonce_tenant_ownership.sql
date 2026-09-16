CREATE TABLE "evm_wallet_nonce_owners" (
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "wallet_address" varchar(42) NOT NULL,
  "chain_id" integer NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "evm_wallet_nonce_owners_pkey" PRIMARY KEY ("wallet_address", "chain_id"),
  CONSTRAINT "evm_wallet_nonce_owners_address_chk"
    CHECK ("wallet_address" ~ '^0x[0-9a-f]{40}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "evm_wallet_nonce_owners_tenant_key_idx"
  ON "evm_wallet_nonce_owners" ("tenant_id", "wallet_address", "chain_id");
--> statement-breakpoint
ALTER TABLE "evm_wallet_nonces" ADD COLUMN "tenant_id" varchar(64);
--> statement-breakpoint
ALTER TABLE "evm_wallet_nonce_inflight" ADD COLUMN "tenant_id" varchar(64);
--> statement-breakpoint
UPDATE "evm_wallet_nonces" SET "wallet_address" = lower("wallet_address");
--> statement-breakpoint
UPDATE "evm_wallet_nonce_inflight" SET "wallet_address" = lower("wallet_address");
--> statement-breakpoint
CREATE TEMP TABLE "steward_nonce_owner_resolution" AS
WITH namespaces AS (
  SELECT "wallet_address", "chain_id" FROM "evm_wallet_nonces"
  UNION
  SELECT "wallet_address", "chain_id" FROM "evm_wallet_nonce_inflight"
), candidate_tenants AS (
  SELECT n."wallet_address", n."chain_id", a."tenant_id"
  FROM namespaces n
  JOIN "agents" a ON lower(a."wallet_address") = n."wallet_address"
  WHERE lower(a."wallet_address") ~ '^0x[0-9a-f]{40}$'
  UNION
  SELECT n."wallet_address", n."chain_id", a."tenant_id"
  FROM namespaces n
  JOIN "agent_wallets" w
    ON w."chain_family" = 'evm' AND lower(w."address") = n."wallet_address"
  JOIN "agents" a ON a."id" = w."agent_id"
)
SELECT
  n."wallet_address",
  n."chain_id",
  min(c."tenant_id") AS "tenant_id",
  count(DISTINCT c."tenant_id") AS "tenant_count"
FROM namespaces n
LEFT JOIN candidate_tenants c
  ON c."wallet_address" = n."wallet_address" AND c."chain_id" = n."chain_id"
GROUP BY n."wallet_address", n."chain_id";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "steward_nonce_owner_resolution" WHERE "tenant_count" <> 1
  ) THEN
    RAISE EXCEPTION
      'EVM nonce tenant backfill requires exactly one tenant owner per wallet/chain namespace';
  END IF;
END
$$;
--> statement-breakpoint
UPDATE "evm_wallet_nonces" n
SET "tenant_id" = r."tenant_id"
FROM "steward_nonce_owner_resolution" r
WHERE r."wallet_address" = n."wallet_address" AND r."chain_id" = n."chain_id";
--> statement-breakpoint
UPDATE "evm_wallet_nonce_inflight" n
SET "tenant_id" = r."tenant_id"
FROM "steward_nonce_owner_resolution" r
WHERE r."wallet_address" = n."wallet_address" AND r."chain_id" = n."chain_id";
--> statement-breakpoint
INSERT INTO "evm_wallet_nonce_owners" ("tenant_id", "wallet_address", "chain_id")
SELECT "tenant_id", "wallet_address", "chain_id"
FROM "steward_nonce_owner_resolution";
--> statement-breakpoint
ALTER TABLE "evm_wallet_nonces" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "evm_wallet_nonce_inflight" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX "evm_wallet_nonces_wallet_chain_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "evm_wallet_nonces_wallet_chain_idx"
  ON "evm_wallet_nonces" ("tenant_id", "wallet_address", "chain_id");
--> statement-breakpoint
DROP INDEX "evm_wallet_nonce_inflight_key_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "evm_wallet_nonce_inflight_key_idx"
  ON "evm_wallet_nonce_inflight" ("tenant_id", "wallet_address", "chain_id", "nonce");
--> statement-breakpoint
DROP INDEX "evm_wallet_nonce_inflight_reclaim_idx";
--> statement-breakpoint
CREATE INDEX "evm_wallet_nonce_inflight_reclaim_idx"
  ON "evm_wallet_nonce_inflight"
  ("tenant_id", "wallet_address", "chain_id", "state", "nonce");
--> statement-breakpoint
ALTER TABLE "evm_wallet_nonces"
  ADD CONSTRAINT "evm_wallet_nonces_owner_fk"
  FOREIGN KEY ("tenant_id", "wallet_address", "chain_id")
  REFERENCES "evm_wallet_nonce_owners" ("tenant_id", "wallet_address", "chain_id")
  ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "evm_wallet_nonce_inflight"
  ADD CONSTRAINT "evm_wallet_nonce_inflight_owner_fk"
  FOREIGN KEY ("tenant_id", "wallet_address", "chain_id")
  REFERENCES "evm_wallet_nonce_owners" ("tenant_id", "wallet_address", "chain_id")
  ON DELETE cascade;
--> statement-breakpoint
DROP TABLE "steward_nonce_owner_resolution";
