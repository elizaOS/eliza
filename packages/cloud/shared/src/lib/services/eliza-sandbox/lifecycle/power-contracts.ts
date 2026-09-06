/** Describes suspend completion and backup authority without conflating a deferred capture with a stopped container. */

export interface AgentSuspendExecutionResult {
  success: boolean;
  containerStopped: boolean;
  backupId?: string;
  error?: string;
  skipped?: true;
  reason?: "lifecycle_changed" | "stop_intent_superseded" | "billing_recovered";
}
