CREATE TABLE IF NOT EXISTS cloud_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE cascade,
  user_id uuid REFERENCES users(id) ON DELETE set null,
  api_key_id uuid REFERENCES api_keys(id) ON DELETE set null,
  generation_id uuid REFERENCES generations(id) ON DELETE set null,
  source text NOT NULL,
  kind text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  storage_url text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  deleted_at timestamp
);

CREATE INDEX IF NOT EXISTS cloud_files_organization_idx
  ON cloud_files (organization_id);
CREATE INDEX IF NOT EXISTS cloud_files_org_status_created_idx
  ON cloud_files (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS cloud_files_org_kind_status_idx
  ON cloud_files (organization_id, kind, status);
CREATE INDEX IF NOT EXISTS cloud_files_generation_idx
  ON cloud_files (generation_id);
CREATE INDEX IF NOT EXISTS cloud_files_sha_idx
  ON cloud_files (sha256);
