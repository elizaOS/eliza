import { dispatchAppEvent, MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../events";
import type { OnboardingServerTarget } from "./server-target";

export const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";

/**
 * Constants describing the bundled mobile on-device agent endpoint. Android
 * serves this over loopback. iOS keeps the same URL shape only as a stable
 * legacy client identity; full-Bun builds resolve it through Capacitor/native
 * IPC, and compatibility builds resolve it through the in-process ITTP kernel.
 */
export const MOBILE_LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337";
export const IOS_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";
export const MOBILE_LOCAL_AGENT_SERVER_ID = "local:mobile";
export const MOBILE_LOCAL_AGENT_LABEL = "On-device agent";

export const ANDROID_LOCAL_AGENT_API_BASE = MOBILE_LOCAL_AGENT_API_BASE;
export const ANDROID_LOCAL_AGENT_SERVER_ID = "local:android";
export const ANDROID_LOCAL_AGENT_LABEL = MOBILE_LOCAL_AGENT_LABEL;

export type MobileRuntimeMode =
  | "remote-mac"
  | "cloud"
  | "cloud-hybrid"
  | "local"
  | "tunnel-to-mobile";

export function normalizeMobileRuntimeMode(
  value: string | null | undefined,
): MobileRuntimeMode | null {
  const normalized = value?.trim();
  switch (normalized) {
    case "remote-mac":
    case "cloud":
    case "cloud-hybrid":
    case "local":
    case "tunnel-to-mobile":
      return normalized;
    default:
      return null;
  }
}

export function mobileRuntimeModeForServerTarget(
  target: OnboardingServerTarget,
): MobileRuntimeMode | null {
  switch (target) {
    case "remote":
      return "remote-mac";
    case "elizacloud":
      return "cloud";
    case "elizacloud-hybrid":
      return "cloud-hybrid";
    case "local":
      return "local";
    default:
      return null;
  }
}

export function readPersistedMobileRuntimeMode(): MobileRuntimeMode | null {
  if (typeof window === "undefined") return null;
  try {
    return normalizeMobileRuntimeMode(
      window.localStorage.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

export function isElizaCloudRuntimeLocked(): boolean {
  const mode = readPersistedMobileRuntimeMode();
  return mode === "cloud" || mode === "cloud-hybrid";
}

async function persistNativeMobileRuntimeMode(
  mode: MobileRuntimeMode | null,
): Promise<void> {
  try {
    const [{ Capacitor }, { Preferences }] = await Promise.all([
      import("@capacitor/core"),
      import("@capacitor/preferences"),
    ]);
    if (!Capacitor.isNativePlatform()) return;
    if (mode) {
      await Preferences.set({
        key: MOBILE_RUNTIME_MODE_STORAGE_KEY,
        value: mode,
      });
    } else {
      await Preferences.remove({ key: MOBILE_RUNTIME_MODE_STORAGE_KEY });
    }
  } catch {
    // Capacitor Preferences is unavailable in web/unit-test shells.
  }
}

export function persistMobileRuntimeModeForServerTarget(
  target: OnboardingServerTarget,
): void {
  const mode = mobileRuntimeModeForServerTarget(target);

  if (typeof window !== "undefined") {
    try {
      if (mode) {
        window.localStorage.setItem(MOBILE_RUNTIME_MODE_STORAGE_KEY, mode);
      } else {
        window.localStorage.removeItem(MOBILE_RUNTIME_MODE_STORAGE_KEY);
      }
    } catch {
      // localStorage can be unavailable in embedded shells.
    }
  }

  void persistNativeMobileRuntimeMode(mode);

  if (typeof document !== "undefined") {
    dispatchAppEvent(MOBILE_RUNTIME_MODE_CHANGED_EVENT, { mode });
  }
}
