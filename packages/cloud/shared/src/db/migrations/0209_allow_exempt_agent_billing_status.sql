-- Keep the persisted billing-status contract aligned with AgentBillingStatus.
ALTER TABLE "agent_sandboxes"
  DROP CONSTRAINT IF EXISTS "billing_status_check";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  ADD CONSTRAINT "billing_status_check"
  CHECK ("billing_status" IN ('active', 'warning', 'shutdown_pending', 'suspended', 'exempt'));
