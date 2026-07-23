/**
 * Covers the pure/filesystem plumbing of the #10726 real voice benchmark lanes
 * (scripts/voice-bench-shared.ts): gate construction, corpus cache validation,
 * report/bundle writing, and the stats helpers. Real filesystem + real WAV
 * codec; the model-dependent synthesis path is skipped deterministically by
 * pointing discovery at an empty model dir.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BENCH_SAMPLE_RATE,
	type BenchGates,
	bootFusedFfi,
	defaultReportDir,
	ensureKokoroCorpus,
	makeBenchGates,
	makeQuantBundle,
	mean,
	median,
	writeBenchReport,
} from "../scripts/voice-bench-shared";
import type { BenchCorpusEntry } from "../src/services/voice/bench-utils";
import { encodeMonoPcm16Wav } from "../src/services/voice/wav-codec";

/** Sentinel raised by the test gates instead of the real process.exit. */
class GateSignal extends Error {
	constructor(
		readonly kind: "skip" | "fail",
		message: string,
	) {
		super(message);
	}
}

function throwingGates(): BenchGates {
	return {
		required: false,
		skip(msg: string): never {
			throw new GateSignal("skip", msg);
		},
		fail(msg: string): never {
			throw new GateSignal("fail", msg);
		},
	};
}

/** Raised by the patched process.exit so exit codes become observable. */
class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit:${code}`);
	}
}

function captureExit(fn: () => void): number {
	const realExit = process.exit;
	process.exit = ((code?: number): never => {
		throw new ExitSignal(code ?? 0);
	}) as typeof process.exit;
	try {
		fn();
		throw new Error("expected the gate to exit the process");
	} catch (error) {
		if (error instanceof ExitSignal) return error.code;
		throw error;
	} finally {
		process.exit = realExit;
	}
}

const SAVED_ENV_KEYS = [
	"ELIZA_VOICE_BENCH_CORPUS_DIR",
	"ELIZA_KOKORO_MODEL_DIR",
	"ELIZA_VOICE_BENCH_OUT",
	"VOICE_BENCH_TEST_REQUIRE",
] as const;
const savedEnv = new Map<string, string | undefined>(
	SAVED_ENV_KEYS.map((key) => [key, process.env[key]]),
);
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Route corpus caching and Kokoro discovery into empty temp dirs. */
function isolateCorpusEnv(): string {
	const corpusDir = makeTempDir("voice-bench-corpus-");
	process.env.ELIZA_VOICE_BENCH_CORPUS_DIR = corpusDir;
	process.env.ELIZA_KOKORO_MODEL_DIR = makeTempDir("kokoro-empty-");
	return corpusDir;
}

const ENTRIES: readonly BenchCorpusEntry[] = [
	{ id: "utt-a", voiceId: "af_bella", text: "hello world" },
	{ id: "utt-b", voiceId: "am_adam", text: "quick brown fox" },
];

function writeCorpusWavs(dir: string, sampleRate: number): void {
	mkdirSync(dir, { recursive: true });
	for (const entry of ENTRIES) {
		const pcm = new Float32Array(sampleRate / 2);
		for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 10) * 0.5;
		writeFileSync(
			path.join(dir, `${entry.id}.wav`),
			encodeMonoPcm16Wav(pcm, sampleRate),
		);
	}
}

describe("makeBenchGates", () => {
	it("skips with exit 2 when the lane REQUIRE env is unset", () => {
		delete process.env.VOICE_BENCH_TEST_REQUIRE;
		const gates = makeBenchGates("test-lane", "VOICE_BENCH_TEST_REQUIRE");
		expect(gates.required).toBe(false);
		expect(captureExit(() => gates.skip("assets absent"))).toBe(2);
	});

	it("turns skips into exit-1 failures when the REQUIRE env is truthy", () => {
		for (const value of ["1", "true", " YES "]) {
			process.env.VOICE_BENCH_TEST_REQUIRE = value;
			const gates = makeBenchGates("test-lane", "VOICE_BENCH_TEST_REQUIRE");
			expect(gates.required).toBe(true);
			expect(captureExit(() => gates.skip("assets absent"))).toBe(1);
		}
	});

	it("treats non-truthy REQUIRE values as unset", () => {
		process.env.VOICE_BENCH_TEST_REQUIRE = "0";
		expect(makeBenchGates("t", "VOICE_BENCH_TEST_REQUIRE").required).toBe(
			false,
		);
	});

	it("always fails with exit 1", () => {
		delete process.env.VOICE_BENCH_TEST_REQUIRE;
		const gates = makeBenchGates("test-lane", "VOICE_BENCH_TEST_REQUIRE");
		expect(captureExit(() => gates.fail("broken"))).toBe(1);
	});
});

describe("bootFusedFfi", () => {
	it("skips outside the bun runtime instead of loading bun:ffi", () => {
		// Vitest workers run under Node, so the bun-runtime guard is the real
		// first gate this helper applies in this environment.
		if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") return;
		expect(() => bootFusedFfi(throwingGates())).toThrow(GateSignal);
		expect(() => bootFusedFfi(throwingGates())).toThrow(/not running under bun/);
	});
});

describe("ensureKokoroCorpus", () => {
	it("returns decoded 16 kHz corpus items on a cache hit without synthesis", async () => {
		const corpusDir = isolateCorpusEnv();
		const dir = path.join(corpusDir, "cache-hit-v1");
		writeCorpusWavs(dir, BENCH_SAMPLE_RATE);
		const logs: string[] = [];
		const items = await ensureKokoroCorpus("cache-hit", ENTRIES, throwingGates(), (m) =>
			logs.push(m),
		);
		expect(items).toHaveLength(ENTRIES.length);
		for (const [index, item] of items.entries()) {
			expect(item.id).toBe(ENTRIES[index]?.id);
			expect(item.wavPath).toBe(path.join(dir, `${item.id}.wav`));
			expect(item.pcm.length).toBe(BENCH_SAMPLE_RATE / 2);
			expect(item.seconds).toBeCloseTo(0.5, 5);
		}
		// The complete cache is adopted as-is: manifest backfilled, no synthesis.
		expect(existsSync(path.join(dir, "manifest.json"))).toBe(true);
		expect(logs).toHaveLength(0);
	});

	it("skips when utterances are missing and no Kokoro model is staged", async () => {
		isolateCorpusEnv();
		await expect(
			ensureKokoroCorpus("no-model", ENTRIES, throwingGates(), () => {}),
		).rejects.toThrow(/2\/2 utterances missing and no Kokoro model staged/);
	});

	it("invalidates every cached utterance when the manifest changed", async () => {
		const corpusDir = isolateCorpusEnv();
		const dir = path.join(corpusDir, "stale-manifest-v1");
		writeCorpusWavs(dir, BENCH_SAMPLE_RATE);
		writeFileSync(
			path.join(dir, "manifest.json"),
			JSON.stringify({ schemaVersion: 1, entries: [] }, null, "\t"),
		);
		const logs: string[] = [];
		await expect(
			ensureKokoroCorpus("stale-manifest", ENTRIES, throwingGates(), (m) =>
				logs.push(m),
			),
		).rejects.toThrow(GateSignal);
		// The stale WAVs must be gone — a text/voice edit may not reuse audio
		// synthesized from the previous transcript.
		expect(existsSync(path.join(dir, "utt-a.wav"))).toBe(false);
		expect(existsSync(path.join(dir, "utt-b.wav"))).toBe(false);
		expect(logs.some((m) => m.includes("manifest changed"))).toBe(true);
	});

	it("fails on a cached WAV with the wrong sample rate", async () => {
		const corpusDir = isolateCorpusEnv();
		writeCorpusWavs(path.join(corpusDir, "wrong-rate-v1"), 24_000);
		await expect(
			ensureKokoroCorpus("wrong-rate", ENTRIES, throwingGates(), () => {}),
		).rejects.toThrow(/utt-a\.wav is 24000 Hz, expected 16000/);
	});
});

describe("makeQuantBundle", () => {
	it("stages the fused-lib bundle layout via symlinks and cleans up", () => {
		const src = makeTempDir("quant-src-");
		const gguf = path.join(src, "model.gguf");
		const mmproj = path.join(src, "mmproj.gguf");
		writeFileSync(gguf, "gguf-bytes");
		writeFileSync(mmproj, "mmproj-bytes");
		const bundle = makeQuantBundle(gguf, mmproj);
		expect(existsSync(path.join(bundle.dir, "asr", "eliza-1-asr.gguf"))).toBe(
			true,
		);
		expect(
			existsSync(path.join(bundle.dir, "asr", "eliza-1-asr-mmproj.gguf")),
		).toBe(true);
		bundle.cleanup();
		expect(existsSync(bundle.dir)).toBe(false);
	});
});

describe("writeBenchReport", () => {
	it("writes the JSON + Markdown pair and returns their paths", () => {
		const outDir = path.join(makeTempDir("bench-report-"), "nested", "out");
		const { jsonPath, mdPath } = writeBenchReport(
			outDir,
			"lane-report",
			{ pass: true, ttfaMs: 123 },
			"# Lane\npass\n",
		);
		expect(jsonPath).toBe(path.join(outDir, "lane-report.json"));
		expect(mdPath).toBe(path.join(outDir, "lane-report.md"));
		expect(existsSync(jsonPath)).toBe(true);
		expect(existsSync(mdPath)).toBe(true);
	});
});

describe("defaultReportDir", () => {
	it("prefers the ELIZA_VOICE_BENCH_OUT override", () => {
		const dir = makeTempDir("bench-out-");
		process.env.ELIZA_VOICE_BENCH_OUT = dir;
		expect(defaultReportDir()).toBe(dir);
	});

	it("defaults to the plugin-local voice-bench-output dir", () => {
		delete process.env.ELIZA_VOICE_BENCH_OUT;
		const dir = defaultReportDir();
		expect(path.basename(dir)).toBe("voice-bench-output");
		expect(dir.includes("plugin-local-inference")).toBe(true);
	});
});

describe("stats helpers", () => {
	it("mean handles empty and non-empty inputs", () => {
		expect(mean([])).toBe(0);
		expect(mean([2, 4, 6])).toBe(4);
	});

	it("median handles empty, odd, and even inputs without mutating them", () => {
		expect(median([])).toBe(0);
		expect(median([9])).toBe(9);
		const values = [5, 1, 3];
		expect(median(values)).toBe(3);
		expect(values).toEqual([5, 1, 3]);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});
});

describe("BENCH_SAMPLE_RATE", () => {
	it("pins the 16 kHz corpus contract every lane assumes", () => {
		expect(BENCH_SAMPLE_RATE).toBe(16_000);
	});
});
