-- Retain every client idempotency-key alias for its immutable command.

CREATE TABLE IF NOT EXISTS "billing_cancel_command_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "idempotency_key_hash" text NOT NULL,
  "request_digest" text NOT NULL,
  "command_id" uuid NOT NULL,
  "requested_by_user_id" uuid NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "billing_cancel_command_keys_org_key_unique"
    UNIQUE("organization_id", "idempotency_key_hash"),
  CONSTRAINT "billing_cancel_command_keys_digest_shape_check"
    CHECK ("idempotency_key_hash" ~ '^[a-f0-9]{64}$'
      AND "request_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT "billing_cancel_command_keys_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT "billing_cancel_command_keys_requested_by_user_id_users_id_fk"
  FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "billing_cancel_command_keys" ADD CONSTRAINT "billing_cancel_command_keys_command_tenant_fkey"
  FOREIGN KEY ("command_id", "organization_id")
  REFERENCES "billing_cancel_commands"("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_cancel_command_keys_command_idx"
  ON "billing_cancel_command_keys" ("command_id");
