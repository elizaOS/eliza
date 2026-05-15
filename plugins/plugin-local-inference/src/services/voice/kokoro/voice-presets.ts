/**
 * Registry of bundled Kokoro voice packs (upstream: hexgrad/Kokoro-82M).
 *
 * Each entry maps a stable `KokoroVoiceId` (the `voices/<id>.bin` filename
 * Kokoro ships) onto display metadata. The runtime resolves a caller's
 * `SpeakerPreset.voiceId` against this table; an unknown id falls through to
 * the backend's `defaultVoiceId`.
 *
 * The actual style tensor (256 fp32 values) lives at
 * `<modelRoot>/voices/<file>` and is loaded lazily on first use.
 *
 * Reference: https://huggingface.co/hexgrad/Kokoro-82M
 */

import type { KokoroVoicePack } from "./types";

export const KOKORO_VOICE_PACKS: ReadonlyArray<KokoroVoicePack> = [
	// American English — female
	{
		id: "af_bella",
		displayName: "Bella (US English)",
		lang: "a",
		file: "af_bella.bin",
		dim: 256,
		tags: ["female", "warm", "default"],
	},
	{
		id: "af_sarah",
		displayName: "Sarah (US English)",
		lang: "a",
		file: "af_sarah.bin",
		dim: 256,
		tags: ["female", "professional"],
	},
	{
		id: "af_nicole",
		displayName: "Nicole (US English, breathy)",
		lang: "a",
		file: "af_nicole.bin",
		dim: 256,
		tags: ["female", "breathy"],
	},
	{
		id: "af_sky",
		displayName: "Sky (US English)",
		lang: "a",
		file: "af_sky.bin",
		dim: 256,
		tags: ["female", "young"],
	},
	// American English — male
	{
		id: "am_michael",
		displayName: "Michael (US English)",
		lang: "a",
		file: "am_michael.bin",
		dim: 256,
		tags: ["male", "warm"],
	},
	{
		id: "am_adam",
		displayName: "Adam (US English)",
		lang: "a",
		file: "am_adam.bin",
		dim: 256,
		tags: ["male", "neutral"],
	},
	// British English
	{
		id: "bf_emma",
		displayName: "Emma (British English)",
		lang: "b",
		file: "bf_emma.bin",
		dim: 256,
		tags: ["female", "british"],
	},
	{
		id: "bf_isabella",
		displayName: "Isabella (British English)",
		lang: "b",
		file: "bf_isabella.bin",
		dim: 256,
		tags: ["female", "british"],
	},
	{
		id: "bm_george",
		displayName: "George (British English)",
		lang: "b",
		file: "bm_george.bin",
		dim: 256,
		tags: ["male", "british"],
	},
	{
		id: "bm_lewis",
		displayName: "Lewis (British English)",
		lang: "b",
		file: "bm_lewis.bin",
		dim: 256,
		tags: ["male", "british"],
	},
	// Eliza-1 fine-tuned voice — same (research-only, derivative of *Her* 2013).
	// Voice pack lives at `elizaos/eliza-1` under `voice/kokoro/voices/af_same.bin`
	// (first push is private; do not promote to default without a public-release sign-off).
	// Source corpus: `lalalune/ai_voices/sam` upstream subset, landed locally as
	// `same` (58 clips, 3.51 min, research-only).
	// Voice id obeys the Kokoro `<lang><sex>_<name>` convention (US English, female).
	{
		id: "af_same",
		displayName: "Same (Eliza-1, US English)",
		lang: "a",
		file: "af_same.bin",
		dim: 256,
		tags: ["female", "same", "eliza-1-voice", "research-only"],
	},
];

const VOICE_BY_ID = new Map(KOKORO_VOICE_PACKS.map((v) => [v.id, v] as const));

/** Look up a voice pack by id. Returns `undefined` for unknown ids — the
 *  backend chooses how to fall back (typically `defaultVoiceId`). */
export function findKokoroVoice(id: string): KokoroVoicePack | undefined {
	return VOICE_BY_ID.get(id);
}

/** The voice the runtime selects when nothing is configured. */
export const KOKORO_DEFAULT_VOICE_ID = "af_bella";

/** Conservative fallback voice when a configured/default preset is not staged. */
export const KOKORO_FALLBACK_VOICE_ID = "af_bella";
