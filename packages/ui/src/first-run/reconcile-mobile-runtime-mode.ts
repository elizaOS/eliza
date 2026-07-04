/**
 * Boot-time reconciliation between the persisted `eliza:mobile-runtime-mode`
 * and the runtime truth stamped into this build (issue #11030).
 *
 * The persisted mode survives reinstalls (it is mirrored into Capacitor
 * Preferences), so a device that once ran a cloud build can carry a stale
 * `"cloud"` mode into a later LOCAL sideload build. That stale mode gates the
 * native local-agent transports ("iOS cloud builds cannot use local-agent IPC
 * unless local runtime mode is active") while the build ships no cloud
 * endpoint at all — every startup probe fails and the renderer hangs on the
 * "Booting up…" splash even though the on-device agent is running.
 *
 * Reconciliation adopts the build's native mode ONLY when the persisted mode
 * is provably unusable in this build ({@link planMobileRuntimeModeReconcile}
 * is the explicit predicate). A persisted mode the user actively chose against
 * a still-valid target — e.g. cloud mode backed by a live cloud session on a
 * local-capable build — is never clobbered.
 *
 * Build truth comes from the EXISTING accessors, not a second query path:
 * `resolveIosRuntimeConfig` (platform/ios-runtime.ts) and
 * `resolveAndroidRuntimeMode` (platform/android-runtime.ts) read the
 * `VITE_ELIZA_{IOS,ANDROID,MOBILE}_RUNTIME_MODE` / `..._API_BASE` values the
 * mobile build lanes stamp into the renderer bundle
 * (packages/app-core/scripts/run-mobile-build.mjs).
 */

import { logger } from "@elizaos/logger";
import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";
import { resolveAndroidRuntimeMode } from "../platform/android-runtime";
import { resolveIosRuntimeConfig } from "../platform/ios-runtime";
import { loadPersistedActiveServer } from "../state/persistence";
import {
  type MobileRuntimeMode,
  persistMobileRuntimeMode,
  readPersistedMobileRuntimeMode,
} from "./mobile-runtime-mode";

type RuntimeEnvRecord = Record<string, string | boolean | undefined>;

export type MobileNativePlatform = "ios" | "android";

/** What this build can actually serve, derived from build-stamped config. */
export interface MobileRuntimeBuildTruth {
  platform: MobileNativePlatform;
  /** Runtime mode stamped into the renderer bundle at build time. */
  buildMode: MobileRuntimeMode;
  /** Whether the build stamps a concrete remote/cloud Agent apiBase. */
  hasBuildApiBase: boolean;
  /** Whether this build can host the on-device agent at all. */
  hasLocalEngine: boolean;
}

export type MobileRuntimeModeReconcilePlan =
  | { action: "keep" }
  | {
      action: "adopt-build-mode";
      from: MobileRuntimeMode;
      to: MobileRuntimeMode;
      reason:
        | "persisted-cloud-mode-has-no-endpoint-in-local-build"
        | "persisted-local-mode-has-no-engine-in-this-build";
    };

/**
 * The unusability predicate — the heart of the reconciliation.
 *
 * - Persisted `cloud`/`cloud-hybrid` is UNUSABLE only when the build declares
 *   an on-device runtime (`buildMode === "local"`) AND stamps no cloud/remote
 *   apiBase AND no cloud session exists on the device. With any of those, the
 *   cloud mode still has somewhere to talk to and is treated as a valid user
 *   choice.
 * - Persisted `local` is UNUSABLE only when this build physically cannot host
 *   the on-device agent (e.g. an iOS store/cloud bundle without the full-Bun
 *   engine, or the Play-Store `android-cloud` APK).
 * - `remote-mac` / `tunnel-to-mobile` target user-configured EXTERNAL
 *   endpoints the build truth cannot invalidate — never reconciled here.
 */
export function planMobileRuntimeModeReconcile(args: {
  persistedMode: MobileRuntimeMode | null;
  build: Pick<
    MobileRuntimeBuildTruth,
    "buildMode" | "hasBuildApiBase" | "hasLocalEngine"
  >;
  hasUsableCloudSession: boolean;
}): MobileRuntimeModeReconcilePlan {
  const { persistedMode, build, hasUsableCloudSession } = args;
  if (!persistedMode || persistedMode === build.buildMode) {
    return { action: "keep" };
  }

  if (persistedMode === "cloud" || persistedMode === "cloud-hybrid") {
    if (
      build.buildMode === "local" &&
      !build.hasBuildApiBase &&
      !hasUsableCloudSession
    ) {
      return {
        action: "adopt-build-mode",
        from: persistedMode,
        to: "local",
        reason: "persisted-cloud-mode-has-no-endpoint-in-local-build",
      };
    }
    return { action: "keep" };
  }

  if (persistedMode === "local" && !build.hasLocalEngine) {
    return {
      action: "adopt-build-mode",
      from: persistedMode,
      to: build.buildMode,
      reason: "persisted-local-mode-has-no-engine-in-this-build",
    };
  }

  return { action: "keep" };
}

function viteEnv(): RuntimeEnvRecord {
  const metaEnv =
    (import.meta as ImportMeta & { env?: RuntimeEnvRecord }).env ?? {};
  const processEnv =
    typeof process === "undefined" ? {} : (process.env as RuntimeEnvRecord);
  return { ...processEnv, ...metaEnv };
}

function isDevBuildEnv(env: RuntimeEnvRecord): boolean {
  return (
    env.DEV === true ||
    String(env.MODE ?? "")
      .trim()
      .toLowerCase() === "development"
  );
}

/**
 * Read the build's native runtime truth via the existing per-platform
 * accessors. `resolveIosRuntimeConfig` reads the full
 * `VITE_ELIZA_{IOS,MOBILE,ANDROID}_*` key set, so its `apiBase` is the
 * build-stamped endpoint for either platform; Android's mode has its own
 * dedicated accessor.
 */
export function readMobileRuntimeBuildTruth(
  platform: MobileNativePlatform,
  env: RuntimeEnvRecord = viteEnv(),
): MobileRuntimeBuildTruth {
  const iosConfig = resolveIosRuntimeConfig(env);
  if (platform === "android") {
    const buildMode = resolveAndroidRuntimeMode(env);
    return {
      platform,
      buildMode,
      hasBuildApiBase: Boolean(iosConfig.apiBase),
      // The sideload/system APKs bundle the on-device agent runtime; the
      // Play-Store `android-cloud` APK ships without it (see
      // platform/android-runtime.ts).
      hasLocalEngine: buildMode === "local",
    };
  }
  return {
    platform,
    buildMode: iosConfig.mode,
    hasBuildApiBase: Boolean(iosConfig.apiBase),
    // Local builds run the in-process route kernel, full-Bun builds embed the
    // engine, and dev builds retain the JSContext compatibility transport
    // (see api/ios-local-agent-transport.ts).
    hasLocalEngine:
      iosConfig.mode === "local" || iosConfig.fullBun || isDevBuildEnv(env),
  };
}

function capacitorNativePlatform(): MobileNativePlatform | null {
  try {
    const cap = (globalThis as Record<string, unknown>).Capacitor as
      | { isNativePlatform?: () => boolean; getPlatform?: () => string }
      | undefined;
    if (!cap?.isNativePlatform?.()) return null;
    const platform = cap.getPlatform?.();
    return platform === "ios" || platform === "android" ? platform : null;
  } catch {
    return null;
  }
}

/**
 * A cloud runtime mode is still serviceable without a build-stamped apiBase
 * when the device holds a live Steward session or a persisted cloud
 * active-server record — either lets startup resolve a cloud agent.
 */
function hasUsableCloudSession(): boolean {
  if (readStoredStewardToken()?.trim()) return true;
  const active = loadPersistedActiveServer();
  return active?.kind === "cloud";
}

export interface AppliedMobileRuntimeModeReconcile {
  from: MobileRuntimeMode;
  to: MobileRuntimeMode;
}

/**
 * Reconcile the persisted mobile runtime mode against this build's native
 * truth. Runs at boot, before startup target resolution reads the persisted
 * mode. No-op on web/desktop (the key only governs native transports) and
 * whenever the persisted mode is still usable in this build.
 *
 * Returns the applied correction, or `null` when nothing changed.
 */
export function reconcilePersistedMobileRuntimeModeAtBoot(options?: {
  env?: RuntimeEnvRecord;
}): AppliedMobileRuntimeModeReconcile | null {
  const platform = capacitorNativePlatform();
  if (!platform) return null;

  const persistedMode = readPersistedMobileRuntimeMode();
  const build = readMobileRuntimeBuildTruth(platform, options?.env);
  const plan = planMobileRuntimeModeReconcile({
    persistedMode,
    build,
    hasUsableCloudSession: hasUsableCloudSession(),
  });
  if (plan.action !== "adopt-build-mode") return null;

  logger.warn(
    {
      persistedMode: plan.from,
      adoptedMode: plan.to,
      buildMode: build.buildMode,
      hasBuildApiBase: build.hasBuildApiBase,
      hasLocalEngine: build.hasLocalEngine,
      platform,
      reason: plan.reason,
    },
    "[StartupModeReconcile] persisted mobile runtime mode is unusable in this build; adopting the build's native mode",
  );
  persistMobileRuntimeMode(plan.to);
  return { from: plan.from, to: plan.to };
}
