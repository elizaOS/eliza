/**
 * End-to-end test for packages/app-core/scripts/omnivoice-fuse/freeze-voice.mjs.
 *
 * The CLI builds an ELZ2 v2 voice preset from a corpus directory. We
 * exercise the corpus-discovery + selection + dry-run + skip-encode write
 * paths against a synthesized minimal corpus (1 short WAV + manifest
 * entry); we do NOT run the FFI encode path here (the fused
 * libelizainference is not built in CI by default — that's covered by
 * the dedicated FFI smoke tests).
 *
 * Coverage:
 *   - --dry-run lists clips without writing anything.
 *   - --skip-encode writes a parseable ELZ2 v2 file under <out>.
 *   - the written preset round-trips via readVoicePresetFile and the
 *     refText + instruct + metadata fields are preserved.
 *   - --voice rejects path-unsafe ids.
 *   - --max-seconds bounds the selected reference length.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readVoicePresetFile } from "../src/services/voice/voice-preset-format";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// .../plugins/plugin-local-inference/__tests__ -> repo root
const REPO_ROOT = path.resolve(HERE, "../../..");
const SCRIPT = path.join(
	REPO_ROOT,
	"packages",
		"app-core",
		"scripts",
		"voice",
		"freeze-voice.mjs",
	);

interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
}

function runFreeze(args: string[], opts: { allowFail?: boolean } = {}): RunResult {
	try {
		const stdout = execFileSync("bun", [SCRIPT, ...args], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "", code: 0 };
	} catch (err) {
		const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
		if (!opts.allowFail) {
			throw err;
		}
		return {
			stdout: typeof e.stdout === "string" ? e.stdout : e.stdout?.toString() ?? "",
			stderr: typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "",
			code: e.status ?? 1,
		};
	}
}

/** Build a minimal 16-bit PCM mono RIFF/WAVE file at `srHz` for `durSec`. */
function writeSineWav(filePath: string, durSec: number, srHz: number) {
	const n = Math.round(durSec * srHz);
	const dataLen = n * 2;
	const buf = Buffer.alloc(44 + dataLen);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(36 + dataLen, 4);
	buf.write("WAVE", 8, "ascii");
	buf.write("fmt ", 12, "ascii");
	buf.writeUInt32LE(16, 16); // fmt size
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // channels
	buf.writeUInt32LE(srHz, 24);
	buf.writeUInt32LE(srHz * 2, 28); // byte rate
	buf.writeUInt16LE(2, 32); // block align
	buf.writeUInt16LE(16, 34); // bits/sample
	buf.write("data", 36, "ascii");
	buf.writeUInt32LE(dataLen, 40);
	const f = 440;
	for (let i = 0; i < n; i++) {
		const s = Math.round(Math.sin((2 * Math.PI * f * i) / srHz) * 0.1 * 32767);
		buf.writeInt16LE(s, 44 + i * 2);
	}
	writeFileSync(filePath, buf);
}

describe("freeze-voice.mjs CLI", () => {
	let corpusDir: string;
	let outDir: string;

	beforeEach(() => {
		corpusDir = mkdtempSync(path.join(tmpdir(), "freeze-voice-corpus-"));
		outDir = mkdtempSync(path.join(tmpdir(), "freeze-voice-out-"));
		mkdirSync(path.join(corpusDir, "audio"), { recursive: true });
		// Two clips: a 3-second sample and a 5-second sample, both at 44.1 kHz.
		writeSineWav(path.join(corpusDir, "audio", "same_001.wav"), 3.0, 44100);
		writeSineWav(path.join(corpusDir, "audio", "same_003.wav"), 5.0, 44100);
		const manifest = [
			JSON.stringify({
				id: "same_001",
				audio_path: "audio/same_001.wav",
				duration_s: 3.0,
				sample_rate: 44100,
				channels: 1,
				bit_depth: 16,
				transcript: "First reference sentence for the freeze test.",
				excluded: false,
			}),
			JSON.stringify({
				id: "same_003",
				audio_path: "audio/same_003.wav",
				duration_s: 5.0,
				sample_rate: 44100,
				channels: 1,
				bit_depth: 16,
				transcript: "Second reference sentence containing more words.",
				excluded: false,
			}),
		].join("\n");
		writeFileSync(path.join(corpusDir, "manifest.jsonl"), manifest);
	});

	afterEach(() => {
		rmSync(corpusDir, { recursive: true, force: true });
		rmSync(outDir, { recursive: true, force: true });
	});

	it("--dry-run lists selected clips without writing", () => {
		const out = path.join(outDir, "voice-preset-test.bin");
		const res = runFreeze([
			"--voice",
			"test",
			"--corpus",
			corpusDir,
			"--out",
			out,
			"--dry-run",
			"--skip-encode",
		]);
		expect(res.stdout).toContain("selected 2 clip(s)");
		expect(res.stdout).toContain("dry-run: skipping load + encode + write");
		expect(existsSync(out)).toBe(false);
	});

	it("--skip-encode writes a parseable ELZ2 v2 file with refText + instruct + metadata", () => {
		const out = path.join(outDir, "voice-preset-test.bin");
		const instruct = "young adult female, warm";
		const res = runFreeze([
			"--voice",
			"test",
			"--corpus",
			corpusDir,
			"--out",
			out,
			"--skip-encode",
			"--instruct",
			instruct,
		]);
		expect(res.code).toBe(0);
		expect(existsSync(out)).toBe(true);
		const bytes = new Uint8Array(readFileSync(out));
		const parsed = readVoicePresetFile(bytes);
		expect(parsed.version).toBe(2);
		expect(parsed.instruct).toBe(instruct);
		expect(parsed.refText).toContain("First reference sentence");
		expect(parsed.refText).toContain("Second reference sentence");
		expect(parsed.refAudioTokens.K).toBe(0); // --skip-encode left these empty
		expect(parsed.refAudioTokens.refT).toBe(0);
		expect(parsed.metadata.voiceId).toBe("test");
		expect(parsed.metadata.generator).toBe("freeze-voice.mjs");
		expect(Array.isArray(parsed.metadata.referenceClipIds)).toBe(true);
		expect((parsed.metadata.referenceClipIds as string[]).length).toBeGreaterThan(0);
	});

	it("--max-seconds bounds selected reference length", () => {
		const out = path.join(outDir, "voice-preset-test.bin");
		const res = runFreeze([
			"--voice",
			"test",
			"--corpus",
			corpusDir,
			"--out",
			out,
			"--skip-encode",
			"--max-seconds",
			"3.5",
		]);
		expect(res.code).toBe(0);
		// Only the first 3 s clip fits in a 3.5 s budget.
		expect(res.stdout).toContain("selected 1 clip(s)");
	});

	it("rejects path-unsafe voice ids", () => {
		const out = path.join(outDir, "voice-preset-test.bin");
		const res = runFreeze(
			[
				"--voice",
				"../escape",
				"--corpus",
				corpusDir,
				"--out",
				out,
				"--skip-encode",
				"--dry-run",
			],
			{ allowFail: true },
		);
		expect(res.code).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/path-safe segment/i);
	});
});
