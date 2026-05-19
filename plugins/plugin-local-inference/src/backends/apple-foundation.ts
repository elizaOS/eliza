/**
 * Apple Foundation Models adapter — iOS / iPadOS / macOS 26+.
 *
 * The Foundation Models framework exposes a managed on-device LLM that
 * Apple ships with the OS when Apple Intelligence is enabled. We do not
 * own its weights and cannot ship our own; this adapter is an
 * **opportunistic fast-path**:
 *
 *   - If the device is iOS 26+ and reports availability via the Capacitor
 *     `ComputerUse` bridge probe, we register a generate function that
 *     calls into Apple's framework for short prompts.
 *   - Otherwise we do nothing, and the existing llama-cpp-capacitor
 *     (Qwen3-VL-2B) path remains the active local-inference handler.
 *
 * Why this lives in plugin-local-inference (not plugin-capacitor-bridge):
 *
 *   - The plugin-capacitor-bridge package is a thin JS↔native shim. The
 *     decision of *when* to use Apple's model vs. llama.cpp is an
 *     inference-routing decision, which is plugin-local-inference's job.
 *     Co-locating the adapter with the rest of the routing logic
 *     (`backend-selector`, `runtime-dispatcher`, etc.) keeps the routing
 *     surface inspectable in one place. The bridge only transports
 *     bytes; it does not decide policy.
 *
 * Entitlement: requires `com.apple.developer.kernel.increased-memory-limit`
 * and Apple Intelligence to be enabled by the user in Settings. See
 * `docs/IOS_CONSTRAINTS.md`.
 */

import type {
	FoundationModelOptions,
	FoundationModelResult,
	IosComputerUseBridge,
} from "@elizaos/plugin-computeruse";

export interface AppleFoundationGenerateArgs {
	readonly prompt: string;
	readonly options?: FoundationModelOptions;
}

export interface AppleFoundationAdapter {
	readonly name: "apple-foundation";
	available(): boolean;
	generate(args: AppleFoundationGenerateArgs): Promise<FoundationModelResult>;
}

/**
 * Builds the adapter. The bridge getter is lazy so this module remains
 * Node-importable for tests; in the Capacitor build the runtime resolves
 * `Capacitor.Plugins.ComputerUse` and passes it in.
 */
export function createAppleFoundationAdapter(
	getBridge: () => IosComputerUseBridge | null,
): AppleFoundationAdapter {
	let probedAvailable: boolean | null = null;
	let probing: Promise<boolean> | null = null;

	async function probe(): Promise<boolean> {
		const bridge = getBridge();
		if (!bridge) return false;
		const result = await bridge.probe();
		if (!result.ok) return false;
		return result.data.capabilities.foundationModel === true;
	}

	return {
		name: "apple-foundation",
		available(): boolean {
			if (probedAvailable !== null) return probedAvailable;
			if (!probing) {
				probing = probe().then((v) => {
					probedAvailable = v;
					return v;
				});
			}
			// Synchronous semantics: return false until the probe resolves; this
			// matches the rest of the local-inference availability pattern, which
			// is allowed to return a slightly stale "not yet available" until the
			// first async probe completes.
			return probedAvailable === true;
		},
		async generate(args): Promise<FoundationModelResult> {
			const bridge = getBridge();
			if (!bridge) {
				throw new Error(
					"apple-foundation adapter invoked but Capacitor ComputerUse plugin is not registered.",
				);
			}
			const result = await bridge.foundationModelGenerate({
				prompt: args.prompt,
				...(args.options ? { options: args.options } : {}),
			});
			if (!result.ok) {
				throw new Error(
					`apple-foundation generate failed: ${result.code} — ${result.message}`,
				);
			}
			return result.data;
		},
	};
}

// ── Registry ─────────────────────────────────────────────────────────────────

let registered: AppleFoundationAdapter | null = null;

/**
 * Register the adapter so the local-inference runtime picks it up
 * opportunistically. Idempotent — subsequent calls overwrite the previous
 * registration so a hot reload of the bridge swaps cleanly.
 */
export function registerAppleFoundationAdapter(
	adapter: AppleFoundationAdapter,
): void {
	registered = adapter;
}

export function getAppleFoundationAdapter(): AppleFoundationAdapter | null {
	return registered;
}

/**
 * Tests use this to ensure each spec starts from a known state.
 */
export function _resetAppleFoundationAdapterForTests(): void {
	registered = null;
}
