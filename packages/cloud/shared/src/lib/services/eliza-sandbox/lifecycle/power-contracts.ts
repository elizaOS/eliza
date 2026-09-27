/** Describes suspend completion and backup authority without conflating a deferred capture with a stopped container. */

export interface AgentSuspendExecutionResult {
  success: boolean;
  containerStopped: boolean;
  backupId?: string;
  /** The unpaid runtime stopped in place because no current backup existed (#30746). */
  retained?: true;
  error?: string;
  skipped?: true;
  reason?: "lifecycle_changed" | "stop_intent_superseded" | "billing_recovered";
}
