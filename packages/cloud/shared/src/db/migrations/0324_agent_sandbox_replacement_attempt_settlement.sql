-- Fence concurrent provider effects, retain committed generations, and index
-- the complete owner history used by the organization cascade.

ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_settlement_shape_check" CHECK ((
    ("state" = 'in_flight_unresolved'
      AND num_nonnulls(
        "provider_succeeded_at", "provider_receipt_digest", "lifecycle_committed_at",
        "lifecycle_receipt_digest", "cleanup_proven_at", "cleanup_receipt_digest"
      ) = 0)
    OR ("state" = 'provider_succeeded'
      AND "locator_recorded_at" IS NOT NULL
      AND "locator_container_id" IS NOT NULL
      AND "provider_succeeded_at" IS NOT NULL
      AND "provider_succeeded_at" >= "locator_container_recorded_at"
      AND ("locator_vpn_node_name" IS NULL OR "locator_vpn_node_id" IS NOT NULL)
      AND ("locator_vpn_recorded_at" IS NULL
        OR "provider_succeeded_at" >= "locator_vpn_recorded_at")
      AND "provider_receipt_digest" ~ '^[0-9a-f]{64}$'
      AND num_nonnulls(
        "lifecycle_committed_at", "lifecycle_receipt_digest",
        "cleanup_proven_at", "cleanup_receipt_digest"
      ) = 0)
    OR ("state" = 'lifecycle_committed'
      AND "provider_succeeded_at" IS NOT NULL
      AND "provider_receipt_digest" ~ '^[0-9a-f]{64}$'
      AND "lifecycle_committed_at" IS NOT NULL
      AND "lifecycle_committed_at" >= "provider_succeeded_at"
      AND "lifecycle_receipt_digest" ~ '^[0-9a-f]{64}$'
      AND "cleanup_proven_at" IS NULL
      AND "cleanup_receipt_digest" IS NULL)
    OR ("state" = 'cleanup_proven'
      AND ("provider_succeeded_at" IS NULL) = ("provider_receipt_digest" IS NULL)
      AND ("provider_receipt_digest" IS NULL
        OR "provider_receipt_digest" ~ '^[0-9a-f]{64}$')
      AND "cleanup_proven_at" IS NOT NULL
      AND "cleanup_proven_at" >= COALESCE(
        "locator_vpn_recorded_at", "locator_container_recorded_at",
        "locator_recorded_at", "created_at"
      )
      AND ("provider_succeeded_at" IS NULL
        OR "cleanup_proven_at" >= "provider_succeeded_at")
      AND "cleanup_receipt_digest" ~ '^[0-9a-f]{64}$'
      AND "lifecycle_committed_at" IS NULL
      AND "lifecycle_receipt_digest" IS NULL)
  ) IS TRUE);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sandbox_replacement_attempts_organization_idx"
  ON "agent_sandbox_replacement_attempts" ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_sandbox_replacement_attempts_active_agent_uidx"
  ON "agent_sandbox_replacement_attempts" ("organization_id", "agent_id")
  WHERE "state" IN ('in_flight_unresolved', 'provider_succeeded');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_sandbox_replacement_attempts_active_generation_uidx"
  ON "agent_sandbox_replacement_attempts"
    ("organization_id", "agent_id", "activation_generation")
  WHERE "state" IN ('in_flight_unresolved', 'provider_succeeded', 'lifecycle_committed');
