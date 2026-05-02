import { dispatchAppEvent, MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../events";
import type { OnboardingServerTarget } from "./server-target";

export const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";

/**
 * Constants describing the bundled Android on-device agent endpoint. The
 * MiladyOS variant pre-seeds these as the persisted active server at app
 * boot; the vanilla Android APK uses them only when the user explicitly
 * picks Local in `RuntimeGate`.
 */
export const ANDROID_LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337";
export const ANDROID_LOCAL_AGENT_SERVER_ID = "local:android";
export const ANDROID_LOCAL_AGENT_LABEL = "On-device agent";

export type MobileRuntimeMode =
  | "remote-mac"
  | "cloud"
  | "cloud-hybrid"
  | "local";

export function normalizeMobileRuntimeMode(
  value: string | null | undefined,
): MobileRuntimeMode | null {
  const normalized = value?.trim();
  switch (normalized) {
    case "remote-mac":
    case "cloud":
    case "cloud-hybrid":
    case "local":
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

  if (typeof document !== "undefined") {
    dispatchAppEvent(MOBILE_RUNTIME_MODE_CHANGED_EVENT, { mode });
  }
}
