-- Hetzner Cloud network-attached block storage support.
--
-- Adds the columns required to track a per-project Hetzner Cloud volume
-- so stateful containers can migrate between Cloud-provisioned nodes
-- in the same location. Auctioned / dedicated boxes are NOT compatible
-- with Hetzner Cloud volumes — those continue to use local-host volumes
-- under /data/projects/<org>/<project>.
--
-- hcloud_volume_id  — Hetzner Cloud volume id (numeric). NULL means the
--                     container is using the legacy local-host volume.
-- volume_location   — Location the volume lives in (e.g. "fsn1").
--                     Sticky scheduling pins the container to a node in
--                     the same location.

ALTER TABLE "containers"
  ADD COLUMN IF NOT EXISTS "hcloud_volume_id" integer,
  ADD COLUMN IF NOT EXISTS "volume_location" text;

CREATE INDEX IF NOT EXISTS "containers_hcloud_volume_idx"
  ON "containers" ("hcloud_volume_id");
CREATE INDEX IF NOT EXISTS "containers_volume_location_idx"
  ON "containers" ("volume_location");
