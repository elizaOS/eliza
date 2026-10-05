CREATE TABLE IF NOT EXISTS "tenant_saml_sso_configs" (
  "tenant_id" varchar(64) PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "status" varchar(16) NOT NULL DEFAULT 'pending',
  "idp_entity_id" text NOT NULL,
  "idp_sso_url" text NOT NULL,
  "idp_cert_pems" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "sp_entity_id" text NOT NULL,
  "acs_url" text NOT NULL,
  "name_id_format" text,
  "email_attribute" varchar(128) NOT NULL DEFAULT 'email',
  "groups_attribute" varchar(128),
  "allow_jit_provisioning" boolean NOT NULL DEFAULT false,
  "jit_default_role" varchar(32) NOT NULL DEFAULT 'viewer',
  "last_tested_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_saml_sso_configs_status_check"
    CHECK ("status" IN ('pending', 'active', 'error')),
  CONSTRAINT "tenant_saml_sso_configs_viewer_jit_role_check"
    CHECK ("jit_default_role" = 'viewer'),
  CONSTRAINT "tenant_saml_sso_configs_cert_count_check"
    CHECK (cardinality("idp_cert_pems") BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS "tenant_saml_sso_configs_status_idx"
  ON "tenant_saml_sso_configs" ("status");

CREATE INDEX IF NOT EXISTS "tenant_saml_sso_configs_enabled_idx"
  ON "tenant_saml_sso_configs" ("enabled");
