/**
 * Kokoro ONNX Runtime execution-provider config — RFC #7667 scaffold.
 *
 * Standalone config knob for selecting the ORT execution provider used by the
 * Kokoro TTS runtime. Adds NPU / accelerator readiness without changing any
 * default behavior: `"cpu"` is the only provider that resolves to anything,
 * every other provider value resolves to the same CPU session options. Future
 * PRs replace the resolver body to emit real NNAPI / XNNPACK / Core ML option
 * blocks once the underlying `onnxruntime-react-native` build (with `--use_nnapi`)
 * and on-device probe land.
 *
 * Why this module lives outside `./kokoro/`:
 *   RFC #7666 is concurrently relocating `./kokoro/` to `packages/shared/src/kokoro/`.
 *   Keeping this config in a sibling module avoids merge conflict with that move
 *   and lets the future NPU PR cherry-pick the wire-up edit into the new location
 *   in one place. The exact line to edit is documented in
 *   `docs/rfc/7667-npu-kokoro-android.md`.
 *
 * Design constraints (per AGENTS.md):
 *   - Default behavior MUST be unchanged. `resolveKokoroOrtExecutionProviders()`
 *     called with no override returns `["cpu"]`, matching the current literal.
 *   - No new runtime dependencies. `onnxruntime-react-native` is NOT pulled in.
 *   - No `any`, no swallowed errors. Invalid env-var values surface as a typed
 *     error so a misconfigured deployment fails fast instead of silently using CPU.
 *   - No fallback sludge. If a non-CPU provider is requested but its session
 *     options have not been implemented yet, this module throws — the caller
 *     decides whether to retry on CPU or surface the error. We do not paper
 *     over an unimplemented accelerator with a silent CPU downgrade.
 */

/**
 * Canonical execution-provider identifiers. Add a new value here when wiring
 * a new accelerator; the union is intentionally narrow so misspellings fail
 * to type-check at the callsite.
 */
export type KokoroExecutionProvider = "cpu" | "nnapi" | "xnnpack" | "coreml";

export const KOKORO_EXECUTION_PROVIDERS: ReadonlyArray<KokoroExecutionProvider> =
	["cpu", "nnapi", "xnnpack", "coreml"] as const;

/** Default — never changes without an RFC. */
export const DEFAULT_KOKORO_EXECUTION_PROVIDER: KokoroExecutionProvider = "cpu";

/** Env var read by `readKokoroExecutionProviderFromEnv`. */
export const KOKORO_EXECUTION_PROVIDER_ENV = "ELIZA_KOKORO_EXECUTION_PROVIDER";

/** Raised when an invalid provider value is supplied (env or config). */
export class KokoroExecutionProviderConfigError extends Error {
	readonly code = "kokoro-execution-provider-config" as const;
	constructor(message: string) {
		super(message);
		this.name = "KokoroExecutionProviderConfigError";
	}
}

/** Raised when a provider is recognized but not yet wired to ORT options. */
export class KokoroExecutionProviderNotImplementedError extends Error {
	readonly code = "kokoro-execution-provider-not-implemented" as const;
	readonly provider: KokoroExecutionProvider;
	constructor(provider: KokoroExecutionProvider, message: string) {
		super(message);
		this.name = "KokoroExecutionProviderNotImplementedError";
		this.provider = provider;
	}
}

/** Type-guard: narrow an arbitrary string to a known provider id. */
export function isKokoroExecutionProvider(
	value: string,
): value is KokoroExecutionProvider {
	return (KOKORO_EXECUTION_PROVIDERS as ReadonlyArray<string>).includes(value);
}

/**
 * Parse the env-var. Returns `null` when unset (so callers fall through to the
 * default), the parsed provider when valid, or throws on a malformed value.
 *
 * Intentionally strict: a typo in deployment config should fail loudly rather
 * than silently degrade to CPU.
 */
export function readKokoroExecutionProviderFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): KokoroExecutionProvider | null {
	const raw = env[KOKORO_EXECUTION_PROVIDER_ENV];
	if (raw === undefined || raw === "") return null;
	const normalised = raw.trim().toLowerCase();
	if (!isKokoroExecutionProvider(normalised)) {
		throw new KokoroExecutionProviderConfigError(
			`[kokoro] invalid ${KOKORO_EXECUTION_PROVIDER_ENV}=${JSON.stringify(raw)}; ` +
				`expected one of ${KOKORO_EXECUTION_PROVIDERS.join(", ")}`,
		);
	}
	return normalised;
}

/**
 * Resolve a provider name into the `executionProviders` value passed to
 * `ort.InferenceSession.create`. Only `"cpu"` is fully implemented; the
 * other branches exist to lock the contract and will be filled in by the
 * NPU PR (see `docs/rfc/7667-npu-kokoro-android.md`).
 *
 * Returning `["cpu"]` from this function (when the caller passes `"cpu"` or
 * omits the argument) is bit-identical to the current literal at the
 * Kokoro ORT session-create site, so wiring this resolver in is a no-op
 * for the default config.
 */
export function resolveKokoroOrtExecutionProviders(
	provider: KokoroExecutionProvider = DEFAULT_KOKORO_EXECUTION_PROVIDER,
): ReadonlyArray<string> {
	switch (provider) {
		case "cpu":
			return ["cpu"];
		case "nnapi":
			throw new KokoroExecutionProviderNotImplementedError(
				"nnapi",
				`[kokoro] NNAPI execution provider is not wired yet. ` +
					`The default onnxruntime-react-native build does not include the NNAPI EP; ` +
					`a custom build with --use_nnapi is required. See plugins/plugin-aosp-local-inference/README.md ` +
					`and docs/rfc/7667-npu-kokoro-android.md.`,
			);
		case "xnnpack":
			throw new KokoroExecutionProviderNotImplementedError(
				"xnnpack",
				`[kokoro] XNNPACK execution provider is not wired yet. ` +
					`See docs/rfc/7667-npu-kokoro-android.md for the planned wire-up.`,
			);
		case "coreml":
			throw new KokoroExecutionProviderNotImplementedError(
				"coreml",
				`[kokoro] Core ML execution provider is not wired yet. ` +
					`See docs/rfc/7667-npu-kokoro-android.md for the planned wire-up.`,
			);
	}
}
