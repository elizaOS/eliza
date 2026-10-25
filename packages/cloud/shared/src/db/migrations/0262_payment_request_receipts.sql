-- Provider payment receipts are immutable projections, not tax or legal invoices.

CREATE UNIQUE INDEX IF NOT EXISTS "payment_requests_id_organization_provider_unique"
  ON "payment_requests" ("id", "organization_id", "provider");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_request_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL
    REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "payment_request_id" uuid NOT NULL,
  "receipt_type" text NOT NULL DEFAULT 'provider_payment_receipt',
  "provider" text NOT NULL,
  "provider_tx_ref" text NOT NULL,
  "provider_event_id" text NOT NULL,
  "amount_cents" bigint NOT NULL,
  "currency" text NOT NULL,
  "settled_at" timestamptz NOT NULL,
  "payload_digest" text NOT NULL,
  "settlement_proof" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "payment_request_receipts_request_unique"
    UNIQUE ("payment_request_id"),
  CONSTRAINT "payment_request_receipts_key_unique"
    UNIQUE ("organization_id", "payment_request_id", "provider", "provider_tx_ref"),
  CONSTRAINT "payment_request_receipts_provider_transaction_unique"
    UNIQUE ("provider", "provider_tx_ref"),
  CONSTRAINT "payment_request_receipts_request_organization_provider_fkey"
    FOREIGN KEY ("payment_request_id", "organization_id", "provider")
    REFERENCES "payment_requests" ("id", "organization_id", "provider") ON DELETE RESTRICT,
  CONSTRAINT "payment_request_receipts_shape_check" CHECK ((
    "receipt_type" = 'provider_payment_receipt'
    AND "provider" IN ('stripe', 'oxapay')
    AND "amount_cents" > 0
    AND "currency" ~ '^[A-Z]{3,8}$'
    AND "provider_tx_ref" = btrim("provider_tx_ref")
    AND octet_length("provider_tx_ref") BETWEEN 1 AND 512
    AND "provider_event_id" = btrim("provider_event_id")
    AND octet_length("provider_event_id") BETWEEN 1 AND 512
    AND "payload_digest" ~ '^[a-f0-9]{64}$') IS TRUE)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_request_receipts_org_created_idx"
  ON "payment_request_receipts" ("organization_id", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_payment_request_receipt_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment request receipt is immutable' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_request_receipts_immutable"
  ON "payment_request_receipts";
--> statement-breakpoint
CREATE TRIGGER "payment_request_receipts_immutable"
  BEFORE UPDATE OR DELETE ON "payment_request_receipts"
  FOR EACH ROW EXECUTE FUNCTION "reject_payment_request_receipt_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "payment_request_receipts_truncate_guard"
  ON "payment_request_receipts";
--> statement-breakpoint
CREATE TRIGGER "payment_request_receipts_truncate_guard"
  BEFORE TRUNCATE ON "payment_request_receipts"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_payment_request_receipt_mutation"();
