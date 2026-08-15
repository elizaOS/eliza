-- Makes the canonical Todos plugin table available to container-free Shared
-- runtimes through the control-plane Postgres and its Hyperdrive connection.

CREATE SCHEMA IF NOT EXISTS "todos";

CREATE TABLE IF NOT EXISTS "todos"."todos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "room_id" uuid,
  "world_id" uuid,
  "content" text NOT NULL,
  "active_form" text NOT NULL,
  "status" text NOT NULL,
  "parent_todo_id" uuid,
  "parent_trajectory_step_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp
);

CREATE INDEX IF NOT EXISTS "idx_todos_entity_status"
  ON "todos"."todos" ("entity_id", "status");
CREATE INDEX IF NOT EXISTS "idx_todos_agent_entity"
  ON "todos"."todos" ("agent_id", "entity_id");
CREATE INDEX IF NOT EXISTS "idx_todos_room"
  ON "todos"."todos" ("room_id");
