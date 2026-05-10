/**
 * Binary format for `cache/voice-preset-default.bin`.
 *
 * Layout (little-endian throughout):
 *
 *   +0   4 bytes  magic 'ELZ1' (0x315A4C45)
 *   +4   4 bytes  format version (uint32)               — v1
 *   +8   4 bytes  speaker embedding offset (uint32)
 *   +12  4 bytes  speaker embedding byte length (uint32)
 *   +16  4 bytes  phrase cache seed offset (uint32)
 *   +20  4 bytes  phrase cache seed byte length (uint32)
 *   +24  ...      speaker embedding (Float32 LE vector)
 *   +... ...      phrase cache seed:
 *                   uint32 LE  N (phrase count)
 *                   for each phrase:
 *                     uint16 LE  text_byte_len
 *                     uint8[]    canonicalized text (UTF-8)
 *                     uint32 LE  sample_rate
 *                     uint32 LE  pcm_byte_len
 *                     uint8[]    PCM (Float32 LE samples)
 *
 * Both sections are mandatory in v1. An empty phrase cache seed is encoded
 * as N=0 (4 bytes); zero-byte sections are not permitted (use N=0 instead).
 */

export const VOICE_PRESET_MAGIC = 0x315a4c45; // 'ELZ1'
export const VOICE_PRESET_VERSION = 1;
export const VOICE_PRESET_HEADER_BYTES = 24;

export interface VoicePresetSeedPhrase {
  /** Canonicalized text (lowercase, single-spaced, trimmed). */
  text: string;
  sampleRate: number;
  pcm: Float32Array;
}

export interface VoicePresetFile {
  version: number;
  embedding: Float32Array;
  phrases: ReadonlyArray<VoicePresetSeedPhrase>;
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
      | "bad-embedding-length",
  ) {
    super(message);
    this.name = "VoicePresetFormatError";
  }
}

interface SectionView {
  offset: number;
  length: number;
}

function readHeader(view: DataView): {
  version: number;
  embedding: SectionView;
  phrases: SectionView;
} {
  if (view.byteLength < VOICE_PRESET_HEADER_BYTES) {
    throw new VoicePresetFormatError(
      `voice preset file truncated: header needs ${VOICE_PRESET_HEADER_BYTES} bytes, got ${view.byteLength}`,
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
  if (version !== VOICE_PRESET_VERSION) {
    throw new VoicePresetFormatError(
      `voice preset unsupported version: ${version} (this build supports ${VOICE_PRESET_VERSION})`,
      "bad-version",
    );
  }
  const embOff = view.getUint32(8, true);
  const embLen = view.getUint32(12, true);
  const phrOff = view.getUint32(16, true);
  const phrLen = view.getUint32(20, true);

  const fileLen = view.byteLength;
  if (embOff + embLen > fileLen || phrOff + phrLen > fileLen) {
    throw new VoicePresetFormatError(
      "voice preset section bounds exceed file length",
      "bad-section-bounds",
    );
  }
  if (embOff < VOICE_PRESET_HEADER_BYTES || phrOff < VOICE_PRESET_HEADER_BYTES) {
    throw new VoicePresetFormatError(
      "voice preset section overlaps header",
      "bad-section-bounds",
    );
  }
  return {
    version,
    embedding: { offset: embOff, length: embLen },
    phrases: { offset: phrOff, length: phrLen },
  };
}

function readEmbedding(bytes: Uint8Array, sec: SectionView): Float32Array {
  if (sec.length % 4 !== 0) {
    throw new VoicePresetFormatError(
      `voice preset embedding length ${sec.length} is not a multiple of 4`,
      "bad-embedding-length",
    );
  }
  // Copy out so the result is independent of the source buffer.
  const out = new Float32Array(sec.length / 4);
  const src = new Float32Array(
    bytes.buffer,
    bytes.byteOffset + sec.offset,
    sec.length / 4,
  );
  out.set(src);
  return out;
}

function readPhrases(
  bytes: Uint8Array,
  sec: SectionView,
): VoicePresetSeedPhrase[] {
  if (sec.length === 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset + sec.offset, sec.length);
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
    const pcm = new Float32Array(pcmByteLen / 4);
    const src = new Float32Array(
      bytes.buffer,
      bytes.byteOffset + sec.offset + pos,
      pcmByteLen / 4,
    );
    pcm.set(src);
    pos += pcmByteLen;
    out.push({ text, sampleRate, pcm });
  }
  return out;
}

/**
 * Parse a voice-preset binary blob. Throws `VoicePresetFormatError` on any
 * malformed input — this is the single defensive boundary for the format.
 */
export function readVoicePresetFile(bytes: Uint8Array): VoicePresetFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readHeader(view);
  return {
    version: header.version,
    embedding: readEmbedding(bytes, header.embedding),
    phrases: readPhrases(bytes, header.phrases),
  };
}

/**
 * Serialize a voice preset to the v1 binary format. The output is a fresh
 * `Uint8Array` ready to be written to disk.
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

  const embOff = VOICE_PRESET_HEADER_BYTES;
  const phrOff = embOff + embBytes;
  const total = phrOff + phrBytes;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, VOICE_PRESET_MAGIC, true);
  view.setUint32(4, VOICE_PRESET_VERSION, true);
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
  let pos = phrOff;
  view.setUint32(pos, file.phrases.length, true);
  pos += 4;
  for (let i = 0; i < file.phrases.length; i++) {
    const t = encodedTexts[i];
    const phrase = file.phrases[i];
    view.setUint16(pos, t.byteLength, true);
    pos += 2;
    out.set(t, pos);
    pos += t.byteLength;
    view.setUint32(pos, phrase.sampleRate, true);
    pos += 4;
    view.setUint32(pos, phrase.pcm.byteLength, true);
    pos += 4;
    out.set(
      new Uint8Array(phrase.pcm.buffer, phrase.pcm.byteOffset, phrase.pcm.byteLength),
      pos,
    );
    pos += phrase.pcm.byteLength;
  }

  return out;
}
