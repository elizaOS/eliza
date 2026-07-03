import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
} from "../../ffi-bindings";
import { writeVoicePresetFileV2 } from "../../voice-preset-format";
import { KokoroFfiRuntime } from "../kokoro-ffi-runtime";
import type { KokoroRuntimeInputs } from "../kokoro-runtime";
import type { KokoroModelLayout, KokoroVoicePack } from "../types";

const MODEL_FILE = "kokoro-82m-v1_0.gguf";

interface FakeFfiCalls {
	loads: Array<{ ggufPath: string; voiceBinPath: string; styleDim?: number }>;
	synths: Array<{ text: string; maxSamples: number; speed?: number }>;
	ipaSynths: Array<{ ipa: string; maxSamples: number; speed?: number }>;
	destroyed: number;
	closed: number;
}

function fakeKokoroFfi(opts: {
	supported?: boolean;
	pcm?: Float32Array;
	calls: FakeFfiCalls;
	/**
	 * When set, the fake exports the v14 G2P surface reporting this kind. When
	 * omitted, the fake OMITS `kokoroG2pKind`/`kokoroSynthesizeIpa` entirely —
	 * modelling a pre-v14 library (the runtime resolves g2p="unknown").
	 */
	g2pKind?: "espeak" | "ascii";
}): ElizaInferenceFfi {
	const pcm = opts.pcm ?? Float32Array.from([0.1, 0.2, 0.3, 0.4]);
	const base = {
		libraryPath: "/fake/libelizainference.so",
		libraryAbiVersion: opts.g2pKind ? "14" : "13",
		create: () => 7n as ElizaInferenceContextHandle,
		destroy: () => {
			opts.calls.destroyed++;
		},
		kokoroSupported: () => opts.supported ?? true,
		kokoroLoad: (a: {
			ggufPath: string;
			voiceBinPath: string;
			styleDim?: number;
		}) => {
			opts.calls.loads.push(a);
		},
		kokoroSynthesize: (a: {
			text: string;
			maxSamples: number;
			speed?: number;
		}) => {
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
	};
	if (opts.g2pKind) {
		return {
			...base,
			kokoroG2pKind: () => opts.g2pKind,
			kokoroSynthesizeIpa: (a: {
				ipa: string;
				maxSamples: number;
				speed?: number;
			}) => {
				opts.calls.ipaSynths.push({
					ipa: a.ipa,
					maxSamples: a.maxSamples,
					speed: a.speed,
				});
				return pcm.slice();
			},
		} as unknown as ElizaInferenceFfi;
	}
	return base as unknown as ElizaInferenceFfi;
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
	extra?: { phonemizerId?: string; ipa?: string },
): KokoroRuntimeInputs {
	return {
		text: "hello",
		phonemes: {
			ids: Int32Array.from([1, 2, 3]),
			phonemes: extra?.ipa ?? "hɛˈloʊ",
		},
		phonemizerId: extra?.phonemizerId,
		voice: v,
		cancelSignal,
		onChunk,
	};
}

function u32(value: number): Buffer {
	const out = Buffer.alloc(4);
	out.writeUInt32LE(value, 0);
	return out;
}

function u64(value: number): Buffer {
	const out = Buffer.alloc(8);
	out.writeBigUInt64LE(BigInt(value), 0);
	return out;
}

function ggufString(value: string): Buffer {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([u64(bytes.byteLength), bytes]);
}

function ggufKvString(key: string, value: string): Buffer {
	return Buffer.concat([ggufString(key), u32(8), ggufString(value)]);
}

function ggufKvU32(key: string, value: number): Buffer {
	return Buffer.concat([ggufString(key), u32(4), u32(value)]);
}

function makeGgufVoicePack(raw: Float32Array, styleDim = 256): Buffer {
	const rawBytes = Buffer.from(
		new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
	);
	const header = Buffer.concat([
		Buffer.from("GGUF", "ascii"),
		u32(3), // version
		u64(1), // tensor_count
		u64(2), // metadata_kv_count
		ggufKvString("general.architecture", "kokoro-voice"),
		ggufKvU32("kokoro_voice.style_dim", styleDim),
		ggufString("voice.pack"),
		u32(3), // n_dims
		u64(styleDim),
		u64(1),
		u64(raw.length / styleDim),
		u32(0), // GGML_TYPE_F32
		u64(0), // tensor offset from aligned data start
	]);
	const padding = Buffer.alloc((32 - (header.byteLength % 32)) % 32);
	return Buffer.concat([header, padding, rawBytes]);
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
		calls = { loads: [], synths: [], ipaSynths: [], destroyed: 0, closed: 0 };
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
		// Pre-v14 lib (fake omits the G2P surface → g2p="unknown"): the runtime
		// keeps the raw-text path (correct on espeak-linked builds), never the
		// JS-side IPA string. IPA-as-text double-phonemizes (#10726/#11238).
		expect(calls.synths[0]?.text).toBe("hello");
		expect(calls.ipaSynths).toHaveLength(0);
		expect(chunks.filter((c) => !c.isFinal)).toHaveLength(1);
		expect(chunks.at(-1)?.isFinal).toBe(true);
		expect(chunks[0]?.len).toBe(4);
	});

	it("g2p=espeak: sends RAW text (the lib phonemizes with espeak-ng, #11238)", async () => {
		const ffi = fakeKokoroFfi({ calls, g2pKind: "espeak" });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});
		await rt.synthesize(
			makeInputs(voice("af_same", "af_same.bin"), () => undefined, undefined, {
				phonemizerId: "phonemizer",
			}),
		);
		expect(calls.synths).toHaveLength(1);
		expect(calls.synths[0]?.text).toBe("hello");
		// Never the IPA entry on an espeak-linked lib.
		expect(calls.ipaSynths).toHaveLength(0);
	});

	it("g2p=ascii: feeds espeak-ng IPA through the IPA entry (#11776)", async () => {
		const ffi = fakeKokoroFfi({ calls, g2pKind: "ascii" });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});
		await rt.synthesize(
			makeInputs(voice("af_same", "af_same.bin"), () => undefined, undefined, {
				phonemizerId: "phonemizer",
				ipa: "həlˈoʊ",
			}),
		);
		// The lossy raw-text path is bypassed; the IPA the TS phonemizer produced
		// goes straight to the native IPA entry.
		expect(calls.ipaSynths).toHaveLength(1);
		expect(calls.ipaSynths[0]?.ipa).toBe("həlˈoʊ");
		expect(calls.synths).toHaveLength(0);
	});

	it("g2p=ascii + fallback phonemizer: warns once, still uses the IPA entry", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const ffi = fakeKokoroFfi({ calls, g2pKind: "ascii" });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});
		const v = voice("af_same", "af_same.bin");
		await rt.synthesize(
			makeInputs(v, () => undefined, undefined, {
				phonemizerId: "fallback-g2p",
				ipa: "hɛloʊ",
			}),
		);
		await rt.synthesize(
			makeInputs(v, () => undefined, undefined, {
				phonemizerId: "fallback-g2p",
				ipa: "hɛloʊ",
			}),
		);
		expect(calls.ipaSynths).toHaveLength(2);
		// Warned exactly once about the lossy fallback despite two synths.
		const fallbackWarns = warn.mock.calls.filter((c) =>
			String(c[0]).includes("fallback-g2p"),
		);
		expect(fallbackWarns).toHaveLength(1);
	});

	it("g2p=unknown (pre-v14 lib): warns once and keeps raw text", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const ffi = fakeKokoroFfi({ calls }); // no g2pKind → unknown
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});
		const v = voice("af_same", "af_same.bin");
		await rt.synthesize(makeInputs(v, () => undefined));
		await rt.synthesize(makeInputs(v, () => undefined));
		expect(calls.synths).toHaveLength(2);
		expect(calls.ipaSynths).toHaveLength(0);
		const oldLibWarns = warn.mock.calls.filter((c) =>
			String(c[0]).includes("predates the Kokoro IPA G2P surface"),
		);
		expect(oldLibWarns).toHaveLength(1);
	});

	it("materializes packaged voice presets before calling the native loader", async () => {
		const embedding = Float32Array.from({ length: 256 }, (_, i) => i);
		const packagedPath = path.join(root, "voices", "af_bella.bin");
		writeFileSync(
			packagedPath,
			Buffer.from(
				writeVoicePresetFileV2({
					embedding,
					phrases: [],
					metadata: { voiceId: "af_bella" },
				}),
			),
		);

		const ffi = fakeKokoroFfi({ calls });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});

		await rt.synthesize(
			makeInputs(voice("af_bella", "af_bella.bin"), () => undefined),
		);

		const materialized = calls.loads[0]?.voiceBinPath;
		expect(materialized).toBeDefined();
		if (!materialized) throw new Error("missing materialized voice path");
		expect(materialized).not.toBe(packagedPath);
		expect(path.basename(materialized)).toMatch(
			/^af_bella-256-[a-f0-9]+\.bin$/,
		);

		const rawBytes = readFileSync(materialized);
		expect(rawBytes.byteLength).toBe(1024);
		const aligned = new Uint8Array(rawBytes.byteLength);
		aligned.set(rawBytes);
		const raw = new Float32Array(aligned.buffer);
		expect(raw[0]).toBe(0);
		expect(raw[42]).toBe(42);
		expect(raw[255]).toBe(255);
	});

	it("materializes GGUF voice packs before calling the native loader", async () => {
		const voicePack = Float32Array.from({ length: 512 }, (_, i) => i);
		const packagedPath = path.join(root, "voices", "af_bella.bin");
		writeFileSync(packagedPath, makeGgufVoicePack(voicePack));

		const ffi = fakeKokoroFfi({ calls });
		const rt = new KokoroFfiRuntime({
			layout: makeLayout(root),
			ffi,
			ctx: 7n as ElizaInferenceContextHandle,
		});

		await rt.synthesize(
			makeInputs(voice("af_bella", "af_bella.bin"), () => undefined),
		);

		const materialized = calls.loads[0]?.voiceBinPath;
		expect(materialized).toBeDefined();
		if (!materialized) throw new Error("missing materialized voice path");
		expect(materialized).not.toBe(packagedPath);
		expect(path.basename(materialized)).toMatch(
			/^af_bella-256-[a-f0-9]+\.bin$/,
		);

		const rawBytes = readFileSync(materialized);
		expect(rawBytes.byteLength).toBe(2048);
		const aligned = new Uint8Array(rawBytes.byteLength);
		aligned.set(rawBytes);
		const raw = new Float32Array(aligned.buffer);
		expect(raw[0]).toBe(0);
		expect(raw[255]).toBe(255);
		expect(raw[511]).toBe(511);
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
