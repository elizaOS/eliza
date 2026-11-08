-- One row per x402 top-up, written before settlement, so a transfer that
-- settled but was not credited in the request is credited by the cron.
CREATE TABLE IF NOT EXISTS "x402_settlement_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "network" text NOT NULL,
  "payer" text NOT NULL,
  "nonce" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "wallet_address" text NOT NULL,
  "amount_usd" numeric(12, 2) NOT NULL,
  "transaction" text,
  "credit_key" text,
  "source_id" text,
  "organization_id" uuid,
  "last_error" text,
  "settled_at" timestamp with time zone,
  "credited_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "x402_settlement_intents_status_check" CHECK ("status" IN ('pending','settled','credited')),
  CONSTRAINT "x402_settlement_intents_settled_check" CHECK ("status" = 'pending' OR ("transaction" IS NOT NULL AND "credit_key" IS NOT NULL AND "source_id" IS NOT NULL AND "settled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "x402_settlement_intents_identity_idx" ON "x402_settlement_intents" USING btree ("network","payer","nonce");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "x402_settlement_intents_settled_idx" ON "x402_settlement_intents" USING btree ("updated_at") WHERE "status" = 'settled';
