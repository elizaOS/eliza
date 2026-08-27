-- Installs the node-occurrence source stamp without rewriting historical rows.

ALTER TABLE "docker_nodes" ADD COLUMN IF NOT EXISTS "backup_admission_xid"
  xid8 DEFAULT '0'::xid8 NOT NULL;
--> statement-breakpoint
ALTER TABLE "docker_nodes" ALTER COLUMN "backup_admission_xid"
  SET DEFAULT pg_current_xact_id();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "stamp_docker_node_backup_admission_xid"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR ROW(
    OLD."id",
    OLD."node_id",
    OLD."current_node_history_id",
    OLD."node_incarnation",
    OLD."fleet_kind",
    OLD."infrastructure_provider",
    OLD."provider_server_id",
    OLD."host_key_fingerprint"
  ) IS DISTINCT FROM ROW(
    NEW."id",
    NEW."node_id",
    NEW."current_node_history_id",
    NEW."node_incarnation",
    NEW."fleet_kind",
    NEW."infrastructure_provider",
    NEW."provider_server_id",
    NEW."host_key_fingerprint"
  ) THEN
    NEW."backup_admission_xid" := pg_current_xact_id();
  ELSE
    NEW."backup_admission_xid" := OLD."backup_admission_xid";
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname = 'docker_nodes_zz_backup_admission_xid_trigger'
      AND tgrelid = 'docker_nodes'::regclass) THEN
    CREATE TRIGGER "docker_nodes_zz_backup_admission_xid_trigger"
      BEFORE INSERT OR UPDATE ON "docker_nodes"
      FOR EACH ROW EXECUTE FUNCTION "stamp_docker_node_backup_admission_xid"();
  END IF;
END $$;
