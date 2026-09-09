/**
 * Reconciles a persisted handoff at boot without restarting its paid operations.
 * A reload marker identifies recovery work, not current quote-bound consent.
 * Matching markers surface an explicit price-review path; runtime state and
 * resources remain untouched until the user confirms in Cloud management.
 */
import { isDirectCloudSharedAgentBase } from "../../api/client-cloud";
import { dispatchCloudHandoffPhase } from "../../events";
import { loadPersistedActiveServer } from "../../state/persistence";
import {
  clearPendingCloudHandoff,
  loadPendingCloudHandoff,
} from "./pending-handoff-store";

let recoveryShownForAgent: string | null = null;

/** Test-only: simulate a new renderer session. */
export function __resetResumeForTests(): void {
  recoveryShownForAgent = null;
}

/**
 * Surface recovery for the current Shared agent without any network dispatch.
 * Returns true when a confirmation-required state was published. This does not
 * mean activation resumed. Mismatched local markers are retired, never resources.
 */
export function resumePendingCloudHandoff(): boolean {
  const pending = loadPendingCloudHandoff();
  if (!pending) return false;
  const active = loadPersistedActiveServer();
  const activeAgentId = active?.id.startsWith("cloud:")
    ? active.id.slice("cloud:".length)
    : active?.id;
  if (
    active?.kind !== "cloud" ||
    activeAgentId !== pending.sharedAgentId ||
    !isDirectCloudSharedAgentBase(active.apiBase)
  ) {
    clearPendingCloudHandoff();
    return false;
  }
  if (recoveryShownForAgent === pending.sharedAgentId) return false;
  recoveryShownForAgent = pending.sharedAgentId;
  dispatchCloudHandoffPhase({
    agentId: pending.sharedAgentId,
    phase: "confirmation-required",
  });
  return true;
}
