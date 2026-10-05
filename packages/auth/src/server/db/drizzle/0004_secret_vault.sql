-- Secret Vault tables migration
-- Phase 1: Encrypted credential storage + route-based injection

CREATE TABLE IF NOT EXISTS "secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" text,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "salt" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "rotated_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "secret_routes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "secret_id" uuid NOT NULL,
  "host_pattern" varchar(512) NOT NULL,
  "path_pattern" varchar(512) DEFAULT '/*',
  "method" varchar(10) DEFAULT '*',
  "inject_as" varchar(50) NOT NULL,
  "inject_key" varchar(255) NOT NULL,
  "inject_format" varchar(255) DEFAULT '{value}',
  "priority" integer NOT NULL DEFAULT 0,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes for secrets table
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_tenant_name_version_idx" ON "secrets" ("tenant_id", "name", "version");
CREATE INDEX IF NOT EXISTS "secrets_tenant_idx" ON "secrets" ("tenant_id");

-- Indexes for secret_routes table
CREATE INDEX IF NOT EXISTS "secret_routes_tenant_idx" ON "secret_routes" ("tenant_id");
CREATE INDEX IF NOT EXISTS "secret_routes_secret_idx" ON "secret_routes" ("secret_id");
CREATE INDEX IF NOT EXISTS "secret_routes_host_idx" ON "secret_routes" ("host_pattern");
