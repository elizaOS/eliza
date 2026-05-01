import { dispatchAppEvent, MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../events";
import {
  loadPersistedActiveServer,
  savePersistedActiveServer,
} from "../state/persistence";
import type { OnboardingServerTarget } from "./server-target";

export const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";

/**
 * The Android APK runs a bundled foreground-service agent on loopback. The
 * RuntimeGate "Choose your setup" picker is desktop/dev-only — Android users
 * land on the local on-device agent unconditionally and can switch later from
 * Settings ▸ Runtime. Used by the pre-seed at app boot.
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

/**
 * On the Android APK the RuntimeGate "Choose your setup" picker is bypassed
 * by default — the only first-run path is the bundled on-device agent. This
 * helper pre-seeds the persisted runtime mode + active server so that, by the
 * time `StartupShell` evaluates whether to render `RuntimeGate`, the answer
 * is "no, the user has already chosen local".
 *
 * No-op when:
 *   - a persisted mode already exists (the user — or a previous boot — has
 *     made a deliberate choice; don't clobber it),
 *   - a persisted active server already exists (a remote/cloud target was
 *     wired up by some other path: deep link, Settings, prior session).
 *
 * Returns `true` when the pre-seed actually wrote anything, `false`
 * otherwise. The boolean is mainly for tests; callers can ignore it.
 *
 * Eliza Cloud and Remote remain reachable from Settings ▸ Runtime; that
 * surface is responsible for clearing both the persisted mode and the
 * persisted active server before re-opening the picker via the explicit
 * `?runtime=picker` override.
 */
export function preSeedAndroidLocalRuntimeIfFresh(): boolean {
  if (readPersistedMobileRuntimeMode() != null) return false;
  if (loadPersistedActiveServer() != null) return false;

  persistMobileRuntimeModeForServerTarget("local");
  savePersistedActiveServer({
    id: ANDROID_LOCAL_AGENT_SERVER_ID,
    kind: "remote",
    label: ANDROID_LOCAL_AGENT_LABEL,
    apiBase: ANDROID_LOCAL_AGENT_API_BASE,
  });
  return true;
}
