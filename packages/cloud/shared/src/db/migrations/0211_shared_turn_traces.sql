-- Sampled per-turn observability for Tier-0 shared agent turns (#20615 P5):
-- compact stage/tool/latency/finish-reason traces written off-path by the
-- flag-gated recorder. Never stores prompt or response text. Deliberately
-- decoupled (no FKs) from tenant tables, like shared_runtime_history.

CREATE TABLE IF NOT EXISTS "shared_turn_traces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "agent_id" text NOT NULL,
  "channel_id" text,
  "trace_id" text NOT NULL,
  "started_at" timestamp NOT NULL,
  "latency_ms" integer NOT NULL,
  "model" text NOT NULL,
  "usage" jsonb,
  "stages" jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "shared_turn_traces_org_agent_created_idx"
  ON "shared_turn_traces" ("organization_id", "agent_id", "created_at");
