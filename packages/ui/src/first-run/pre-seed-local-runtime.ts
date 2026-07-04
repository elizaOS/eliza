/**
 * Pre-seed the AOSP ElizaOS APK when the device itself is the local agent.
 */

import { isAndroidCloudBuild } from "../platform/android-runtime";
import { isAospElizaUserAgent } from "../platform/aosp-user-agent";
import { getFrontendPlatform } from "../platform/platform-guards";
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
    // error-policy:J3 corrupt persisted server blob — treat as "none" so the
    // pre-seed can write a fresh one
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
    // error-policy:J6 storage blocked (embedded shells) — the pre-seed is an
    // optimization; first-run still resolves the server interactively
  }
}

function isBrandedAndroidDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return isAospElizaUserAgent(navigator.userAgent);
}

/**
 * The stock-phone local sideload build (`android` / `android-system`, renderer
 * mode `local`) ships the on-device agent — that IS its backend. The
 * `android-cloud` Play-Store build is a thin cloud client with no on-device
 * agent, so it must never seed local. iOS/desktop/web are not android and
 * resolve to a non-cloud mode by default, so gate on the native platform too.
 */
function isAndroidLocalSideloadBuild(): boolean {
  return getFrontendPlatform() === "android" && !isAndroidCloudBuild();
}

/**
 * Whether to pre-seed the on-device local agent as the active server.
 *
 * Fires for branded ElizaOS device images AND the stock-phone local sideload
 * build (the on-device-agent APK). Both run the on-device agent as their
 * backend, so a fresh launch should default to it instead of falling back to
 * cloud-connect. Gating only on the branded `ElizaOS/<tag>` UA marker (as
 * before) excluded the stock sideload and left it stuck on cloud onboarding —
 * which is exactly the bug the caller in `main.tsx` documents. The explicit
 * cloud/remote-choice and existing-active-server guards in
 * `preSeedAndroidLocalRuntimeIfFresh` still respect a user who picked cloud.
 */
function shouldPreSeedLocalRuntime(): boolean {
  return isBrandedAndroidDevice() || isAndroidLocalSideloadBuild();
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
