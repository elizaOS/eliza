/**
 * Kokoro runtime selector — picks the resolved-runtime path.
 *
 * The env knob is `KOKORO_BACKEND`:
 *
 *   ffi   (default)  → KokoroFfiRuntime → in-process synthesis through the
 *                       fused `libelizainference` handle (ABI v10
 *                       `eliza_inference_kokoro_*`). This is the only path that
 *                       ships on iOS / Google Play — those platforms forbid the
 *                       app opening a local TCP socket, so the llama-server
 *                       `/v1/audio/speech` route cannot be used there.
 *   fork / server    → KokoroGgufRuntime → POST /v1/audio/speech on the
 *                       running llama-server. Dev/desktop opt-in only; NEVER
 *                       resolved on the mobile path.
 *   mock             → KokoroMockRuntime. Tests only.
 *
 * The "onnx" value is no longer accepted — `onnxruntime-node` was removed.
 */

import {
	KokoroFfiRuntime,
	type KokoroFfiRuntimeOptions,
} from "./kokoro-ffi-runtime";
import {
	KokoroGgufRuntime,
	type KokoroGgufRuntimeOptions,
	KokoroMockRuntime,
	type KokoroMockRuntimeOptions,
	type KokoroRuntime,
} from "./kokoro-runtime";

export type KokoroBackendId = "ffi" | "fork" | "mock";

export interface KokoroBackendInputs {
	/** Override the env-resolved backend (tests / programmatic selection). */
	backend?: KokoroBackendId;
	/** Default backend derived from the discovered model layout. Used when no
	 *  explicit backend and no `KOKORO_BACKEND` env override are set. When
	 *  omitted the selector defaults to the in-process `ffi` path. */
	defaultBackend?: KokoroBackendId;
	/** Construction options for the in-process FFI path. Used iff backend === "ffi". */
	ffi?: KokoroFfiRuntimeOptions;
	/** Construction options for the fork (HTTP) path. Used iff backend === "fork". */
	fork?: KokoroGgufRuntimeOptions;
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
 * fallback"). `server` is accepted as an alias for the `fork` (HTTP) path.
 */
export function readKokoroBackendFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): KokoroBackendId | undefined {
	const raw = env.KOKORO_BACKEND?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "ffi" || raw === "fork" || raw === "mock") return raw;
	if (raw === "server") return "fork";
	throw new Error(
		`[voice/kokoro] KOKORO_BACKEND must be one of 'ffi', 'fork' ('server' alias), 'mock' (got '${raw}')`,
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
