/**
 * Kokoro runtime selector — picks the resolved-runtime path.
 *
 * The env knob is `KOKORO_BACKEND`:
 *
 *   ffi   (default)  → KokoroFfiRuntime → in-process synthesis through the
 *                       fused `libelizainference` handle (the
 *                       `eliza_inference_kokoro_*` exports, introduced at ABI
 *                       v10; the fused library is currently ABI v12). This is
 *                       the SOLE synthesis path on every platform.
 *   mock             → KokoroMockRuntime. Tests only.
 *
 * The legacy `fork` / `server` value (POST `/v1/audio/speech` on a running
 * llama-server) was removed — Kokoro is folded into the fused lib, so there is
 * one runtime, not a duplicate HTTP transport. The "onnx" value was removed
 * earlier with `onnxruntime-node`.
 */

import {
	KokoroFfiRuntime,
	type KokoroFfiRuntimeOptions,
} from "./kokoro-ffi-runtime";
import {
	KokoroMockRuntime,
	type KokoroMockRuntimeOptions,
	type KokoroRuntime,
} from "./kokoro-runtime";

export type KokoroBackendId = "ffi" | "mock";

export interface KokoroBackendInputs {
	/** Override the env-resolved backend (tests / programmatic selection). */
	backend?: KokoroBackendId;
	/** Default backend derived from the discovered model layout. Used when no
	 *  explicit backend and no `KOKORO_BACKEND` env override are set. When
	 *  omitted the selector defaults to the in-process `ffi` path. */
	defaultBackend?: KokoroBackendId;
	/** Construction options for the in-process FFI path. Used iff backend === "ffi". */
	ffi?: KokoroFfiRuntimeOptions;
	/** Construction options for the mock path. */
	mock?: KokoroMockRuntimeOptions;
	/** Override the process.env source. */
	env?: NodeJS.ProcessEnv;
}

export interface KokoroBackendDecision {
	backend: KokoroBackendId;
	/** One-line reason — surfaced to telemetry. */
	reason: string;
	runtime: KokoroRuntime;
}

/**
 * Resolve the `KOKORO_BACKEND` env variable. Throws on an unrecognized value
 * — silent fallback would hide a misconfiguration (AGENTS.md §3 "no silent
 * fallback"). The legacy `fork` / `server` (HTTP) value is rejected with a
 * pointer to the in-process path.
 */
export function readKokoroBackendFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): KokoroBackendId | undefined {
	const raw = env.KOKORO_BACKEND?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "ffi" || raw === "mock") return raw;
	if (raw === "fork" || raw === "server") {
		throw new Error(
			"[voice/kokoro] KOKORO_BACKEND='fork'/'server' (llama-server HTTP) was " +
				"removed — Kokoro runs in-process through the fused libelizainference. " +
				"Use 'ffi' (default).",
		);
	}
	throw new Error(
		`[voice/kokoro] KOKORO_BACKEND must be one of 'ffi', 'mock' (got '${raw}')`,
	);
}

/**
 * Pick the Kokoro runtime backend.
 *
 *   1. Explicit `inputs.backend` wins.
 *   2. Else env (`KOKORO_BACKEND`).
 *   3. Else `inputs.defaultBackend`.
 *   4. Else default → `ffi` (in-process fused handle, the only mobile-safe path).
 *
 * If the chosen backend's options block is missing the call throws a
 * structured error (no silent downgrade). Callers must wire the options
 * for the backends they enable.
 */
export function pickKokoroRuntimeBackend(
	inputs: KokoroBackendInputs,
): KokoroBackendDecision {
	const fromEnv = readKokoroBackendFromEnv(inputs.env);
	const fromDefault = inputs.backend === undefined && fromEnv === undefined;
	const backend: KokoroBackendId =
		inputs.backend ?? fromEnv ?? inputs.defaultBackend ?? "ffi";

	if (backend === "ffi") {
		if (!inputs.ffi) {
			throw new Error(
				"[voice/kokoro] KOKORO_BACKEND=ffi requires `inputs.ffi` " +
					"(layout). Pass the resolved Kokoro layout so the in-process " +
					"fused engine can load the GGUF + voice .bin.",
			);
		}
		return {
			backend,
			reason: inputs.backend
				? "explicit backend=ffi (in-process fused libelizainference)"
				: fromEnv
					? `KOKORO_BACKEND=${fromEnv} → ffi (in-process fused libelizainference)`
					: fromDefault && inputs.defaultBackend === "ffi"
						? "model layout default → ffi (in-process fused libelizainference)"
						: "default → ffi (in-process fused libelizainference)",
			runtime: new KokoroFfiRuntime(inputs.ffi),
		};
	}

	// backend === "mock"
	if (!inputs.mock) {
		throw new Error(
			"[voice/kokoro] KOKORO_BACKEND=mock requires `inputs.mock` " +
				"(sampleRate). Construct the runtime with explicit test options.",
		);
	}
	return {
		backend,
		reason: "explicit backend=mock (test fixture)",
		runtime: new KokoroMockRuntime(inputs.mock),
	};
}
