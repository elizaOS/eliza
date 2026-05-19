/**
 * Binary format for `cache/voice-preset-*.bin`.
 *
 * Two versions are supported:
 *
 *   v1 (`magic='ELZ1', version=1`) — legacy two-section layout used by the
 *   initial Kokoro-style placeholder. Carries a Float32 speaker embedding +
 *   a phrase-cache seed list. Still read for back-compat (older bundles only
 *   contain v1).
 *
 *   v2 (`magic='ELZ1', version=2`) — superset adopted for the OmniVoice
 *   freeze. Adds three OmniVoice-specific sections that the v1 layout had
 *   no room for: pre-encoded `ref_audio_tokens` (int32, shape
 *   `[K, ref_T]`), a UTF-8 `ref_text` transcript of the reference clip, and
 *   a closed-vocabulary `instruct` string (the resolved VoiceDesign
 *   attributes). v2 readers handle v1 files transparently (the new sections
 *   default to empty). A v1 reader applied to a v2 file fails fast on
 *   `truncated-header` because the v2 header is larger.
 *
 * Layout (little-endian throughout):
 *
 *   v1 header (24 bytes):
 *     +0   4 bytes  magic 'ELZ1' (0x315A4C45)
 *     +4   4 bytes  format version (uint32)                — 1
 *     +8   4 bytes  speaker embedding offset (uint32)
 *     +12  4 bytes  speaker embedding byte length (uint32)
 *     +16  4 bytes  phrase cache seed offset (uint32)
 *     +20  4 bytes  phrase cache seed byte length (uint32)
 *
 *   v2 header (64 bytes — additive, all section descriptors are
 *               `(offset:uint32, length:uint32)` pairs):
 *     +0   4 bytes  magic 'ELZ1' (0x315A4C45)
 *     +4   4 bytes  format version (uint32)                — 2
 *     +8   4 bytes  speaker embedding offset
 *     +12  4 bytes  speaker embedding byte length
 *     +16  4 bytes  phrase cache seed offset
 *     +20  4 bytes  phrase cache seed byte length
 *     +24  4 bytes  ref_audio_tokens offset
 *     +28  4 bytes  ref_audio_tokens byte length
 *     +32  4 bytes  ref_text offset
 *     +36  4 bytes  ref_text byte length
 *     +40  4 bytes  instruct offset
 *     +44  4 bytes  instruct byte length
 *     +48  4 bytes  metadata offset
 *     +52  4 bytes  metadata byte length
 *     +56  4 bytes  reserved (must be 0)
 *     +60  4 bytes  reserved (must be 0)
 *
 *   `ref_audio_tokens` payload (v2):
 *     +0   4 bytes  K            — codebook count (uint32, OmniVoice = 8)
 *     +4   4 bytes  ref_T        — frames per codebook (uint32)
 *     +8   ...      int32 LE codebook samples, row-major shape `[K, ref_T]`
 *
 *   `ref_text` payload (v2): raw UTF-8 bytes (no NUL terminator).
 *   `instruct` payload (v2): raw UTF-8 bytes (closed VoiceDesign vocabulary).
 *   `metadata` payload (v2): raw UTF-8 JSON bytes (codec sha256, corpus
 *                            hash, etc.); the runtime never relies on
 *                            metadata for correctness.
 *
 *   Phrase cache seed payload (v1 + v2, identical):
 *     uint32 LE  N (phrase count)
 *     for each phrase:
 *       uint16 LE  text_byte_len
 *       uint8[]    canonicalized text (UTF-8)
 *       uint32 LE  sample_rate
 *       uint32 LE  pcm_byte_len
 *       uint8[]    PCM (Float32 LE samples)
 *
 * Per-section invariants:
 *   - Section bounds may not overlap the header.
 *   - Section bounds must fit within the file length.
 *   - A `length=0` section is allowed (means "absent"); the corresponding
 *     output field is an empty `Float32Array` / `Int32Array` / empty string.
 *   - `embedding.length % 4 == 0` (Float32).
 *   - `ref_audio_tokens.length` ≥ 8 (the two header words K, ref_T) and the
 *     payload is `8 + K*ref_T*4` bytes.
 */

export const VOICE_PRESET_MAGIC = 0x315a4c45; // 'ELZ1'

/** Header byte counts. */
export const VOICE_PRESET_HEADER_BYTES_V1 = 24;
export const VOICE_PRESET_HEADER_BYTES_V2 = 64;

/** Supported format versions. v2 is the canonical write path. */
export const VOICE_PRESET_VERSION_V1 = 1;
export const VOICE_PRESET_VERSION_V2 = 2;
export const VOICE_PRESET_VERSION_CURRENT = VOICE_PRESET_VERSION_V2;

/** Back-compat alias: legacy callers expect `VOICE_PRESET_VERSION` to exist. */
export const VOICE_PRESET_VERSION = VOICE_PRESET_VERSION_V1;
/** Back-compat alias for the v1 header size. */
export const VOICE_PRESET_HEADER_BYTES = VOICE_PRESET_HEADER_BYTES_V1;

export interface VoicePresetSeedPhrase {
	/** Canonicalized text (lowercase, single-spaced, trimmed). */
	text: string;
	sampleRate: number;
	pcm: Float32Array;
}

/**
 * OmniVoice reference-audio-tokens payload. `K` is the codebook count (=8 for
 * OmniVoice / HiggsAudioV2) and `refT` is the number of frames per codebook.
 * `tokens` is row-major: codebook `k`, frame `t` is at `tokens[k*refT + t]`.
 * An empty payload (refT=0, K=0, tokens length 0) is valid and means "no
 * reference audio bound to this preset" (instruct-only voice).
 */
export interface RefAudioTokens {
	K: number;
	refT: number;
	tokens: Int32Array;
}

export interface VoicePresetFile {
	version: number;
	embedding: Float32Array;
	phrases: ReadonlyArray<VoicePresetSeedPhrase>;
	/** v2 only — empty for v1 files. */
	refAudioTokens: RefAudioTokens;
	/** v2 only — empty for v1 files. */
	refText: string;
	/** v2 only — empty for v1 files. */
	instruct: string;
	/** v2 only — parsed JSON object, empty `{}` for v1 files. */
	metadata: Record<string, unknown>;
}

export class VoicePresetFormatError extends Error {
	constructor(
		message: string,
		readonly code:
			| "bad-magic"
			| "bad-version"
			| "truncated-header"
			| "truncated-section"
			| "bad-section-bounds"
			| "bad-phrase-record"
			| "bad-embedding-length"
			| "bad-ref-tokens"
			| "bad-metadata",
	) {
		super(message);
		this.name = "VoicePresetFormatError";
	}
}

interface SectionView {
	offset: number;
	length: number;
}

interface ParsedHeader {
	version: number;
	headerBytes: number;
	embedding: SectionView;
	phrases: SectionView;
	refAudioTokens: SectionView;
	refText: SectionView;
	instruct: SectionView;
	metadata: SectionView;
}

const EMPTY_SECTION: SectionView = Object.freeze({ offset: 0, length: 0 });

function checkSectionBounds(
	sec: SectionView,
	fileLen: number,
	headerBytes: number,
): void {
	if (sec.length === 0) return;
	if (sec.offset < headerBytes) {
		throw new VoicePresetFormatError(
			`voice preset section overlaps header (offset=${sec.offset} < header=${headerBytes})`,
			"bad-section-bounds",
		);
	}
	if (sec.offset + sec.length > fileLen) {
		throw new VoicePresetFormatError(
			`voice preset section bounds exceed file length`,
			"bad-section-bounds",
		);
	}
}

function readHeader(view: DataView): ParsedHeader {
	if (view.byteLength < VOICE_PRESET_HEADER_BYTES_V1) {
		throw new VoicePresetFormatError(
			`voice preset file truncated: header needs ${VOICE_PRESET_HEADER_BYTES_V1} bytes, got ${view.byteLength}`,
			"truncated-header",
		);
	}
	const magic = view.getUint32(0, true);
	if (magic !== VOICE_PRESET_MAGIC) {
		throw new VoicePresetFormatError(
			`voice preset bad magic: expected 0x${VOICE_PRESET_MAGIC.toString(16)}, got 0x${magic.toString(16)}`,
			"bad-magic",
		);
	}
	const version = view.getUint32(4, true);
	if (
		version !== VOICE_PRESET_VERSION_V1 &&
		version !== VOICE_PRESET_VERSION_V2
	) {
		throw new VoicePresetFormatError(
			`voice preset unsupported version: ${version} (this build supports 1 and 2)`,
			"bad-version",
		);
	}
	const headerBytes =
		version === VOICE_PRESET_VERSION_V2
			? VOICE_PRESET_HEADER_BYTES_V2
			: VOICE_PRESET_HEADER_BYTES_V1;
	if (view.byteLength < headerBytes) {
		throw new VoicePresetFormatError(
			`voice preset file truncated: v${version} header needs ${headerBytes} bytes, got ${view.byteLength}`,
			"truncated-header",
		);
	}

	const embedding: SectionView = {
		offset: view.getUint32(8, true),
		length: view.getUint32(12, true),
	};
	const phrases: SectionView = {
		offset: view.getUint32(16, true),
		length: view.getUint32(20, true),
	};

	let refAudioTokens = EMPTY_SECTION;
	let refText = EMPTY_SECTION;
	let instruct = EMPTY_SECTION;
	let metadata = EMPTY_SECTION;
	if (version === VOICE_PRESET_VERSION_V2) {
		refAudioTokens = {
			offset: view.getUint32(24, true),
			length: view.getUint32(28, true),
		};
		refText = {
			offset: view.getUint32(32, true),
			length: view.getUint32(36, true),
		};
		instruct = {
			offset: view.getUint32(40, true),
			length: view.getUint32(44, true),
		};
		metadata = {
			offset: view.getUint32(48, true),
			length: view.getUint32(52, true),
		};
		// Reserved words must be zero — fail closed on accidental reuse.
		const r0 = view.getUint32(56, true);
		const r1 = view.getUint32(60, true);
		if (r0 !== 0 || r1 !== 0) {
			throw new VoicePresetFormatError(
				`voice preset v2 reserved header words must be 0 (got ${r0}, ${r1})`,
				"bad-section-bounds",
			);
		}
	}

	const fileLen = view.byteLength;
	checkSectionBounds(embedding, fileLen, headerBytes);
	checkSectionBounds(phrases, fileLen, headerBytes);
	checkSectionBounds(refAudioTokens, fileLen, headerBytes);
	checkSectionBounds(refText, fileLen, headerBytes);
	checkSectionBounds(instruct, fileLen, headerBytes);
	checkSectionBounds(metadata, fileLen, headerBytes);

	return {
		version,
		headerBytes,
		embedding,
		phrases,
		refAudioTokens,
		refText,
		instruct,
		metadata,
	};
}

function copyFloat32(
	bytes: Uint8Array,
	/** Offset relative to `bytes` (i.e. relative to bytes.byteOffset). */
	relativeOffset: number,
	byteLength: number,
): Float32Array {
	// The source byte offset is not guaranteed to be 4-aligned in the file
	// buffer, so we copy raw bytes into a fresh ArrayBuffer first.
	const aligned = new Uint8Array(byteLength);
	aligned.set(bytes.subarray(relativeOffset, relativeOffset + byteLength));
	return new Float32Array(aligned.buffer, 0, byteLength / 4);
}

function copyInt32(
	bytes: Uint8Array,
	relativeOffset: number,
	byteLength: number,
): Int32Array {
	const aligned = new Uint8Array(byteLength);
	aligned.set(bytes.subarray(relativeOffset, relativeOffset + byteLength));
	return new Int32Array(aligned.buffer, 0, byteLength / 4);
}

function readEmbedding(bytes: Uint8Array, sec: SectionView): Float32Array {
	if (sec.length === 0) return new Float32Array(0);
	if (sec.length % 4 !== 0) {
		throw new VoicePresetFormatError(
			`voice preset embedding length ${sec.length} is not a multiple of 4`,
			"bad-embedding-length",
		);
	}
	return copyFloat32(bytes, sec.offset, sec.length);
}

function readRefAudioTokens(
	bytes: Uint8Array,
	sec: SectionView,
): RefAudioTokens {
	if (sec.length === 0) {
		return { K: 0, refT: 0, tokens: new Int32Array(0) };
	}
	if (sec.length < 8) {
		throw new VoicePresetFormatError(
			`voice preset ref_audio_tokens section truncated (need ≥ 8 bytes, got ${sec.length})`,
			"bad-ref-tokens",
		);
	}
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset + sec.offset,
		sec.length,
	);
	const K = view.getUint32(0, true);
	const refT = view.getUint32(4, true);
	const tokenBytes = sec.length - 8;
	if (tokenBytes % 4 !== 0) {
		throw new VoicePresetFormatError(
			`voice preset ref_audio_tokens payload bytes ${tokenBytes} is not a multiple of 4`,
			"bad-ref-tokens",
		);
	}
	const expected = K * refT * 4;
	if (tokenBytes !== expected) {
		throw new VoicePresetFormatError(
			`voice preset ref_audio_tokens shape mismatch: K=${K}, ref_T=${refT}, expected ${expected} bytes, got ${tokenBytes}`,
			"bad-ref-tokens",
		);
	}
	const tokens =
		tokenBytes === 0
			? new Int32Array(0)
			: copyInt32(bytes, sec.offset + 8, tokenBytes);
	return { K, refT, tokens };
}

function readUtf8(bytes: Uint8Array, sec: SectionView): string {
	if (sec.length === 0) return "";
	const slice = bytes.subarray(sec.offset, sec.offset + sec.length);
	return new TextDecoder("utf-8", { fatal: true }).decode(slice);
}

function readMetadata(
	bytes: Uint8Array,
	sec: SectionView,
): Record<string, unknown> {
	if (sec.length === 0) return {};
	const text = readUtf8(bytes, sec);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new VoicePresetFormatError(
			`voice preset metadata is not valid JSON: ${(err as Error).message}`,
			"bad-metadata",
		);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new VoicePresetFormatError(
			`voice preset metadata must be a JSON object`,
			"bad-metadata",
		);
	}
	return parsed as Record<string, unknown>;
}

function readPhrases(
	bytes: Uint8Array,
	sec: SectionView,
): VoicePresetSeedPhrase[] {
	if (sec.length === 0) return [];
	const view = new DataView(
		bytes.buffer,
		bytes.byteOffset + sec.offset,
		sec.length,
	);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let pos = 0;
	if (sec.length < 4) {
		throw new VoicePresetFormatError(
			"voice preset phrase section truncated before count",
			"truncated-section",
		);
	}
	const count = view.getUint32(pos, true);
	pos += 4;
	const out: VoicePresetSeedPhrase[] = [];
	for (let i = 0; i < count; i++) {
		if (pos + 2 > sec.length) {
			throw new VoicePresetFormatError(
				`voice preset phrase #${i}: truncated before text length`,
				"bad-phrase-record",
			);
		}
		const textLen = view.getUint16(pos, true);
		pos += 2;
		if (pos + textLen > sec.length) {
			throw new VoicePresetFormatError(
				`voice preset phrase #${i}: text overruns section`,
				"bad-phrase-record",
			);
		}
		const textBytes = new Uint8Array(
			bytes.buffer,
			bytes.byteOffset + sec.offset + pos,
			textLen,
		);
		const text = decoder.decode(textBytes);
		pos += textLen;
		if (pos + 8 > sec.length) {
			throw new VoicePresetFormatError(
				`voice preset phrase #${i}: truncated before sample_rate/pcm_len`,
				"bad-phrase-record",
			);
		}
		const sampleRate = view.getUint32(pos, true);
		pos += 4;
		const pcmByteLen = view.getUint32(pos, true);
		pos += 4;
		if (pcmByteLen % 4 !== 0) {
			throw new VoicePresetFormatError(
				`voice preset phrase #${i}: pcm byte length ${pcmByteLen} is not a multiple of 4`,
				"bad-phrase-record",
			);
		}
		if (pos + pcmByteLen > sec.length) {
			throw new VoicePresetFormatError(
				`voice preset phrase #${i}: pcm overruns section`,
				"bad-phrase-record",
			);
		}
		const pcm = copyFloat32(bytes, sec.offset + pos, pcmByteLen);
		pos += pcmByteLen;
		out.push({ text, sampleRate, pcm });
	}
	return out;
}

/**
 * Parse a voice-preset binary blob. Throws `VoicePresetFormatError` on any
 * malformed input — this is the single defensive boundary for the format.
 * Supports both v1 and v2 files. For v1 files the v2-only fields are
 * returned as their empty equivalents.
 */
export function readVoicePresetFile(bytes: Uint8Array): VoicePresetFile {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const header = readHeader(view);
	return {
		version: header.version,
		embedding: readEmbedding(bytes, header.embedding),
		phrases: readPhrases(bytes, header.phrases),
		refAudioTokens: readRefAudioTokens(bytes, header.refAudioTokens),
		refText: readUtf8(bytes, header.refText),
		instruct: readUtf8(bytes, header.instruct),
		metadata: readMetadata(bytes, header.metadata),
	};
}

/**
 * Serialize a voice preset to the v1 binary format. The output is a fresh
 * `Uint8Array` ready to be written to disk.
 *
 * Use this only when the caller deliberately wants the legacy v1 shape (e.g.
 * the existing Kokoro-style placeholder builder). New code should call
 * `writeVoicePresetFileV2`.
 */
export function writeVoicePresetFile(file: {
	embedding: Float32Array;
	phrases: ReadonlyArray<VoicePresetSeedPhrase>;
}): Uint8Array {
	const encoder = new TextEncoder();
	const encodedTexts = file.phrases.map((p) => encoder.encode(p.text));

	const embBytes = file.embedding.byteLength;
	let phrBytes = 4; // count
	for (let i = 0; i < file.phrases.length; i++) {
		const t = encodedTexts[i];
		if (t.byteLength > 0xffff) {
			throw new VoicePresetFormatError(
				`phrase #${i} text too long (${t.byteLength} bytes, max 65535)`,
				"bad-phrase-record",
			);
		}
		phrBytes += 2 + t.byteLength + 4 + 4 + file.phrases[i].pcm.byteLength;
	}

	const embOff = VOICE_PRESET_HEADER_BYTES_V1;
	const phrOff = embOff + embBytes;
	const total = phrOff + phrBytes;

	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, VOICE_PRESET_MAGIC, true);
	view.setUint32(4, VOICE_PRESET_VERSION_V1, true);
	view.setUint32(8, embOff, true);
	view.setUint32(12, embBytes, true);
	view.setUint32(16, phrOff, true);
	view.setUint32(20, phrBytes, true);

	// Embedding
	out.set(
		new Uint8Array(
			file.embedding.buffer,
			file.embedding.byteOffset,
			file.embedding.byteLength,
		),
		embOff,
	);

	// Phrases
	writePhraseSection(out, view, phrOff, file.phrases, encodedTexts);

	return out;
}

function writePhraseSection(
	out: Uint8Array,
	view: DataView,
	startOff: number,
	phrases: ReadonlyArray<VoicePresetSeedPhrase>,
	encodedTexts: Uint8Array[],
): void {
	let pos = startOff;
	view.setUint32(pos, phrases.length, true);
	pos += 4;
	for (let i = 0; i < phrases.length; i++) {
		const t = encodedTexts[i];
		const phrase = phrases[i];
		view.setUint16(pos, t.byteLength, true);
		pos += 2;
		out.set(t, pos);
		pos += t.byteLength;
		view.setUint32(pos, phrase.sampleRate, true);
		pos += 4;
		view.setUint32(pos, phrase.pcm.byteLength, true);
		pos += 4;
		out.set(
			new Uint8Array(
				phrase.pcm.buffer,
				phrase.pcm.byteOffset,
				phrase.pcm.byteLength,
			),
			pos,
		);
		pos += phrase.pcm.byteLength;
	}
}

/**
 * Write a voice preset in the v2 (additive) layout. Used by the OmniVoice
 * freeze pipeline (`freeze-voice.mjs`) and other producers that need to
 * persist `refAudioTokens` / `refText` / `instruct` alongside the v1
 * embedding + phrase-seed sections.
 *
 * Any field that the caller doesn't need to persist can be omitted (or
 * passed empty). The on-disk section is then written as length=0 and is
 * read back as the empty equivalent.
 */
export function writeVoicePresetFileV2(file: {
	embedding?: Float32Array;
	phrases?: ReadonlyArray<VoicePresetSeedPhrase>;
	refAudioTokens?: RefAudioTokens;
	refText?: string;
	instruct?: string;
	metadata?: Record<string, unknown>;
}): Uint8Array {
	const embedding = file.embedding ?? new Float32Array(0);
	const phrases = file.phrases ?? [];
	const refAudioTokens = file.refAudioTokens ?? {
		K: 0,
		refT: 0,
		tokens: new Int32Array(0),
	};
	const refText = file.refText ?? "";
	const instruct = file.instruct ?? "";
	const metadata = file.metadata ?? {};

	if (refAudioTokens.K * refAudioTokens.refT !== refAudioTokens.tokens.length) {
		throw new VoicePresetFormatError(
			`ref_audio_tokens shape mismatch: K=${refAudioTokens.K}, ref_T=${refAudioTokens.refT}, but tokens.length=${refAudioTokens.tokens.length}`,
			"bad-ref-tokens",
		);
	}

	const encoder = new TextEncoder();
	const encodedTexts = phrases.map((p) => encoder.encode(p.text));
	const encodedRefText = encoder.encode(refText);
	const encodedInstruct = encoder.encode(instruct);
	const encodedMetadata =
		Object.keys(metadata).length === 0
			? new Uint8Array(0)
			: encoder.encode(JSON.stringify(metadata));

	// Compute payload sizes up-front so we can lay out section offsets.
	const embBytes = embedding.byteLength;
	let phrBytes = phrases.length === 0 && encodedTexts.length === 0 ? 0 : 4;
	if (phrBytes > 0) {
		for (let i = 0; i < phrases.length; i++) {
			const t = encodedTexts[i];
			if (t.byteLength > 0xffff) {
				throw new VoicePresetFormatError(
					`phrase #${i} text too long (${t.byteLength} bytes, max 65535)`,
					"bad-phrase-record",
				);
			}
			phrBytes += 2 + t.byteLength + 4 + 4 + phrases[i].pcm.byteLength;
		}
	}
	const refTokensBytes =
		refAudioTokens.tokens.length === 0 && refAudioTokens.K === 0
			? 0
			: 8 + refAudioTokens.tokens.byteLength;

	// Lay out sections in declared order. Empty sections claim no space and
	// are recorded as (offset=0, length=0).
	let cursor = VOICE_PRESET_HEADER_BYTES_V2;
	const embOff = embBytes > 0 ? cursor : 0;
	cursor += embBytes;
	const phrOff = phrBytes > 0 ? cursor : 0;
	cursor += phrBytes;
	const refTokensOff = refTokensBytes > 0 ? cursor : 0;
	cursor += refTokensBytes;
	const refTextOff = encodedRefText.byteLength > 0 ? cursor : 0;
	cursor += encodedRefText.byteLength;
	const instructOff = encodedInstruct.byteLength > 0 ? cursor : 0;
	cursor += encodedInstruct.byteLength;
	const metadataOff = encodedMetadata.byteLength > 0 ? cursor : 0;
	cursor += encodedMetadata.byteLength;

	const total = cursor;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);

	view.setUint32(0, VOICE_PRESET_MAGIC, true);
	view.setUint32(4, VOICE_PRESET_VERSION_V2, true);
	view.setUint32(8, embOff, true);
	view.setUint32(12, embBytes, true);
	view.setUint32(16, phrOff, true);
	view.setUint32(20, phrBytes, true);
	view.setUint32(24, refTokensOff, true);
	view.setUint32(28, refTokensBytes, true);
	view.setUint32(32, refTextOff, true);
	view.setUint32(36, encodedRefText.byteLength, true);
	view.setUint32(40, instructOff, true);
	view.setUint32(44, encodedInstruct.byteLength, true);
	view.setUint32(48, metadataOff, true);
	view.setUint32(52, encodedMetadata.byteLength, true);
	view.setUint32(56, 0, true);
	view.setUint32(60, 0, true);

	if (embBytes > 0) {
		out.set(
			new Uint8Array(embedding.buffer, embedding.byteOffset, embBytes),
			embOff,
		);
	}
	if (phrBytes > 0) {
		writePhraseSection(out, view, phrOff, phrases, encodedTexts);
	}
	if (refTokensBytes > 0) {
		view.setUint32(refTokensOff, refAudioTokens.K, true);
		view.setUint32(refTokensOff + 4, refAudioTokens.refT, true);
		if (refAudioTokens.tokens.byteLength > 0) {
			out.set(
				new Uint8Array(
					refAudioTokens.tokens.buffer,
					refAudioTokens.tokens.byteOffset,
					refAudioTokens.tokens.byteLength,
				),
				refTokensOff + 8,
			);
		}
	}
	if (encodedRefText.byteLength > 0) {
		out.set(encodedRefText, refTextOff);
	}
	if (encodedInstruct.byteLength > 0) {
		out.set(encodedInstruct, instructOff);
	}
	if (encodedMetadata.byteLength > 0) {
		out.set(encodedMetadata, metadataOff);
	}

	return out;
}
