/**
 * Extends durable agent-billing run receipts with the pending warning-delivery
 * state used to recover a worker crash between provider delivery and finalization.
 */

ALTER TABLE "agent_billing_run_items"
  DROP CONSTRAINT IF EXISTS "agent_billing_run_items_action_check";
--> statement-breakpoint
ALTER TABLE "agent_billing_run_items"
  ADD CONSTRAINT "agent_billing_run_items_action_check"
  CHECK ("action" IN ('billed', 'warning_pending', 'warning_sent', 'shutdown', 'skipped', 'error'));
