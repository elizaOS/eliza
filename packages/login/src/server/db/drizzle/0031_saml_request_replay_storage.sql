CREATE TABLE IF NOT EXISTS "tenant_saml_authn_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "request_id" varchar(128) NOT NULL,
  "relay_state" varchar(128) NOT NULL,
  "redirect_uri" text NOT NULL,
  "app_client_id" varchar(64),
  "code_challenge" varchar(128) NOT NULL,
  "code_challenge_method" varchar(16) NOT NULL DEFAULT 'S256',
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_saml_authn_requests_pkce_method_check"
    CHECK ("code_challenge_method" = 'S256')
);

CREATE INDEX IF NOT EXISTS "tenant_saml_authn_requests_tenant_idx"
  ON "tenant_saml_authn_requests" ("tenant_id");

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_saml_authn_requests_relay_state_idx"
  ON "tenant_saml_authn_requests" ("relay_state");

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_saml_authn_requests_tenant_request_idx"
  ON "tenant_saml_authn_requests" ("tenant_id", "request_id");

CREATE INDEX IF NOT EXISTS "tenant_saml_authn_requests_expires_at_idx"
  ON "tenant_saml_authn_requests" ("expires_at");

CREATE TABLE IF NOT EXISTS "tenant_saml_assertion_replays" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "assertion_id" varchar(256) NOT NULL,
  "response_id" varchar(256),
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_saml_assertion_replays_tenant_assertion_idx"
  ON "tenant_saml_assertion_replays" ("tenant_id", "assertion_id");

CREATE INDEX IF NOT EXISTS "tenant_saml_assertion_replays_expires_at_idx"
  ON "tenant_saml_assertion_replays" ("expires_at");
