-- Makes queue, defer, lease, and settlement states structurally explicit.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname = 'agent_backup_admission_work_state_shape_check'
    AND conrelid = 'agent_backup_admission_work'::regclass) THEN
    ALTER TABLE "agent_backup_admission_work" ADD CONSTRAINT
      "agent_backup_admission_work_state_shape_check" CHECK ((
        ("state" = 'queued' AND "deferred_reason" IS NULL
          AND num_nonnulls("lease_owner", "lease_generation", "lease_expires_at",
            "settled_at", "settled_reason") = 0)
        OR ("state" = 'deferred'
          AND "deferred_reason" ~ '^[A-Z][A-Z0-9_]{0,95}$'
          AND num_nonnulls("lease_owner", "lease_generation", "lease_expires_at",
            "settled_at", "settled_reason") = 0)
        OR ("state" = 'leased' AND "deferred_reason" IS NULL
          AND "lease_owner" = btrim("lease_owner")
          AND octet_length("lease_owner") BETWEEN 1 AND 128
          AND "lease_owner" !~ '[[:cntrl:]]'
          AND "lease_generation" IS NOT NULL
          AND "lease_expires_at" > "not_before" AND "attempts" >= 1
          AND num_nonnulls("settled_at", "settled_reason") = 0)
        OR ("state" = 'settled' AND "deferred_reason" IS NULL
          AND num_nonnulls("lease_owner", "lease_generation", "lease_expires_at") = 0
          AND "settled_at" IS NOT NULL
          AND "settled_reason" ~ '^[A-Z][A-Z0-9_]{0,95}$')
      ) IS TRUE);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname = 'agent_backup_admission_work_retry_exhaustion_check'
    AND conrelid = 'agent_backup_admission_work'::regclass) THEN
    ALTER TABLE "agent_backup_admission_work" ADD CONSTRAINT
      "agent_backup_admission_work_retry_exhaustion_check" CHECK ((
        "settled_reason" IS DISTINCT FROM 'RETRY_EXHAUSTED'
        OR ("work_kind" = 'schedule_capture' AND "state" = 'settled'
          AND "attempts" = 12)
      ) IS TRUE);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname = 'agent_backup_admission_work_schedule_source_shape_check'
    AND conrelid = 'agent_backup_admission_work'::regclass) THEN
    ALTER TABLE "agent_backup_admission_work" ADD CONSTRAINT
      "agent_backup_admission_work_schedule_source_shape_check" CHECK ((
        ("work_kind" = 'schedule_capture'
          AND "source_activation_generation" IS NOT NULL
          AND "source_lifecycle_revision" >= 0
          AND "source_provider_handle" = btrim("source_provider_handle")
          AND octet_length("source_provider_handle") BETWEEN 1 AND 512
          AND "source_provider_handle" !~ '[[:cntrl:]]'
          AND "source_container_id" ~ '^[0-9a-f]{64}$'
          AND "source_provider_handle" <> "source_container_id"
          AND "source_image_digest" ~ '^sha256:[0-9a-f]{64}$'
          AND "source_rpo_ms" BETWEEN 60000 AND 900000
          AND "rpo_deadline_at" >= "source_due_at")
        OR ("work_kind" <> 'schedule_capture' AND num_nonnulls(
          "source_activation_generation", "source_lifecycle_revision",
          "source_provider_handle", "source_container_id", "source_image_digest",
          "source_rpo_ms", "rpo_deadline_at"
        ) = 0)
      ) IS TRUE);
  END IF;
END $$;
