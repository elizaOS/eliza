-- A vault authority is one immutable chain and its pointer advances one direct successor at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_vault_key_generations_one_root_uidx" ON "agent_vault_key_generations" ("organization_id", "agent_id") WHERE "supersedes_generation_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_vault_key_generations_one_successor_uidx" ON "agent_vault_key_generations" ("organization_id", "agent_id", "supersedes_generation_id") WHERE "supersedes_generation_id" IS NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    WITH RECURSIVE connected AS (
      SELECT generation."organization_id", generation."agent_id", generation."generation_id" FROM "agent_vault_key_generations" AS generation
      WHERE generation."supersedes_generation_id" IS NULL
      UNION
      SELECT successor."organization_id", successor."agent_id", successor."generation_id" FROM "agent_vault_key_generations" AS successor
      JOIN connected ON (connected."organization_id", connected."agent_id", connected."generation_id")
        = (successor."organization_id", successor."agent_id", successor."supersedes_generation_id"))
    SELECT 1 FROM "agent_vault_key_generations" AS generation
    WHERE NOT EXISTS (SELECT 1 FROM connected WHERE (connected."organization_id",
      connected."agent_id", connected."generation_id") = (generation."organization_id",
      generation."agent_id", generation."generation_id"))
    OR EXISTS (SELECT 1 FROM "agent_vault_key_generations" AS generation LEFT JOIN "agent_vault_key_authorities" AS authority
      ON (authority."organization_id", authority."agent_id") = (generation."organization_id", generation."agent_id") LEFT JOIN "agent_vault_key_generations" AS successor
      ON (successor."organization_id", successor."agent_id", successor."supersedes_generation_id") = (authority."organization_id", authority."agent_id", authority."current_generation_id") WHERE authority."organization_id" IS NULL OR successor."generation_id" IS NOT NULL)) THEN
    RAISE EXCEPTION 'existing vault-key generations are not one connected acyclic current-tipped chain'
      USING ERRCODE = '55000';
  END IF;
END; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_vault_key_generation_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_WHEN = 'AFTER' AND NOT EXISTS (SELECT 1 FROM "agent_vault_key_authorities" AS authority LEFT JOIN "agent_vault_key_generations" AS successor
    ON (successor."organization_id", successor."agent_id", successor."supersedes_generation_id") = (authority."organization_id", authority."agent_id", authority."current_generation_id")
    WHERE authority."organization_id" = NEW."organization_id" AND authority."agent_id" = NEW."agent_id" AND successor."generation_id" IS NULL) THEN
    RAISE EXCEPTION 'vault-key current authority must exist and finish at the chain tip' USING ERRCODE = '55000';
  END IF;
  IF TG_WHEN = 'AFTER' THEN RETURN NULL; END IF;
  PERFORM 1 FROM "agent_backup_catalog_authorities" WHERE "organization_id" = NEW."organization_id"
    AND "agent_id" = NEW."agent_id" FOR UPDATE;
  IF NEW."supersedes_generation_id" IS NULL THEN
    IF EXISTS (SELECT 1 FROM "agent_vault_key_generations"
      WHERE "organization_id" = NEW."organization_id" AND "agent_id" = NEW."agent_id") THEN
      RAISE EXCEPTION 'vault-key root must begin an empty committed chain' USING ERRCODE = '55000';
    END IF;
  ELSE
    PERFORM 1 FROM "agent_vault_key_authorities"
      WHERE "organization_id" = NEW."organization_id" AND "agent_id" = NEW."agent_id"
        AND "current_generation_id" = NEW."supersedes_generation_id" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'vault-key successor must extend the committed current generation'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_generation_insert_guard" ON "agent_vault_key_generations";
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_generation_insert_guard" BEFORE INSERT ON "agent_vault_key_generations"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_vault_key_generation_insert"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_generation_tip_guard" ON "agent_vault_key_generations";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_vault_key_generation_tip_guard" AFTER INSERT ON "agent_vault_key_generations" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "guard_agent_vault_key_generation_insert"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_vault_key_authority"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE db_now timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vault-key current authority cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" <> 1 OR NOT EXISTS (
      SELECT 1 FROM "agent_vault_key_generations" AS generation
      WHERE (generation."organization_id", generation."agent_id", generation."generation_id")
        = (NEW."organization_id", NEW."agent_id", NEW."current_generation_id")
        AND generation."supersedes_generation_id" IS NULL) THEN
      RAISE EXCEPTION 'vault-key authority must begin at its one root'
        USING ERRCODE = '55000';
    END IF;
    NEW."updated_at" := db_now;
    RETURN NEW;
  END IF;
  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."agent_id" IS DISTINCT FROM OLD."agent_id"
    OR NEW."revision" <> OLD."revision" + 1 OR NOT EXISTS (
      SELECT 1 FROM "agent_vault_key_generations" AS generation
      WHERE (generation."organization_id", generation."agent_id", generation."generation_id",
        generation."supersedes_generation_id") = (OLD."organization_id", OLD."agent_id",
        NEW."current_generation_id", OLD."current_generation_id")) THEN
    RAISE EXCEPTION 'vault-key authority must advance one direct successor and revision'
      USING ERRCODE = '55000';
  END IF;
  NEW."updated_at" := GREATEST(OLD."updated_at", db_now);
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_vault_key_authority_guard" ON "agent_vault_key_authorities";
--> statement-breakpoint
CREATE TRIGGER "agent_vault_key_authority_guard" BEFORE INSERT OR UPDATE OR DELETE ON "agent_vault_key_authorities"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_vault_key_authority"();
