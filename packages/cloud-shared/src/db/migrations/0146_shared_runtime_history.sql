-- Durable conversation history for Tier-0 "shared" agents (run in-Worker, no
-- container). Previously stored only in the request cache, which is disabled on
-- the prod Worker (CACHE_ENABLED=false) so history never persisted. One row per
-- (agent_id, channel_id) holds the capped, ordered message list. Additive +
-- idempotent (IF NOT EXISTS) so it is safe to apply out of band.
CREATE TABLE IF NOT EXISTS "shared_runtime_history" (
	"agent_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"messages" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "shared_runtime_history_agent_id_channel_id_pk" PRIMARY KEY("agent_id","channel_id")
);
