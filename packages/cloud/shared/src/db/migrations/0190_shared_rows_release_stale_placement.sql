-- Release container placement held by legacy shared-tier rows.
--
-- Shared-tier agents run container-free in the hosted shared runtime: their
-- node_id / container_name are NULL by design, the heartbeat sweep excludes the
-- tier for exactly that reason, and nothing on the serving path reads a
-- container locator for them. Before that design landed, shared agents got real
-- containers, and a handful of rows from that era still carry their placement.
-- Their containers are long gone (reaped by the orphan reconciler), but the
-- rows still count toward node allocation — `running` is non-terminal — so each
-- one permanently holds a slot the allocator believes is occupied.
--
-- Measured on production 2026-08-06: exactly six such rows, every one with a
-- last heartbeat 26 days old. None created in the last 14 days, so this is a
-- remnant, not an active leak — a data fix, with no code change required.
--
-- Scope guards, each load-bearing:
--   * pool_status IS NULL      — warm-pool rows are shared-tier AND legitimately
--                                placed while unclaimed; they are owned by the
--                                pool lifecycle, never by this migration.
--   * status = 'running'       — deletion_pending/deletion_failed rows keep
--                                their locator for the delete-retry sweep.
--   * heartbeat stale > 7 days — a placed shared row with a recent heartbeat
--                                would be live evidence the container-free
--                                design assumption is wrong somewhere; leave it
--                                for a human rather than erase the evidence.
--
-- Clearing the same column set as executeSleep, the canonical release shape.

UPDATE "agent_sandboxes"
SET
  node_id = NULL,
  container_name = NULL,
  sandbox_id = NULL,
  bridge_url = NULL,
  health_url = NULL,
  headscale_ip = NULL,
  bridge_port = NULL,
  web_ui_port = NULL,
  updated_at = NOW()
WHERE execution_tier = 'shared'
  AND status = 'running'
  AND pool_status IS NULL
  AND node_id IS NOT NULL
  AND (last_heartbeat_at IS NULL OR last_heartbeat_at < NOW() - INTERVAL '7 days');
