-- Makes source identity and settled work immutable across raw SQL writers.

CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_work_insert"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" <> 'queued' OR NEW."attempts" <> 0 THEN
    RAISE EXCEPTION 'backup admission work must enter queued at attempt zero'
      USING ERRCODE = '55000';
  END IF;
  PERFORM 1
  FROM "organizations" AS account_org
  WHERE account_org."id" = NEW."organization_id"
    AND account_org."account_lifecycle_state" = 'active'
    AND account_org."is_active"
    AND account_org."account_deletion_request_id" IS NULL
  FOR SHARE OF account_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backup admission work requires active account authority'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE
    tgname = 'agent_backup_admission_work_05_insert_guard'
    AND tgrelid = 'agent_backup_admission_work'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_work_05_insert_guard"
      BEFORE INSERT ON "agent_backup_admission_work" FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_backup_admission_work_insert"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_work_identity"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    OLD."id", OLD."work_kind", OLD."work_stage", OLD."organization_id", OLD."sandbox_id",
    OLD."backup_id", OLD."gc_object_id", OLD."node_history_id",
    OLD."source_activation_generation", OLD."source_lifecycle_revision",
    OLD."source_provider_handle", OLD."source_container_id", OLD."source_image_digest",
    OLD."source_rpo_ms", OLD."requires_node_lane", OLD."priority_class",
    OLD."base_priority", OLD."source_due_at", OLD."rpo_deadline_at",
    OLD."shard_id", OLD."created_at"
  ) IS DISTINCT FROM ROW(
    NEW."id", NEW."work_kind", NEW."work_stage", NEW."organization_id", NEW."sandbox_id",
    NEW."backup_id", NEW."gc_object_id", NEW."node_history_id",
    NEW."source_activation_generation", NEW."source_lifecycle_revision",
    NEW."source_provider_handle", NEW."source_container_id", NEW."source_image_digest",
    NEW."source_rpo_ms", NEW."requires_node_lane", NEW."priority_class",
    NEW."base_priority", NEW."source_due_at", NEW."rpo_deadline_at",
    NEW."shard_id", NEW."created_at"
  ) THEN
    RAISE EXCEPTION 'backup admission work identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'settled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'settled backup admission work is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE
    tgname = 'agent_backup_admission_work_10_identity_guard'
    AND tgrelid = 'agent_backup_admission_work'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_work_10_identity_guard"
      BEFORE UPDATE ON "agent_backup_admission_work" FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_backup_admission_work_identity"();
  END IF;
END $$;
