/**
 * Pre-ready boot entrypoint for plugin-local-inference.
 *
 * The app-core host once hard-wired this plugin's boot internals at fixed
 * init points in `repairRuntimeAfterBoot` — importing
 * `@elizaos/plugin-local-inference/runtime` by name and calling
 * `warnIfMobileGateActiveWithoutPlatform` + `shouldEnableMobileLocalInference` +
 * `ensureLocalInferenceHandler` inline (arch-audit #12089 item 18). This single
 * exported hook lets the plugin OWN that boot coupling: it is declared as the
 * plugin's `bootHook` in `registry-entry.json`, and the shared agent host drains
 * it through the generic pre-ready boot-hook channel (naming no plugin).
 *
 * It encapsulates exactly what the host inlined, in the same order and with the
 * same platform gating:
 *   1. Emit the mobile-voice-invariant warning when the mobile local-inference
 *      gate is active but `ELIZA_PLATFORM` is unset (evaluated regardless of
 *      platform, as the host did outside the mobile branch).
 *   2. On a mobile platform, install the local model handler ONLY when the
 *      mobile local-inference gate says a mobile-safe backend is wired.
 *   3. On desktop / server, install the local model handler unconditionally
 *      (`ensureLocalInferenceHandler` self-skips when the runtime mode is cloud
 *      or no backend is available).
 *
 * The host keeps its own `isMobilePlatform()` control flow for the host-only
 * boot steps it skips on mobile (telegram polling, app-route plugins, etc.);
 * this hook only owns the local-inference-specific init.
 */
import { type AgentRuntime, isMobilePlatform, logger } from "@elizaos/core";

import { ensureLocalInferenceHandler } from "./ensure-local-inference-handler";
import {
	shouldEnableMobileLocalInference,
	warnIfMobileGateActiveWithoutPlatform,
} from "./mobile-local-inference-gate";

/**
 * Install the local-inference model handler at the pre-ready boot phase.
 *
 * Owns the platform gating the host previously inlined. A no-op when local
 * inference does not apply on this platform/config (mobile without a wired
 * mobile-safe backend, or a runtime mode / missing backend that
 * `ensureLocalInferenceHandler` self-skips). Invoked once by the shared agent
 * boot-hook channel for headless and app-core hosts alike.
 */
export async function registerLocalInferenceBoot(
	runtime: AgentRuntime,
): Promise<void> {
	// Mobile-voice-invariant diagnostic: evaluated on every platform (the host
	// ran it outside the mobile branch) so the mismatch — gate active without
	// ELIZA_PLATFORM — is actually reachable.
	warnIfMobileGateActiveWithoutPlatform({
		mobilePlatform: isMobilePlatform(),
		warn: logger.warn,
	});

	if (isMobilePlatform()) {
		// Mobile bundle wires the local model handler only when a mobile-safe
		// backend (device-bridge / AOSP FFI / bionic host / riscv64) is enabled;
		// otherwise the runtime serves from a remote/cloud provider.
		if (shouldEnableMobileLocalInference()) {
			await ensureLocalInferenceHandler(runtime);
		}
		return;
	}

	// Desktop / server: ensureLocalInferenceHandler self-skips on a cloud
	// runtime mode or when no local backend is available.
	await ensureLocalInferenceHandler(runtime);
}
