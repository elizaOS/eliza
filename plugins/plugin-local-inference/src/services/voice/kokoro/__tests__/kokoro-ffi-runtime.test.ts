import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "../ffi-bindings";
import { KokoroFfiRuntime } from "../kokoro-ffi-runtime";
import type { KokoroRuntimeInputs } from "../kokoro-runtime";
import type { KokoroModelLayout, KokoroVoicePack } from "../types";

const MODEL_FILE = "kokoro-82m-v1_0.gguf";

interface FakeFfiCalls {
	loads: Array<{ ggufPath: string; voiceBinPath: string; styleDim?: number }>;
	synths: Array<{ text: string; maxSamples: number; speed?: number }>;
	destroyed: number;
	closed: number;
}

function fakeKokoroFfi(opts: {
	supported?: boolean;
	pcm?: Float32Array;
	calls: FakeFfiCalls;
}): ElizaInferenceFfi {
	const pcm = opts.pcm ?? Float32Array.from([0.1, 0.2, 0.3, 0.4]);
	return {
		libraryPath: "/fake/libelizainference.so",
		libraryAbiVersion: "10",
		create: () => 7n as ElizaInferenceContextHandle,
		destroy: () => {
			opts.calls.destroyed++;
		},
		kokoroSupported: () => opts.supported ?? true,
		kokoroLoad: (a) => {
			opts.calls.loads.push(a);
		},
		kokoroSynthesize: (a) => {
			opts.calls.synths.push({
				text: a.text,
				maxSamples: a.maxSamples,
				speed: a.speed,
			});
			return pcm.slice();
		},
		kokoroSampleRate: () => 24_000,
		close: () => {
			opts.calls.closed++;
		},
	} as unknown as ElizaInferenceFfi;
}

function makeLayout(root: string): KokoroModelLayout {
	return {
		root,
		modelFile: MODEL_FILE,
		voicesDir: path.join(root, "voices"),
		sampleRate: 24_000,
	};
}

function voice(id: string, file: string): KokoroVoicePack {
	return { id, displayName: id, lang: "a", file, dim: 256 };
}

function makeInputs(
	v: KokoroVoicePack,
	onChunk: KokoroRuntimeInputs["onChunk"],
	cancelSignal = { cancelled: false },
): KokoroRuntimeInputs {
	return {
		phonemes: { ids: Int32Array.from([1, 2, 3]), phonemes: "hɛˈloʊ" },
		voice: v,
		cancelSignal,
		onChunk,
	};
}

describe("KokoroFfiRuntime", () => {
	let root: string;
	let calls: FakeFfiCalls;

	beforeEach(() => {
		root = mkdtempSync(path.join(os.tmpdir(), "kokoro-ffi-test-"));
		mkdirSync(path.join(root, "voices"), { recursive: true });
		writeFileSync(path.join(root, MODEL_FILE), Buffer.alloc(8));
		writeFileSync(path.join(root, "voices", "af_same.bin"), Buffer.alloc(1024));
		writeFileSync(
			path.join(root, "voices", "af_bella.bin"),
			Buffer.alloc(1024),
		);
		calls = { loads: [], synths: [], destroyed: 0, closed: 0 };
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("throws when the loaded build does not link the Kokoro engine (no TCP fallback)", () => {
		const ffi = fakeKokoroFfi({ supported: false, calls });
		expect(
			() =>
				new KokoroFfiRuntime({
					layout: makeLayout(root),
					ffi,
					ctx: 7n as ElizaInferenceContextHandle,
				}),
		).toThrow(/does not link the in-process Eliza-1 Kokoro engine/);
	});

	it("loads the GGUF + voice once and emits one body chunk + final tail", async () => {
		const ffi = fakeKokoroFfi({ calls });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});

		const chunks: Array<{ isFinal: boolean; len: number }> = [];
		const result = await rt.synthesize(
			makeInputs(voice("af_same", "af_same.bin"), (c) => {
				chunks.push({ isFinal: c.isFinal, len: c.pcm.length });
				return undefined;
			}),
		);

		expect(result.cancelled).toBe(false);
		expect(calls.loads).toHaveLength(1);
		expect(calls.loads[0]?.ggufPath).toBe(path.join(root, MODEL_FILE));
		expect(calls.loads[0]?.voiceBinPath).toBe(
			path.join(root, "voices", "af_same.bin"),
		);
		// The fork phonemizes internally — we hand it the phoneme string, the
		// same `input` the llama-server /v1/audio/speech path sends.
		expect(calls.synths[0]?.text).toBe("hɛˈloʊ");
		expect(chunks.filter((c) => !c.isFinal)).toHaveLength(1);
		expect(chunks.at(-1)?.isFinal).toBe(true);
		expect(chunks[0]?.len).toBe(4);
	});

	it("does not reload the voice across synthesize calls for the same voice", async () => {
		const ffi = fakeKokoroFfi({ calls });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});

		const v = voice("af_same", "af_same.bin");
		await rt.synthesize(makeInputs(v, () => undefined));
		await rt.synthesize(makeInputs(v, () => undefined));

		expect(calls.loads).toHaveLength(1);
		expect(calls.synths).toHaveLength(2);
	});

	it("reloads when the requested voice changes", async () => {
		const ffi = fakeKokoroFfi({ calls });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});

		await rt.synthesize(
			makeInputs(voice("af_same", "af_same.bin"), () => undefined),
		);
		await rt.synthesize(
			makeInputs(voice("af_bella", "af_bella.bin"), () => undefined),
		);

		expect(calls.loads).toHaveLength(2);
		expect(calls.loads[1]?.voiceBinPath).toBe(
			path.join(root, "voices", "af_bella.bin"),
		);
	});

	it("honours a pre-set cancel signal without synthesizing", async () => {
		const ffi = fakeKokoroFfi({ calls });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});

		const chunks: boolean[] = [];
		const result = await rt.synthesize(
			makeInputs(
				voice("af_same", "af_same.bin"),
				(c) => {
					chunks.push(c.isFinal);
					return undefined;
				},
				{ cancelled: true },
			),
		);

		expect(result.cancelled).toBe(true);
		// Only the final tail is emitted; no synthesis happened.
		expect(calls.synths).toHaveLength(0);
		expect(chunks).toEqual([true]);
	});

	it("throws when the model file is missing on disk", async () => {
		rmSync(path.join(root, MODEL_FILE), { force: true });
		const ffi = fakeKokoroFfi({ calls });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});

		await expect(
			rt.synthesize(
				makeInputs(voice("af_same", "af_same.bin"), () => undefined),
			),
		).rejects.toThrow(/Kokoro model file not found/);
	});

	it("destroys the ctx and closes the lib only when it owns them", () => {
		const ffi = fakeKokoroFfi({ calls });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});
		rt.dispose();
		// ctx + ffi were injected → not owned → not torn down.
		expect(calls.destroyed).toBe(0);
		expect(calls.closed).toBe(0);
	});
});
