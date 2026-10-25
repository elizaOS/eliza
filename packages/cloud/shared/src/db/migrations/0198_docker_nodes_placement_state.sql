-- Separates "may this node take NEW work" from "is this node operationally
-- enabled", so a box can be cordoned while its residents keep serving.
--
-- `enabled` was the only switch, and it is the wrong one to cordon with. It is
-- read by the placement selectors, but it is ALSO the gate on the loops that
-- have to keep running precisely while a node is being emptied: the health
-- check sweep, allocated-count sync, disk monitoring, and the orphan
-- reconciler all start from the enabled set. Flipping `enabled=false` on a box
-- holding thirty live agents therefore stops watching them at the exact moment
-- they are most likely to move, fail, or strand a container.
--
-- The four states are ordered by how much freedom the node still has:
--   open       - normal, accepts new placements
--   cordoned   - no new placements; residents untouched
--   evacuating - cordoned, and residents are actively being moved off
--   drained    - cordoned and empty; safe to decommission or repurpose
--
-- Only the placement SELECTs filter on this column. Every operational loop
-- deliberately ignores it. Defaulting to 'open' makes the column a no-op for
-- every existing row and every caller that has not been taught about it yet.

ALTER TABLE "docker_nodes"
  ADD COLUMN IF NOT EXISTS "placement_state" text NOT NULL DEFAULT 'open';
