/**
 * Resumes a pending cloud handoff after a reload/redirect by rehydrating the
 * cloud auth token and shared-agent base.
 */
import { client } from "../../api";
import {
  getCloudAuthToken,
  isDirectCloudSharedAgentBase,
} from "../../api/client-cloud";
import {
  CLOUD_HANDOFF_RETRY_EVENT,
  type CloudHandoffRetryDetail,
  dispatchCloudHandoffPhase,
} from "../../events";
import { loadPersistedActiveServer } from "../../state";
import {
  clearPendingCloudHandoff,
  loadPendingCloudHandoff,
  type PendingCloudHandoff,
  savePendingCloudHandoff,
} from "./pending-handoff-store";
import { runCloudAgentHandoff } from "./run-cloud-agent-handoff";
import { silentlyRepointToDedicated } from "./silent-repoint";

let resumeAttemptedThisSession = false;
/**
 * Live AbortControllers for dead-target Retry listeners — tracked so a
 * relaunch (or a test reset) can abort any still-armed listeners instead of
 * leaking them.
 */
const deadTargetRetryListeners = new Set<AbortController>();

/** Test-only: allow a fresh resume attempt in the next call. */
export function __resetResumeForTests(): void {
  resumeAttemptedThisSession = false;
  for (const ac of deadTargetRetryListeners) ac.abort();
  deadTargetRetryListeners.clear();
}

/**
 * Verify the pending handoff's dedicated TARGET still exists before resuming.
 *
 * A resume re-runs the SAME migration against `pending.dedicatedAgentId`. If
 * that dedicated agent was deleted / errored server-side (the worker gave up,
 * an admin tombstoned it, the create half never landed), resuming is pointless:
 * the supervisor would poll a dead id until it times out, leaving the user on
 * the shared adapter with the "Setting up…" tile pinned for the marker's full
 * 24h TTL. Probing the control-plane once — the same lookup
 * `startup-phase-poll` uses to disambiguate a dead dedicated base — lets us
 * fail fast: clear the marker so the user re-enters provisioning instead of
 * waiting out a migration that can never complete.
 *
 * Returns `"gone"` ONLY on a positive absence signal (a `success:false` lookup
 * or a 404). A network blip / 5xx / missing-auth is `"unknown"` — inconclusive,
 * so we do NOT clear the marker on an unprovable assumption and let the resume
 * proceed (the supervisor's own retry/TTL still bounds it).
 */
async function dedicatedHandoffTargetState(
  dedicatedAgentId: string,
): Promise<"gone" | "live" | "unknown"> {
  if (!getCloudAuthToken(client)) return "unknown";
  try {
    const res = await client.getCloudCompatAgent(dedicatedAgentId);
    // A successful lookup always carries the agent id, so success alone proves
    // the record still exists. success:false => the control-plane has no such
    // agent (deleted).
    return res.success ? "live" : "gone";
  } catch (err) {
    // A 404 is the positive "target is gone" signal. Any other failure
    // (network blip, 5xx) is inconclusive — never strand on an unprovable
    // assumption.
    const status = (err as { status?: unknown } | null)?.status;
    return status === 404 ? "gone" : "unknown";
  }
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
 * Before re-running, it verifies the persisted dedicated TARGET still exists
 * (a control-plane probe). A dead target (deleted/errored) can never complete
 * the migration, so the marker is cleared and no resume fires — killing the
 * stranded 24h "Setting up…" state instead of polling a dead id to its TTL.
 *
 * Returns true when a resume DECISION was started (the target probe is in
 * flight and the handoff kicks off unless the target proves gone). No-ops (and
 * self-cleans the marker where it is provably stale) otherwise. At most one
 * attempt per session — the supervisor owns retries after that.
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

  // Marker hygiene: verify the dedicated TARGET still exists before resuming.
  // A dead target (deleted/errored server-side) can never complete the
  // migration, so resuming just pins the "Setting up…" tile for the marker's
  // full 24h TTL. Probe once; on a positive "gone" clear the marker and do NOT
  // resume a dead migration. Inconclusive (`unknown`) still resumes — the
  // supervisor's own retry/TTL bounds it, and we never strand on an unprovable
  // assumption. The probe is async, so the sync entry returns true (a resume
  // decision is in flight) and the kickoff is gated behind it.
  void dedicatedHandoffTargetState(pending.dedicatedAgentId).then((state) => {
    if (state === "gone") {
      clearPendingCloudHandoff();
      console.warn(
        `[resumePendingCloudHandoff] dedicated handoff target ${pending.dedicatedAgentId} is gone; clearing marker instead of resuming a dead migration`,
      );
      // Surface a first-class `failed` phase so the provisioning tile lights
      // up instead of silently persisting "Setting up…". Arm a one-shot Retry
      // listener that mints a FRESH dedicated target (the dead id is never
      // reused) so the widget's existing Retry affordance works.
      dispatchCloudHandoffPhase({
        agentId: pending.sharedAgentId,
        phase: "failed",
        error: "Dedicated agent target is no longer available.",
      });
      armFreshRetryForDeadTarget(pending, authToken);
      return;
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
  });
  return true;
}

/**
 * One-shot listener for `CLOUD_HANDOFF_RETRY_EVENT` that re-runs the handoff
 * with a FRESH dedicated create instead of the dead id from the cleared
 * marker. Bounded by an AbortController + TTL to match the runner's own retry
 * arming (so a never-clicked Retry does not leak the listener).
 */
const DEAD_TARGET_RETRY_TTL_MS = 10 * 60_000;

function armFreshRetryForDeadTarget(
  pending: PendingCloudHandoff,
  authToken: string,
): void {
  if (typeof window === "undefined") return;
  const ac = new AbortController();
  deadTargetRetryListeners.add(ac);
  const cleanup = () => {
    deadTargetRetryListeners.delete(ac);
  };
  ac.signal.addEventListener("abort", cleanup, { once: true });
  const ttl = setTimeout(() => ac.abort(), DEAD_TARGET_RETRY_TTL_MS);
  const onRetry = (event: Event) => {
    const detail = (event as CustomEvent<CloudHandoffRetryDetail>).detail;
    if (detail?.agentId !== pending.sharedAgentId) return;
    clearTimeout(ttl);
    ac.abort();
    void runFreshDedicatedHandoff(pending, authToken);
  };
  window.addEventListener(CLOUD_HANDOFF_RETRY_EVENT, onRetry, {
    signal: ac.signal,
  });
}

/**
 * Mint a FRESH dedicated agent (forceCreate) and run the handoff against it,
 * routing lifecycle through the same {@link runCloudAgentHandoff} runner so
 * the widget stays in sync. The dead id from the cleared marker is never
 * reused. Best-effort: a failure to mint surfaces as a `failed` phase with the
 * error, mirroring the original handoff's failure semantics.
 */
async function runFreshDedicatedHandoff(
  pending: PendingCloudHandoff,
  authToken: string,
): Promise<void> {
  try {
    const created = await client.createCloudCompatAgent({
      agentName: "Eliza",
      forceCreate: true,
    });
    if (!created.success || !created.data.agentId) {
      dispatchCloudHandoffPhase({
        agentId: pending.sharedAgentId,
        phase: "failed",
        error:
          created.data?.message ?? "Failed to create a fresh dedicated agent.",
      });
      return;
    }
    const dedicatedAgentId = created.data.agentId;
    savePendingCloudHandoff({
      sharedAgentId: pending.sharedAgentId,
      dedicatedAgentId,
      sharedApiBase: pending.sharedApiBase,
      cloudApiBase: pending.cloudApiBase,
      startedAt: Date.now(),
    });
    runCloudAgentHandoff(
      pending.sharedAgentId,
      () =>
        client.startCloudAgentHandoff({
          agentId: pending.sharedAgentId,
          sharedApiBase: pending.sharedApiBase,
          conversationId: pending.sharedAgentId,
          dedicatedAgentId,
          cloudApiBase: pending.cloudApiBase,
          authToken,
          onSwitch: (containerBase) => {
            silentlyRepointToDedicated({
              containerBase,
              authToken,
              dedicatedAgentId,
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
                `[runFreshDedicatedHandoff] shared bridge delete failed (leaked row ${pending.sharedAgentId}): ${res.error ?? "unknown"}`,
              );
            }
          });
      },
    );
  } catch (err) {
    dispatchCloudHandoffPhase({
      agentId: pending.sharedAgentId,
      phase: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
