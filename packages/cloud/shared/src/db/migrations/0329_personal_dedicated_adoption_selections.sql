-- Selects one existing owner-scoped Dedicated row without adopting or provisioning it.

CREATE TABLE "personal_dedicated_adoption_selections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "source_agent_id" text NOT NULL,
  "dedicated_agent_id" uuid NOT NULL,
  "selected_by_user_id" uuid,
  "selection_reason" text NOT NULL,
  "state_disposition" text NOT NULL,
  "activation_kind" text NOT NULL,
  "activation_backup_id" uuid,
  "activation_backup_hash" text,
  "activation_backup_chain" jsonb,
  "restore_fence_hash" text,
  "restore_fence_started_at" timestamp with time zone,
  "inventory_fingerprint" text NOT NULL,
  "candidate_count" integer NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "selected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "personal_dedicated_adoption_selections_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "personal_dedicated_adoption_selections_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "personal_dedicated_adoption_selections_selected_by_user_id_users_id_fk"
    FOREIGN KEY ("selected_by_user_id") REFERENCES "public"."users"("id")
    ON DELETE set null ON UPDATE no action,
  CONSTRAINT "personal_dedicated_adoption_selections_version_check"
    CHECK ("schema_version" = 1),
  CONSTRAINT "personal_dedicated_adoption_selections_reason_check"
    CHECK ("selection_reason" = 'duplicate_owned_dedicated_inventory'),
  CONSTRAINT "personal_dedicated_adoption_selections_state_disposition_check"
    CHECK ("state_disposition" IN ('verified_backup_present', 'fresh_boot_no_verified_backup')),
  CONSTRAINT "personal_dedicated_adoption_selections_activation_check"
    CHECK (("activation_kind" = 'fresh_boot' AND "activation_backup_id" IS NULL
        AND "activation_backup_hash" IS NULL AND "activation_backup_chain" IS NULL)
      OR ("activation_kind" = 'legacy_backup'
        AND "activation_backup_id" IS NOT NULL
        AND "activation_backup_hash" ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof("activation_backup_chain") = 'array'
        AND jsonb_array_length("activation_backup_chain") > 0)
      OR ("activation_kind" = 'catalog_restore_required'
        AND "activation_backup_id" IS NOT NULL
        AND "activation_backup_hash" ~ '^[a-f0-9]{64}$'
        AND "activation_backup_chain" IS NULL)),
  CONSTRAINT "personal_dedicated_adoption_selections_fingerprint_check"
    CHECK ("inventory_fingerprint" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "personal_dedicated_adoption_selections_restore_fence_check"
    CHECK (("restore_fence_hash" IS NULL AND "restore_fence_started_at" IS NULL)
      OR ("restore_fence_hash" ~ '^[a-f0-9]{64}$'
        AND "restore_fence_started_at" IS NOT NULL)),
  CONSTRAINT "personal_dedicated_adoption_selections_candidate_count_check"
    CHECK ("candidate_count" >= 2)
);

CREATE UNIQUE INDEX "personal_dedicated_adoption_selections_source_unique"
  ON "personal_dedicated_adoption_selections" USING btree
  ("organization_id", "user_id", "source_agent_id");
CREATE UNIQUE INDEX "personal_dedicated_adoption_selections_target_unique"
  ON "personal_dedicated_adoption_selections" USING btree ("dedicated_agent_id");

-- A reviewed restore fence is committed before provider or billing admission.
-- Every backup mutation locks the affected agent row, then checks this durable
-- receipt. Older mutations finish before authority validation; newer mutations
-- wait for the fence commit and then fail closed.
CREATE OR REPLACE FUNCTION "guard_personal_dedicated_restore_backup_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_agent_id uuid;
BEGIN
  FOR affected_agent_id IN
    SELECT DISTINCT candidate
    FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD."sandbox_record_id" ELSE NULL END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW."sandbox_record_id" ELSE NULL END
    ]::uuid[]) AS candidate
    WHERE candidate IS NOT NULL
    ORDER BY candidate
  LOOP
    PERFORM 1 FROM "agent_sandboxes" WHERE "id" = affected_agent_id FOR KEY SHARE;
    IF EXISTS (
      SELECT 1
      FROM "personal_dedicated_adoption_selections"
      WHERE "dedicated_agent_id" = affected_agent_id
        AND "restore_fence_hash" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'reviewed restore authority is fenced for agent %', affected_agent_id
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "agent_sandbox_backups_reviewed_restore_fence"
BEFORE INSERT OR UPDATE OR DELETE ON "agent_sandbox_backups"
FOR EACH ROW EXECUTE FUNCTION "guard_personal_dedicated_restore_backup_mutation"();

-- Adoption authority must remain as a fail-closed tombstone if its target is
-- later deleted. Migration 0319 originally cascaded this FK; remove it before
-- any authority rows can be created in a deployed environment.
ALTER TABLE "personal_dedicated_upgrade_authorities"
  DROP CONSTRAINT IF EXISTS "personal_dedicated_upgrade_authorities_dedicated_agent_id_agent_sandboxes_id_fk";
