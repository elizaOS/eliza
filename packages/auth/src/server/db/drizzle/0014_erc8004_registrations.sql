-- Migration: ERC-8004 agent registration, reputation cache, and registry index tables.

CREATE TABLE IF NOT EXISTS agent_registrations (
  id              SERIAL PRIMARY KEY,
  tenant_id       VARCHAR(128) NOT NULL,
  agent_id        VARCHAR(128) NOT NULL,
  chain_id        INTEGER NOT NULL,
  token_id        VARCHAR(256),
  tx_hash         VARCHAR(128),
  registry_address VARCHAR(64) NOT NULL,
  agent_card_uri  TEXT,
  agent_card_json JSONB,
  status          VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, agent_id, chain_id)
);

CREATE TABLE IF NOT EXISTS reputation_cache (
  id              SERIAL PRIMARY KEY,
  agent_id        VARCHAR(128) NOT NULL,
  chain_id        INTEGER NOT NULL,
  token_id        VARCHAR(256) NOT NULL,
  score_onchain   NUMERIC(5,2) NOT NULL DEFAULT 0,
  score_internal  NUMERIC(5,2) NOT NULL DEFAULT 0,
  score_combined  NUMERIC(5,2) NOT NULL DEFAULT 0,
  feedback_count  INTEGER NOT NULL DEFAULT 0,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, chain_id)
);

CREATE TABLE IF NOT EXISTS registry_index (
  id              SERIAL PRIMARY KEY,
  chain_id        INTEGER NOT NULL,
  name            VARCHAR(64) NOT NULL,
  rpc_url         TEXT NOT NULL,
  registry_address VARCHAR(64) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id)
);
