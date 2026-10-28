/**
 * On-device TTS backend selection for the agent voice pipeline.
 *
 * Paradee-8M v1.1 on libelizainference is the product TTS on every device: the
 * desktop agent runs it through the explicit host worker
 * (`src/host-tts-worker.ts`), Android and AOSP through the bundled fused
 * library. Kokoro is no longer a product default. It stays selectable only by
 * an explicit `ELIZA_TTS_BACKEND=kokoro`, for the benchmark and acoustic
 * corpora that still synthesize with Kokoro's multi-voice packs, and is never
 * chosen to cover for a missing Paradee: when Paradee is absent the selector
 * throws so the caller reports local TTS as unavailable instead of silently
 * changing voice.
 */

export type VoiceBackendChoice = "paradee" | "kokoro";

/** `auto` resolves to Paradee; `kokoro` is the explicit opt-in. */
export type VoiceBackendMode = "auto" | "paradee" | "kokoro";

export interface VoiceBackendInputs {
	/** Caller-set mode. Defaults to `auto`. */
	mode?: VoiceBackendMode;
	/** Paradee model files, the fused library and its reviewed digest exist. */
	paradeeAvailable: boolean;
	/** Kokoro artifacts are staged; consulted only for `mode: "kokoro"`. */
	kokoroAvailable?: boolean;
	/** Why Paradee is unavailable, appended to the error. */
	paradeeUnavailableReason?: string;
	/** True on mobile (iOS / Android) builds — informational only. */
	mobile?: boolean;
}

export interface VoiceBackendDecision {
	backend: VoiceBackendChoice;
	/** One-line reason — surfaced to telemetry. */
	reason: string;
}

/** Resolve the env override (`ELIZA_TTS_BACKEND=auto|paradee|kokoro`). */
export function readVoiceBackendModeFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): VoiceBackendMode | undefined {
	const raw = env.ELIZA_TTS_BACKEND?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "auto" || raw === "paradee" || raw === "kokoro") return raw;
	if (raw === "omnivoice") {
		throw new Error(
			"[voice] ELIZA_TTS_BACKEND=omnivoice is retired — OmniVoice TTS was removed; Paradee-8M v1.1 is the on-device TTS backend.",
		);
	}
	throw new Error(
		`[voice] ELIZA_TTS_BACKEND must be 'auto', 'paradee' or 'kokoro' (got '${raw}')`,
	);
}

export function selectVoiceBackend(
	inputs: VoiceBackendInputs,
): VoiceBackendDecision {
	const mode = inputs.mode ?? "auto";
	if (mode === "kokoro") {
		if (!inputs.kokoroAvailable) {
			throw new Error(
				"[voice] ELIZA_TTS_BACKEND=kokoro but the Kokoro model artifacts are not present on disk (stage the Kokoro GGUF + at least one voice .bin under ELIZA_KOKORO_MODEL_DIR).",
			);
		}
		return {
			backend: "kokoro",
			reason:
				"ELIZA_TTS_BACKEND=kokoro (explicit opt-in; not the product voice)",
		};
	}
	if (!inputs.paradeeAvailable) {
		throw new Error(
			`[voice] Paradee-8M v1.1 is the on-device TTS backend and it cannot run here${
				inputs.paradeeUnavailableReason
					? `: ${inputs.paradeeUnavailableReason}`
					: ""
			}. Stage it with packages/app/scripts/paradee-voice/build-native.ts --models-only.`,
		);
	}
	return {
		backend: "paradee",
		reason: inputs.mobile
			? "mobile platform — Paradee-8M v1.1 (product on-device TTS)"
			: "Paradee-8M v1.1 through the host TTS worker (product on-device TTS)",
	};
}
