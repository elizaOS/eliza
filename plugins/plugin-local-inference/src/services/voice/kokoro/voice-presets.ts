/**
 * Registry of bundled Kokoro voice packs (upstream: hexgrad/Kokoro-82M).
 *
 * Each entry maps a stable `KokoroVoiceId` (the `voices/<id>.bin` filename
 * Kokoro ships) onto display metadata. The runtime resolves a caller's
 * `SpeakerPreset.voiceId` against this table; an unknown id falls through to
 * the backend's `defaultVoiceId`.
 *
 * The actual style tensor lives at `<modelRoot>/voices/<file>` and is loaded
 * lazily on first use. English packs below match the full US/UK set from
 * onnx-community/Kokoro-82M-v1.0-ONNX; non-English packs stay out of this
 * table until the runtime phonemizer path for those langs is wired.
 *
 * Reference: https://huggingface.co/hexgrad/Kokoro-82M
 */

import type { KokoroVoicePack } from "./types";

export const KOKORO_VOICE_PACKS: ReadonlyArray<KokoroVoicePack> = [
	// American English — female
	{
		id: "af_heart",
		displayName: "Heart (US English)",
		lang: "a",
		file: "af_heart.bin",
		dim: 256,
		tags: ["female", "warm", "high-quality"],
	},
	{
		id: "af_bella",
		displayName: "Bella (US English)",
		lang: "a",
		file: "af_bella.bin",
		dim: 256,
		tags: ["female", "warm", "default"],
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
		id: "af_sarah",
		displayName: "Sarah (US English)",
		lang: "a",
		file: "af_sarah.bin",
		dim: 256,
		tags: ["female", "professional"],
	},
	{
		id: "af_sky",
		displayName: "Sky (US English)",
		lang: "a",
		file: "af_sky.bin",
		dim: 256,
		tags: ["female", "young"],
	},
	{
		id: "af_alloy",
		displayName: "Alloy (US English)",
		lang: "a",
		file: "af_alloy.bin",
		dim: 256,
		tags: ["female"],
	},
	{
		id: "af_aoede",
		displayName: "Aoede (US English)",
		lang: "a",
		file: "af_aoede.bin",
		dim: 256,
		tags: ["female"],
	},
	{
		id: "af_kore",
		displayName: "Kore (US English)",
		lang: "a",
		file: "af_kore.bin",
		dim: 256,
		tags: ["female"],
	},
	{
		id: "af_nova",
		displayName: "Nova (US English)",
		lang: "a",
		file: "af_nova.bin",
		dim: 256,
		tags: ["female"],
	},
	{
		id: "af_jessica",
		displayName: "Jessica (US English)",
		lang: "a",
		file: "af_jessica.bin",
		dim: 256,
		tags: ["female"],
	},
	{
		id: "af_river",
		displayName: "River (US English)",
		lang: "a",
		file: "af_river.bin",
		dim: 256,
		tags: ["female"],
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
		id: "am_fenrir",
		displayName: "Fenrir (US English)",
		lang: "a",
		file: "am_fenrir.bin",
		dim: 256,
		tags: ["male"],
	},
	{
		id: "am_puck",
		displayName: "Puck (US English)",
		lang: "a",
		file: "am_puck.bin",
		dim: 256,
		tags: ["male"],
	},
	{
		id: "am_adam",
		displayName: "Adam (US English)",
		lang: "a",
		file: "am_adam.bin",
		dim: 256,
		tags: ["male", "neutral"],
	},
	{
		id: "am_echo",
		displayName: "Echo (US English)",
		lang: "a",
		file: "am_echo.bin",
		dim: 256,
		tags: ["male"],
	},
	{
		id: "am_eric",
		displayName: "Eric (US English)",
		lang: "a",
		file: "am_eric.bin",
		dim: 256,
		tags: ["male"],
	},
	{
		id: "am_liam",
		displayName: "Liam (US English)",
		lang: "a",
		file: "am_liam.bin",
		dim: 256,
		tags: ["male"],
	},
	{
		id: "am_onyx",
		displayName: "Onyx (US English)",
		lang: "a",
		file: "am_onyx.bin",
		dim: 256,
		tags: ["male"],
	},
	{
		id: "am_santa",
		displayName: "Santa (US English)",
		lang: "a",
		file: "am_santa.bin",
		dim: 256,
		tags: ["male", "character"],
	},
	// British English — female
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
		id: "bf_alice",
		displayName: "Alice (British English)",
		lang: "b",
		file: "bf_alice.bin",
		dim: 256,
		tags: ["female", "british"],
	},
	{
		id: "bf_lily",
		displayName: "Lily (British English)",
		lang: "b",
		file: "bf_lily.bin",
		dim: 256,
		tags: ["female", "british"],
	},
	// British English — male
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
	{
		id: "bm_daniel",
		displayName: "Daniel (British English)",
		lang: "b",
		file: "bm_daniel.bin",
		dim: 256,
		tags: ["male", "british"],
	},
	{
		id: "bm_fable",
		displayName: "Fable (British English)",
		lang: "b",
		file: "bm_fable.bin",
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
export const KOKORO_DEFAULT_VOICE_ID = "af_same";

/** Conservative fallback voice when a configured/default preset is not staged. */
export const KOKORO_FALLBACK_VOICE_ID = "af_bella";
