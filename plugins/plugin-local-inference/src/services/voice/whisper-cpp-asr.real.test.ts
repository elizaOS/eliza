// Real STT test: transcribes a real speech WAV through the actual whisper.cpp
// FFI adapter and asserts the transcript. This is genuinely-real voice
// processing — no mocks: it dlopen()'s libwhisper_eliza_adapter and runs a real
// ggml whisper model over real 16 kHz PCM.
//
// Self-gating: skips cleanly unless the whisper adapter + a ggml model resolve
// (resolveWhisperCppRuntime() != null) AND it runs under the Bun test runner
// (bun:ffi). To run it locally (from plugins/plugin-local-inference):
//   node native/build-whisper.mjs                       # builds the .so (auto-resolved)
//   bash ../../packages/app-core/platforms/electrobun/scripts/ensure-whisper-gguf.sh tiny.en
//   ELIZA_WHISPER_MODEL=~/.cache/.../ggml-tiny.en.bin \
//     bun test src/services/voice/whisper-cpp-asr.real.test.ts   # NOTE: bun test, not vitest
// (or stage a model at ~/.cache/eliza/whisper/ggml-base.en.bin). Under vitest /
// Node it skips (FFI needs Bun); wire `bun test` for it in the post-merge lane.
//
// Fixture: jfk.wav (public-domain US government audio, the canonical whisper.cpp
// sample), 16 kHz mono 16-bit PCM — resolved from the whisper.cpp checkout
// (present wherever the adapter is built) or ELIZA_ASR_TEST_WAV, never committed
// (the repo gitignores *.wav).

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	makeWhisperCppDecoder,
	resolveWhisperCppRuntime,
} from "./whisper-cpp-asr";

/**
 * Resolve a real speech WAV without committing a binary (the repo gitignores
 * *.wav). whisper.cpp ships samples/jfk.wav, and native/build-whisper.mjs clones
 * whisper.cpp to ~/.cache/eliza-whisper-cpp — so the sample is present wherever
 * the adapter was built. Honor an explicit override first.
 */
function resolveJfkWav(): string | null {
	const env = process.env.ELIZA_ASR_TEST_WAV?.trim();
	if (env) return existsSync(env) ? env : null;
	const here = path.dirname(new URL(import.meta.url).pathname);
	const candidates = [
		path.join(
			os.homedir(),
			".cache",
			"eliza-whisper-cpp",
			"whisper.cpp",
			"samples",
			"jfk.wav",
		),
		path.resolve(
			here,
			"..",
			"..",
			"..",
			"native",
			"whisper.cpp",
			"samples",
			"jfk.wav",
		),
	];
	for (const c of candidates) if (existsSync(c)) return c;
	return null;
}

/** Decode a 16-bit PCM mono WAV into the Float32 [-1,1] samples whisper wants. */
function readWavAsFloat32(path: string): {
	samples: Float32Array;
	rate: number;
} {
	const buf = readFileSync(path);
	if (
		buf.toString("ascii", 0, 4) !== "RIFF" ||
		buf.toString("ascii", 8, 12) !== "WAVE"
	) {
		throw new Error(`${path}: not a RIFF/WAVE file`);
	}
	let rate = 16000;
	let dataOffset = -1;
	let dataLength = 0;
	let offset = 12;
	while (offset + 8 <= buf.length) {
		const id = buf.toString("ascii", offset, offset + 4);
		const size = buf.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") {
			rate = buf.readUInt32LE(body + 4);
		} else if (id === "data") {
			dataOffset = body;
			dataLength = size;
			break;
		}
		offset = body + size + (size % 2);
	}
	if (dataOffset < 0) throw new Error(`${path}: no data chunk`);
	const count = Math.floor(dataLength / 2);
	const samples = new Float32Array(count);
	for (let i = 0; i < count; i += 1) {
		samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
	}
	return { samples, rate };
}

const runtime = resolveWhisperCppRuntime();
const jfkWav = resolveJfkWav();
// The whisper adapter loads via bun:ffi, so this only runs under the Bun test
// runner (`bun test <thisFile>`). Under vitest/Node it skips cleanly — the FFI
// loader would otherwise throw. See the header comment for the run command.
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

describe.skipIf(!runtime || !isBun || !jfkWav)(
	"whisper.cpp ASR — real transcription of a real WAV",
	() => {
		it("transcribes jfk.wav to the expected words", async () => {
			const { samples, rate } = readWavAsFloat32(jfkWav as string);
			expect(rate).toBe(16000);
			expect(samples.length).toBeGreaterThan(16000); // > 1s of audio

			// runtime is non-null inside the skipIf-guarded block.
			const { decoder, dispose } = makeWhisperCppDecoder(
				runtime as NonNullable<typeof runtime>,
			);
			try {
				const transcript = (await decoder(samples)).toLowerCase();
				// Real model output — assert the salient words, tolerant of punctuation
				// and tiny-model spelling wobble.
				expect(transcript).toContain("fellow americans");
				expect(transcript).toContain("country");
				expect(transcript).toContain("ask");
			} finally {
				dispose();
			}
		}, 60_000);
	},
);
