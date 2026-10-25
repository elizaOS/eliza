-- Create n8n_workflow schema (namespace for n8n plugin tables)
CREATE SCHEMA IF NOT EXISTS "n8n_workflow";

-- Create credential_mappings table
CREATE TABLE IF NOT EXISTS "n8n_workflow"."credential_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" text NOT NULL,
  "cred_type" text NOT NULL,
  "n8n_credential_id" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

-- Create unique index for user_id + cred_type
CREATE UNIQUE INDEX IF NOT EXISTS "idx_user_cred" ON "n8n_workflow"."credential_mappings" ("user_id", "cred_type");
