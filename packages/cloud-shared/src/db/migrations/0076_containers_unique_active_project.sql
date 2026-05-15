-- Enforce one active stateful container per (organization_id, project_name).
--
-- A "stateful" container has volume_path set; multiple of them sharing
-- the same /data/projects/<org>/<project> path would race on disk. The
-- partial index excludes failed/stopped rows so redeploy flows (delete +
-- create) keep working: the old row may briefly remain in failed state
-- while the new one is created.
--
-- Stateless containers (volume_path IS NULL) are not constrained — those
-- can scale freely if multi-replica support ever lands.

CREATE UNIQUE INDEX IF NOT EXISTS "containers_active_project_volume_unique"
  ON "containers" ("organization_id", "project_name")
  WHERE "status" NOT IN ('failed', 'stopped')
    AND "volume_path" IS NOT NULL;
