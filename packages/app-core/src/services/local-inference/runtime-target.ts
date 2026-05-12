/**
 * Inference runtime-target detection.
 *
 * The local-inference subsystem has two operational shapes depending on the
 * host platform:
 *
 *   - `"spawn"`        — out-of-process `llama-server` child process, served
 *                        over HTTP. The current desktop / GPU path; lives in
 *                        `dflash-server.ts`. Uses `node:child_process.spawn`,
 *                        which is unavailable on iOS and disallowed by the
 *                        Apple App Store sandbox review.
 *   - `"ffi"`          — in-process bun:ffi streaming bindings against the
 *                        `libelizainference` (fused omnivoice + llama.cpp)
 *                        shared library. Lives in `voice/ffi-bindings.ts` and
 *                        `ffi-streaming-runner.ts`. The mandatory mobile path
 *                        — iOS and Android cannot spawn subprocesses inside
 *                        the app sandbox, so all generation has to happen in
 *                        the app's own address space.
 *   - `"native-bridge"`— delegate to a Capacitor / JNI-side native runtime
 *                        plugin (e.g. a Swift / Kotlin host wrapping
 *                        llama.cpp directly). Reserved for future builds
 *                        where the FFI layer cannot be used (e.g. a build
 *                        that disables `bun:ffi`); the actual implementation
 *                        of this branch is a separate work-stream. Today
 *                        only the env-override path can select it.
 *
 * This module is the single source of truth for the platform → runtime
 * mapping. The `backend-selector.ts` decision function (FFI vs HTTP for the
 * `ffi-streaming` path) is downstream of this — it answers "which JS surface
 * to use", while this module answers "are we even allowed to spawn a server
 * on this host".
 *
 * Detection inputs (in priority order):
 *   1. `MILADY_INFERENCE_MODE` env var. Values: `spawn` / `ffi` /
 *      `native-bridge`. Wins over every heuristic so operators can force a
 *      branch from a CI shell or a debug build without recompiling.
 *      `ELIZA_INFERENCE_MODE` is accepted as a legacy alias for the same
 *      knob (the rest of the app uses both `MILADY_*` and `ELIZA_*` prefixes
 *      interchangeably; see CLAUDE.md §Environment variables).
 *   2. Capacitor native marker — when `globalThis.Capacitor.isNativePlatform()`
 *      returns `true`, we are inside a Capacitor shell on iOS or Android.
 *      Force `"ffi"` regardless of Node's `process.platform` (which on iOS
 *      reports `darwin`).
 *   3. `process.platform` — `ios` / `android` map to `"ffi"`. `darwin`,
 *      `linux`, `win32` map to `"spawn"`. Anything else (`aix`, `freebsd`,
 *      `openbsd`, `sunos`, `cygwin`, `netbsd`) maps to `"spawn"` because
 *      that's the historical desktop-class default — operators who need
 *      otherwise set the env var.
 *
 * The function is pure: same inputs → same answer. All inputs are explicit
 * arguments so tests can replay the decision offline without poking the live
 * `process` / `globalThis`.
 *
 * NOTE: this module does NOT decide whether the FFI library is actually
 * loaded or whether the FFI symbols are present. `backend-selector.ts`
 * handles that (with a hard throw if the mobile build is missing the
 * streaming-LLM symbols). The two work together:
 *
 *   inferenceRuntimeMode() === "spawn"        → use `dflash-server.ts`
 *   inferenceRuntimeMode() === "ffi"          → use `ffi-streaming-runner.ts`
 *   inferenceRuntimeMode() === "native-bridge"→ use the Capacitor plugin shim
 */

export type InferenceRuntimeMode = "spawn" | "ffi" | "native-bridge";

/**
 * Node's `process.platform` values, narrowed to the set we care about.
 * `unknown` covers exotic platforms (aix, freebsd, …) without baking them
 * into the public API of this module.
 */
export type SupportedHostPlatform =
  | "darwin"
  | "linux"
  | "win32"
  | "ios"
  | "android"
  | "unknown";

export interface InferenceRuntimeModeInput {
  /**
   * Raw `process.platform` value (or a synthetic one in tests). Optional —
   * defaults to the live `process.platform`. Anything other than the
   * recognised set is treated as `"unknown"` and routed to `"spawn"`
   * unless an env override or Capacitor marker overrides it.
   */
  platform?: SupportedHostPlatform | NodeJS.Platform;
  /**
   * Whether the JS runtime is currently embedded inside a Capacitor
   * native shell. Defaults to inspecting `globalThis.Capacitor`. Tests
   * pass `false` to keep the env-var / platform branches deterministic.
   */
  isCapacitorNative?: boolean;
  /**
   * Environment-variable bag. Defaults to `process.env`. The function
   * reads `MILADY_INFERENCE_MODE` (canonical) and falls back to
   * `ELIZA_INFERENCE_MODE` (legacy alias) for the override.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * Read and normalise the `MILADY_INFERENCE_MODE` / `ELIZA_INFERENCE_MODE`
 * env override. Returns `null` when unset or unrecognised — callers must
 * not silently fall through on a typo, so an unknown value is treated the
 * same as unset (callers can warn upstream if they want).
 */
export function readRuntimeModeEnvOverride(
  env: NodeJS.ProcessEnv = process.env,
): InferenceRuntimeMode | null {
  const raw = (
    env.MILADY_INFERENCE_MODE ??
    env.ELIZA_INFERENCE_MODE ??
    ""
  )
    .trim()
    .toLowerCase();
  if (raw === "") return null;
  if (raw === "spawn" || raw === "http" || raw === "http-server") {
    return "spawn";
  }
  if (raw === "ffi" || raw === "ffi-streaming") return "ffi";
  if (
    raw === "native-bridge" ||
    raw === "native" ||
    raw === "bridge" ||
    raw === "capacitor"
  ) {
    return "native-bridge";
  }
  return null;
}

/**
 * Synchronous Capacitor probe. Reads `globalThis.Capacitor.isNativePlatform()`
 * defensively — neither the property nor the call site is guaranteed to
 * exist in every build (desktop, plain Node tests, web-only Vite dev).
 *
 * Surfaces no errors: any failure means "not native". The throw-on-bad-build
 * policy belongs to the backend-selector, not to platform detection.
 */
export function isCapacitorNativeRuntime(
  global: typeof globalThis = globalThis,
): boolean {
  const cap = (global as { Capacitor?: { isNativePlatform?: () => boolean } })
    .Capacitor;
  if (!cap || typeof cap.isNativePlatform !== "function") return false;
  try {
    return cap.isNativePlatform() === true;
  } catch {
    return false;
  }
}

/**
 * Decide which inference runtime mode the host should use. Pure: caller
 * controls every input. See file header for the decision rules.
 */
export function inferenceRuntimeMode(
  input: InferenceRuntimeModeInput = {},
): InferenceRuntimeMode {
  const env = input.env ?? process.env;
  const override = readRuntimeModeEnvOverride(env);
  if (override) return override;

  const capacitor =
    input.isCapacitorNative !== undefined
      ? input.isCapacitorNative
      : isCapacitorNativeRuntime();
  if (capacitor) return "ffi";

  const platform = (input.platform ??
    (process.platform as NodeJS.Platform)) as string;
  if (platform === "ios" || platform === "android") return "ffi";
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return "spawn";
  }
  // Exotic / unknown — default to spawn so the existing desktop fallbacks
  // keep working. Operators who need otherwise set MILADY_INFERENCE_MODE.
  return "spawn";
}

/**
 * Convenience wrapper for the `backend-selector.ts` boundary: maps the
 * runtime mode onto the `"desktop" | "mobile"` slot the selector expects.
 *
 * `native-bridge` is treated as `"mobile"` because in every shipping
 * configuration where we'd pick it the host has already classified itself
 * as a mobile device (Capacitor shell that opted out of `bun:ffi`).
 */
export function inferencePlatformClass(
  mode: InferenceRuntimeMode = inferenceRuntimeMode(),
): "desktop" | "mobile" {
  if (mode === "spawn") return "desktop";
  return "mobile";
}
