-- Contract phase: a replacement locator and its capacity proof are one inseparable ledger.
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_capacity_shape_check";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_capacity_compat_check";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_capacity_shape_check" CHECK ((CASE
    WHEN "locator_recorded_at" IS NULL THEN
      "capacity_state" IS NULL
      AND "capacity_reserved_at" IS NULL
      AND "capacity_settled_at" IS NULL
      AND "capacity_settlement_receipt_digest" IS NULL
    ELSE
      "capacity_reserved_at" = "locator_recorded_at"
      AND (("state" IN ('in_flight_unresolved', 'provider_succeeded')
        AND "capacity_state" = 'reserved'
        AND "capacity_reserved_at" IS NOT NULL
        AND "capacity_settled_at" IS NULL
        AND "capacity_settlement_receipt_digest" IS NULL)
        OR ("state" = 'lifecycle_committed'
          AND "capacity_state" = 'handed_off'
          AND "capacity_reserved_at" IS NOT NULL
          AND "capacity_settled_at" >= "capacity_reserved_at"
          AND "capacity_settled_at" = "lifecycle_committed_at"
          AND "capacity_settlement_receipt_digest" = "lifecycle_receipt_digest"
          AND "capacity_settlement_receipt_digest" ~ '^[0-9a-f]{64}$')
        OR ("state" = 'cleanup_proven'
          AND "capacity_state" = 'released'
          AND "capacity_reserved_at" IS NOT NULL
          AND "capacity_settled_at" >= "capacity_reserved_at"
          AND "capacity_settled_at" = "cleanup_proven_at"
          AND "capacity_settlement_receipt_digest" = "cleanup_receipt_digest"
          AND "capacity_settlement_receipt_digest" ~ '^[0-9a-f]{64}$'))
  END) IS TRUE);
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_previous_cleanup_compat_check";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_previous_cleanup_shape_check";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_previous_cleanup_shape_check" CHECK ((CASE
    WHEN "previous_placement_absent" = TRUE THEN
      "previous_cleanup_state" IS NULL
      AND "previous_cleanup_proven_at" IS NULL
      AND "previous_cleanup_receipt_digest" IS NULL
    WHEN "state" <> 'lifecycle_committed' THEN
      "previous_cleanup_state" IS NULL
      AND "previous_cleanup_proven_at" IS NULL
      AND "previous_cleanup_receipt_digest" IS NULL
    ELSE
      ("previous_cleanup_state" = 'pending'
        AND "previous_cleanup_proven_at" IS NULL
        AND "previous_cleanup_receipt_digest" IS NULL)
      OR ("previous_cleanup_state" = 'released'
        AND "previous_cleanup_proven_at" >= "lifecycle_committed_at"
        AND "previous_cleanup_receipt_digest" ~ '^[0-9a-f]{64}$')
  END) IS TRUE);
