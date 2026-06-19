/**
 * Pre-seed the AOSP ElizaOS APK when the device itself is the local agent.
 */

import { isAospElizaUserAgent } from "../platform/aosp-user-agent";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeModeForServerTarget,
  readPersistedMobileRuntimeMode,
} from "./mobile-runtime-mode";

export { isAospElizaUserAgent } from "../platform/aosp-user-agent";

// Mirror of `ACTIVE_SERVER_STORAGE_KEY` in `state/persistence.ts`. Split
// here so this file stays a leaf module — `state/persistence.ts` pulls in
// the entire UI state graph and would create a cycle through
// `bridge/storage-bridge`.
const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

function hasPersistedActiveServer(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { id?: unknown } | null;
    return (
      parsed != null &&
      typeof parsed === "object" &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0
    );
  } catch {
    return false;
  }
}

function writeLocalAgentActiveServer(): void {
  if (typeof window === "undefined") return;
  const payload = {
    id: ANDROID_LOCAL_AGENT_SERVER_ID,
    kind: "remote" as const,
    label: ANDROID_LOCAL_AGENT_LABEL,
    apiBase: ANDROID_LOCAL_AGENT_IPC_BASE,
  };
  try {
    window.localStorage.setItem(
      ACTIVE_SERVER_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // localStorage can be unavailable in embedded shells.
  }
}

function isBrandedAndroidDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return isAospElizaUserAgent(navigator.userAgent);
}

/**
 * Whether to pre-seed the on-device local agent as the active server.
 *
 * Branded ElizaOS device images (carrying the `ElizaOS/<tag>` UA marker) are
 * dedicated local-agent hardware, so they auto-seed local.
 *
 * Stock-phone sideloads do NOT auto-seed: the first-run 3-way chooser
 * (CompactOnboarding's "Local models" card) now offers local explicitly, so
 * auto-seeding only did harm — it skipped the chooser, auto-started the slow
 * on-device agent foreground service (triggering the POST_NOTIFICATIONS prompt
 * at launch), and left the dashboard stuck "connecting to backend" while that
 * agent booted. Letting the chooser render instead is faster, prompts nothing
 * on launch, and still reaches local in one tap.
 */
function shouldPreSeedLocalRuntime(): boolean {
  return isBrandedAndroidDevice();
}

export function preSeedAndroidLocalRuntimeIfFresh(): boolean {
  if (!shouldPreSeedLocalRuntime()) return false;
  // Respect an explicit cloud/remote choice, but treat null or "local" as
  // seedable: a stock-phone sideload may carry a "local" mode with no active
  // server yet (so the dashboard would otherwise fall back to cloud-connect).
  const persistedMode = readPersistedMobileRuntimeMode();
  if (persistedMode != null && persistedMode !== "local") return false;
  if (hasPersistedActiveServer()) return false;

  persistMobileRuntimeModeForServerTarget("local");
  writeLocalAgentActiveServer();
  return true;
}
