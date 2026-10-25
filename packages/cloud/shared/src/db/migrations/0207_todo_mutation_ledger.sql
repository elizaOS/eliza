-- Persists exactly-once Todo mutation outcomes so retried Shared turns replay
-- the original receipt instead of applying the same user action again.

CREATE SCHEMA IF NOT EXISTS "todos";

CREATE TABLE IF NOT EXISTS "todos"."todo_mutations" (
  "mutation_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_digest" text NOT NULL,
  "operation" text NOT NULL,
  "applied" boolean NOT NULL,
  "result_json" jsonb NOT NULL,
  "committed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "todo_mutations_agent_entity_idempotency_key_unique"
    UNIQUE ("agent_id", "entity_id", "idempotency_key")
);

CREATE INDEX IF NOT EXISTS "idx_todo_mutations_scope_commit"
  ON "todos"."todo_mutations"
  ("agent_id", "entity_id", "committed_at", "mutation_id");
