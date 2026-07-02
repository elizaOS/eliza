/**
 * Shared plumbing for the #10726 real voice benchmark lanes. Bun-only (bun:ffi).
 *
 * Conventions (matches asr-real-smoke / kokoro-real-smoke):
 *   exit 0 = pass, exit 1 = real failure, exit 2 = honest skip (assets absent).
 *   A lane-specific `*_REQUIRE=1` env flips every skip into a hard failure so a
 *   CI job that STAGED the assets goes RED when they are missing.
 *
 * Corpus: fixed-transcript utterances synthesized ONCE with the shipped Kokoro
 * TTS (real weights; #11238 raw-text path + espeak-linked lib required for
 * intelligible audio) and cached under
 * `<stateDir>/local-inference/voice-bench-corpus/<name>-v1/` as 16 kHz mono
 * PCM16 WAVs + manifest. Reruns hit the cache and need no TTS at all.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFusedLibraryPath } from "../src/services/desktop-fused-ffi-backend-runtime";
import type { BenchCorpusEntry } from "../src/services/voice/bench-utils";
import { decodeMonoPcm16Wav } from "../src/services/voice/engine-bridge";
import {
	type ElizaInferenceFfi,
	loadElizaInferenceFfi,
} from "../src/services/voice/ffi-bindings";
import { resolveKokoroEngineConfig } from "../src/services/voice/kokoro/kokoro-engine-discovery";
import { localInferenceRoot } from "../src/services/paths";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BENCH_SAMPLE_RATE = 16_000;
const CORPUS_SCHEMA = 1;

export interface BenchGates {
	skip(msg: string): never;
	fail(msg: string): never;
	required: boolean;
}

/** skip()/fail() pair with the repo's exit-code + REQUIRE-env contract. */
export function makeBenchGates(tag: string, requireEnvName: string): BenchGates {
	const v = process.env[requireEnvName]?.trim().toLowerCase();
	const required = v === "1" || v === "true" || v === "yes";
	return {
		required,
		skip(msg: string): never {
			if (required) {
				console.error(`[${tag}] FAIL (${requireEnvName} set): ${msg}`);
				process.exit(1);
			}
			console.log(`[${tag}] SKIP: ${msg}`);
			process.exit(2);
		},
		fail(msg: string): never {
			console.error(`[${tag}] FAIL: ${msg}`);
			process.exit(1);
		},
	};
}

/** Load the fused lib (ABI v12) or skip. */
export function bootFusedFfi(gates: BenchGates): {
	ffi: ElizaInferenceFfi;
	libPath: string;
} {
	if (typeof (globalThis as { Bun?: unknown }).Bun === "undefined") {
		gates.skip("not running under bun (bun:ffi required) — invoke with `bun`");
	}
	const libPath = resolveFusedLibraryPath(null, process.env);
	if (!libPath) {
		gates.skip(
			"fused lib not found (set ELIZA_INFERENCE_LIBRARY / ELIZA_INFERENCE_LIB_DIR, " +
				"or run `bun run build:fused-desktop` in packages/app-core)",
		);
	}
	const ffi = loadElizaInferenceFfi(libPath);
	if (ffi.libraryAbiVersion !== "12") {
		gates.fail(`expected fused-lib ABI v12, got v${ffi.libraryAbiVersion}`);
	}
	return { ffi, libPath };
}

export interface CorpusItem extends BenchCorpusEntry {
	wavPath: string;
	pcm: Float32Array;
	seconds: number;
}

function corpusRoot(): string {
	return (
		process.env.ELIZA_VOICE_BENCH_CORPUS_DIR?.trim() ||
		path.join(localInferenceRoot(), "voice-bench-corpus")
	);
}

interface CorpusManifest {
	schemaVersion: number;
	entries: Array<{ id: string; voiceId: string; text: string }>;
}

/**
 * Return the cached corpus, synthesizing any missing utterances with the real
 * Kokoro TTS first (parallel worker subprocesses — the Kokoro forward pass is
 * effectively single-threaded on desktop CPU). Skips when the cache is
 * incomplete AND no Kokoro model is staged.
 */
export async function ensureKokoroCorpus(
	name: string,
	entries: readonly BenchCorpusEntry[],
	gates: BenchGates,
	log: (msg: string) => void,
): Promise<CorpusItem[]> {
	const dir = path.join(corpusRoot(), `${name}-v${CORPUS_SCHEMA}`);
	mkdirSync(dir, { recursive: true });
	const manifestPath = path.join(dir, "manifest.json");
	const manifest: CorpusManifest = {
		schemaVersion: CORPUS_SCHEMA,
		entries: entries.map((e) => ({ id: e.id, voiceId: e.voiceId, text: e.text })),
	};
	// A stale manifest (different texts/voices) invalidates the whole cache.
	if (existsSync(manifestPath)) {
		const existing = readFileSync(manifestPath, "utf8");
		if (existing !== JSON.stringify(manifest, null, "\t")) {
			log(`corpus ${name}: manifest changed — regenerating all utterances`);
			for (const e of entries) rmSync(path.join(dir, `${e.id}.wav`), { force: true });
		}
	}

	const missing = entries.filter((e) => !existsSync(path.join(dir, `${e.id}.wav`)));
	if (missing.length > 0) {
		const kokoro = resolveKokoroEngineConfig();
		if (!kokoro) {
			gates.skip(
				`corpus ${name}: ${missing.length}/${entries.length} utterances missing and no Kokoro model staged ` +
					"(set ELIZA_KOKORO_MODEL_DIR to a dir with kokoro-82m-v1_0*.gguf + voices/<v>.bin)",
			);
		}
		log(
			`corpus ${name}: synthesizing ${missing.length} utterance(s) with Kokoro ` +
				`(${kokoro.layout.modelFile}) — one-time, cached in ${dir}`,
		);
		const workers = Math.max(
			1,
			Math.min(
				Number(process.env.ELIZA_VOICE_BENCH_WORKERS ?? "6") || 6,
				missing.length,
			),
		);
		const queue = [...missing];
		const failures: string[] = [];
		await Promise.all(
			Array.from({ length: workers }, async () => {
				for (;;) {
					const entry = queue.shift();
					if (!entry) return;
					const out = path.join(dir, `${entry.id}.wav`);
					const started = Date.now();
					const code = await runSynthWorker(entry, out);
					if (code !== 0) {
						failures.push(`${entry.id} (exit ${code})`);
						return;
					}
					log(
						`corpus ${name}: ${entry.id} [${entry.voiceId}] synthesized in ${((Date.now() - started) / 1000).toFixed(1)}s`,
					);
				}
			}),
		);
		if (failures.length > 0) {
			gates.fail(`corpus ${name}: Kokoro synthesis failed for ${failures.join(", ")}`);
		}
		writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
	} else if (!existsSync(manifestPath)) {
		writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t"));
	}

	return entries.map((e) => {
		const wavPath = path.join(dir, `${e.id}.wav`);
		const { pcm, sampleRate } = decodeMonoPcm16Wav(
			new Uint8Array(readFileSync(wavPath)),
		);
		if (sampleRate !== BENCH_SAMPLE_RATE) {
			gates.fail(
				`corpus ${name}: ${e.id}.wav is ${sampleRate} Hz, expected ${BENCH_SAMPLE_RATE} (delete ${dir} to regenerate)`,
			);
		}
		return { ...e, wavPath, pcm, seconds: pcm.length / sampleRate };
	});
}

function runSynthWorker(entry: BenchCorpusEntry, outPath: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(
			process.execPath, // bun
			[
				path.join(__dirname, "voice-bench-synth-worker.ts"),
				"--voice",
				entry.voiceId,
				"--out",
				outPath,
				"--text-b64",
				Buffer.from(entry.text, "utf8").toString("base64"),
			],
			{ stdio: ["ignore", "inherit", "inherit"], env: process.env },
		);
		child.on("close", (code) => resolve(code ?? 1));
		child.on("error", () => resolve(1));
	});
}

/**
 * Stage one ASR quant as a bundle dir the fused lib understands
 * (`asr/eliza-1-asr.gguf` + `asr/eliza-1-asr-mmproj.gguf` symlinks).
 */
export function makeQuantBundle(
	quantGgufPath: string,
	mmprojPath: string,
): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(path.join(os.tmpdir(), "stt-quant-bundle-"));
	mkdirSync(path.join(dir, "asr"));
	symlinkSync(quantGgufPath, path.join(dir, "asr", "eliza-1-asr.gguf"));
	symlinkSync(mmprojPath, path.join(dir, "asr", "eliza-1-asr-mmproj.gguf"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write the JSON + Markdown report pair and return their paths. */
export function writeBenchReport(
	outDir: string,
	baseName: string,
	payload: object,
	markdown: string,
): { jsonPath: string; mdPath: string } {
	mkdirSync(outDir, { recursive: true });
	const jsonPath = path.join(outDir, `${baseName}.json`);
	const mdPath = path.join(outDir, `${baseName}.md`);
	writeFileSync(jsonPath, JSON.stringify(payload, null, "\t"));
	writeFileSync(mdPath, markdown);
	return { jsonPath, mdPath };
}

/** Default report dir (gitignored): `<plugin>/voice-bench-output/`. */
export function defaultReportDir(): string {
	return (
		process.env.ELIZA_VOICE_BENCH_OUT?.trim() ||
		path.resolve(__dirname, "..", "voice-bench-output")
	);
}

export const mean = (xs: readonly number[]): number =>
	xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export const median = (xs: readonly number[]): number => {
	if (xs.length === 0) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
