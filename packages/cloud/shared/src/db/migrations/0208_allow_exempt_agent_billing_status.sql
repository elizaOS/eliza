-- Widens the agent billing-status CHECK to include 'exempt', aligning the
-- migrated database with the canonical AgentBillingStatus TypeScript contract
-- (packages/cloud/shared/src/db/schemas/agent-sandboxes.ts). Migration 0056
-- added the constraint before 'exempt' existed, so a canonically migrated
-- database rejects the zero-charge status the billing code already writes.
-- 0095 renamed the table but not this constraint, so the historical name is
-- still "billing_status_check". Drop-then-add keeps reapplication safe.

ALTER TABLE "agent_sandboxes" DROP CONSTRAINT IF EXISTS "billing_status_check";
ALTER TABLE "agent_sandboxes" ADD CONSTRAINT "billing_status_check"
  CHECK (billing_status IN ('active', 'warning', 'shutdown_pending', 'suspended', 'exempt'));
