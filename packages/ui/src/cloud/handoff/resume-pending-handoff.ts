/**
 * Resumes a pending cloud handoff after a reload/redirect by rehydrating the
 * cloud auth token and shared-agent base.
 */
import { client } from "../../api";
import {
  getCloudAuthToken,
  isDirectCloudSharedAgentBase,
} from "../../api/client-cloud";
import { loadPersistedActiveServer } from "../../state";
import {
  clearPendingCloudHandoff,
  loadPendingCloudHandoff,
} from "./pending-handoff-store";
import { runCloudAgentHandoff } from "./run-cloud-agent-handoff";
import { silentlyRepointToDedicated } from "./silent-repoint";

let resumeAttemptedThisSession = false;

/** Test-only: allow a fresh resume attempt in the next call. */
export function __resetResumeForTests(): void {
  resumeAttemptedThisSession = false;
}

/**
 * Resume an interrupted shared→dedicated handoff after a reload/relaunch.
 *
 * The supervisor is in-memory, so a reload during the 60–90s container boot
 * used to strand the user on the shared adapter permanently. Boot calls this
 * when it lands on a shared-bridge base: if a pending-handoff marker matches
 * the active shared agent, the SAME migration (same dedicated target — nothing
 * is created here) is re-run through {@link runCloudAgentHandoff}, giving back
 * the lifecycle events, the retry arming, and the gated shared-bridge delete.
 *
 * Returns true when a resume was started. No-ops (and self-cleans the marker
 * where it is provably stale) otherwise. At most one attempt per session — the
 * supervisor owns retries after that.
 */
export function resumePendingCloudHandoff(): boolean {
  if (resumeAttemptedThisSession) return false;
  resumeAttemptedThisSession = true;

  const pending = loadPendingCloudHandoff();
  if (!pending) return false;

  const active = loadPersistedActiveServer();
  if (active?.kind !== "cloud" || !active.apiBase) {
    // Not on a cloud runtime anymore (user switched / reset) — marker is stale.
    clearPendingCloudHandoff();
    return false;
  }
  const activeAgentId = active.id.startsWith("cloud:")
    ? active.id.slice("cloud:".length)
    : active.id;
  if (
    activeAgentId !== pending.sharedAgentId ||
    !isDirectCloudSharedAgentBase(active.apiBase)
  ) {
    // Already off the shared bridge (repoint landed) or on a different agent.
    clearPendingCloudHandoff();
    return false;
  }

  const authToken = getCloudAuthToken(client) ?? active.accessToken ?? "";
  if (!authToken) {
    // Cloud auth not restored yet — keep the marker; a later boot retries.
    resumeAttemptedThisSession = false;
    return false;
  }

  runCloudAgentHandoff(
    pending.sharedAgentId,
    () =>
      client.startCloudAgentHandoff({
        agentId: pending.sharedAgentId,
        sharedApiBase: pending.sharedApiBase,
        conversationId: pending.sharedAgentId,
        dedicatedAgentId: pending.dedicatedAgentId,
        cloudApiBase: pending.cloudApiBase,
        authToken,
        onSwitch: (containerBase) => {
          silentlyRepointToDedicated({
            containerBase,
            authToken,
            dedicatedAgentId: pending.dedicatedAgentId,
          });
        },
      }),
    () => {
      void client
        .deleteSharedBridgeAgent(pending.sharedAgentId, {
          cloudApiBase: pending.cloudApiBase,
          authToken,
        })
        .then((res) => {
          if (!res.success) {
            console.warn(
              `[resumePendingCloudHandoff] shared bridge delete failed (leaked row ${pending.sharedAgentId}): ${res.error ?? "unknown"}`,
            );
          }
        });
    },
  );
  return true;
}
