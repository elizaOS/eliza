/**
 * Local-inference backend selector.
 *
 * One choice per host process: route generation through the in-process
 * FFI streaming runner (`ffi-streaming-runner.ts`). The selection is
 * deterministic so callers can mock it in tests and so no platform falls
 * back to a server sidecar by accident.
 *
 * Rules:
 *   - Mobile (Android / iOS) ALWAYS uses `ffi-streaming`. The
 *     `llama-server` child-process path cannot ship on mobile (sandbox
 *     restrictions, App Store review, ~10–30 ms HTTP round-trip per
 *     token, no slot persistence on Android's APK private dir). When
 *     the FFI symbols are absent on a mobile build we throw — there is
 *     no second backend to fall back to.
 *   - Desktop also uses `ffi-streaming`. Missing streaming-LLM symbols are
 *     a bad build, not a reason to start a server backend.
 *   - `ELIZA_INFERENCE_BACKEND=ffi` forces the streaming runner and
 *     throws if the symbols are absent. `=auto` (or unset) follows the
 *     rules above.
 *
 * The selector intentionally does NOT inspect the live process to detect
 * mobile — callers pass that information in. The mobile bootstrap
 * (`aosp-mtp-adapter.ts` / the iOS bridge) knows what it is; tests
 * pass synthetic values. Keeping detection out of the selector matches
 * AGENTS.md §7 (single source of truth for inputs) and lets the
 * decision be replayed offline.
 */

export type LocalInferenceBackend = "ffi-streaming";

export type LocalInferencePlatform = "desktop" | "mobile";

export interface BackendSelectInput {
	/** Where the host is running. */
	platform: LocalInferencePlatform;
	/**
	 * `llmStreamSupported()` from the loaded FFI binding. All builds MUST
	 * have this true; false means the runtime was built without the unified
	 * llama.cpp FFI path.
	 */
	ffiSupported: boolean;
	/**
	 * Optional env override (`ELIZA_INFERENCE_BACKEND`). `"ffi"` forces
	 * the FFI path, while `"auto"` or unset follows the default rule.
	 */
	envOverride?: string | null;
}

/** Read the `ELIZA_INFERENCE_BACKEND` env var into a normalised value. */
export function readBackendEnvOverride(
	env: NodeJS.ProcessEnv = process.env,
): "ffi" | "auto" | null {
	const raw = env.ELIZA_INFERENCE_BACKEND?.trim().toLowerCase();
	if (!raw || raw === "auto") return raw === "auto" ? "auto" : null;
	if (raw === "ffi" || raw === "ffi-streaming") return "ffi";
	return null;
}

/**
 * Decide which local-inference backend should service text generation.
 * See file header for the full rule set. Throws when the chosen
 * combination is incoherent (no FFI support, explicit FFI with a bad
 * runtime build, …).
 */
export function selectBackend(
	input: BackendSelectInput,
): LocalInferenceBackend {
	const { platform, ffiSupported, envOverride } = input;
	const override = (envOverride ?? "").toLowerCase();

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

	if (!ffiSupported) {
		const target = platform === "mobile" ? "Mobile build" : "Desktop build";
		throw new Error(
			`[backend-selector] ${target} missing streaming-LLM FFI symbols. ` +
				"Rebuild libelizainference against the current ffi-streaming-llm.h.",
		);
	}
	return "ffi-streaming";
}
