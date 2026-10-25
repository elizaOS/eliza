-- Retains the deleted provisional account's exact personal-Eliza address until
-- its history alias is durably installed. The receipt makes a retry after the
-- database commit deterministic instead of guessing which account was merged.

CREATE TABLE IF NOT EXISTS "personal_account_convergences" (
  "token" text PRIMARY KEY NOT NULL,
  "source_user_id" uuid NOT NULL,
  "source_organization_id" uuid NOT NULL,
  "source_agent_id" text NOT NULL,
  "target_user_id" uuid NOT NULL,
  "target_organization_id" uuid NOT NULL,
  "target_agent_id" text NOT NULL,
  "phone_number" text NOT NULL,
  "telegram_id" text NOT NULL,
  "steward_user_id" text NOT NULL,
  "status" text DEFAULT 'pending_alias' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "personal_account_convergences_target_user_id_users_id_fk"
    FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "personal_account_convergences_target_organization_id_organizations_id_fk"
    FOREIGN KEY ("target_organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "personal_account_convergences_status_check"
    CHECK ("status" IN ('pending_alias', 'complete'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "personal_account_convergences_phone_telegram_unique"
  ON "personal_account_convergences" ("phone_number", "telegram_id");

CREATE UNIQUE INDEX IF NOT EXISTS "personal_account_convergences_target_unique"
  ON "personal_account_convergences" ("target_user_id");
