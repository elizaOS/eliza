/**
 * Deterministic speaker → fused Kokoro voice-pack mapping for the voice
 * workbench real lane (#9577 keyless mode). Pure data + hashing, split out of
 * `workbench-real-services.ts` so the mapping is unit-coverable without the
 * fused native library the adapter binds.
 *
 * The agent pack is reserved: it must never collide with a human speaker, or
 * the self-voice margin the echo scenarios measure would collapse by
 * construction — `resolveKokoroVoicePack` can only ever return a human pack.
 */

/** Reserved pack for agent turns; never handed to a human speaker. */
export const KOKORO_AGENT_VOICE = "af_nicole";

export const KOKORO_HUMAN_VOICE_IDS = [
	"af_bella",
	"am_adam",
	"am_michael",
	"af_sarah",
	"bf_emma",
	"bm_george",
	"af_sky",
	"bf_isabella",
	"bm_lewis",
] as const;

/** Scenario speaker labels and explicit voice ids → concrete Kokoro packs. */
export const KOKORO_VOICE_ALIASES: Record<string, string> = {
	af_bella: "af_bella",
	af_sarah: "af_sarah",
	af_sky: "af_sky",
	am_adam: "am_adam",
	am_michael: "am_michael",
	bf_emma: "bf_emma",
	bf_isabella: "bf_isabella",
	bm_george: "bm_george",
	bm_lewis: "bm_lewis",
	owner: "af_bella",
	alice: "af_bella",
	jill: "af_bella",
	bob: "am_adam",
	guest: "am_adam",
	intruder: "am_adam",
	marcus: "am_michael",
	priya: "af_sarah",
	aria: "bf_emma",
};

/** FNV-1a 32-bit — stable across runs so a label always gets the same pack. */
export function labelHash(label: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < label.length; i += 1) {
		h ^= label.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/**
 * Resolve the Kokoro pack for a human turn: the explicit voiceId wins over the
 * speaker label, both case-insensitively; unknown speakers get a stable
 * hash-assigned human pack so a label keeps the same voice across runs.
 */
export function resolveKokoroVoicePack(
	voiceId: string | undefined,
	speakerLabel: string,
): string {
	const keys = [voiceId, speakerLabel].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	for (const key of keys) {
		const mapped = KOKORO_VOICE_ALIASES[key.toLowerCase()];
		if (mapped) return mapped;
	}
	return KOKORO_HUMAN_VOICE_IDS[
		labelHash(speakerLabel) % KOKORO_HUMAN_VOICE_IDS.length
	];
}
