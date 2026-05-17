import { dispatchAppEvent, MOBILE_RUNTIME_MODE_CHANGED_EVENT } from "../events";
import type { OnboardingServerTarget } from "./server-target";

export const MOBILE_RUNTIME_MODE_STORAGE_KEY = "eliza:mobile-runtime-mode";

/**
 * Constants describing the bundled mobile on-device agent endpoint.
 *
 * `MOBILE_LOCAL_AGENT_IPC_BASE` is the UI-facing identity for the bundled
 * local agent. Native transports resolve it through Capacitor instead of
 * letting WebView fetch open a socket. The loopback URL remains as the
 * Android service implementation detail used by the current native bridge
 * and simulator harness until the route kernel moves behind Binder/stdio IPC.
 */
export const MOBILE_LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337";
export const MOBILE_LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc";
export const IOS_LOCAL_AGENT_IPC_BASE = MOBILE_LOCAL_AGENT_IPC_BASE;
export const MOBILE_LOCAL_AGENT_SERVER_ID = "local:mobile";
export const MOBILE_LOCAL_AGENT_LABEL = "On-device agent";
export const MOBILE_LOCAL_AGENT_PORT = "31337";

export const ANDROID_LOCAL_AGENT_API_BASE = MOBILE_LOCAL_AGENT_API_BASE;
export const ANDROID_LOCAL_AGENT_IPC_BASE = MOBILE_LOCAL_AGENT_IPC_BASE;
export const ANDROID_LOCAL_AGENT_SERVER_ID = "local:android";
export const ANDROID_LOCAL_AGENT_LABEL = MOBILE_LOCAL_AGENT_LABEL;

const MOBILE_LOCAL_AGENT_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MOBILE_LOCAL_AGENT_IPC_PROTOCOL = "eliza-local-agent:";
const MOBILE_LOCAL_AGENT_IPC_HOST = "ipc";

export function isMobileLocalAgentIpcUrl(
  value: string | URL | null | undefined,
): boolean {
  if (!value) return false;
  const trimmed = value.toString().trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (
    lower === MOBILE_LOCAL_AGENT_IPC_BASE ||
    lower.startsWith(`${MOBILE_LOCAL_AGENT_IPC_BASE}/`) ||
    lower.startsWith(`${MOBILE_LOCAL_AGENT_IPC_BASE}?`)
  ) {
    return true;
  }

  try {
    const parsed = value instanceof URL ? value : new URL(trimmed);
    if (parsed.protocol !== MOBILE_LOCAL_AGENT_IPC_PROTOCOL) return false;
    if (parsed.hostname === MOBILE_LOCAL_AGENT_IPC_HOST) return true;

    // Chromium WebView treats non-special URL authorities as path data:
    // eliza-local-agent://ipc/api/status -> pathname "//ipc/api/status".
    const pathname = parsed.pathname || "";
    return (
      pathname === `//${MOBILE_LOCAL_AGENT_IPC_HOST}` ||
      pathname.startsWith(`//${MOBILE_LOCAL_AGENT_IPC_HOST}/`)
    );
  } catch {
    return false;
  }
}

export function mobileLocalAgentPathFromUrl(
  value: string | URL | null | undefined,
): string | null {
  if (!value) return null;
  const trimmed = value.toString().trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower === MOBILE_LOCAL_AGENT_IPC_BASE) return "/";
  if (
    lower.startsWith(`${MOBILE_LOCAL_AGENT_IPC_BASE}/`) ||
    lower.startsWith(`${MOBILE_LOCAL_AGENT_IPC_BASE}?`)
  ) {
    const suffix = trimmed.slice(MOBILE_LOCAL_AGENT_IPC_BASE.length);
    return suffix.startsWith("?") ? `/${suffix}` : suffix || "/";
  }

  let parsed: URL;
  try {
    parsed = value instanceof URL ? value : new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol === MOBILE_LOCAL_AGENT_IPC_PROTOCOL) {
    if (parsed.hostname === MOBILE_LOCAL_AGENT_IPC_HOST) {
      return `${parsed.pathname || "/"}${parsed.search}`;
    }
    const pathname = parsed.pathname || "";
    const ipcPathPrefix = `//${MOBILE_LOCAL_AGENT_IPC_HOST}`;
    if (pathname === ipcPathPrefix) {
      return parsed.search ? `/${parsed.search}` : "/";
    }
    if (pathname.startsWith(`${ipcPathPrefix}/`)) {
      return `${pathname.slice(ipcPathPrefix.length)}${parsed.search}`;
    }
    return null;
  }

  if (
    parsed.protocol === "http:" &&
    parsed.port === MOBILE_LOCAL_AGENT_PORT &&
    MOBILE_LOCAL_AGENT_HOSTS.has(parsed.hostname)
  ) {
    return `${parsed.pathname || "/"}${parsed.search}`;
  }

  return null;
}

export function isMobileLocalAgentUrl(
  value: string | URL | null | undefined,
): boolean {
  if (!value) return false;
  if (isMobileLocalAgentIpcUrl(value)) return true;

  let parsed: URL;
  try {
    parsed = value instanceof URL ? value : new URL(value.toString());
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    parsed.port === MOBILE_LOCAL_AGENT_PORT &&
    MOBILE_LOCAL_AGENT_HOSTS.has(parsed.hostname)
  );
}

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
