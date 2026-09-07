/** Defines the externally visible result of sandbox provisioning and restore admission. */
import { type AgentSandbox } from "../../../../db/repositories/agent-sandboxes";
import { isContainerBackedExecutionTier } from "../../sandbox-provider-types";

export type ProvisionResult =
  | {
      success: true;
      sandboxRecord: AgentSandbox;
      bridgeUrl: string;
      healthUrl: string;
    }
  | {
      success: false;
      sandboxRecord?: AgentSandbox;
      error: string;
      /**
       * Internal typed failure retained for the provisioning queue's durable
       * operator diagnostic. Callers must never serialize this field into a
       * public result; `error` remains the owner-safe boundary value.
       */
      failureCause?: unknown;
      /**
       * True when the failure is a transient, retryable condition (e.g. the
       * readiness probe could not reach the container). The provision JOB
       * should retry rather than treat this as a permanent failure that flips
       * the sandbox row to `error`. Absent/false = terminal.
       */
      retryable?: boolean;
    };

export function rejectNonContainerBackedProvision(
  rec: AgentSandbox,
): Extract<ProvisionResult, { success: false }> | undefined {
  if (isContainerBackedExecutionTier(rec.execution_tier)) {
    return undefined;
  }
  return {
    success: false,
    sandboxRecord: rec,
    error: "Sandbox provisioning requires an explicit container-backed execution tier",
  };
}
