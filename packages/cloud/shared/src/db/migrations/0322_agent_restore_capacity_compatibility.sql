-- Expand compatibility: legacy writers may retain their old target tuple, but
-- any row that opts into capacity ownership must satisfy the exact final form.
ALTER TABLE "agent_backup_restore_operations"
  DROP CONSTRAINT IF EXISTS "agent_backup_restore_operations_capacity_compat_check";
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  ADD CONSTRAINT "agent_backup_restore_operations_capacity_compat_check" CHECK ((
    ("capacity_state" IS NULL
      AND "expected_node_id" IS NULL
      AND "capacity_reserved_at" IS NULL
      AND "capacity_settled_at" IS NULL
      AND "capacity_settlement_receipt_digest" IS NULL)
    OR
    ("expected_node_history_id" IS NOT NULL
      AND "expected_node_record_id" IS NOT NULL
      AND "expected_node_incarnation" IS NOT NULL
      AND "expected_node_id" IS NOT NULL
      AND btrim("expected_node_id") = "expected_node_id"
      AND octet_length("expected_node_id") BETWEEN 1 AND 255
      AND "expected_image_digest" IS NOT NULL
      AND (("capacity_state" = 'reserved'
          AND "capacity_reserved_at" IS NOT NULL
          AND "capacity_settled_at" IS NULL
          AND "capacity_settlement_receipt_digest" IS NULL)
        OR ("capacity_state" IN ('handed_off', 'released')
          AND "capacity_reserved_at" IS NOT NULL
          AND "capacity_settled_at" >= "capacity_reserved_at"
          AND "capacity_settlement_receipt_digest" ~ '^[0-9a-f]{64}$'))
      AND ("phase" <> 'finalized' OR "capacity_state" = 'handed_off')
      AND ("phase" <> 'failed_terminal' OR "capacity_state" IS DISTINCT FROM 'reserved'))
  ) IS TRUE);
