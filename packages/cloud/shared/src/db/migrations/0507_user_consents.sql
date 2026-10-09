CREATE TABLE IF NOT EXISTS "user_consents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "purpose" text NOT NULL,
  "granted" boolean NOT NULL,
  "policy_version" text NOT NULL,
  "source" text NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "user_consents_purpose_check" CHECK ("purpose" IN ('vision_capture'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_consents_user_purpose_idx"
  ON "user_consents" ("user_id", "organization_id", "purpose", "recorded_at");
