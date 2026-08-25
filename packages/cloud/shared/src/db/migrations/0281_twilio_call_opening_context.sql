-- Immutable per-call context keeps generated PSTN openers retry-identical.

ALTER TABLE "twilio_inbound_calls"
  ADD COLUMN IF NOT EXISTS "opening_returning_caller" boolean,
  ADD COLUMN IF NOT EXISTS "opening_previous_interaction_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'twilio_inbound_calls_opening_context_shape_check'
      AND conrelid = 'twilio_inbound_calls'::regclass) THEN
    ALTER TABLE "twilio_inbound_calls" ADD CONSTRAINT
      "twilio_inbound_calls_opening_context_shape_check" CHECK ((
        "opening_returning_caller" IS TRUE
        OR "opening_previous_interaction_at" IS NULL
      ) IS TRUE) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "twilio_inbound_calls"
  VALIDATE CONSTRAINT "twilio_inbound_calls_opening_context_shape_check";
