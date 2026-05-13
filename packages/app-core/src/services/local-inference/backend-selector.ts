/**
 * Local-inference backend selector.
 *
 * One choice per host process: route generation through the in-process
 * FFI streaming runner (`ffi-streaming-runner.ts`) or through the
 * out-of-process `llama-server` HTTP path (`dflash-server.ts`). The
 * selection is deterministic so callers can mock it in tests and so the
 * mobile bundle never falls back to the HTTP path by accident.
 *
 * Rules:
 *   - Mobile (Android / iOS) ALWAYS uses `ffi-streaming`. The
 *     `llama-server` child-process path cannot ship on mobile (sandbox
 *     restrictions, App Store review, ~10–30 ms HTTP round-trip per
 *     token, no slot persistence on Android's APK private dir). When
 *     the FFI symbols are absent on a mobile build we throw — there is
 *     no second backend to fall back to.
 *   - Desktop defaults to `http-server` (the historical, well-tested
 *     path) unless `preferFfi === true` AND the FFI symbols are
 *     supported. Operators can flip the default with
 *     `ELIZA_INFERENCE_BACKEND=ffi` to force the streaming runner, or
 *     `=http` to force the legacy server even on a build that supports
 *     FFI streaming. The `=auto` value (default) follows the rules
 *     above.
 *
 * The selector intentionally does NOT inspect the live process to detect
 * mobile — callers pass that information in. The mobile bootstrap
 * (`aosp-dflash-adapter.ts` / the iOS bridge) knows what it is; tests
 * pass synthetic values. Keeping detection out of the selector matches
 * AGENTS.md §7 (single source of truth for inputs) and lets the
 * decision be replayed offline.
 */

export type LocalInferenceBackend = "ffi-streaming" | "http-server";

export type LocalInferencePlatform = "desktop" | "mobile";

export interface BackendSelectInput {
  /** Where the host is running. */
  platform: LocalInferencePlatform;
  /**
   * Operator preference for the FFI path. Picked up from runtime config
   * / the catalog entry; orthogonal to whether the build actually
   * exports the streaming-LLM symbols.
   */
  preferFfi: boolean;
  /**
   * `llmStreamSupported()` from the loaded FFI binding. Mobile builds
   * MUST have this true — when it's false on mobile, `selectBackend`
   * throws to surface the bad build (rather than silently falling
   * through to a path that doesn't exist).
   */
  ffiSupported: boolean;
  /**
   * Optional env override (`ELIZA_INFERENCE_BACKEND`). When `"ffi"` or
   * `"http"`, wins over the per-platform default. When `"auto"` or
   * unset, the default rules apply.
   */
  envOverride?: string | null;
}

/** Read the `ELIZA_INFERENCE_BACKEND` env var into a normalised value. */
export function readBackendEnvOverride(
  env: NodeJS.ProcessEnv = process.env,
): "ffi" | "http" | "auto" | null {
  const raw = env.ELIZA_INFERENCE_BACKEND?.trim().toLowerCase();
  if (!raw || raw === "auto") return raw === "auto" ? "auto" : null;
  if (raw === "ffi" || raw === "ffi-streaming") return "ffi";
  if (raw === "http" || raw === "http-server" || raw === "server") {
    return "http";
  }
  return null;
}

/**
 * Decide which local-inference backend should service text generation.
 * See file header for the full rule set. Throws when the chosen
 * combination is incoherent (mobile + no FFI support, explicit env
 * override of "http" on mobile, …).
 */
export function selectBackend(
  input: BackendSelectInput,
): LocalInferenceBackend {
  const { platform, preferFfi, ffiSupported, envOverride } = input;
  const override = (envOverride ?? "").toLowerCase();

  if (override === "http") {
    if (platform === "mobile") {
      throw new Error(
        "[backend-selector] ELIZA_INFERENCE_BACKEND=http is not supported on mobile " +
          "(llama-server child-process spawn cannot ship inside the sandbox). " +
          "Use ELIZA_INFERENCE_BACKEND=ffi or unset to take the FFI streaming path.",
      );
    }
    return "http-server";
  }
  if (override === "ffi") {
    if (!ffiSupported) {
      throw new Error(
        "[backend-selector] ELIZA_INFERENCE_BACKEND=ffi but the loaded " +
          "libelizainference does not export the streaming-LLM symbols. " +
          "Rebuild the omnivoice fuse against the current ffi-streaming-llm.h.",
      );
    }
    return "ffi-streaming";
  }

  if (platform === "mobile") {
    if (!ffiSupported) {
      throw new Error(
        "[backend-selector] Mobile build missing streaming-LLM FFI symbols. " +
          "The llama-server child-process path is unavailable on mobile; " +
          "rebuild libelizainference against the current ffi-streaming-llm.h.",
      );
    }
    return "ffi-streaming";
  }

  // Desktop: opt-in to FFI streaming, otherwise stay on the historical
  // HTTP server path. This default flips after the FFI runner stabilizes
  // (tracked in docs/eliza-1-ffi-streaming-llm.md).
  if (preferFfi && ffiSupported) return "ffi-streaming";
  return "http-server";
}
