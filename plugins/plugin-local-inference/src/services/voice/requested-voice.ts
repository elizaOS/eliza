/** Normalizes caller-supplied TTS voice identifiers without confusing provider model or endpoint settings for speaker names. */

import type { TextToSpeechParams } from "@elizaos/core";

/** Read the explicit `voice` contract plus the legacy `voiceId` spelling. */
export function extractRequestedVoiceId(
	params: TextToSpeechParams | string,
): string | undefined {
	if (typeof params !== "object" || params === null) return undefined;
	const legacyVoiceId = (params as TextToSpeechParams & { voiceId?: unknown })
		.voiceId;
	const raw =
		typeof params.voice === "string"
			? params.voice
			: typeof legacyVoiceId === "string"
				? legacyVoiceId
				: undefined;
	const trimmed = raw?.trim();
	return trimmed || undefined;
}

/** Historical Piper / OpenAI voice names mapped to bundled Kokoro ids. */
const KOKORO_VOICE_ALIASES: Readonly<Record<string, string>> = {
	"en_us-female-medium": "af_nicole",
	"en_us-female": "af_bella",
	"en_us-male-medium": "am_michael",
	nova: "af_nova",
	alloy: "af_alloy",
};

/** Resolve compatibility aliases only at the Kokoro-owned engine boundary. */
export function extractRequestedKokoroVoiceId(
	params: TextToSpeechParams | string,
): string | undefined {
	const requested = extractRequestedVoiceId(params);
	if (!requested) return undefined;
	return KOKORO_VOICE_ALIASES[requested.toLowerCase()] ?? requested;
}
