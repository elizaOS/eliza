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
  CONSTRAINT "personal_dedicated_adoption_selections_candidate_count_check"
    CHECK ("candidate_count" >= 2)
);

CREATE UNIQUE INDEX "personal_dedicated_adoption_selections_source_unique"
  ON "personal_dedicated_adoption_selections" USING btree
  ("organization_id", "user_id", "source_agent_id");
CREATE UNIQUE INDEX "personal_dedicated_adoption_selections_target_unique"
  ON "personal_dedicated_adoption_selections" USING btree ("dedicated_agent_id");

-- Adoption authority must remain as a fail-closed tombstone if its target is
-- later deleted. Migration 0319 originally cascaded this FK; remove it before
-- any authority rows can be created in a deployed environment.
ALTER TABLE "personal_dedicated_upgrade_authorities"
  DROP CONSTRAINT IF EXISTS "personal_dedicated_upgrade_authorities_dedicated_agent_id_agent_sandboxes_id_fk";
