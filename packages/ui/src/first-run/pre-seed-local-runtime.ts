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

export function preSeedAndroidLocalRuntimeIfFresh(): boolean {
  if (!isBrandedAndroidDevice()) return false;
  if (readPersistedMobileRuntimeMode() != null) return false;
  if (hasPersistedActiveServer()) return false;

  persistMobileRuntimeModeForServerTarget("local");
  writeLocalAgentActiveServer();
  return true;
}
