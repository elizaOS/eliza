ALTER TABLE "payment_request_events"
  ADD COLUMN IF NOT EXISTS "provider" text,
  ADD COLUMN IF NOT EXISTS "provider_event_id" text,
  ADD COLUMN IF NOT EXISTS "provider_tx_ref" text,
  ADD COLUMN IF NOT EXISTS "provider_disposition" text,
  ADD COLUMN IF NOT EXISTS "payload_digest" text,
  ADD COLUMN IF NOT EXISTS "callback_state" text,
  ADD COLUMN IF NOT EXISTS "callback_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "callback_last_error" text,
  ADD COLUMN IF NOT EXISTS "callback_next_attempt_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "callback_claimed_until" timestamptz;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_request_events_provider_event_unique"
  ON "payment_request_events" ("provider", "provider_event_id")
  WHERE "event_name" = 'webhook.received';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payment_request_events_settled_provider_tx_unique"
  ON "payment_request_events" ("provider", "provider_tx_ref")
  WHERE "event_name" = 'webhook.received' AND "provider_disposition" = 'settled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_request_events_callback_due_idx"
  ON "payment_request_events" ("callback_state", "callback_next_attempt_at")
  WHERE "event_name" = 'webhook.received';
--> statement-breakpoint
ALTER TABLE "payment_request_events"
  ADD CONSTRAINT "payment_request_events_provider_event_shape_check"
  CHECK (
    ("event_name" <> 'webhook.received'
      AND "provider" IS NULL
      AND "provider_event_id" IS NULL
      AND "provider_tx_ref" IS NULL
      AND "provider_disposition" IS NULL
      AND "payload_digest" IS NULL
      AND "callback_state" IS NULL)
    OR
    ("event_name" = 'webhook.received'
      AND "provider" IS NOT NULL
      AND "provider_event_id" IS NOT NULL
      AND "provider_tx_ref" IS NOT NULL
      AND "provider_disposition" IS NOT NULL
      AND "payload_digest" IS NOT NULL
      AND "callback_state" IS NOT NULL)
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_request_events"
  VALIDATE CONSTRAINT "payment_request_events_provider_event_shape_check";
--> statement-breakpoint
ALTER TABLE "payment_request_events"
  ADD CONSTRAINT "payment_request_events_provider_event_provider_check"
  CHECK ("provider" IS NULL OR "provider" IN ('stripe','oxapay','x402','wallet_native')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_request_events"
  VALIDATE CONSTRAINT "payment_request_events_provider_event_provider_check";
--> statement-breakpoint
ALTER TABLE "payment_request_events"
  ADD CONSTRAINT "payment_request_events_provider_event_disposition_check"
  CHECK ("provider_disposition" IS NULL OR "provider_disposition" IN ('settled','failed')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_request_events"
  VALIDATE CONSTRAINT "payment_request_events_provider_event_disposition_check";
--> statement-breakpoint
ALTER TABLE "payment_request_events"
  ADD CONSTRAINT "payment_request_events_callback_state_check"
  CHECK ("callback_state" IS NULL OR "callback_state" IN ('pending','dispatched','failed','superseded')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "payment_request_events"
  VALIDATE CONSTRAINT "payment_request_events_callback_state_check";
