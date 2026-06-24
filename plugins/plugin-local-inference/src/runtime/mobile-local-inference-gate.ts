/**
 * On a mobile platform (`ELIZA_PLATFORM=android` / `ios`) the runtime skips
 * nearly every boot helper because they shell out to subprocesses,
 * platform-specific binaries, or optional packages that aren't in the mobile
 * bundle. Three mobile-safe inference paths need wiring:
 *
 *   - `ELIZA_DEVICE_BRIDGE_ENABLED=1`: the agent (this process) hosts the
 *     device-bridge WSS and dials whichever paired device connects. On the
 *     Capacitor APK the WebView's `@elizaos/capacitor-llama` is the intended
 *     dialer over loopback. The Capacitor build always exports this env so
 *     the bridge is ready as soon as first-run picks the local mode.
 *
 *   - `ELIZA_LOCAL_LLAMA=1`: AOSP path that loads `libllama.so` directly
 *     inside the Android process via `bun:ffi`. Wired here so the gate is
 *     in place ahead of sub-task 2 — the AOSP build flag flips this on.
 *
 *   - `process.arch === "riscv64"`: `capacitor-llama` has no riscv64 prebuild
 *     and we can't NAPI-build it on-device, so the in-process FFI path
 *     (same loader contract as the AOSP path) is the only viable option.
 *     Auto-firing here keeps the riscv64 mobile boot path zero-config; an
 *     operator can hard-disable via `ELIZA_DISABLE_FFI_LLAMA=1` to skip the
 *     loader and route inference through Cloud instead. See
 *     `plugin-aosp-local-inference/src/aosp-llama-adapter.ts:isAospEnabled`
 *     and `plugin-local-inference/src/runtime/ensure-local-inference-handler.ts:shouldAttemptAospLlamaLoader`
 *     — the three predicates agree on the trigger set.
 *
 * Kept dependency-free so it can be unit-tested without instantiating the
 * full runtime.
 */
export function shouldEnableMobileLocalInference(
	env: NodeJS.ProcessEnv = process.env,
	arch: NodeJS.Architecture = process.arch,
): boolean {
	// Bionic-host delegation (Android dynamic-Vulkan): the app shell stages a
	// dynamic-Vulkan `libelizainference.so` reachable only from the in-process
	// bionic host and sets `ELIZA_BIONIC_HOST_DELEGATED=1` (suppressing
	// ELIZA_LOCAL_LLAMA so the musl agent never dlopen's the lib). The agent talks
	// to that host over the abstract UDS — a process-external backend just like
	// the device bridge. Without counting it here, ensureLocalInferenceHandler is
	// skipped on the phone, so `tryRegisterBionicHostLoader` + the
	// TEXT/embedding (and TTS/TRANSCRIPTION/IMAGE_DESCRIPTION) handlers never
	// register and only the mobile-local-direct-reply chat path works (#8848).
	const bionicHost = env.ELIZA_BIONIC_HOST_DELEGATED?.trim() === "1";
	if (env.ELIZA_DISABLE_FFI_LLAMA?.trim() === "1") {
		// Operator opted out of the FFI path entirely — the device-bridge and the
		// in-process bionic host are both process-external (WS / UDS) and don't
		// depend on `libllama.so` being dlopen'd in this musl process.
		return env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1" || bionicHost;
	}
	const deviceBridge = env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
	const localLlama = env.ELIZA_LOCAL_LLAMA?.trim() === "1";
	const riscv64Auto = arch === "riscv64";
	return deviceBridge || localLlama || riscv64Auto || bionicHost;
}

/**
 * Boot-time invariant check for the mobile voice backend selector.
 *
 * The voice engine passes `mobile: isMobilePlatform()` into `selectVoiceBackend`
 * (`services/engine.ts`). That flag is what pins mobile to the Kokoro-exclusive
 * TTS path — OmniVoice is never shipped on a phone. But `isMobilePlatform()`
 * keys solely off `ELIZA_PLATFORM ∈ {ios, android}`, whereas
 * {@link shouldEnableMobileLocalInference} also fires on the device-bridge /
 * `ELIZA_LOCAL_LLAMA` / riscv64 triggers — none of which set `ELIZA_PLATFORM`.
 * So a build that enables the mobile local-inference gate without exporting
 * `ELIZA_PLATFORM` leaves `mobile` false in the selector and could pick
 * OmniVoice on a phone, violating the Kokoro-exclusive mobile voice invariant.
 *
 * This emits exactly one boot-time warning when the gate is active but the
 * platform flag is absent (the real mismatch). It is a diagnostic, not a
 * behavior change: the fix is to export `ELIZA_PLATFORM` from the offending
 * build, which this surfaces. The caller MUST evaluate it on a boot path where
 * BOTH predicates are checked (i.e. outside any `if (isMobilePlatform())`
 * branch) — passing the already-computed `mobilePlatform` makes that explicit.
 *
 * Kept dependency-free (injectable `warn` + the already-resolved
 * `mobilePlatform` boolean) so it can be unit-tested without the runtime or a
 * logger instance, matching the `engine.warnIfParallelTooLow({ warn })` pattern.
 *
 * @returns `true` when the warning fired (the mismatch is real), else `false`.
 */
export function warnIfMobileGateActiveWithoutPlatform(args: {
	mobilePlatform: boolean;
	warn: (message: string) => void;
	env?: NodeJS.ProcessEnv;
	arch?: NodeJS.Architecture;
}): boolean {
	const { mobilePlatform, warn, env = process.env, arch = process.arch } = args;
	if (mobilePlatform) return false;
	if (!shouldEnableMobileLocalInference(env, arch)) return false;
	warn(
		"[local-inference] ELIZA_PLATFORM is not set while the mobile local-inference gate is active " +
			"(ELIZA_DEVICE_BRIDGE_ENABLED / ELIZA_LOCAL_LLAMA / riscv64), so the Kokoro-exclusive mobile " +
			"voice invariant may be missed. The voice backend selector keys `mobile` off " +
			"ELIZA_PLATFORM ∈ {ios,android}; with it unset the selector may pick OmniVoice on a phone. " +
			"Set ELIZA_PLATFORM=android (or ios) on this build.",
	);
	return true;
}
