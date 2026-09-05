-- Bind every operator reservation to the tenant that owns its agent. Independent
-- tenant_id and agent_id foreign keys do not reject a cross-tenant pair.
ALTER TABLE "operator_transfer_reservations"
  ADD CONSTRAINT "operator_transfer_reservations_tenant_agent_fk"
  FOREIGN KEY ("tenant_id", "agent_id")
  REFERENCES "agents" ("tenant_id", "id")
  ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "operator_transfer_reservations"
  ADD CONSTRAINT "operator_transfer_reservation_rail_chk"
  CHECK ("rail" in ('withdraw', 'usd-send'));
--> statement-breakpoint
-- Application writes already pair terminal states with finalized_at. Normalize
-- legacy rows before making that lifecycle shape database-enforced.
UPDATE "operator_transfer_reservations"
SET "finalized_at" = COALESCE("finalized_at", "created_at")
WHERE "status" in ('final', 'released');
--> statement-breakpoint
UPDATE "operator_transfer_reservations"
SET "finalized_at" = NULL
WHERE "status" = 'pending';
--> statement-breakpoint
ALTER TABLE "operator_transfer_reservations"
  ADD CONSTRAINT "operator_transfer_reservation_status_finalized_chk"
  CHECK (
    ("status" = 'pending' AND "finalized_at" IS NULL)
    OR ("status" in ('final', 'released') AND "finalized_at" IS NOT NULL)
  );
