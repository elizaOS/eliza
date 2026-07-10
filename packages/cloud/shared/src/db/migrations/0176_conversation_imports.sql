CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE cascade,
  user_id uuid REFERENCES users(id) ON DELETE set null,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE set null,
  app_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL DEFAULT 'uploading',
  upload_bytes bigint NOT NULL,
  reserved_bytes bigint NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  deleted_at timestamp
);

CREATE INDEX IF NOT EXISTS import_batches_organization_idx
  ON import_batches (organization_id);
CREATE INDEX IF NOT EXISTS import_batches_org_status_created_idx
  ON import_batches (organization_id, status, created_at);

CREATE TABLE IF NOT EXISTS import_upload_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE cascade,
  batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE cascade,
  filename text NOT NULL,
  content_type text NOT NULL,
  declared_sha256 text NOT NULL,
  upload_bytes bigint NOT NULL,
  chunk_size integer NOT NULL,
  chunk_count integer NOT NULL,
  status text NOT NULL DEFAULT 'open',
  multipart_upload_id text NOT NULL,
  storage_key text NOT NULL,
  session_state jsonb NOT NULL,
  part_etags jsonb NOT NULL DEFAULT '{}'::jsonb,
  retain_raw boolean NOT NULL DEFAULT false,
  retain_reason text,
  expires_at timestamp NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS import_upload_sessions_organization_idx
  ON import_upload_sessions (organization_id);
CREATE INDEX IF NOT EXISTS import_upload_sessions_batch_idx
  ON import_upload_sessions (batch_id);
CREATE INDEX IF NOT EXISTS import_upload_sessions_status_expires_idx
  ON import_upload_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS import_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE cascade,
  batch_id uuid NOT NULL REFERENCES import_batches(id) ON DELETE cascade,
  kind text NOT NULL,
  sha256 text NOT NULL,
  byte_length bigint NOT NULL,
  content_type text NOT NULL,
  storage_key text NOT NULL,
  retention_mode text NOT NULL,
  retain_reason text,
  expires_at timestamp,
  status text NOT NULL DEFAULT 'active',
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  deleted_at timestamp
);

CREATE INDEX IF NOT EXISTS import_artifacts_organization_idx
  ON import_artifacts (organization_id);
CREATE INDEX IF NOT EXISTS import_artifacts_batch_status_idx
  ON import_artifacts (batch_id, status);
CREATE INDEX IF NOT EXISTS import_artifacts_status_expires_idx
  ON import_artifacts (status, expires_at);
CREATE INDEX IF NOT EXISTS import_artifacts_sha_idx
  ON import_artifacts (sha256);
