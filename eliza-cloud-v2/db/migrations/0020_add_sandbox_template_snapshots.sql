-- Add sandbox template snapshots table for faster sandbox creation
-- Snapshots allow skipping git clone and package installation

CREATE TABLE IF NOT EXISTS sandbox_template_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Snapshot identification
  snapshot_id TEXT NOT NULL UNIQUE,
  template_key TEXT NOT NULL,
  
  -- Source tracking
  github_repo TEXT,
  github_commit_sha TEXT,
  
  -- Snapshot metadata
  node_modules_size_mb INTEGER,
  total_files INTEGER,
  
  -- Status
  status TEXT NOT NULL DEFAULT 'creating',
  error_message TEXT,
  
  -- Timestamps
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NOT NULL,
  last_used_at TIMESTAMP,
  
  -- Usage tracking
  usage_count INTEGER NOT NULL DEFAULT 0,
  
  -- Add check constraint for status values
  CONSTRAINT sandbox_snapshots_status_check CHECK (
    status IN ('creating', 'ready', 'expired', 'failed')
  )
);

-- Add indexes for common queries
CREATE INDEX IF NOT EXISTS sandbox_snapshots_template_key_idx 
  ON sandbox_template_snapshots(template_key);

CREATE INDEX IF NOT EXISTS sandbox_snapshots_status_idx 
  ON sandbox_template_snapshots(status);

CREATE INDEX IF NOT EXISTS sandbox_snapshots_expires_at_idx 
  ON sandbox_template_snapshots(expires_at);

CREATE INDEX IF NOT EXISTS sandbox_snapshots_snapshot_id_idx 
  ON sandbox_template_snapshots(snapshot_id);

-- Add comment
COMMENT ON TABLE sandbox_template_snapshots IS 
  'Stores Vercel Sandbox snapshots for templates to enable faster startup. Snapshots expire after 7 days.';
