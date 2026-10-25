-- Durable core-shape memory rows for container-free Shared runtimes, scoped
-- per tenant: mirrors the core `memories` row and pins every row to its
-- owning organization + user. Embeddings stay real[] (core row shape);
-- semantic reads cast through pgvector, already created in migration 0000.

CREATE TABLE IF NOT EXISTS "shared_agent_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "entity_id" uuid,
  "room_id" uuid,
  "world_id" uuid,
  "type" text NOT NULL,
  "content" jsonb NOT NULL,
  "embedding" real[],
  "embedding_model" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "shared_agent_memories"
    ADD CONSTRAINT "shared_agent_memories_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "shared_agent_memories"
    ADD CONSTRAINT "shared_agent_memories_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "idx_shared_agent_memories_tenant_room_recency"
  ON "shared_agent_memories" ("organization_id", "user_id", "agent_id", "room_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_shared_agent_memories_tenant_type"
  ON "shared_agent_memories" ("organization_id", "agent_id", "type");
