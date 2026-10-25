-- Safety: prevent indefinite lock waits on active tables
SET lock_timeout = '3s';
SET statement_timeout = '30s';

-- Docker nodes table for tracking VPS infrastructure
CREATE TABLE IF NOT EXISTS docker_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id TEXT UNIQUE NOT NULL,
  hostname TEXT NOT NULL,
  ssh_port INTEGER NOT NULL DEFAULT 22,
  capacity INTEGER NOT NULL DEFAULT 8,
  enabled BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'unknown',
  allocated_count INTEGER NOT NULL DEFAULT 0,
  last_health_check TIMESTAMPTZ,
  ssh_user TEXT NOT NULL DEFAULT 'root',
  host_key_fingerprint TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS docker_nodes_node_id_idx ON docker_nodes(node_id);
CREATE INDEX IF NOT EXISTS docker_nodes_status_idx ON docker_nodes(status);
CREATE INDEX IF NOT EXISTS docker_nodes_enabled_idx ON docker_nodes(enabled);

-- Add docker infrastructure columns to eliza_sandboxes (if table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'eliza_sandboxes') THEN
    ALTER TABLE eliza_sandboxes ADD COLUMN IF NOT EXISTS node_id TEXT;
    ALTER TABLE eliza_sandboxes ADD COLUMN IF NOT EXISTS container_name TEXT;
    ALTER TABLE eliza_sandboxes ADD COLUMN IF NOT EXISTS bridge_port INTEGER;
    ALTER TABLE eliza_sandboxes ADD COLUMN IF NOT EXISTS web_ui_port INTEGER;
    ALTER TABLE eliza_sandboxes ADD COLUMN IF NOT EXISTS headscale_ip TEXT;
    ALTER TABLE eliza_sandboxes ADD COLUMN IF NOT EXISTS docker_image TEXT;

    CREATE INDEX IF NOT EXISTS eliza_sandboxes_node_id_idx ON eliza_sandboxes(node_id);

    -- Prevent port collisions: unique constraint on (node_id, bridge_port) for active sandboxes
    -- Note: partial unique index so stopped/deleted sandboxes don't block port reuse
    CREATE UNIQUE INDEX IF NOT EXISTS eliza_sandboxes_node_bridge_port_uniq
      ON eliza_sandboxes (node_id, bridge_port)
      WHERE status IN ('running', 'provisioning', 'pending');

    -- Prevent web UI port collisions: same pattern as bridge_port
    CREATE UNIQUE INDEX IF NOT EXISTS eliza_sandboxes_node_webui_port_uniq
      ON eliza_sandboxes (node_id, web_ui_port)
      WHERE status IN ('running', 'provisioning', 'pending');
  END IF;
END $$;
