-- Disable the legacy `milady-core-*` static nodes so the autoscaler treats
-- them as inert during the data-plane migration to fully autoscaled
-- `eliza-core-*` cores.
--
-- Why:
--   - The 6 milady-core-* rows were inserted manually in 2026-03 (0xSolace
--     era) with `capacity = 100`, which is wildly above the realistic
--     cpx32 limit (~8 sandboxes per node before OOM). They have been
--     `status = 'offline'` in prod for weeks; the SSH health-check no
--     longer reaches them.
--   - The autoscale evaluator already filters on
--     `enabled = true AND status = 'healthy'`, so flipping `enabled = false`
--     removes them from capacity decisions without touching workloads that
--     happen to still run on the underlying VMs.
--   - Capacity is corrected to 8 for consistency with autoscaled
--     `eliza-core-*` rows. This is informational once enabled=false.
--
-- Sandboxes currently allocated on these nodes:
--   - Stay reachable while their Docker containers are alive.
--   - On the next user-triggered restart/recreate, the daemon will
--     provision them onto an autoscaled `eliza-core-<hex>` node.
--
-- Cleanup (separate, ops action — NOT in this migration):
--   1. Once `allocated_count = 0` for all milady-core-*: delete the Hetzner
--      Cloud servers via Cloud Console or `hcloud server delete`.
--   2. DELETE FROM docker_nodes WHERE node_id LIKE 'milady-core-%'.

UPDATE docker_nodes
SET
  capacity = 8,
  enabled = false,
  updated_at = now()
WHERE node_id LIKE 'milady-core-%';
