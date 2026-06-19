CREATE TABLE IF NOT EXISTS "device_bus_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"push_token" text,
	"label" text,
	"online" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_bus_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"delivered_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_bus_devices" ADD CONSTRAINT "device_bus_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_bus_intents" ADD CONSTRAINT "device_bus_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_bus_devices_user_id_idx" ON "device_bus_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_bus_devices_last_seen_idx" ON "device_bus_devices" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_bus_intents_user_created_idx" ON "device_bus_intents" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_bus_intents_kind_idx" ON "device_bus_intents" USING btree ("kind");
