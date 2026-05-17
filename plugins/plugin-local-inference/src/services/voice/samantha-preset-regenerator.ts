/**
 * Samantha-preset on-the-fly regeneration via the fused OmniVoice FFI.
 *
 * Path A from W3-11: when the bundle ships the I-wave zero-fill placeholder
 * for `cache/voice-preset-default.bin`, the runtime synthesises a real
 * preset by encoding the bundled Samantha reference clip through the FFI's
 * `eliza_inference_encode_reference` entrypoint and writing the resulting
 * `ref_audio_tokens` + canonical instruct/refText into a v2 preset blob.
 *
 * Determinism contract:
 *   - The reference clip bytes (24 kHz mono fp32 WAV) are pinned in the
 *     bundle.
 *   - The reference transcript (`SAMANTHA_REFERENCE_TRANSCRIPT`) is pinned.
 *   - The instruct string (`SAMANTHA_INSTRUCT`) is pinned.
 *   - The OmniVoice encode entrypoint does not consume randomness (the
 *     HuBERT semantic + RVQ codec passes are pure functions of the input
 *     PCM + the model weights).
 * Therefore the produced preset bytes are reproducible byte-for-byte across
 * boots given the same FFI library + bundle.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	type ElizaInferenceContextHandle,
	type ElizaInferenceFfi,
	loadElizaInferenceFfi,
} from "./ffi-bindings";
import {
	detectSamanthaPlaceholder,
	SAMANTHA_INSTRUCT,
	SAMANTHA_REFERENCE_TRANSCRIPT,
} from "./samantha-preset-placeholder";
import { writeVoicePresetFileV2 } from "./voice-preset-format";

/** Outcome of `ensureSamanthaPresetReady`. Distinct kinds let the caller
 *  log the right thing at the right level without re-doing detection. */
export type EnsureSamanthaPresetOutcome =
	| { kind: "real-preset" }
	| { kind: "missing-bundle-preset" }
	| { kind: "regenerated"; bytes: number; K: number; refT: number }
	| {
			kind: "placeholder-no-regen";
			reason:
				| "missing-reference-wav"
				| "missing-ffi-library"
				| "ffi-no-encode-reference"
				| "encode-reference-failed";
			detail: string;
	  };

export interface RegenerateOptions {
	bundleRoot: string;
	/** Absolute path the regenerated preset bytes should target. The caller
	 *  performs the write — this function only produces the bytes + metadata. */
	presetPath: string;
	/** Override path to the Samantha reference WAV. Defaults to the bundle's
	 *  `tts/omnivoice/samantha-ref.wav`. */
	referenceWav?: string;
	/** Override the canonical reference transcript. Defaults to the pinned
	 *  `SAMANTHA_REFERENCE_TRANSCRIPT`. */
	referenceText?: string;
}

export interface RegenerateResult {
	bytes: Uint8Array;
	K: number;
	refT: number;
	embeddingDim: number;
}

/**
 * Platform-specific filenames probed when locating the OmniVoice fused
 * shared library inside a bundle. Mirrors the matching helper inside
 * `engine-bridge.ts` (kept private there); regenerator and bridge resolve
 * the same set of names so a bundle that loads at boot also loads at
 * regeneration time.
 */
function libraryFilenames(): string[] {
	if (process.platform === "darwin") return ["libelizainference.dylib"];
	if (process.platform === "win32") {
		return ["elizainference.dll", "libelizainference.dll"];
	}
	return ["libelizainference.so"];
}

function locateBundleLibrary(bundleRoot: string): string {
	const exact = process.env.ELIZA_INFERENCE_LIBRARY?.trim();
	if (exact && existsSync(exact)) return exact;
	const dirs = [
		path.join(bundleRoot, "lib"),
		exact ? path.dirname(exact) : null,
		process.env.ELIZA_INFERENCE_LIB_DIR?.trim() || null,
	].filter((dir): dir is string => Boolean(dir));
	for (const dir of dirs) {
		for (const name of libraryFilenames()) {
			const candidate = path.join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return path.join(
		dirs[0] ?? path.join(bundleRoot, "lib"),
		libraryFilenames()[0] ?? "libelizainference.so",
	);
}

/**
 * Decode a 24 kHz mono Float32 LE WAV file into a Float32Array of PCM
 * samples. Refuses anything that is not the canonical OmniVoice reference
 * format — encoders happily accept stereo / 16-bit / 48 kHz inputs and
 * silently degrade, which is exactly the kind of fallback sludge AGENTS.md
 * §3 forbids. We require the file be in the right format up front.
 */
export function decodeMonoFloat32Wav24kHz(bytes: Uint8Array): Float32Array {
	if (bytes.byteLength < 44) {
		throw new Error(
			`[samantha-regen] reference WAV too small (${bytes.byteLength} bytes, need >= 44 for header)`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const riff = String.fromCharCode(...bytes.subarray(0, 4));
	const wave = String.fromCharCode(...bytes.subarray(8, 12));
	if (riff !== "RIFF" || wave !== "WAVE") {
		throw new Error(
			`[samantha-regen] reference WAV bad magic: RIFF=${JSON.stringify(riff)} WAVE=${JSON.stringify(wave)}`,
		);
	}

	// Walk chunks for "fmt " + "data".
	let cursor = 12;
	let fmtOffset = -1;
	let fmtLen = 0;
	let dataOffset = -1;
	let dataLen = 0;
	while (cursor + 8 <= bytes.byteLength) {
		const id = String.fromCharCode(...bytes.subarray(cursor, cursor + 4));
		const size = view.getUint32(cursor + 4, true);
		const payload = cursor + 8;
		if (id === "fmt ") {
			fmtOffset = payload;
			fmtLen = size;
		} else if (id === "data") {
			dataOffset = payload;
			dataLen = size;
			break;
		}
		cursor = payload + size + (size % 2); // pad byte
	}
	if (fmtOffset < 0 || dataOffset < 0) {
		throw new Error("[samantha-regen] reference WAV missing fmt or data chunk");
	}
	const audioFormat = view.getUint16(fmtOffset + 0, true);
	const channels = view.getUint16(fmtOffset + 2, true);
	const sampleRate = view.getUint32(fmtOffset + 4, true);
	const bitsPerSample = view.getUint16(fmtOffset + 14, true);

	// Accept WAVE_FORMAT_IEEE_FLOAT (3) or WAVE_FORMAT_EXTENSIBLE (0xFFFE)
	// with 32-bit float samples.
	const isFloat =
		(audioFormat === 3 && bitsPerSample === 32) ||
		(audioFormat === 0xfffe && bitsPerSample === 32 && fmtLen >= 40);
	if (!isFloat) {
		throw new Error(
			`[samantha-regen] reference WAV must be 32-bit float PCM (got format=${audioFormat}, bps=${bitsPerSample})`,
		);
	}
	if (channels !== 1) {
		throw new Error(
			`[samantha-regen] reference WAV must be mono (got ${channels} channels)`,
		);
	}
	if (sampleRate !== 24_000) {
		throw new Error(
			`[samantha-regen] reference WAV must be 24 kHz (got ${sampleRate})`,
		);
	}

	const sampleCount = Math.floor(dataLen / 4);
	// Copy into an aligned buffer (the input slice is not guaranteed
	// 4-aligned; Float32Array constructor requires alignment).
	const aligned = new Uint8Array(sampleCount * 4);
	aligned.set(bytes.subarray(dataOffset, dataOffset + sampleCount * 4));
	return new Float32Array(aligned.buffer);
}

/**
 * Run the on-the-fly regeneration. Loads the bundle's OmniVoice FFI, calls
 * `encodeReference` against the Samantha reference clip, and serialises the
 * result into an ELZ1 v2 preset blob. The caller writes the bytes to disk.
 */
export async function regenerateSamanthaPresetFromBundle(
	opts: RegenerateOptions,
): Promise<RegenerateResult> {
	const refWav =
		opts.referenceWav ??
		path.join(opts.bundleRoot, "tts", "omnivoice", "samantha-ref.wav");
	if (!existsSync(refWav)) {
		throw new Error(
			`[samantha-regen] Samantha reference WAV not found at ${refWav}. The bundle is missing the OmniVoice samantha reference clip.`,
		);
	}

	const libPath = locateBundleLibrary(opts.bundleRoot);
	if (!existsSync(libPath)) {
		throw new Error(
			`[samantha-regen] OmniVoice FFI library not found under ${path.join(
				opts.bundleRoot,
				"lib",
			)} (tried ${libraryFilenames().join(", ")}). Build via packages/app-core/scripts/build-llama-cpp-dflash.mjs (omnivoice-merged target).`,
		);
	}

	const ffi: ElizaInferenceFfi = loadElizaInferenceFfi(libPath);
	let ctx: ElizaInferenceContextHandle | null = null;
	let ttsAcquired = false;
	try {
		if (
			typeof ffi.encodeReferenceSupported !== "function" ||
			!ffi.encodeReferenceSupported()
		) {
			throw new Error(
				"[samantha-regen] this OmniVoice build does not export eliza_inference_encode_reference (ABI v4 required). Rebuild with the encode-reference target.",
			);
		}
		if (typeof ffi.encodeReference !== "function") {
			throw new Error(
				"[samantha-regen] FFI binding missing encodeReference method despite encodeReferenceSupported()=true",
			);
		}

		ctx = ffi.create(opts.bundleRoot);
		ffi.mmapAcquire(ctx, "tts");
		ttsAcquired = true;

		const wavBytes = new Uint8Array(readFileSync(refWav));
		const pcm = decodeMonoFloat32Wav24kHz(wavBytes);

		const encoded = ffi.encodeReference({
			ctx,
			pcm,
			sampleRateHz: 24_000,
		});
		if (encoded.K <= 0 || encoded.refT <= 0) {
			throw new Error(
				`[samantha-regen] encode_reference returned empty tensor (K=${encoded.K}, refT=${encoded.refT})`,
			);
		}

		// The FFI encode pass produces ref_audio_tokens; the speaker
		// embedding section stays empty (OmniVoice resolves the speaker
		// identity from the tokens, not from a separate embedding vector).
		const embedding = new Float32Array(0);
		const refText = opts.referenceText ?? SAMANTHA_REFERENCE_TRANSCRIPT;
		const instruct = SAMANTHA_INSTRUCT;
		const metadata: Record<string, unknown> = {
			generator: "samantha-preset-regenerator",
			generatorVersion: 1,
			referenceWavPath: path.basename(refWav),
			referenceWavBytes: wavBytes.byteLength,
			referenceText: refText,
			instruct,
			K: encoded.K,
			refT: encoded.refT,
		};

		const bytes = writeVoicePresetFileV2({
			embedding,
			phrases: [],
			refAudioTokens: {
				K: encoded.K,
				refT: encoded.refT,
				tokens: encoded.tokens,
			},
			refText,
			instruct,
			metadata,
		});

		return {
			bytes,
			K: encoded.K,
			refT: encoded.refT,
			embeddingDim: 0,
		};
	} finally {
		if (ctx !== null) {
			if (ttsAcquired) {
				try {
					ffi.mmapEvict(ctx, "tts");
				} catch {
					// Evict is best-effort during regeneration; destroy below
					// tears down the context either way.
				}
			}
			try {
				ffi.destroy(ctx);
			} catch {
				// Destroy is best-effort during regeneration; the OS reclaims
				// the context on process exit.
			}
		}
		try {
			ffi.close();
		} catch {
			// Same — close is best-effort.
		}
	}
}

/**
 * Pre-flight: detect a placeholder preset at the bundle's canonical path
 * and regenerate it via OmniVoice when possible. Called by
 * `EngineVoiceBridge.start()` (via `ensureActiveBundleVoiceReady`) before
 * the synchronous preset load.
 *
 * Outcomes:
 *
 *   - `real-preset`            — nothing to do; the file is a real preset.
 *   - `missing-bundle-preset`  — file does not exist; the bridge's existing
 *                                error path runs (loud failure).
 *   - `regenerated`            — preset bytes were generated and written.
 *   - `placeholder-no-regen`   — placeholder detected but regen could not
 *                                run (FFI missing, reference clip missing,
 *                                etc.). Returned for the caller to log; the
 *                                bridge then falls through to af_bella via
 *                                discovery's fallback chain.
 */
export async function ensureSamanthaPresetReady(
	bundleRoot: string,
): Promise<EnsureSamanthaPresetOutcome> {
	const presetPath = path.join(bundleRoot, "cache", "voice-preset-default.bin");
	const state = detectSamanthaPlaceholder(presetPath);

	if (state.kind === "missing") {
		return { kind: "missing-bundle-preset" };
	}
	if (state.kind === "real-preset") {
		return { kind: "real-preset" };
	}
	if (state.kind === "unreadable") {
		return {
			kind: "placeholder-no-regen",
			reason: "missing-ffi-library", // closest match — file is unreadable
			detail: state.reason,
		};
	}

	// Placeholder detected. Try to regenerate.
	const refWav = path.join(bundleRoot, "tts", "omnivoice", "samantha-ref.wav");
	if (!existsSync(refWav)) {
		return {
			kind: "placeholder-no-regen",
			reason: "missing-reference-wav",
			detail: refWav,
		};
	}
	const libPath = locateBundleLibrary(bundleRoot);
	if (!existsSync(libPath)) {
		return {
			kind: "placeholder-no-regen",
			reason: "missing-ffi-library",
			detail: libPath,
		};
	}

	let result: RegenerateResult;
	try {
		result = await regenerateSamanthaPresetFromBundle({
			bundleRoot,
			presetPath,
			referenceWav: refWav,
			referenceText: SAMANTHA_REFERENCE_TRANSCRIPT,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Distinguish the FFI-symbol-missing path from a real synth failure
		// — both are placeholder-no-regen but the operator-facing reason
		// differs.
		const reason: "ffi-no-encode-reference" | "encode-reference-failed" =
			/encode_reference|encodeReferenceSupported|ABI v4/.test(message)
				? "ffi-no-encode-reference"
				: "encode-reference-failed";
		return { kind: "placeholder-no-regen", reason, detail: message };
	}

	mkdirSync(path.dirname(presetPath), { recursive: true });
	writeFileSync(presetPath, result.bytes);
	return {
		kind: "regenerated",
		bytes: result.bytes.byteLength,
		K: result.K,
		refT: result.refT,
	};
}
