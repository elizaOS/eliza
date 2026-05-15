-- Migration: Add first-class token↔agent linkage columns to user_characters
-- Purpose: Thin clients should not need to dig through JSONB to discover
--          which token an agent is linked to. These columns make the link
--          queryable, indexable, and canonical.

-- Add token linkage columns to user_characters
ALTER TABLE "user_characters"
  ADD COLUMN "token_address" text,
  ADD COLUMN "token_chain"   text,
  ADD COLUMN "token_name"    text,
  ADD COLUMN "token_ticker"  text;

-- Composite unique index: at most one agent per (token_address, token_chain) pair
-- Uses a partial index so NULLs are ignored (agents without tokens).
CREATE UNIQUE INDEX "user_characters_token_address_chain_uniq"
  ON "user_characters" ("token_address", "token_chain")
  WHERE "token_address" IS NOT NULL;

-- Fast lookup by token_address alone (covers cross-chain queries)
CREATE INDEX "user_characters_token_address_idx"
  ON "user_characters" ("token_address")
  WHERE "token_address" IS NOT NULL;

-- Backfill from eliza_sandboxes.agent_config JSONB where data already exists.
-- This extracts tokenContractAddress / chain stored during service-to-service provisioning.
-- If legacy rows contain duplicate token linkages, keep the earliest sandbox mapping
-- and leave later duplicates unbackfilled so the unique index remains valid.
-- Guard: only run if eliza_sandboxes table exists (not present in all environments).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'eliza_sandboxes') THEN
    EXECUTE $backfill$
      WITH candidate_links AS (
        SELECT
          uc.id AS character_id,
          CASE
            WHEN (ms.agent_config->>'tokenContractAddress') ~ '^0x[0-9A-Fa-f]{40}$'
              THEN lower(ms.agent_config->>'tokenContractAddress')
            ELSE ms.agent_config->>'tokenContractAddress'
          END AS normalized_token_address,
          ms.agent_config->>'chain' AS token_chain,
          ms.agent_config->>'tokenName' AS token_name,
          ms.agent_config->>'tokenTicker' AS token_ticker,
          row_number() OVER (
            PARTITION BY
              CASE
                WHEN (ms.agent_config->>'tokenContractAddress') ~ '^0x[0-9A-Fa-f]{40}$'
                  THEN lower(ms.agent_config->>'tokenContractAddress')
                ELSE ms.agent_config->>'tokenContractAddress'
              END,
              COALESCE(ms.agent_config->>'chain', '')
            ORDER BY ms.created_at ASC, ms.id ASC
          ) AS token_rank
        FROM "eliza_sandboxes" ms
        JOIN "user_characters" uc ON uc.id = ms.character_id
        WHERE ms.agent_config->>'tokenContractAddress' IS NOT NULL
          AND ms.agent_config->>'tokenContractAddress' <> ''
          AND uc.token_address IS NULL
      )
      UPDATE "user_characters" uc
      SET
        token_address = candidate_links.normalized_token_address,
        token_chain   = NULLIF(candidate_links.token_chain, ''),
        token_name    = candidate_links.token_name,
        token_ticker  = candidate_links.token_ticker
      FROM candidate_links
      WHERE candidate_links.character_id = uc.id
        AND candidate_links.token_rank = 1
    $backfill$;
  END IF;
END $$;

