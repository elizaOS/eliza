/**
 * The pinned ASR model the host ASR worker verifies and loads.
 *
 * `<root>/asr/` holds Phonon-2 (Parakeet-TDT 0.6B, five-value weights;
 * FermionResearch/Phonon-2, CC-BY-4.0) as `asr/phonon-2-fv5.gguf`, served by
 * libelizainference's Parakeet-TDT backend. Phonon-2 is the only local ASR.
 * `asr/` must hold no other GGUF, so the library can load nothing but the
 * bytes the worker hashed. `ELIZA_ASR_BACKEND`, which the library reads in
 * the ASR calls, must select the in-tree ggml implementation. The native
 * registry also honors ELIZA_BACKEND when the per-operation override is empty.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PinnedSpeechAsset } from "./host-speech-runtime";

/**
 * Phonon-2 converted by elizaOS/llama.cpp tools/parakeet/convert_phonon2_to_gguf.py
 * from FermionResearch/Phonon-2@7e153e4054c0a10db6d47d6fff5c062d4c77c154
 * (byte-reproducible; the same pin as the `mobile-voice` catalog row
 * `phonon-2-fv5`). Build it with
 * `bun packages/app/scripts/voice/build-phonon2-gguf.ts`.
 */
export const PHONON_ASR_ASSETS: readonly PinnedSpeechAsset[] = [
	{
		path: "asr/phonon-2-fv5.gguf",
		sha256: "dc552eb786486167dde3ac80bbe49a6088c8ef39c03c257d5a090fc57b2c47b3",
		bytes: 330_632_256,
	},
];

/**
 * Check that `<root>/asr/` holds only the Phonon-2 GGUF and that
 * the effective backend override selects the in-tree ggml path. Throws a fixed message
 * otherwise. Hashing is the caller's job.
 */
export function selectHostAsrAssets(
	root: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
): readonly PinnedSpeechAsset[] {
	// Match backend-registry.h: case-insensitive aliases, no whitespace trimming.
	const forced = (
		env.ELIZA_ASR_BACKEND ||
		env.ELIZA_BACKEND ||
		""
	).toLowerCase();
	if (
		![
			"",
			"ggml",
			"llama.cpp",
			"llamacpp",
			"llama",
			"intree",
			"default",
		].includes(forced)
	)
		throw Error("Invalid speech ASR backend");
	const expected = PHONON_ASR_ASSETS.map((asset) =>
		asset.path.slice("asr/".length),
	).sort();
	const present = readdirSync(join(root, "asr"), {
		recursive: true,
		encoding: "utf8",
	})
		.filter((file) => file.endsWith(".gguf"))
		.sort();
	if (
		present.length !== expected.length ||
		expected.some((name, i) => present[i] !== name)
	)
		throw Error("Ambiguous speech ASR model");
	return PHONON_ASR_ASSETS;
}
