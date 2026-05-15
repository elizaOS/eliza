/**
 * Samantha-preset placeholder detection + on-the-fly regeneration.
 *
 * Background: the canonical default voice (Samantha, `af_same`) ships with
 * the Eliza-1 bundle as `cache/voice-preset-default.bin` (ELZ1 format).
 * The first I-wave shipped a 1052-byte zero-filled placeholder before the
 * real preset bytes were produced — the runtime treats this placeholder as
 * "not yet generated" and synthesises a fresh preset on first boot via the
 * fused OmniVoice TTS (Path A).
 *
 * The detection rule is intentionally narrow: only an ELZ1 v1/v2 file whose
 * (a) speaker embedding is exactly zero AND (b) ref_audio_tokens / ref_text
 * are empty AND (c) phrase-cache seed is empty counts as a placeholder. Any
 * file that has even one non-zero region is considered real and is left
 * alone — the runtime never silently overwrites operator-supplied presets.
 *
 * The fallback chain executed by `EngineVoiceBridge.start()`:
 *
 *   1. If `cache/voice-preset-default.bin` is missing → throw (existing
 *      behaviour, the bundle is malformed).
 *   2. If the file exists and is NOT a placeholder → load it as-is.
 *   3. If it IS a placeholder AND the OmniVoice reference-encode FFI is
 *      available → regenerate the preset using the bundled Samantha
 *      reference clip + transcript, write the new bytes back to disk,
 *      then load.
 *   4. If it IS a placeholder AND OmniVoice reference-encode is unavailable
 *      → log a loud warning and fall through to `af_bella` (the bundled
 *      cold-start fallback voice) by re-pointing the discovery layer.
 */

import { readFileSync, statSync } from "node:fs";
import {
	readVoicePresetFile,
	VOICE_PRESET_HEADER_BYTES_V1,
	VOICE_PRESET_MAGIC,
	VOICE_PRESET_VERSION_V1,
	VOICE_PRESET_VERSION_V2,
	type VoicePresetFile,
	VoicePresetFormatError,
} from "./voice-preset-format";

/** The exact byte-length the I-wave placeholder shipped at. Used as a fast
 *  pre-check before the more expensive structural parse — files of any
 *  other size cannot be the placeholder. */
export const SAMANTHA_PLACEHOLDER_BYTE_LENGTH = 1052;

/** Reasons `detectSamanthaPlaceholder` returns. Each is structurally
 *  distinct so the caller can branch without re-parsing. */
export type SamanthaPlaceholderState =
	| { kind: "missing" }
	| { kind: "real-preset"; reason: string }
	| { kind: "placeholder" }
	| { kind: "unreadable"; reason: string };

/**
 * Inspect `presetPath` and report whether it is the I-wave zero-fill
 * placeholder, a real preset, missing, or unreadable. Pure I/O — no
 * mutation of the file.
 */
export function detectSamanthaPlaceholder(
	presetPath: string,
): SamanthaPlaceholderState {
	let bytes: Uint8Array;
	try {
		const stat = statSync(presetPath);
		if (!stat.isFile()) {
			return { kind: "unreadable", reason: "path is not a regular file" };
		}
		bytes = new Uint8Array(readFileSync(presetPath));
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return { kind: "missing" };
		return {
			kind: "unreadable",
			reason: (err as Error).message ?? String(err),
		};
	}

	// Fast path: only the exact placeholder byte-length is a candidate.
	if (bytes.byteLength !== SAMANTHA_PLACEHOLDER_BYTE_LENGTH) {
		return { kind: "real-preset", reason: "byte-length mismatch" };
	}

	// Structural path: must parse as ELZ1 v1/v2 with all-zero embedding and
	// empty ref/phrase sections.
	if (bytes.byteLength < VOICE_PRESET_HEADER_BYTES_V1) {
		return { kind: "real-preset", reason: "too short for v1 header" };
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint32(0, true) !== VOICE_PRESET_MAGIC) {
		return { kind: "real-preset", reason: "magic mismatch" };
	}
	const version = view.getUint32(4, true);
	if (
		version !== VOICE_PRESET_VERSION_V1 &&
		version !== VOICE_PRESET_VERSION_V2
	) {
		return { kind: "real-preset", reason: "version mismatch" };
	}

	let parsed: VoicePresetFile;
	try {
		parsed = readVoicePresetFile(bytes);
	} catch (err) {
		// Malformed v2 file — not a placeholder we own; surface as
		// real-preset so the loader's existing error path runs.
		if (err instanceof VoicePresetFormatError) {
			return { kind: "real-preset", reason: `parse failed: ${err.code}` };
		}
		throw err;
	}

	if (parsed.embedding.length === 0) {
		return { kind: "real-preset", reason: "empty embedding section" };
	}
	if (!parsed.embedding.every((v) => v === 0)) {
		return { kind: "real-preset", reason: "non-zero embedding sample" };
	}
	if (parsed.refAudioTokens.tokens.length !== 0) {
		return { kind: "real-preset", reason: "ref_audio_tokens populated" };
	}
	if (parsed.refText.length !== 0) {
		return { kind: "real-preset", reason: "ref_text populated" };
	}
	if (parsed.phrases.length !== 0) {
		return { kind: "real-preset", reason: "phrase-cache seed populated" };
	}

	return { kind: "placeholder" };
}

/**
 * The text the on-the-fly regeneration uses as the Samantha reference
 * transcript. Stable across versions so the produced preset is
 * deterministic — pinning the prompt is part of the cacheability contract
 * (same inputs -> same output bytes for byte-for-byte comparison).
 */
export const SAMANTHA_REFERENCE_TRANSCRIPT =
	"Hi, I'm Samantha. It's nice to finally talk to you about something real.";

/**
 * The closed-vocabulary VoiceDesign instruct string baked into the
 * regenerated Samantha preset. Mirrors the publish-time freeze CLI's
 * settings so the runtime regen and a future operator-built preset land on
 * the same surface. Pinned for deterministic regeneration.
 */
export const SAMANTHA_INSTRUCT =
	"voice=samantha;style=warm-conversational;tempo=medium;pitch=mid-soprano";
