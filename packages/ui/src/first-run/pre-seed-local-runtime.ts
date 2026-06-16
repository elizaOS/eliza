/**
 * Pre-seed the AOSP ElizaOS APK when the device itself is the local agent.
 */

import { Capacitor } from "@capacitor/core";
import { isAndroidCloudBuild } from "../platform/android-runtime";
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

function isNativeAndroid(): boolean {
  try {
    if (Capacitor.getPlatform() === "android") return true;
  } catch {
    // Capacitor may not be wired up yet during early boot — fall through to
    // the UA check, which is available synchronously from the first paint.
  }
  // Capacitor's Android System WebView UA carries the "; wv)" marker, which a
  // stock Android Chrome browser does not — so this matches the native app
  // only, not the web dashboard opened in Android Chrome.
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /android/i.test(ua) && /;\s*wv\)/i.test(ua);
}

/**
 * Whether to pre-seed the on-device local agent as the active server.
 *
 * Branded ElizaOS device images carry the `ElizaOS/<tag>` UA marker. The
 * stock-phone sideload build does not, but it IS the local on-device agent
 * build (the cloud variant is `build:android:cloud`). Without seeding, that
 * sideload defaults to the cloud-connect onboarding with no "use local"
 * option, so a fresh install on a stock phone can never reach the local
 * agent. Seed local whenever this is the local Android build.
 */
function shouldPreSeedLocalRuntime(): boolean {
  if (isBrandedAndroidDevice()) return true;
  return isNativeAndroid() && !isAndroidCloudBuild();
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
