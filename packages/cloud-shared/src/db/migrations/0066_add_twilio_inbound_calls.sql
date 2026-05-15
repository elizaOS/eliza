CREATE TABLE IF NOT EXISTS "twilio_inbound_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_sid" text NOT NULL,
	"account_sid" text NOT NULL,
	"from_number" text NOT NULL,
	"to_number" text NOT NULL,
	"call_status" text NOT NULL,
	"agent_id" uuid,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "twilio_inbound_calls_call_sid_unique" UNIQUE("call_sid")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "twilio_inbound_calls_to_idx" ON "twilio_inbound_calls" USING btree ("to_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "twilio_inbound_calls_received_idx" ON "twilio_inbound_calls" USING btree ("received_at");
