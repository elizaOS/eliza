import {
  dispatchAppEvent,
  MOBILE_RUNTIME_MODE_CHANGED_EVENT,
} from "../events";
import type { OnboardingServerTarget } from "./server-target";

export const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";

export type MobileRuntimeMode = "remote-mac" | "cloud" | "cloud-hybrid";

export function normalizeMobileRuntimeMode(
  value: string | null | undefined,
): MobileRuntimeMode | null {
  const normalized = value?.trim();
  switch (normalized) {
    case "remote-mac":
    case "cloud":
    case "cloud-hybrid":
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
