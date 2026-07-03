/**
 * Canonical Capacitor-llama loader — MOBILE ONLY.
 *
 * `initCapacitorLlama(params)` returns a context that implements
 * `CapacitorLlamaContext` by dynamic-importing `llama-cpp-capacitor` on
 * `ELIZA_PLATFORM=android|ios`. The package's `LlamaContext` already implements
 * the canonical shape verbatim, so we return it directly with an `as` cast (the
 * d.ts overlaps by construction).
 *
 * The Capacitor llama API is mobile-only. libllama has been retired, so there
 * is no desktop façade: desktop / server inference runs through the fused
 * `libelizainference` engine (`LocalInferenceEngine` /
 * `desktopFusedFfiBackendRuntime`), not this loader. `initCapacitorLlama` on a
 * non-mobile platform throws `CapacitorLlamaUnsupportedError`.
 */

import { logger } from "@elizaos/core";
import {
	type CapacitorLlamaContext,
	type CapacitorLlamaContextParams,
	CapacitorLlamaUnsupportedError,
} from "./types";

// === Mobile shim ===========================================================

interface MobileCapacitorModule {
	initLlama(
		params: CapacitorLlamaContextParams,
		onProgress?: (progress: number) => void,
	): Promise<CapacitorLlamaContext>;
	releaseAllLlama(): Promise<void>;
	setContextLimit(limit: number): Promise<void>;
	toggleNativeLog(enabled: boolean): Promise<void>;
	/** GGUF metadata probe without loading the model (llama-cpp-capacitor). */
	loadLlamaModelInfo?(model: string): Promise<object>;
}

let cachedMobileModule: MobileCapacitorModule | null = null;

async function loadMobileCapacitor(): Promise<MobileCapacitorModule> {
	if (cachedMobileModule) return cachedMobileModule;
	// Dynamic import keeps the desktop / test runtime from trying to resolve
	// the mobile-only native binding.
	const spec = "llama-cpp-capacitor";
	const mod = (await import(spec)) as MobileCapacitorModule;
	if (typeof mod.initLlama !== "function") {
		throw new Error(
			"[capacitor-llama] llama-cpp-capacitor did not expose initLlama — the binding is missing or unavailable.",
		);
	}
	cachedMobileModule = mod;
	return mod;
}

// === Public loader =========================================================

export interface InitCapacitorLlamaOptions extends CapacitorLlamaContextParams {
	/**
	 * Force a specific backend. Only `mobile` is supported — it requires the
	 * `llama-cpp-capacitor` package. The desktop façade was removed when
	 * libllama was retired; desktop inference runs through the fused engine.
	 */
	backend?: "mobile";
}

function detectBackend(env: NodeJS.ProcessEnv = process.env): "mobile" | null {
	const platform = env.ELIZA_PLATFORM?.trim().toLowerCase();
	if (platform === "android" || platform === "ios") return "mobile";
	return null;
}

/**
 * Load a Capacitor-shaped llama.cpp context. Mobile-only: on
 * `ELIZA_PLATFORM=android|ios` it resolves `llama-cpp-capacitor`; on any other
 * platform it throws `CapacitorLlamaUnsupportedError` (libllama is retired —
 * desktop/server inference runs through the fused `libelizainference` engine,
 * not this loader). Callers MUST handle the throw explicitly.
 */
export async function initCapacitorLlama(
	opts: InitCapacitorLlamaOptions,
): Promise<CapacitorLlamaContext> {
	const { backend, ...params } = opts;
	const target = backend ?? detectBackend();

	if (target === "mobile") {
		const mod = await loadMobileCapacitor();
		return mod.initLlama(params);
	}

	throw new CapacitorLlamaUnsupportedError(
		"initCapacitorLlama",
		"desktop-ffi",
		"[capacitor-llama] The Capacitor llama API is mobile-only. libllama has been " +
			"retired; desktop/server inference runs through the fused libelizainference " +
			"engine (LocalInferenceEngine / desktopFusedFfiBackendRuntime), not this loader.",
	);
}

/**
 * Mobile-only: read GGUF metadata (layer count etc.) without loading the
 * model. Returns `null` on desktop or when the binding lacks the probe —
 * callers fall back to conservative defaults (memory-admission.ts).
 */
export async function loadCapacitorLlamaModelInfo(
	model: string,
): Promise<Record<string, unknown> | null> {
	if (detectBackend() !== "mobile") return null;
	try {
		const mod = await loadMobileCapacitor();
		if (typeof mod.loadLlamaModelInfo !== "function") return null;
		return (await mod.loadLlamaModelInfo(model)) as Record<string, unknown>;
	} catch (err) {
		logger.debug(
			{ err: err instanceof Error ? err.message : String(err) },
			"[capacitor-llama] loadLlamaModelInfo unavailable",
		);
		return null;
	}
}

/** Mobile-only: release every context. No-op on desktop. */
export async function releaseAllCapacitorLlama(): Promise<void> {
	if (detectBackend() !== "mobile") return;
	try {
		const mod = await loadMobileCapacitor();
		await mod.releaseAllLlama();
	} catch (err) {
		logger.debug(
			{ err: err instanceof Error ? err.message : String(err) },
			"[capacitor-llama] releaseAllLlama not available",
		);
	}
}
