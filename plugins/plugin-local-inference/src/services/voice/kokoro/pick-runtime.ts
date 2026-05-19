/**
 * Kokoro runtime selector — picks between the fork's llama-server
 * `/v1/audio/speech` route (`KokoroGgufRuntime`), the ONNX runtime used by
 * release verification, and the mock runtime (tests only).
 *
 * The env knob is `KOKORO_BACKEND`:
 *
 *   fork  (default)  → KokoroGgufRuntime → POST /v1/audio/speech on the
 *                       running llama-server.
 *   onnx             → KokoroOnnxRuntime → bundled ONNX model + voice pack.
 *   mock             → KokoroMockRuntime. Tests only.
 */

import {
	KokoroGgufRuntime,
	type KokoroGgufRuntimeOptions,
	KokoroMockRuntime,
	type KokoroMockRuntimeOptions,
	KokoroOnnxRuntime,
	type KokoroOnnxRuntimeOptions,
	type KokoroRuntime,
} from "./kokoro-runtime";

export type KokoroBackendId = "fork" | "onnx" | "mock";

export interface KokoroBackendInputs {
	/** Override the env-resolved backend (tests / programmatic selection). */
	backend?: KokoroBackendId;
	/** Default backend derived from the discovered model layout. Used when no
	 *  explicit backend and no `KOKORO_BACKEND` env override are set. */
	defaultBackend?: KokoroBackendId;
	/** Construction options for the fork (HTTP) path. Used iff backend === "fork". */
	fork?: KokoroGgufRuntimeOptions;
	/** Construction options for the ONNX path. Used iff backend === "onnx". */
	onnx?: KokoroOnnxRuntimeOptions;
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
 * fallback").
 */
export function readKokoroBackendFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): KokoroBackendId | undefined {
	const raw = env.KOKORO_BACKEND?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "fork" || raw === "onnx" || raw === "mock") return raw;
	throw new Error(
		`[voice/kokoro] KOKORO_BACKEND must be one of 'fork', 'onnx', 'mock' (got '${raw}')`,
	);
}

/**
 * Pick the Kokoro runtime backend.
 *
 *   1. Explicit `inputs.backend` wins.
 *   2. Else env (`KOKORO_BACKEND`).
 *   3. Else `inputs.defaultBackend`.
 *   4. Else default → `fork`.
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
		inputs.backend ?? fromEnv ?? inputs.defaultBackend ?? "fork";

	if (backend === "fork") {
		if (!inputs.fork) {
			throw new Error(
				"[voice/kokoro] KOKORO_BACKEND=fork requires `inputs.fork` " +
					"(serverUrl + modelId + sampleRate). Configure llama-server " +
					"with --kokoro-model and pass its base URL.",
			);
		}
		return {
			backend,
			reason: inputs.backend
				? "explicit backend=fork (llama-server /v1/audio/speech)"
				: fromEnv
					? `KOKORO_BACKEND=${fromEnv} → fork (llama-server /v1/audio/speech)`
					: fromDefault && inputs.defaultBackend === "fork"
						? "model layout default → fork (llama-server /v1/audio/speech)"
						: "default → fork (llama-server /v1/audio/speech)",
			runtime: new KokoroGgufRuntime(inputs.fork),
		};
	}

	if (backend === "onnx") {
		if (!inputs.onnx) {
			throw new Error(
				"[voice/kokoro] KOKORO_BACKEND=onnx requires `inputs.onnx` " +
					"(layout + optional SHA/runtime options).",
			);
		}
		return {
			backend,
			reason: inputs.backend
				? "explicit backend=onnx (bundled ONNX runtime)"
				: fromEnv
					? `KOKORO_BACKEND=${fromEnv} → onnx (bundled ONNX runtime)`
					: "model layout default → onnx (bundled ONNX runtime)",
			runtime: new KokoroOnnxRuntime(inputs.onnx),
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
