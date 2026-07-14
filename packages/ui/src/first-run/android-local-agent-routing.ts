/**
 * Resolves whether Android traffic targets the bundled agent or a forwarded
 * remote host. IPC is unambiguous, while legacy loopback HTTP needs runtime
 * mode and cloud-session precedence before native routing is safe.
 */
import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";
import {
  isMobileLocalAgentIpcUrl,
  isMobileLocalAgentUrl,
  MOBILE_RUNTIME_MODE_STORAGE_KEY,
} from "./mobile-runtime-mode";

type RuntimeModeValue = string | boolean | null | undefined;

export interface AndroidLocalAgentRuntimeModeInputs {
  persistedMode?: RuntimeModeValue;
  hasCloudSession: boolean;
  androidBuildMode?: RuntimeModeValue;
  mobileBuildMode?: RuntimeModeValue;
}

function normalizedMode(value: RuntimeModeValue): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

/** Resolve persisted, cloud-session, and build defaults in precedence order. */
export function resolveAndroidLocalAgentRuntimeMode(
  inputs: AndroidLocalAgentRuntimeModeInputs,
): string | null {
  const persistedMode = normalizedMode(inputs.persistedMode);
  if (persistedMode) return persistedMode;
  if (inputs.hasCloudSession) return "cloud";
  return (
    normalizedMode(inputs.androidBuildMode) ??
    normalizedMode(inputs.mobileBuildMode)
  );
}

/** Report whether a durable Steward cloud session is present. */
export function hasStoredAndroidCloudSession(): boolean {
  try {
    return Boolean(readStoredStewardToken()?.trim());
  } catch {
    // error-policy:J4 token storage is a capability probe here; a failed read
    // leaves explicit runtime-mode selection available.
    return false;
  }
}

/** Read the effective mode used by both native routing and token hydration. */
export function readAndroidLocalAgentRuntimeMode(): string | null {
  let persistedMode: string | null = null;
  try {
    const storage =
      globalThis.localStorage ??
      (typeof window !== "undefined" ? window.localStorage : undefined);
    persistedMode = storage?.getItem(MOBILE_RUNTIME_MODE_STORAGE_KEY) ?? null;
  } catch {
    // error-policy:J4 localStorage can be unavailable in tests and early
    // native startup; build configuration remains the explicit fallback.
    persistedMode = null;
  }

  const metaEnv = (
    import.meta as ImportMeta & {
      env?: Record<string, RuntimeModeValue>;
    }
  ).env;
  const processEnv = typeof process !== "undefined" ? process.env : undefined;

  return resolveAndroidLocalAgentRuntimeMode({
    persistedMode,
    hasCloudSession: hasStoredAndroidCloudSession(),
    androidBuildMode:
      metaEnv?.VITE_ELIZA_ANDROID_RUNTIME_MODE ??
      processEnv?.VITE_ELIZA_ANDROID_RUNTIME_MODE,
    mobileBuildMode:
      metaEnv?.VITE_ELIZA_MOBILE_RUNTIME_MODE ??
      processEnv?.VITE_ELIZA_MOBILE_RUNTIME_MODE,
  });
}

/**
 * Decide whether an Android request must use the bundled agent bridge.
 *
 * The IPC identity is unambiguous. The legacy loopback HTTP identity is also
 * used by adb/SSH forwarding, so the selected runtime mode must disambiguate
 * it before native routing or private-token hydration occurs.
 */
export function shouldRouteAndroidRequestToLocalAgent(
  value: string,
  mode: string | null = readAndroidLocalAgentRuntimeMode(),
): boolean {
  if (isMobileLocalAgentIpcUrl(value)) return true;
  return mode === "local" && isMobileLocalAgentUrl(value);
}
