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
import { getAgentPlugin } from "../bridge/native-plugins";
import { isAndroid, isIOS } from "../platform/init";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
} from "../state/persistence";
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
