CREATE TABLE IF NOT EXISTS "operator_transfer_reservations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "agent_id" varchar(64) NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "rail" varchar(16) NOT NULL,
  "idempotency_key" varchar(256) NOT NULL,
  "destination" varchar(128) NOT NULL,
  "amount_base_units" text NOT NULL,
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "finalized_at" timestamptz,
  CONSTRAINT "operator_transfer_reservation_amount_base_units_chk" CHECK ("amount_base_units" ~ '^[0-9]+$'),
  CONSTRAINT "operator_transfer_reservation_status_chk" CHECK ("status" in ('pending', 'final', 'released'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "operator_transfer_reservation_request_uidx"
  ON "operator_transfer_reservations" ("tenant_id", "rail", "idempotency_key")
  WHERE "status" in ('pending', 'final');
CREATE INDEX IF NOT EXISTS "operator_transfer_reservation_agent_created_idx"
  ON "operator_transfer_reservations" ("tenant_id", "agent_id", "created_at");
