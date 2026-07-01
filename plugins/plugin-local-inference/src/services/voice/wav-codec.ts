/**
 * Mono PCM16 WAV codec — dependency-light so corpus / fixture / test code can
 * encode + decode WAV without dragging in the heavy `engine-bridge` module
 * graph. `engine-bridge` re-exports these for its existing callers.
 */

import type { TranscriptionAudio } from "./types";

function writeAscii(out: Uint8Array, offset: number, text: string): void {
	for (let i = 0; i < text.length; i++) {
		out[offset + i] = text.charCodeAt(i);
	}
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
	let out = "";
	for (let i = 0; i < length; i++) {
		out += String.fromCharCode(bytes[offset + i]);
	}
	return out;
}

/** Encode mono float PCM as a 16-bit little-endian WAV byte stream. */
export function encodeMonoPcm16Wav(
	pcm: Float32Array,
	sampleRate: number,
): Uint8Array {
	const channels = 1;
	const bytesPerSample = 2;
	const dataBytes = pcm.length * bytesPerSample;
	const out = new Uint8Array(44 + dataBytes);
	const view = new DataView(out.buffer);
	writeAscii(out, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(out, 8, "WAVE");
	writeAscii(out, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, channels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * channels * bytesPerSample, true);
	view.setUint16(32, channels * bytesPerSample, true);
	view.setUint16(34, bytesPerSample * 8, true);
	writeAscii(out, 36, "data");
	view.setUint32(40, dataBytes, true);

	let offset = 44;
	for (const sample of pcm) {
		const clamped = Math.max(-1, Math.min(1, sample));
		const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
		view.setInt16(offset, Math.round(value), true);
		offset += bytesPerSample;
	}
	return out;
}

/** Decode a mono PCM16 WAV byte stream into float PCM + sample rate. */
export function decodeMonoPcm16Wav(bytes: Uint8Array): TranscriptionAudio {
	if (bytes.byteLength < 44) {
		throw new Error("[voice] WAV input is too short to contain a header");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (
		readAscii(bytes, 0, 4) !== "RIFF" ||
		readAscii(bytes, 8, 4) !== "WAVE" ||
		readAscii(bytes, 12, 4) !== "fmt "
	) {
		throw new Error("[voice] Local transcription expects mono PCM16 WAV bytes");
	}
	const audioFormat = view.getUint16(20, true);
	const channels = view.getUint16(22, true);
	const sampleRate = view.getUint32(24, true);
	const bitsPerSample = view.getUint16(34, true);
	if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
		throw new Error(
			`[voice] Local transcription expects mono PCM16 WAV (format=1 channels=1 bits=16); got format=${audioFormat} channels=${channels} bits=${bitsPerSample}`,
		);
	}

	let pos = 36;
	while (pos + 8 <= bytes.byteLength) {
		const chunkId = readAscii(bytes, pos, 4);
		const chunkBytes = view.getUint32(pos + 4, true);
		const dataStart = pos + 8;
		if (chunkId === "data") {
			if (dataStart + chunkBytes > bytes.byteLength) {
				throw new Error("[voice] WAV data chunk exceeds input length");
			}
			if (chunkBytes % 2 !== 0) {
				throw new Error("[voice] WAV PCM16 data chunk has odd byte length");
			}
			const pcm = new Float32Array(chunkBytes / 2);
			for (let i = 0; i < pcm.length; i++) {
				pcm[i] = view.getInt16(dataStart + i * 2, true) / 0x8000;
			}
			return { pcm, sampleRate };
		}
		pos = dataStart + chunkBytes + (chunkBytes % 2);
	}
	throw new Error("[voice] WAV input is missing a data chunk");
}
