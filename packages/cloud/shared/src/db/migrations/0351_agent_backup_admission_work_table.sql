-- Creates one explicit queue for schedule, catalogue, and exact-object work.

CREATE TABLE IF NOT EXISTS "agent_backup_admission_work" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "work_kind" text NOT NULL,
  "work_stage" text NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sandbox_id" uuid,
  "backup_id" uuid,
  "gc_object_id" uuid,
  "node_history_id" uuid REFERENCES "agent_node_incarnation_histories"("id")
    ON DELETE RESTRICT,
  "source_activation_generation" uuid,
  "source_lifecycle_revision" bigint,
  "source_provider_handle" text,
  "source_container_id" text,
  "source_image_digest" text,
  "source_rpo_ms" integer,
  "requires_node_lane" boolean NOT NULL,
  "priority_class" text NOT NULL,
  "base_priority" smallint NOT NULL,
  "source_due_at" timestamp with time zone NOT NULL,
  "rpo_deadline_at" timestamp with time zone,
  "first_eligible_at" timestamp with time zone
    GENERATED ALWAYS AS ("source_due_at") STORED NOT NULL,
  "state" text NOT NULL DEFAULT 'queued',
  "not_before" timestamp with time zone NOT NULL DEFAULT now(),
  "deferred_reason" text,
  "ready_cohort" bigint NOT NULL,
  "cohort_ordinal" integer NOT NULL,
  "shard_id" smallint NOT NULL,
  "lease_owner" text,
  "lease_generation" uuid,
  "lease_expires_at" timestamp with time zone,
  "attempts" integer NOT NULL DEFAULT 0,
  "settled_at" timestamp with time zone,
  "settled_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_admission_work_sandbox_tenant_fkey"
    FOREIGN KEY ("sandbox_id", "organization_id")
    REFERENCES "agent_sandboxes"("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "agent_backup_admission_work_backup_tenant_fkey"
    FOREIGN KEY ("backup_id", "organization_id")
    REFERENCES "agent_sandbox_backups"("id", "catalog_organization_id") ON DELETE CASCADE,
  CONSTRAINT "agent_backup_admission_work_gc_authority_fkey"
    FOREIGN KEY ("gc_object_id", "work_stage")
    REFERENCES "agent_backup_gc_outbox"("object_id", "action") ON DELETE CASCADE,
  CONSTRAINT "agent_backup_admission_work_gc_object_tenant_fkey"
    FOREIGN KEY ("gc_object_id", "organization_id")
    REFERENCES "agent_backup_objects"("id", "organization_id") ON DELETE RESTRICT
);
