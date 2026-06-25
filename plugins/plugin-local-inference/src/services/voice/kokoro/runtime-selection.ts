/**
 * Voice backend selection — Kokoro is the only on-device TTS backend.
 *
 * OmniVoice TTS was retired (it was an autoregressive LM-based synth: heavier,
 * slower TTFB, and only it could voice-clone). Kokoro (StyleTTS2 / iSTFTNet,
 * non-autoregressive) is faster, smaller, and ships in every bundle — desktop
 * and mobile alike — so the selector collapses to a single auditable answer.
 * The function + env reader are kept (rather than inlined) so the engine layer
 * and tests retain one seam to ask "is a TTS backend available?".
 */

export type VoiceBackendChoice = "kokoro";

/** Retained for the env override; `auto` and `kokoro` both resolve to Kokoro. */
export type VoiceBackendMode = "kokoro" | "auto";

export interface VoiceBackendInputs {
	/** Caller-set mode. Defaults to `auto`; both modes resolve to Kokoro. */
	mode?: VoiceBackendMode;
	/** Whether Kokoro model artifacts are present on disk. The selector throws
	 *  rather than returning a backend when this is `false` — no silent downgrade. */
	kokoroAvailable: boolean;
	/** True on mobile (iOS / Android) builds — informational only now. */
	mobile?: boolean;
}

export interface VoiceBackendDecision {
	backend: VoiceBackendChoice;
	/** One-line reason — surfaced to telemetry. */
	reason: string;
}

/** Resolve the env override (`ELIZA_TTS_BACKEND=kokoro|auto`). */
export function readVoiceBackendModeFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): VoiceBackendMode | undefined {
	const raw = env.ELIZA_TTS_BACKEND?.trim().toLowerCase();
	if (!raw) return undefined;
	if (raw === "kokoro" || raw === "auto") return raw;
	if (raw === "omnivoice") {
		throw new Error(
			"[voice] ELIZA_TTS_BACKEND=omnivoice is retired — OmniVoice TTS was removed; Kokoro is the only on-device TTS backend.",
		);
	}
	throw new Error(
		`[voice] ELIZA_TTS_BACKEND must be 'kokoro' or 'auto' (got '${raw}')`,
	);
}

export function selectVoiceBackend(
	inputs: VoiceBackendInputs,
): VoiceBackendDecision {
	if (!inputs.kokoroAvailable) {
		throw new Error(
			"[voice] Kokoro model artifacts are not present on disk; Kokoro is the only on-device TTS backend (install an Eliza-1 bundle or stage the Kokoro GGUF + at least one voice .bin).",
		);
	}
	return {
		backend: "kokoro",
		reason: inputs.mobile
			? "mobile platform — Kokoro (the only on-device TTS backend)"
			: "Kokoro (the only on-device TTS backend)",
	};
}
