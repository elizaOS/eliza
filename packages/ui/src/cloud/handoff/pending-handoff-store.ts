/**
 * Persistence marker for an in-flight shared→dedicated cloud-agent handoff.
 *
 * The handoff supervisor is in-memory: a reload (or app relaunch) while the
 * dedicated container boots would otherwise strand the user on the shared
 * adapter forever — the persisted active server still points at the shared
 * bridge, the provisioning widget shows "Setting up…" with no live phase, and
 * the retry event has no listener. This marker records the deterministic
 * handoff target (the dedicated agent already created for this shared bridge)
 * so boot can RESUME the same migration instead of guessing or re-creating.
 *
 * Lifecycle: saved when the handoff starts (the dedicated target id is known),
 * cleared by `silentlyRepointToDedicated` (repointed ⇒ nothing pending) and by
 * the TTL (a marker that never resolves must not outlive the handoff story).
 */
import { runAsPrivilegedShell } from "../../surface-realm-channel";

export interface PendingCloudHandoff {
  sharedAgentId: string;
  dedicatedAgentId: string;
  /** The shared bridge base the conversation lives on. */
  sharedApiBase: string;
  cloudApiBase: string;
  /** Epoch ms when the handoff started (TTL anchor). */
  startedAt: number;
}

const STORAGE_KEY = "eliza:cloud-handoff-pending";

/** A handoff older than this is dead — the cloud reclaims its resources. */
export const PENDING_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // error-policy:J4 storage unavailable — pending handoffs simply cannot
    // persist across reloads; the in-flight flow still completes.
    return null;
  }
}

export function savePendingCloudHandoff(pending: PendingCloudHandoff): void {
  // Reserved shell key (`eliza:`) — privileged so the raw-global guard admits it
  // while a view scope is active (#13452); `storage()` keeps the SSR/no-window
  // guard. This write is intentionally not swallowed: a lost marker strands the
  // user on the shared adapter after reload.
  runAsPrivilegedShell(() =>
    storage()?.setItem(STORAGE_KEY, JSON.stringify(pending)),
  );
}

export function clearPendingCloudHandoff(): void {
  runAsPrivilegedShell(() => storage()?.removeItem(STORAGE_KEY));
}

/** Load the marker; malformed or expired entries are cleared and reported null. */
export function loadPendingCloudHandoff(
  now: number = Date.now(),
): PendingCloudHandoff | null {
  const store = storage();
  const raw = store?.getItem(STORAGE_KEY);
  if (!store || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingCloudHandoff>;
    if (
      typeof parsed.sharedAgentId !== "string" ||
      !parsed.sharedAgentId ||
      typeof parsed.dedicatedAgentId !== "string" ||
      !parsed.dedicatedAgentId ||
      typeof parsed.sharedApiBase !== "string" ||
      !parsed.sharedApiBase ||
      typeof parsed.cloudApiBase !== "string" ||
      !parsed.cloudApiBase ||
      typeof parsed.startedAt !== "number"
    ) {
      runAsPrivilegedShell(() => store.removeItem(STORAGE_KEY));
      return null;
    }
    if (now - parsed.startedAt > PENDING_HANDOFF_TTL_MS) {
      runAsPrivilegedShell(() => store.removeItem(STORAGE_KEY));
      return null;
    }
    return parsed as PendingCloudHandoff;
  } catch {
    runAsPrivilegedShell(() => store.removeItem(STORAGE_KEY));
    return null;
  }
}
