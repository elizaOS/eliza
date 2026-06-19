CREATE TABLE IF NOT EXISTS "agent_phone_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "agent_id" uuid NOT NULL REFERENCES "agent_sandboxes"("id") ON DELETE cascade,
  "provider" text NOT NULL,
  "contact_identifier" text NOT NULL,
  "contact_display_name" text,
  "first_contacted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_contacted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_inbound_at" timestamp with time zone,
  "last_outbound_at" timestamp with time zone,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_phone_contacts_agent_contact_idx"
  ON "agent_phone_contacts" ("provider", "contact_identifier", "agent_id");

CREATE INDEX IF NOT EXISTS "agent_phone_contacts_lookup_idx"
  ON "agent_phone_contacts" ("provider", "contact_identifier", "is_active", "last_contacted_at");

CREATE INDEX IF NOT EXISTS "agent_phone_contacts_agent_idx"
  ON "agent_phone_contacts" ("agent_id");

CREATE INDEX IF NOT EXISTS "agent_phone_contacts_organization_idx"
  ON "agent_phone_contacts" ("organization_id");

CREATE INDEX IF NOT EXISTS "agent_phone_contacts_user_idx"
  ON "agent_phone_contacts" ("user_id");
