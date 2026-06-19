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
	if (env.ELIZA_DISABLE_FFI_LLAMA?.trim() === "1") {
		// Operator opted out of the FFI path entirely — the device-bridge
		// path remains valid because the bridge is process-external and
		// doesn't depend on `libllama.so` being present in the APK.
		return env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
	}
	const deviceBridge = env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1";
	const localLlama = env.ELIZA_LOCAL_LLAMA?.trim() === "1";
	const riscv64Auto = arch === "riscv64";
	return deviceBridge || localLlama || riscv64Auto;
}
