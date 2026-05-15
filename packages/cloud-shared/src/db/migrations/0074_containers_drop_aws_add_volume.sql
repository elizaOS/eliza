-- Drop AWS-only legacy columns from containers (now Hetzner-Docker only)
-- and add the columns required for stateful sticky scheduling and per-
-- container persistent volumes.
--
-- AWS columns being dropped were nullable and unused since the
-- Hetzner-Docker migration. The corresponding indexes go with them.
--
-- New columns:
--   node_id        — pins the container to a specific docker_node so the
--                    autoscaler / drain logic can reason about co-located
--                    state (especially the host-mounted volume below).
--   volume_path    — host filesystem path mounted into the container at
--                    /data. NULL means the container is stateless.
--   volume_size_gb — informational declared size of the volume.

DROP INDEX IF EXISTS "containers_ecs_service_idx";
DROP INDEX IF EXISTS "containers_ecr_repository_idx";

ALTER TABLE "containers"
  DROP COLUMN IF EXISTS "cloudformation_stack_name",
  DROP COLUMN IF EXISTS "ecr_repository_uri",
  DROP COLUMN IF EXISTS "ecr_image_tag",
  DROP COLUMN IF EXISTS "ecs_cluster_arn",
  DROP COLUMN IF EXISTS "ecs_service_arn",
  DROP COLUMN IF EXISTS "ecs_task_definition_arn",
  DROP COLUMN IF EXISTS "ecs_task_arn",
  DROP COLUMN IF EXISTS "is_update",
  DROP COLUMN IF EXISTS "dockerfile_path",
  DROP COLUMN IF EXISTS "architecture";

ALTER TABLE "containers"
  ADD COLUMN IF NOT EXISTS "node_id" text,
  ADD COLUMN IF NOT EXISTS "volume_path" text,
  ADD COLUMN IF NOT EXISTS "volume_size_gb" integer;

CREATE INDEX IF NOT EXISTS "containers_node_idx" ON "containers" ("node_id");
