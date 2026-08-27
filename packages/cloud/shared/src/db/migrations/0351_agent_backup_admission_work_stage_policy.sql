-- Couples every work stage to its lane and canonical business priority.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname = 'agent_backup_admission_work_stage_policy_check'
    AND conrelid = 'agent_backup_admission_work'::regclass) THEN
    ALTER TABLE "agent_backup_admission_work" ADD CONSTRAINT
      "agent_backup_admission_work_stage_policy_check" CHECK ((
        ("work_kind" = 'schedule_capture' AND "work_stage" = 'reserve_capture'
          AND "requires_node_lane" AND "base_priority" BETWEEN 0 AND 3)
        OR ("work_kind" = 'catalog_operation'
          AND "work_stage" IN ('capture', 'primary_publication')
          AND "requires_node_lane" = ("work_stage" = 'capture')
          AND "base_priority" BETWEEN 0 AND 3)
        OR ("work_kind" = 'catalog_operation'
          AND "work_stage" = 'secondary_replication'
          AND NOT "requires_node_lane" AND "base_priority" = 4)
        OR ("work_kind" = 'catalog_operation'
          AND "work_stage" IN (
            'primary_verification', 'deletion_prepare', 'deletion_finalize'
          ) AND NOT "requires_node_lane" AND "base_priority" = 5)
        OR ("work_kind" = 'gc_object' AND "work_stage" = 'delete_object'
          AND NOT "requires_node_lane" AND "base_priority" = 6)
      ) IS TRUE);
  END IF;
END $$;
