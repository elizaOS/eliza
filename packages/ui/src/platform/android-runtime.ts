/**
 * Android runtime mode resolution.
 *
 * The Android build orchestrator ships three target APKs (see
 * `packages/app-core/scripts/run-mobile-build.mjs`):
 *
 *   - `android`         — sideload-only debug client with the on-device
 *                         agent runtime (Bun via libeliza_bun.so) plus
 *                         AOSP/system-only permissions. Renderer mode `local`.
 *   - `android-cloud`   — Play-Store-compliant thin Capacitor client
 *                         backed by Eliza Cloud. No on-device agent.
 *                         Renderer mode `cloud`.
 *   - `android-system`  — privileged platform-signed AOSP release APK for
 *                         Eliza OS / ElizaOS device builds. Renderer
 *                         mode `local`.
 *
 * The build script injects `VITE_ELIZA_ANDROID_RUNTIME_MODE` (and the
 * `VITE_ELIZA_ANDROID_RUNTIME_MODE` alias for white-label forks) at vite
 * compile time so the renderer can adapt — most importantly, the
 * `android-cloud` build must hide the Local first-run option so users
 * cannot try to provision an on-device agent that physically isn't there.
 */

import { getFrontendPlatform } from "./platform-guards";

export type AndroidRuntimeMode = "cloud" | "local";

type RuntimeEnv = Record<string, string | boolean | undefined>;

function readString(env: RuntimeEnv, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function normalizeMode(value: string | undefined): AndroidRuntimeMode {
  switch (value?.trim().toLowerCase()) {
    case "cloud":
      return "cloud";
    default:
      return "local";
  }
}

export function resolveAndroidRuntimeMode(env: RuntimeEnv): AndroidRuntimeMode {
  return normalizeMode(readString(env, ["VITE_ELIZA_ANDROID_RUNTIME_MODE"]));
}

/**
 * Returns true when the active Android build is the Play-Store-compliant
 * cloud-locked variant. Always false on iOS, desktop, and the default
 * sideload Android build.
 */
export function isAndroidCloudBuild(): boolean {
  // import.meta.env is statically replaced by Vite at compile time, so
  // this read collapses to a constant in the shipped bundle.
  const env =
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: RuntimeEnv }).env
      ? ((import.meta as { env: RuntimeEnv }).env as RuntimeEnv)
      : {};
  return resolveAndroidRuntimeMode(env) === "cloud";
}

/** True only for the direct-install HOME/launcher Cloud artifact. */
export function resolveAndroidLauncherBuild(env: RuntimeEnv): boolean {
  return readString(env, ["VITE_ELIZA_ANDROID_LAUNCHER_BUILD"]) === "1";
}

export function isAndroidLauncherBuild(): boolean {
  const env =
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: RuntimeEnv }).env
      ? ((import.meta as { env: RuntimeEnv }).env as RuntimeEnv)
      : {};
  return resolveAndroidLauncherBuild(env);
}

/**
 * True only for the dedicated LP3 VPS fallback renderer. Its Android 14
 * system WebView can keep page code in an out-of-app renderer but predates
 * androidx.webkit multi-profile storage, so Browser tabs deliberately request
 * one shared browser profile instead of a per-tab profile. The mobile build
 * orchestrator owns this compile-time flag; ordinary Android builds remain on
 * isolated storage.
 */
export function resolveAndroidLp3SharedBrowserStorage(
  env: RuntimeEnv,
): boolean {
  return (
    readString(env, ["VITE_ELIZA_ANDROID_LP3_SHARED_BROWSER_STORAGE"]) === "1"
  );
}

export function usesAndroidLp3SharedBrowserStorage(): boolean {
  const env =
    typeof import.meta !== "undefined" &&
    (import.meta as { env?: RuntimeEnv }).env
      ? ((import.meta as { env: RuntimeEnv }).env as RuntimeEnv)
      : {};
  return resolveAndroidLp3SharedBrowserStorage(env);
}

/**
 * True on the Android builds that ship the on-device agent runtime
 * (`android` sideload / `android-system`): a native Android shell that is not
 * the cloud-locked Play-Store variant. These builds' whole point is the local
 * agent, so onboarding must offer the local runtime path
 * (first-run-runtime-flag.ts) — but never auto-start it before the user picks
 * it (#14390).
 */
export function isAndroidLocalSideloadBuild(): boolean {
  return getFrontendPlatform() === "android" && !isAndroidCloudBuild();
}
