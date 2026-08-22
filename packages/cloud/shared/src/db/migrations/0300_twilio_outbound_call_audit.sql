CREATE TABLE "twilio_call_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_digest" text NOT NULL,
	"outbound_call_id" uuid NOT NULL,
	"call_sid" text NOT NULL,
	"call_status" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"provider_timestamp" timestamp with time zone,
	"provider_error_code" text,
	"receipt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "twilio_call_status_events_event_digest_unique" UNIQUE("event_digest")
);
--> statement-breakpoint
CREATE TABLE "twilio_outbound_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"request_digest" text NOT NULL,
	"call_sid" text,
	"account_sid" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"from_number" text NOT NULL,
	"to_number" text NOT NULL,
	"call_status" text DEFAULT 'requesting' NOT NULL,
	"last_status_sequence" integer DEFAULT -1 NOT NULL,
	"provider_error_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"hangup_requested_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "twilio_outbound_calls_request_digest_unique" UNIQUE("request_digest"),
	CONSTRAINT "twilio_outbound_calls_call_sid_unique" UNIQUE("call_sid"),
	CONSTRAINT "twilio_outbound_calls_shape_check" CHECK ("twilio_outbound_calls"."last_status_sequence" >= -1
        AND ("twilio_outbound_calls"."answered_at" IS NULL OR "twilio_outbound_calls"."call_sid" IS NOT NULL)
        AND (
          "twilio_outbound_calls"."terminal_at" IS NULL
          OR "twilio_outbound_calls"."call_sid" IS NOT NULL
          OR "twilio_outbound_calls"."call_status" = 'provider-error'
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "twilio_call_status_events_call_sequence_uidx" ON "twilio_call_status_events" USING btree ("call_sid","sequence_number");--> statement-breakpoint
CREATE INDEX "twilio_call_status_events_outbound_received_idx" ON "twilio_call_status_events" USING btree ("outbound_call_id","received_at");--> statement-breakpoint
CREATE INDEX "twilio_outbound_calls_user_requested_idx" ON "twilio_outbound_calls" USING btree ("user_id","requested_at");--> statement-breakpoint
CREATE INDEX "twilio_outbound_calls_org_requested_idx" ON "twilio_outbound_calls" USING btree ("organization_id","requested_at");--> statement-breakpoint
CREATE INDEX "twilio_outbound_calls_status_idx" ON "twilio_outbound_calls" USING btree ("call_status");
