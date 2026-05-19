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
 * `android-cloud` build must hide the "Local" runtime picker so users
 * cannot try to provision an on-device agent that physically isn't there.
 */
export type AndroidRuntimeMode = "cloud" | "local";
type RuntimeEnv = Record<string, string | boolean | undefined>;
export declare function resolveAndroidRuntimeMode(env: RuntimeEnv): AndroidRuntimeMode;
/**
 * Returns true when the active Android build is the Play-Store-compliant
 * cloud-locked variant. Always false on iOS, desktop, and the default
 * sideload Android build.
 */
export declare function isAndroidCloudBuild(): boolean;
export {};
//# sourceMappingURL=android-runtime.d.ts.map