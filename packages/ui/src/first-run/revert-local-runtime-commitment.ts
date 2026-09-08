/**
 * Reversal cleanup for an un-finished local-runtime choice (#14390): when the
 * user backs out of "On this device" mid-onboarding (the back affordance, the
 * error-recovery "choose a different way to run", or a direct cloud/remote
 * re-pick), nothing the local path committed may survive — the persisted
 * `eliza:mobile-runtime-mode`, the local active-server record, and the mobile
 * agent service itself must all be unwound, or the next boot auto-starts an
 * agent the user chose against.
 *
 * `finishLocal` persists the runtime mode BEFORE it starts the service, so a
 * cleared runtime mode is the reliable signal that the service may have been
 * started; the stop bridge call is only attempted then (and is a no-op when
 * the service never came up). Desktop is deliberately untouched beyond the
 * persisted records: the embedded desktop agent is owned by the shell
 * lifecycle, not by onboarding.
 */

import { logger } from "@elizaos/logger";
import type { DesktopStorageAuthority } from "../bridge/desktop-secure-store-transaction";
import { getAgentPlugin } from "../bridge/native-plugins";
import { removeStorageValue } from "../bridge/storage-bridge";
import { isAndroid, isIOS } from "../platform/init";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
} from "../state/persistence";
import { getBuildConfiguredRemoteApiBaseUrl } from "../state/runtime-url-trust";
import {
  ANDROID_LOCAL_AGENT_SERVER_ID,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeMode,
  readPersistedMobileRuntimeMode,
} from "./mobile-runtime-mode";

const LOCAL_AGENT_SERVER_IDS = new Set<string>([
  ANDROID_LOCAL_AGENT_SERVER_ID,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  "local:desktop",
  "local:app-shell",
]);

export interface ClearedLocalRuntimeCommitment {
  clearedRuntimeMode: boolean;
  clearedActiveServer: boolean;
}

/**
 * Clear the persisted local-runtime records (runtime mode + local active
 * server) if present. Synchronous so the boot-time RAM-policy enforcement
 * (`device-ram-gate.ts`) can run it before startup resolves its target.
 * "cloud-hybrid" is a local-agent commitment too (local runtime with cloud
 * inference); "cloud"/"remote" modes and non-local servers are never touched.
 */
export function clearPersistedLocalRuntimeCommitment(): ClearedLocalRuntimeCommitment {
  const mode = readPersistedMobileRuntimeMode();
  const clearedRuntimeMode = mode === "local" || mode === "cloud-hybrid";
  if (clearedRuntimeMode) {
    persistMobileRuntimeMode(null);
  }

  const active = loadPersistedActiveServer();
  const clearedActiveServer =
    active != null &&
    (active.kind === "local" || LOCAL_AGENT_SERVER_IDS.has(active.id));
  if (clearedActiveServer) {
    clearPersistedActiveServer();
  }

  return { clearedRuntimeMode, clearedActiveServer };
}

/**
 * Full reversal: clear the persisted commitment and, on mobile, stop the
 * on-device agent service that a partially-completed local finish may have
 * started. Never throws — reversal runs on the user's way OUT of the local
 * path, and a failed stop must not block them from picking cloud.
 */
export async function revertLocalRuntimeCommitment(): Promise<ClearedLocalRuntimeCommitment> {
  const cleared = clearPersistedLocalRuntimeCommitment();
  if ((isAndroid || isIOS) && cleared.clearedRuntimeMode) {
    try {
      await getAgentPlugin().stop?.();
    } catch (err) {
      // error-policy:J6 best-effort teardown — the service may simply never
      // have started (the finish failed before the start), and the boot gate
      // no longer auto-starts it once the mode is cleared above.
      logger.warn(
        { err },
        "[revertLocalRuntimeCommitment] on-device agent stop bridge call failed",
      );
    }
  }
  if (cleared.clearedRuntimeMode || cleared.clearedActiveServer) {
    logger.info(
      { ...cleared },
      "[revertLocalRuntimeCommitment] reverted un-finished local runtime commitment",
    );
  }
  return cleared;
}

/** Finish an explicitly requested Local → Cloud cleanup before capturing the next runtime target. */
export async function revertLocalRuntimeCommitmentBeforeCloud(options: {
  revalidate: () => void;
  nativeAuthority?: DesktopStorageAuthority;
  acceptClearedServer: () => void;
}): Promise<void> {
  options.revalidate();
  if (getBuildConfiguredRemoteApiBaseUrl()) {
    throw new Error(
      "Cloud setup is unavailable in this build-pinned remote runtime",
    );
  }
  const mode = readPersistedMobileRuntimeMode();
  const revalidate = () => {
    options.revalidate();
    if (readPersistedMobileRuntimeMode() !== mode)
      throw new Error("Local runtime choice changed during cleanup");
  };
  const active = loadPersistedActiveServer();
  if (
    active &&
    (active.kind === "local" || LOCAL_AGENT_SERVER_IDS.has(active.id))
  ) {
    await removeStorageValue("elizaos:active-server", {
      revalidate,
      nativeAuthority: options.nativeAuthority,
    });
    // Advance only the exact deletion this guarded transaction acknowledged.
    // A newer selected server must fail the caller's expected-null check.
    options.acceptClearedServer();
  }
  revalidate();
  if (mode !== "local" && mode !== "cloud-hybrid") return;
  if (isAndroid || isIOS) {
    // A rejected stop is a visible setup failure, not permission to join Cloud
    // while an abandoned local service may still be running.
    const agent = getAgentPlugin();
    if (!agent.stop)
      throw new Error("The local agent stop bridge is unavailable");
    const stopped = await agent.stop();
    revalidate();
    if (
      !stopped ||
      typeof stopped !== "object" ||
      !("ok" in stopped) ||
      stopped.ok !== true
    ) {
      throw new Error("The local agent did not acknowledge stopping");
    }
  }
  persistMobileRuntimeMode(null);
}
