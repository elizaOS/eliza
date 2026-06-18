// End-to-end REAL voice round-trip: text -> real OmniVoice TTS -> real audio ->
// real whisper STT -> text. No mocks at any stage. This is the gold-standard
// proof that the local voice pipeline produces *intelligible* speech, not just
// non-silent bytes: the synthesized audio must transcribe back to the words it
// was asked to speak.
//
// Pipeline (all real, all local):
//   1. omnivoice-tts CLI  (native/omnivoice.cpp/build/omnivoice-tts) synthesizes
//      the prompt with the OmniVoice base + tokenizer GGUF into a 24 kHz WAV.
//   2. assert the WAV carries real signal (peak well above the noise floor) —
//      catches the "engine emitted silent zero PCM" failure mode (AGENTS.md §3).
//   3. ffmpeg resamples 24 kHz -> 16 kHz (whisper's native rate).
//   4. whisper-cli transcribes; assert the transcript contains the spoken words.
//
// Subprocess-based, so it runs under vitest/Node (no bun:ffi). Self-skips unless
// every real artifact resolves: the two built CLIs, the OmniVoice GGUF pair, a
// whisper ggml model, and ffmpeg. Build them with
//   node native/build-omnivoice.mjs && cmake --build native/omnivoice.cpp/build --target omnivoice-tts
//   node native/build-whisper.mjs
// stage the OmniVoice GGUFs under <stateDir>/local-inference/models/omnivoice/
// and a whisper model under ~/.cache/eliza-whisper-models/, then run:
//   ELIZA_VOICE_ROUNDTRIP_TEST=1 bun run --cwd plugins/plugin-local-inference test:voice:roundtrip
// Overrides: ELIZA_OMNIVOICE_TTS_BIN, ELIZA_OMNIVOICE_MODEL_DIR,
// ELIZA_WHISPER_CLI, ELIZA_WHISPER_MODEL, ELIZA_FFMPEG.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");

function firstExisting(candidates: Array<string | undefined>): string | null {
	for (const c of candidates) if (c && existsSync(c)) return c;
	return null;
}

function which(bin: string): string | null {
	const r = spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
	const out = r.stdout?.trim();
	return r.status === 0 && out ? out : null;
}

const ttsBin = firstExisting([
	process.env.ELIZA_OMNIVOICE_TTS_BIN,
	path.join(PLUGIN_ROOT, "native", "omnivoice.cpp", "build", "omnivoice-tts"),
]);

const omniDir = firstExisting([
	process.env.ELIZA_OMNIVOICE_MODEL_DIR,
	path.join(
		os.homedir(),
		".local",
		"state",
		"milady",
		"local-inference",
		"models",
		"omnivoice",
	),
]);
const omniModel = omniDir
	? firstExisting([
			path.join(omniDir, "omnivoice-base-q4_k_m.gguf"),
			path.join(omniDir, "omnivoice-base-q8_0.gguf"),
		])
	: null;
const omniCodec = omniDir
	? firstExisting([path.join(omniDir, "omnivoice-tokenizer-q4_k_m.gguf")])
	: null;

const whisperCli = firstExisting([
	process.env.ELIZA_WHISPER_CLI,
	path.join(PLUGIN_ROOT, "native", "build-whisper", "bin", "whisper-cli"),
]);
const whisperModel = firstExisting([
	process.env.ELIZA_WHISPER_MODEL,
	path.join(os.homedir(), ".cache", "eliza-whisper-models", "ggml-base.en.bin"),
	path.join(os.homedir(), ".cache", "eliza-whisper-models", "ggml-tiny.en.bin"),
]);
const ffmpeg = process.env.ELIZA_FFMPEG ?? which("ffmpeg");

const READY = Boolean(
	ttsBin && omniModel && omniCodec && whisperCli && whisperModel && ffmpeg,
);

function wavPeak(file: string): { frames: number; rate: number; peak: number } {
	const buf = readFileSync(file);
	// minimal RIFF/WAVE parse (16-bit PCM)
	let rate = 0;
	let dataOffset = -1;
	let dataLen = 0;
	let off = 12;
	while (off + 8 <= buf.length) {
		const id = buf.toString("ascii", off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		if (id === "fmt ") rate = buf.readUInt32LE(off + 8 + 4);
		else if (id === "data") {
			dataOffset = off + 8;
			dataLen = size;
			break;
		}
		off += 8 + size + (size % 2);
	}
	let peak = 0;
	const end = dataOffset + dataLen;
	for (let i = dataOffset; i + 1 < end; i += 2) {
		const v = Math.abs(buf.readInt16LE(i));
		if (v > peak) peak = v;
	}
	return { frames: dataLen / 2, rate, peak };
}

const PROMPT =
	"And so my fellow Americans, ask not what your country can do for you.";

describe.skipIf(!READY)("voice pipeline — real TTS -> STT round-trip", () => {
	it("synthesizes the prompt and transcribes it back to the same words", () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "voice-rt-"));
		const wav24 = path.join(tmp, "tts.wav");
		const wav16 = path.join(tmp, "tts-16k.wav");

		// 1. Real TTS: text (stdin) -> 24 kHz WAV.
		const tts = spawnSync(
			ttsBin as string,
			[
				"--model",
				omniModel as string,
				"--codec",
				omniCodec as string,
				"--format",
				"wav16",
				"-o",
				wav24,
			],
			{ input: PROMPT, encoding: "utf8", timeout: 240_000 },
		);
		expect(tts.status, tts.stderr?.slice(-800)).toBe(0);
		expect(existsSync(wav24)).toBe(true);

		// 2. Real, non-silent audio (not the silent-zero-PCM failure mode).
		const { frames, rate, peak } = wavPeak(wav24);
		expect(rate).toBe(24000);
		expect(frames).toBeGreaterThan(24000); // > 1s of audio
		expect(peak).toBeGreaterThan(1000); // real signal, not silence

		// 3. Resample to whisper's 16 kHz.
		const rs = spawnSync(
			ffmpeg as string,
			["-y", "-i", wav24, "-ar", "16000", "-ac", "1", wav16],
			{ encoding: "utf8", timeout: 60_000 },
		);
		expect(rs.status, rs.stderr?.slice(-400)).toBe(0);

		// 4. Real STT: transcribe the synthesized speech.
		const stt = spawnSync(
			whisperCli as string,
			["-m", whisperModel as string, "-f", wav16, "-nt"],
			{ encoding: "utf8", timeout: 120_000 },
		);
		expect(stt.status, stt.stderr?.slice(-400)).toBe(0);
		const transcript = (stt.stdout ?? "").toLowerCase();

		// The synthesized speech must be intelligible enough to read back the
		// salient words — proving real TTS produced real, recognizable speech.
		expect(transcript).toContain("fellow americans");
		expect(transcript).toContain("country");
		expect(transcript).toContain("ask");
	}, 300_000);
});
