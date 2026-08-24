/**
 * Unit coverage for the generated known-phrase fixture
 * (`fixtures/known-phrase.ts`, regenerated from `known-phrase.wav` by
 * `gen-known-phrase.mjs`).
 *
 * The fixture crosses two real consumer boundaries:
 *
 *  - The ui-smoke and android playwright configs split the data URL on its
 *    comma, base64-decode the payload, and write the bytes to disk as
 *    `known-phrase.wav` for Chromium's `--use-file-for-fake-audio-capture`;
 *    a malformed container breaks every real-audio lane at launch.
 *  - The voice self-test shell passes the same URL to WebAudio playback and
 *    compares live ASR output against `EXPECTED_PHRASE`; an unusable phrase
 *    value makes the self-test pass vacuously.
 *
 * These cases decode the actual embedded bytes and validate the RIFF/WAVE
 * structure those consumers depend on — PCM format, frame alignment, chunk
 * sizes inside the buffer — plus the phrase contract above. Nothing is
 * mocked and no literal from the generated source is restated.
 */

import { describe, expect, it } from "vitest";
import { EXPECTED_PHRASE, KNOWN_PHRASE_WAV_DATA_URL } from "./known-phrase";

const DATA_URL_PREFIX = "data:audio/wav;base64,";

interface WavChunk {
  id: string;
  size: number;
  dataOffset: number;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function readChunks(view: DataView, bytes: Uint8Array): WavChunk[] {
  const chunks: WavChunk[] = [];
  // Skip the 12-byte RIFF descriptor ("RIFF" + riffSize + "WAVE").
  let cursor = 12;
  while (cursor + 8 <= bytes.byteLength) {
    const id = ascii(bytes, cursor, 4);
    const size = view.getUint32(cursor + 4, true);
    chunks.push({ id, size, dataOffset: cursor + 8 });
    // Chunk payloads are word-aligned: an odd size carries one pad byte.
    cursor += 8 + size + (size % 2);
  }
  return chunks;
}

function decodeFixtureWav(): {
  bytes: Uint8Array;
  view: DataView;
  chunks: WavChunk[];
} {
  expect(KNOWN_PHRASE_WAV_DATA_URL.startsWith(DATA_URL_PREFIX)).toBe(true);
  const payload = KNOWN_PHRASE_WAV_DATA_URL.slice(DATA_URL_PREFIX.length);
  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  // A WAV too small to hold even the RIFF descriptor + fmt chunk cannot be
  // real speech; fail before the structural reads below index out of range.
  expect(bytes.byteLength).toBeGreaterThan(44);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { bytes, view, chunks: readChunks(view, bytes) };
}

describe("KNOWN_PHRASE_WAV_DATA_URL", () => {
  it("carries a non-empty base64 payload after the audio/wav prefix", () => {
    const { bytes } = decodeFixtureWav();
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it("is a structurally complete RIFF/WAVE container", () => {
    const { bytes, view } = decodeFixtureWav();
    expect(ascii(bytes, 0, 4)).toBe("RIFF");
    expect(ascii(bytes, 8, 4)).toBe("WAVE");
    // riffSize counts every byte after itself, so the file must end exactly
    // where the descriptor claims — truncation or trailing junk breaks the
    // capture configs that persist these bytes verbatim.
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
  });

  it("declares the documented 16 kHz mono 16-bit PCM format", () => {
    const { view, chunks } = decodeFixtureWav();
    const fmt = chunks.find((chunk) => chunk.id === "fmt ");
    expect(fmt).toBeDefined();
    if (!fmt) return;
    const audioFormat = view.getUint16(fmt.dataOffset, true);
    const channels = view.getUint16(fmt.dataOffset + 2, true);
    const sampleRate = view.getUint32(fmt.dataOffset + 4, true);
    const byteRate = view.getUint32(fmt.dataOffset + 8, true);
    const blockAlign = view.getUint16(fmt.dataOffset + 12, true);
    const bitsPerSample = view.getUint16(fmt.dataOffset + 14, true);
    expect(audioFormat).toBe(1);
    expect(channels).toBe(1);
    expect(sampleRate).toBe(16000);
    expect(bitsPerSample).toBe(16);
    expect(blockAlign).toBe((bitsPerSample / 8) * channels);
    expect(byteRate).toBe(sampleRate * blockAlign);
  });

  it("carries a non-empty, frame-aligned data chunk inside the buffer", () => {
    const { bytes, view, chunks } = decodeFixtureWav();
    const fmt = chunks.find((chunk) => chunk.id === "fmt ");
    const data = chunks.find((chunk) => chunk.id === "data");
    expect(fmt).toBeDefined();
    expect(data).toBeDefined();
    if (!data || !fmt) return;
    const blockAlign = view.getUint16(fmt.dataOffset + 12, true);
    expect(data.size).toBeGreaterThan(0);
    expect(data.dataOffset + data.size).toBeLessThanOrEqual(bytes.byteLength);
    // Whole frames only: a ragged tail means truncated samples mid-playback.
    expect(data.size % blockAlign).toBe(0);
  });

  it("keeps every declared RIFF chunk within the embedded buffer", () => {
    const { bytes, chunks } = decodeFixtureWav();
    // The fixture embeds metadata chunks (LIST/INFO) ahead of the samples,
    // so walk all of them instead of assuming a fixed layout.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.dataOffset + chunk.size).toBeLessThanOrEqual(
        bytes.byteLength,
      );
    }
  });
});

describe("EXPECTED_PHRASE", () => {
  it("is a non-empty comparison target for live ASR output", () => {
    expect(typeof EXPECTED_PHRASE).toBe("string");
    // An empty expected phrase matches any transcript, so a regression here
    // would report self-test passes that prove nothing.
    expect(EXPECTED_PHRASE.trim().length).toBeGreaterThan(0);
  });

  it("is trim-stable and single-line so transcript comparison stays exact", () => {
    expect(EXPECTED_PHRASE).toBe(EXPECTED_PHRASE.trim());
    // Every code point at 32+ rules out newlines, NULs, and other C0
    // control characters without a control-character regex literal.
    for (let i = 0; i < EXPECTED_PHRASE.length; i += 1) {
      expect(EXPECTED_PHRASE.charCodeAt(i)).toBeGreaterThanOrEqual(32);
    }
  });
});
