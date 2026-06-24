/**
 * Unit coverage for decodeMonoFloat32Wav24kHz (#9147 voice).
 *
 * The pure reference-WAV decoder that samantha-preset regeneration feeds from:
 * it parses a RIFF/WAVE byte stream and returns the mono float32 samples,
 * validating magic / chunks / format / channels / sample-rate. Was untested.
 * No GGUF / audio device — operates on in-memory bytes.
 */

import { describe, expect, it } from "vitest";
import { decodeMonoFloat32Wav24kHz } from "./samantha-preset-regenerator";

function buildWav(
	samples: number[],
	opts: {
		sampleRate?: number;
		channels?: number;
		audioFormat?: number;
		bitsPerSample?: number;
	} = {},
): Uint8Array {
	const sampleRate = opts.sampleRate ?? 24_000;
	const channels = opts.channels ?? 1;
	const audioFormat = opts.audioFormat ?? 3; // IEEE float
	const bitsPerSample = opts.bitsPerSample ?? 32;
	const dataLen = samples.length * 4;
	const buf = new ArrayBuffer(44 + dataLen);
	const view = new DataView(buf);
	const bytes = new Uint8Array(buf);
	const writeStr = (off: number, s: string) => {
		for (let i = 0; i < s.length; i += 1) bytes[off + i] = s.charCodeAt(i);
	};
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + dataLen, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, audioFormat, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
	view.setUint16(32, channels * (bitsPerSample / 8), true);
	view.setUint16(34, bitsPerSample, true);
	writeStr(36, "data");
	view.setUint32(40, dataLen, true);
	for (let i = 0; i < samples.length; i += 1) {
		view.setFloat32(44 + i * 4, samples[i], true);
	}
	return bytes;
}

describe("decodeMonoFloat32Wav24kHz", () => {
	it("decodes a valid mono 24kHz float32 WAV to its samples", () => {
		const out = decodeMonoFloat32Wav24kHz(buildWav([0.5, -0.25, 0.75]));
		expect(out).toBeInstanceOf(Float32Array);
		expect(Array.from(out)).toEqual([0.5, -0.25, 0.75]);
	});

	it("throws on a too-small buffer (no header room)", () => {
		expect(() => decodeMonoFloat32Wav24kHz(new Uint8Array(10))).toThrow(
			/too small/,
		);
	});

	it("throws on bad RIFF/WAVE magic", () => {
		const wav = buildWav([0]);
		wav[0] = 0x00; // corrupt "RIFF"
		expect(() => decodeMonoFloat32Wav24kHz(wav)).toThrow(/bad magic/);
	});

	it("throws when the format is not 32-bit float PCM", () => {
		expect(() =>
			decodeMonoFloat32Wav24kHz(
				buildWav([0], { audioFormat: 1, bitsPerSample: 16 }),
			),
		).toThrow(/32-bit float/);
	});

	it("throws on a non-mono WAV", () => {
		expect(() =>
			decodeMonoFloat32Wav24kHz(buildWav([0, 0], { channels: 2 })),
		).toThrow(/mono/);
	});

	it("throws on a non-24kHz WAV", () => {
		expect(() =>
			decodeMonoFloat32Wav24kHz(buildWav([0], { sampleRate: 16_000 })),
		).toThrow(/24 kHz/);
	});
});
