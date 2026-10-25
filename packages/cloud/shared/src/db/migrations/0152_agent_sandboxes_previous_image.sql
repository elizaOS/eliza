-- Persist the prior-good image so a fleet upgrade can be rolled back.
--
-- `executeUpgrade` blue/green-swaps an agent onto a new image. Before this
-- migration the old digest was lost at swap time, so there was no rollback
-- target (image-rollout-status reported `rollback` as Unsupported). These two
-- nullable columns capture the pre-upgrade image:
--   previous_image_digest  — the sha256 digest the agent ran on before the swap
--   previous_docker_image  — the docker image reference it ran on before the swap
-- `executeDowngrade` reads them to swap the agent back onto the prior good
-- image. Both are null until the first upgrade — agents that have never been
-- upgraded have no rollback target, which is the correct "rollback unavailable"
-- state. See packages/cloud/shared/src/lib/services/eliza-sandbox.ts.
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, no backfill, no drops.

ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "previous_image_digest" text,
  ADD COLUMN IF NOT EXISTS "previous_docker_image" text;
