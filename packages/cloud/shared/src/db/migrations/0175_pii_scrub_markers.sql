CREATE TABLE IF NOT EXISTS pii_scrub_markers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE cascade,
  marker_key text NOT NULL,
  content_hash text NOT NULL,
  ruleset_version text NOT NULL,
  model_id text NOT NULL,
  tier0_only boolean NOT NULL,
  job_id uuid,
  created_at timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS pii_scrub_markers_org_key_idx
  ON pii_scrub_markers (organization_id, marker_key);
CREATE INDEX IF NOT EXISTS pii_scrub_markers_org_idx
  ON pii_scrub_markers (organization_id);
CREATE INDEX IF NOT EXISTS pii_scrub_markers_org_ruleset_idx
  ON pii_scrub_markers (organization_id, ruleset_version);
