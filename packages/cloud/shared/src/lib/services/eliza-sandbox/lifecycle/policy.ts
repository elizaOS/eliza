/** Defines sandbox lifecycle admission and replacement sweep policy shared by the authority and operation owners. */
import { type AgentSandbox } from "../../../../db/repositories/agent-sandboxes";
import { isContainerBackedExecutionTier } from "../../sandbox-provider-types";

export type ContainerBackedServiceAction =
  | "shutdown"
  | "suspend"
  | "sleep"
  | "wake"
  | "resume"
  | "restart"
  | "upgrade"
  | "downgrade"
  | "logs"
  | "replacement"
  | "credential"
  | "character push";

/** Canonical fail-closed error for direct container-service re-entry. */
export function containerBackedServiceRejection(
  rec: Pick<AgentSandbox, "execution_tier">,
  action: ContainerBackedServiceAction,
): string | undefined {
  return isContainerBackedExecutionTier(rec.execution_tier)
    ? undefined
    : `Agent ${action} requires a container-backed execution tier`;
}

// A timed-out lifecycle awaiter does not cancel its underlying work. Keep a
// pre-cutover replacement out of the crash-recovery sweep long enough for the
// 15-minute cold-boot job ceiling and any bounded leaf cleanup to settle.
export const PRE_CUTOVER_REPLACEMENT_SWEEP_GRACE_MINUTES = 30;
