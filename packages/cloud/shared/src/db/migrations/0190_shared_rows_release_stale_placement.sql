-- Release container placement held by stale shared-tier rows.
--
-- Shared-tier agents run container-free in the hosted shared runtime, but stale
-- rows can retain locators that continue to count toward node allocation. Clear
-- locator fields only from user-owned running rows without a recent heartbeat.
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
-- This is the same locator set cleared by executeSleep.

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
