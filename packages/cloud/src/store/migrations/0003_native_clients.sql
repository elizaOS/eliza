CREATE TABLE native_clients (
  client_id text PRIMARY KEY,
  environment text NOT NULL CHECK (environment IN ('production', 'staging')),
  display_name text NOT NULL,
  android_package text NOT NULL UNIQUE,
  cert_fingerprints jsonb NOT NULL,
  sign_in_return text NOT NULL,
  billing_return text NOT NULL,
  connect_return text,
  credential_ttl_ms bigint NOT NULL,
  native_google boolean NOT NULL,
  enabled boolean NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
