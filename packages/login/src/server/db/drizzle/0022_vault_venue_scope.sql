-- Sprint 4 Phase 1 Day 1: venue scoping for vault wallets.
--
-- Today's vault keys wallets by (agentId, chainFamily). Sol's BSC wallet
-- (chain) and Sol's Hyperliquid wallet (venue, signs EIP-712 on Arbitrum
-- but routes through HL's exchange) need to be distinct. We introduce a
-- nullable `venue` column on both `encrypted_chain_keys` and
-- `agent_wallets`. Legacy rows keep `venue = NULL` and continue to be
-- looked up by (agentId, chainFamily).
--
-- The previous primary keys / unique indexes on (agentId, chainFamily) are
-- replaced with unique indexes over (agentId, chainFamily, COALESCE(venue,
-- '')) so that:
--   1. Legacy NULL-venue rows are still constrained to one per chain family
--      (COALESCE collapses NULL into '', so the index treats them as equal).
--   2. New venue-scoped rows can coexist with the legacy row for the same
--      agent + chainFamily (e.g. one EVM legacy wallet AND one EVM
--      hyperliquid wallet for Sol).
--
-- The `purpose` column is a human-readable label for the wallet (e.g.
-- "perp", "spot", "ops"). Not enforced; useful for the dashboard and the
-- audit trail.
--
-- Apply step (dev Neon):
--   cd packages/db && DATABASE_URL=$NEON_DEV_URL bun run migrate:neon
--
-- Down: drop the new columns + indexes, restore the original PK / unique
-- index. Manual; not provided here because production has no rows yet.

ALTER TABLE "encrypted_chain_keys" ADD COLUMN IF NOT EXISTS "venue" text;
--> statement-breakpoint
ALTER TABLE "encrypted_chain_keys" ADD COLUMN IF NOT EXISTS "purpose" text;
--> statement-breakpoint

-- Drop the composite PK from 0010 / current schema. Drizzle named it
-- `encrypted_chain_keys_agent_id_chain_family_pk`; the IF EXISTS guards
-- against re-runs.
ALTER TABLE "encrypted_chain_keys"
    DROP CONSTRAINT IF EXISTS "encrypted_chain_keys_agent_id_chain_family_pk";
--> statement-breakpoint

-- Surrogate PK so multiple (agentId, chainFamily) rows can coexist (one
-- per venue). DEFAULT gen_random_uuid() backfills existing rows.
ALTER TABLE "encrypted_chain_keys"
    ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
--> statement-breakpoint

ALTER TABLE "encrypted_chain_keys"
    ADD CONSTRAINT "encrypted_chain_keys_pkey" PRIMARY KEY ("id");
--> statement-breakpoint

-- Uniqueness invariant: at most one row per (agentId, chainFamily, venue).
-- COALESCE(venue, '') so the legacy NULL-venue rows still get the
-- one-per-chainFamily guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS "encrypted_chain_keys_agent_chain_venue_idx"
    ON "encrypted_chain_keys" ("agent_id", "chain_family", (COALESCE("venue", '')));
--> statement-breakpoint

-- Partial unique index on the legacy NULL-venue subset. This is what the
-- vault.importKey() upsert targets via Drizzle's onConflictDoUpdate -- a
-- partial unique index can be named as a conflict target, an expression
-- index cannot.
CREATE UNIQUE INDEX IF NOT EXISTS "encrypted_chain_keys_agent_chain_legacy_idx"
    ON "encrypted_chain_keys" ("agent_id", "chain_family")
    WHERE "venue" IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "encrypted_chain_keys_agent_id_idx"
    ON "encrypted_chain_keys" ("agent_id");
--> statement-breakpoint

-- agent_wallets gets the same treatment. Its previous uniqueness lived in
-- a uniqueIndex (`agent_wallets_agent_chain_idx`) not a PK, so we just
-- swap the index.

ALTER TABLE "agent_wallets" ADD COLUMN IF NOT EXISTS "venue" text;
--> statement-breakpoint
ALTER TABLE "agent_wallets" ADD COLUMN IF NOT EXISTS "purpose" text;
--> statement-breakpoint

-- The 0001 migration created uniqueness as a CONSTRAINT named
-- `agent_wallets_agent_chain_idx`. Some environments (later schema
-- regenerations) created it as a plain UNIQUE INDEX of the same name.
-- Drop whichever shape is present; both DROP forms are idempotent.
ALTER TABLE "agent_wallets"
    DROP CONSTRAINT IF EXISTS "agent_wallets_agent_chain_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "agent_wallets_agent_chain_idx";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "agent_wallets_agent_chain_venue_idx"
    ON "agent_wallets" ("agent_id", "chain_family", (COALESCE("venue", '')));
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "agent_wallets_agent_chain_legacy_idx"
    ON "agent_wallets" ("agent_id", "chain_family")
    WHERE "venue" IS NULL;
--> statement-breakpoint

-- ALTER TYPE ... ADD VALUE cannot run inside a transaction in PG < 12.
-- We rely on the Drizzle migrator running each statement-breakpoint
-- chunk in its own transaction; the IF NOT EXISTS form is idempotent so
-- re-runs are safe.

ALTER TYPE "policy_type" ADD VALUE IF NOT EXISTS 'venue-allowlist';
--> statement-breakpoint
ALTER TYPE "policy_type" ADD VALUE IF NOT EXISTS 'leverage-cap';
