CREATE TYPE "provider_environment" AS ENUM ('development', 'staging', 'production');
CREATE TYPE "provider_authority_status" AS ENUM ('active', 'disabled', 'revoked');
CREATE TYPE "provider_principal_type" AS ENUM ('human', 'agent');
CREATE TYPE "provider_role" AS ENUM ('tenant_authority_admin', 'workspace_admin', 'workspace_operator', 'workspace_viewer', 'workspace_approver');
CREATE TYPE "provider_risk_class" AS ENUM ('read', 'write', 'consequential');
--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_tenant_id_unique_idx" ON "secrets" ("tenant_id", "id");
CREATE UNIQUE INDEX "secret_routes_tenant_id_unique_idx" ON "secret_routes" ("tenant_id", "id");
--> statement-breakpoint
CREATE TABLE "provider_authority_tenant_state" (
  "tenant_id" varchar(64) PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL DEFAULT 0,
  "bootstrap_completed" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "workspaces" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "key" varchar(128) NOT NULL,
  "name" varchar(255) NOT NULL,
  "environment" provider_environment NOT NULL,
  "status" provider_authority_status NOT NULL DEFAULT 'active',
  "revision" integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  "created_by" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenant_id", "id"),
  UNIQUE ("tenant_id", "key")
);
CREATE INDEX "workspaces_tenant_status_idx" ON "workspaces" ("tenant_id", "status");
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" varchar(64) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "adapter_key" varchar(128) NOT NULL,
  "external_ref" varchar(512) NOT NULL,
  "display_name" varchar(255) NOT NULL,
  "status" provider_authority_status NOT NULL DEFAULT 'active',
  "credential_secret_id" uuid,
  "credential_version" integer,
  "revision" integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "provider_accounts_tenant_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "workspaces"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_accounts_tenant_credential_fk" FOREIGN KEY ("tenant_id", "credential_secret_id") REFERENCES "secrets"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "provider_accounts_credential_pair_check" CHECK ((credential_secret_id IS NULL) = (credential_version IS NULL)),
  UNIQUE ("tenant_id", "workspace_id", "id"),
  UNIQUE ("tenant_id", "workspace_id", "adapter_key", "external_ref")
);
--> statement-breakpoint
CREATE TABLE "provider_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" varchar(64) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "provider_account_id" uuid NOT NULL,
  "operation_key" varchar(128) NOT NULL,
  "risk_class" provider_risk_class NOT NULL,
  "capability_id" uuid,
  "secret_route_id" uuid,
  "request_profile" jsonb NOT NULL DEFAULT '{}',
  "response_profile" jsonb NOT NULL DEFAULT '{}',
  "status" provider_authority_status NOT NULL DEFAULT 'active',
  "revision" integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "provider_operations_tenant_workspace_account_fk" FOREIGN KEY ("tenant_id", "workspace_id", "provider_account_id") REFERENCES "provider_accounts"("tenant_id", "workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_operations_tenant_route_fk" FOREIGN KEY ("tenant_id", "secret_route_id") REFERENCES "secret_routes"("tenant_id", "id") ON DELETE RESTRICT,
  UNIQUE ("tenant_id", "workspace_id", "provider_account_id", "operation_key"),
  UNIQUE ("tenant_id", "workspace_id", "provider_account_id", "id")
);
--> statement-breakpoint
CREATE TABLE "provider_role_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "workspace_id" uuid,
  "provider_account_id" uuid,
  "principal_type" provider_principal_type NOT NULL,
  "principal_id" varchar(64) NOT NULL,
  "role_key" provider_role NOT NULL,
  "operation_keys" text[] NOT NULL DEFAULT '{}',
  "environment" provider_environment,
  "not_before" timestamptz,
  "expires_at" timestamptz,
  "status" provider_authority_status NOT NULL DEFAULT 'active',
  "revision" integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  "granted_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" text NOT NULL CHECK (length(trim(reason)) > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "provider_role_bindings_tenant_workspace_fk" FOREIGN KEY ("tenant_id", "workspace_id") REFERENCES "workspaces"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_role_bindings_tenant_workspace_account_fk" FOREIGN KEY ("tenant_id", "workspace_id", "provider_account_id") REFERENCES "provider_accounts"("tenant_id", "workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_role_bindings_scope_check" CHECK ((role_key = 'tenant_authority_admin' AND workspace_id IS NULL AND provider_account_id IS NULL) OR (role_key <> 'tenant_authority_admin' AND workspace_id IS NOT NULL)),
  CONSTRAINT "provider_role_bindings_account_workspace_check" CHECK (provider_account_id IS NULL OR workspace_id IS NOT NULL),
  CONSTRAINT "provider_role_bindings_lifetime_check" CHECK (not_before IS NULL OR expires_at IS NULL OR expires_at > not_before)
);
CREATE INDEX "provider_role_bindings_principal_idx" ON "provider_role_bindings" ("tenant_id", "principal_type", "principal_id", "status");
--> statement-breakpoint
CREATE TABLE "provider_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" varchar(64) NOT NULL,
  "workspace_id" uuid NOT NULL,
  "provider_account_id" uuid NOT NULL,
  "agent_id" varchar(64) NOT NULL,
  "operation_keys" text[] NOT NULL,
  "environment" provider_environment,
  "not_before" timestamptz,
  "expires_at" timestamptz NOT NULL,
  "status" provider_authority_status NOT NULL DEFAULT 'active',
  "revision" integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  "granted_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "reason" text NOT NULL CHECK (length(trim(reason)) > 0),
  "revoked_at" timestamptz,
  "revoked_by_user_id" uuid REFERENCES "users"("id") ON DELETE RESTRICT,
  "revocation_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "provider_grants_tenant_workspace_account_fk" FOREIGN KEY ("tenant_id", "workspace_id", "provider_account_id") REFERENCES "provider_accounts"("tenant_id", "workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_grants_tenant_agent_fk" FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "agents"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "provider_grants_operations_nonempty_check" CHECK (cardinality(operation_keys) > 0),
  CONSTRAINT "provider_grants_lifetime_check" CHECK (not_before IS NULL OR expires_at > not_before)
);
CREATE INDEX "provider_grants_agent_scope_idx" ON "provider_grants" ("tenant_id", "workspace_id", "agent_id", "status");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION steward_reject_provider_scope_move() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'provider authority tenant ownership is immutable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(OLD)->>'workspace_id') IS DISTINCT FROM (to_jsonb(NEW)->>'workspace_id') THEN
    RAISE EXCEPTION 'provider authority workspace ownership is immutable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(OLD)->>'provider_account_id') IS DISTINCT FROM (to_jsonb(NEW)->>'provider_account_id') THEN
    RAISE EXCEPTION 'provider account ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workspaces_immutable_owner BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION steward_reject_provider_scope_move();
CREATE TRIGGER provider_accounts_immutable_owner BEFORE UPDATE ON provider_accounts FOR EACH ROW EXECUTE FUNCTION steward_reject_provider_scope_move();
CREATE TRIGGER provider_operations_immutable_owner BEFORE UPDATE ON provider_operations FOR EACH ROW EXECUTE FUNCTION steward_reject_provider_scope_move();
CREATE TRIGGER provider_role_bindings_immutable_owner BEFORE UPDATE ON provider_role_bindings FOR EACH ROW EXECUTE FUNCTION steward_reject_provider_scope_move();
CREATE TRIGGER provider_grants_immutable_owner BEFORE UPDATE ON provider_grants FOR EACH ROW EXECUTE FUNCTION steward_reject_provider_scope_move();
